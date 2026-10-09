import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { defaults, Store, addOffline, renameOffline, offlineIdentity } from '../electron/services/store.ts';
import { safePath, preparePath, secureUrl, redact } from '../electron/services/security.ts';
import { settingsSchema, commandSchemas, communitySchema } from '../shared/contracts.ts';
import { validateModpack, syncModpack } from '../electron/services/modpack.ts';
import { downloadFile, httpsFetch } from '../electron/services/download.ts';
import { javaRequirement, probeJava, runtimeSymlinkTarget } from '../electron/services/java.ts';
import { linuxDataDirectory, linuxStateDirectory } from '../electron/services/xdg.ts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
async function temp(t: { after(fn: () => Promise<void>): void }) { const path = await mkdtemp(join(tmpdir(), 'matrix-test-')); t.after(() => rm(path, { recursive: true, force: true })); return path; }
test('offline identity matches Java UUID v3 and is case sensitive', () => {
  assert.equal(offlineIdentity('Notch'), 'b50ad385829d3141a2167e7d7539ba7f'); assert.notEqual(offlineIdentity('Notch'), offlineIdentity('notch'));
});
test('offline profiles validate, select, rename deterministically and reject duplicates', () => {
  const data = defaults('/games'); const a = addOffline(data, 'Matrix_01'); assert.equal(data.selectedAccount, a.id);
  assert.throws(() => addOffline(data, 'matrix_01')); assert.throws(() => addOffline(data, 'invalid name'));
  renameOffline(data, a.id, 'Matrix_02'); assert.equal(a.uuid, offlineIdentity('Matrix_02')); a.kind = 'microsoft'; assert.throws(() => renameOffline(data, a.id, 'Matrix_03'));
});
test('path security rejects traversal, drive letters, UNC, ADS, device names and trailing dots', () => {
  for (const p of ['../evil', 'mods/../../evil', 'C:/evil', '\\\\server\\evil', '/etc/passwd', 'mods/evil:ads', 'mods/NUL.jar', 'mods/con', 'mods/a.', 'mods/a ', 'mods//a', 'mods/./a', 'mods/a\0']) assert.throws(() => safePath('C:/games', p), p);
  assert.ok(safePath('C:/games', 'mods/example.jar').endsWith('example.jar'));
});
test('symlink/junction cannot redirect installation writes', async t => {
  const root = await temp(t); const outside = await temp(t); await symlink(outside, join(root, 'mods'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(preparePath(root, 'mods/evil.jar'), /Links/);
});
test('settings enforce memory bounds and IPC rejects unknown fields', () => {
  const settings = defaults('/games').settings; assert.throws(() => settingsSchema.parse({ ...settings, minMemory: 8000, maxMemory: 4000 }));
  const legacy = { ...settings } as Record<string, unknown>; delete legacy.skinCamera;
  assert.deepEqual(settingsSchema.parse(legacy).skinCamera, settings.skinCamera);
  assert.throws(() => settingsSchema.parse({ ...settings, skinCamera: { ...settings.skinCamera, rotateSensitivity: 5 } }));
  assert.throws(() => commandSchemas['game.play'].parse({ id: randomUUID(), connect: false, command: 'evil' }));
});
test('atomic store persists profiles and recovers a corrupt primary using backup', async t => {
  const root = await temp(t); const file = join(root, 'settings.json'); const first = new Store(file, root); await first.load();
  addOffline(first.data, 'Player1'); first.data.settings.skinCamera.rotateSensitivity = 1.4; await first.save(); await first.save(); const next = new Store(file, root); await next.load(); assert.equal(next.data.accounts[0].name, 'Player1'); assert.equal(next.data.settings.skinCamera.rotateSensitivity, 1.4);
  await writeFile(file, '{broken'); const recovered = new Store(file, root); await recovered.load(); assert.equal(recovered.data.accounts[0].name, 'Player1');
});
test('settings schema v1 migrates to v2 and keeps an original backup', async t => {
  const root = await temp(t); const file = join(root, 'settings.json'); const legacy = defaults(root) as any;
  legacy.schemaVersion = 1; delete legacy.settings.updateChannel; addOffline(legacy, 'Player2'); await writeFile(file, JSON.stringify(legacy));
  const store = new Store(file, root); await store.load();
  assert.equal(store.data.schemaVersion, 2); assert.equal(store.data.settings.updateChannel, 'stable'); assert.equal(store.data.accounts[0].name, 'Player2');
  assert.equal(JSON.parse(await readFile(`${file}.bak`, 'utf8')).schemaVersion, 1); assert.equal(JSON.parse(await readFile(file, 'utf8')).schemaVersion, 2);
});
test('downloads validate hash and reuse existing files without network', async t => {
  const root = await temp(t); const destination = join(root, 'file'); let count = 0; const content = 'verified file';
  const fetcher = (async () => { count++; return new Response(content); }) as typeof fetch;
  const spec = { url: 'https://cdn.modrinth.com/file', hosts: ['cdn.modrinth.com'], destination, hash: sha(content), size: content.length, fetcher };
  await downloadFile(spec); await downloadFile(spec); assert.equal(count, 1); assert.equal(await readFile(destination, 'utf8'), content);
});
test('corrupt downloads never replace a valid destination', async t => {
  const root = await temp(t); const destination = join(root, 'file'); await writeFile(destination, 'personal');
  await assert.rejects(downloadFile({ url: 'https://cdn.modrinth.com/file', hosts: ['cdn.modrinth.com'], destination, hash: sha('good'), size: 4, fetcher: (async () => new Response('bad!')) as typeof fetch }), /corrompido/);
  assert.equal(await readFile(destination, 'utf8'), 'personal');
});
test('cancellation preserves partial bytes and next attempt uses a validated Range response', async t => {
  const root = await temp(t); const destination = join(root, 'file'); const content = 'abcdefgh'; const controller = new AbortController();
  const stream = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(Buffer.from('abcd')); } }, { highWaterMark: 0 });
  const spec = { url: 'https://cdn.modrinth.com/file', hosts: ['cdn.modrinth.com'], destination, hash: sha(content), size: 8 };
  await assert.rejects(downloadFile({ ...spec, signal: controller.signal, progress: () => controller.abort(), fetcher: (async () => new Response(stream)) as typeof fetch }), { name: 'AbortError' });
  let range = ''; await downloadFile({ ...spec, fetcher: (async (_url, init) => { range = new Headers(init?.headers).get('range')!; return new Response('efgh', { status: 206, headers: { 'content-range': 'bytes 4-7/8' } }); }) as typeof fetch });
  assert.equal(range, 'bytes=4-'); assert.equal(await readFile(destination, 'utf8'), content);
});
test('HTTPS and redirect allowlists reject insecure or unexpected destinations', async () => {
  assert.throws(() => secureUrl('http://cdn.modrinth.com/file')); assert.throws(() => secureUrl('https://cdn.modrinth.com.evil.test/file', ['cdn.modrinth.com']));
  await assert.rejects(httpsFetch('https://cdn.modrinth.com/file', {}, ['cdn.modrinth.com'], (async () => new Response(null, { status: 302, headers: { location: 'https://evil.test/payload' } })) as typeof fetch), /autorizado/);
});
function manifest() { return { schemaVersion: 1, id: 'matrix', version: '1.0.0', minecraft: '1.20.1', loader: { type: 'fabric', version: '0.16.14' }, allowedHosts: ['cdn.modrinth.com'], removalPolicy: 'managed-only', files: [{ path: 'mods/test.jar', url: 'https://cdn.modrinth.com/test.jar', sha256: sha('good'), size: 4, license: 'MIT' }] }; }
test('modpack validates host authorization, paths, license and duplicate files', () => {
  const m = manifest(); validateModpack(m, ['cdn.modrinth.com']); assert.throws(() => validateModpack(m, []));
  assert.throws(() => validateModpack({ ...m, files: [{ ...m.files[0], path: 'saves/world.dat' }] }, ['cdn.modrinth.com']));
  assert.throws(() => validateModpack({ ...m, files: [m.files[0], { ...m.files[0], path: 'mods/TEST.jar' }] }, ['cdn.modrinth.com']));
  assert.throws(() => validateModpack({ ...m, files: [{ ...m.files[0], license: '' }] }, ['cdn.modrinth.com']));
});
test('modpack synchronization preserves personal files before writing', async t => {
  const root = await temp(t); await mkdir(join(root, 'mods')); await writeFile(join(root, 'mods/test.jar'), 'mine');
  const content = JSON.stringify(manifest()); const original = globalThis.fetch; globalThis.fetch = (async () => new Response(content)) as typeof fetch; t.after(() => { globalThis.fetch = original; });
  await assert.rejects(syncModpack({ id: randomUUID(), name: 'test', minecraft: '1.20.1', loader: 'fabric', loaderVersion: '0.16.14', installed: true }, root, 'https://cdn.modrinth.com/manifest', sha(content), ['cdn.modrinth.com'], true, new AbortController().signal, () => {}), /pessoal/);
  assert.equal(await readFile(join(root, 'mods/test.jar'), 'utf8'), 'mine');
});
test('modpack journal supports updates and removes only unchanged managed files with authorization', async t => {
  const root = await temp(t); const old = globalThis.fetch; let current = manifest();
  globalThis.fetch = (async input => String(input).endsWith('/manifest') ? new Response(JSON.stringify(current)) : new Response('good')) as typeof fetch; t.after(() => { globalThis.fetch = old; });
  const instance = { id: randomUUID(), name: 'test', minecraft: '1.20.1', loader: 'fabric' as const, loaderVersion: '0.16.14', installed: true };
  const sync = (allow: boolean) => syncModpack(instance, root, 'https://cdn.modrinth.com/manifest', sha(JSON.stringify(current)), ['cdn.modrinth.com'], allow, new AbortController().signal, () => {});
  await sync(false); assert.equal(await readFile(join(root, 'mods/test.jar'), 'utf8'), 'good');
  await writeFile(join(root, 'mods/personal.jar'), 'personal'); current = { ...current, version: '2.0.0', files: [] };
  await sync(false); assert.equal(await readFile(join(root, 'mods/test.jar'), 'utf8'), 'good');
  await sync(true); await assert.rejects(readFile(join(root, 'mods/test.jar')), { code: 'ENOENT' }); assert.equal(await readFile(join(root, 'mods/personal.jar'), 'utf8'), 'personal');
});
test('community contract requires typed plain content and safe URLs', () => {
  assert.throws(() => communitySchema.parse({ schemaVersion: 1, news: [{ title: 'hi', body: 'body', date: 'invalid', url: 'javascript:alert(1)' }] }));
  assert.equal(communitySchema.parse({ schemaVersion: 1, news: [] }).news.length, 0);
});
test('logs redact credentials and JWTs', () => { const output = redact('Bearer secret access_token: abc refresh_token=def --accessToken ghijk'); assert.ok(!output.includes('secret')); assert.ok(!output.includes('abc')); assert.ok(!output.includes('def')); assert.ok(!output.includes('ghijk')); });
test('Java requirements follow metadata and supported historical versions', () => { assert.equal(javaRequirement({ javaVersion: { majorVersion: 25 } }, '26.1'), 25); assert.equal(javaRequirement({}, '1.16.5'), 8); assert.equal(javaRequirement({}, '1.17.1'), 16); assert.equal(javaRequirement({}, '1.20.1'), 17); assert.equal(javaRequirement({}, '1.20.5'), 21); });
test('invalid Java executable is rejected without shell evaluation', async () => { await assert.rejects(probeJava('nonexistent-matrix-java')); });
test('Java runtime symbolic links are accepted only when their targets stay inside the runtime directory', () => {
  assert.equal(runtimeSymlinkTarget('/runtime', 'lib/alias.so', 'real.so'), 'real.so');
  assert.throws(() => runtimeSymlinkTarget('/runtime', 'lib/alias.so', '../../../outside'), /escapes/);
  assert.throws(() => runtimeSymlinkTarget('/runtime', '../outside', 'file'), /path/i);
});
test('Linux data and state paths follow absolute XDG directories with standard defaults', () => {
  assert.equal(linuxDataDirectory({}, '/home/player'), '/home/player/.local/share/matrix-launcher');
  assert.equal(linuxStateDirectory({}, '/home/player'), '/home/player/.local/state/matrix-launcher');
  assert.equal(linuxDataDirectory({ XDG_DATA_HOME: '/mnt/data' }, '/home/player'), '/mnt/data/matrix-launcher');
  assert.equal(linuxDataDirectory({ XDG_DATA_HOME: 'relative' }, '/home/player'), '/home/player/.local/share/matrix-launcher');
});
