import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { Store } from '../electron/services/store.ts';
import { ContentCatalog } from '../electron/services/catalog.ts';
import { SmartInstallService } from '../electron/services/smart-install.ts';
import { Minecraft, instanceDirectory } from '../electron/services/minecraft.ts';
import { applyPreferences, selectShader, activeShader } from '../electron/services/smart-config.ts';
import { readFabricMetadata, validateFabricDependencies, validateShaderArchive, matchesPredicate } from '../electron/services/content-validation.ts';
import { setNetworkTransport } from '../electron/services/download.ts';
import type { ContentFile, SmartRequest } from '../shared/smart.ts';

function zip(files: Record<string, string | Buffer>): Buffer {
  const local: Buffer[] = []; const central: Buffer[] = []; let offset = 0;
  for (const [name, input] of Object.entries(files)) {
    const filename = Buffer.from(name); const data = Buffer.from(input); const checksum = crc32(data);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt32LE(checksum, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, data);
    const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt32LE(checksum, 16); record.writeUInt32LE(data.length, 20); record.writeUInt32LE(data.length, 24); record.writeUInt16LE(filename.length, 28); record.writeUInt32LE(offset, 42); central.push(record, filename); offset += header.length + filename.length + data.length;
  }
  const directory = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
const prefs = { minMemory: 512, maxMemory: 1024, renderDistance: 8, simulationDistance: 5, particles: 'minimal' as const, graphics: 'fast' as const, maxFps: 120 };
const request: SmartRequest = { name: 'Smart fixture', preset: 'performance', mods: ['sodium', 'iris'], preferences: prefs };
const jar = (id: string, version = '1.0.0', depends: Record<string,string> = {}) => zip({ 'fabric.mod.json': JSON.stringify({ schemaVersion: 1, id, version, environment: 'client', depends: { minecraft: '~1.21.1', java: '>=21', fabricloader: '>=0.16.0', ...depends } }) });
function file(slug: string, data: Buffer, kind: 'mod' | 'shader' = 'mod'): ContentFile { return { projectId: slug, slug, title: slug, versionId: `${slug}Version`, version: '1.0.0', kind, filename: `${slug}.${kind === 'mod' ? 'jar' : 'zip'}`, url: `https://cdn.modrinth.com/data/${slug}/versions/${slug}Version/${slug}.${kind === 'mod' ? 'jar' : 'zip'}`, hash: createHash('sha512').update(data).digest('hex'), algorithm: 'sha512', size: data.length, license: 'MIT', sourceUrl: `https://modrinth.com/${kind}/${slug}` }; }
test('Fabric JAR reader handles nested modules, constraints and conflicts; shader traversal is refused', async t => {
  const root = await mkdtemp(join(tmpdir(), 'matrix-jars-')); t.after(() => rm(root, { recursive: true, force: true }));
  const nested = jar('nested_module'); const packed = zip({ 'fabric.mod.json': JSON.stringify({ schemaVersion: 1, id: 'parent_mod', version: '1.0.0', depends: { nested_module: '*' }, jars: [{ file: 'META-INF/jars/module.jar' }] }), 'META-INF/jars/module.jar': nested });
  const mods = await readFabricMetadata(packed); assert.equal(mods.length, 2); validateFabricDependencies(mods, '0.19.5');
  assert.equal(matchesPredicate('1.21.1', '>=1.15-alpha.19.39.a'), true);
  assert.equal(matchesPredicate('1.21.1', '>=1.21- <1.21.2-'), true);
  assert.equal(matchesPredicate('1.21.2', '>=1.21- <1.21.2-'), false);
  validateFabricDependencies([...mods, { ...mods[1], version: '1.1.0', nested: true }], '0.19.5');
  assert.throws(() => validateFabricDependencies([{ ...mods[1], nested: false }, { ...mods[1], version: '1.1.0', nested: false }], '0.19.5'), /duplicado/);
  assert.throws(() => validateFabricDependencies(mods, '0.15.0'), /exige/);
  assert.throws(() => validateFabricDependencies([{ ...mods[0], breaks: { nested_module: '*' } }, mods[1]], '0.19.5'), /Incompatibilidade/);
  const unsafe = join(root, 'unsafe.zip'); await writeFile(unsafe, zip({ '../shaders/payload.fsh': 'x' })); await assert.rejects(validateShaderArchive(unsafe));
});
test('configuration merging makes backups and preserves worlds, user settings and Iris properties', async t => {
  const root = await mkdtemp(join(tmpdir(), 'matrix-config-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'config')); await mkdir(join(root, 'saves')); await writeFile(join(root, 'saves/world.dat'), 'world');
  await writeFile(join(root, 'options.txt'), 'fullscreen:true\nrenderDistance:24\nkey_key.forward:key.keyboard.z\n');
  await writeFile(join(root, 'config/iris.properties'), 'maxShadowRenderDistance=12\nenableShaders=false\n');
  await applyPreferences(root, prefs); await selectShader(root, 'Shader verão.zip');
  assert.match(await readFile(join(root, 'options.txt'), 'utf8'), /fullscreen:true/); assert.match(await readFile(join(root, 'options.txt'), 'utf8'), /renderDistance:8/);
  assert.match(await readFile(join(root, 'config/iris.properties'), 'utf8'), /maxShadowRenderDistance=12/); assert.equal(await activeShader(root), 'Shader verão.zip');
  await selectShader(root); assert.equal(await activeShader(root), undefined); assert.equal(await readFile(join(root, 'saves/world.dat'), 'utf8'), 'world'); assert.ok((await readdir(join(root, '.matrix-backups'))).length >= 3);
});
test('Smart Install persists interrupted plans, resumes SHA512 downloads, isolates instances and protects dependencies', async t => {
  const root = await mkdtemp(join(tmpdir(), 'matrix-smart-')); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, 'settings.json'), join(root, 'games')); await store.load();
  const sodium = jar('sodium'); const iris = jar('iris', '1.0.0', { sodium: '>=1.0.0' }); const shader = zip({ 'shaders/test.fsh': 'void main() {}' });
  const contents = [file('sodium', sodium), file('iris', iris)]; const shaderFile = file('testshader', shader, 'shader');
  const responses = new Map([[contents[0].url, sodium], [contents[1].url, iris], [shaderFile.url, shader]]);
  const incompatibleJar = zip({ 'fabric.mod.json': JSON.stringify({ schemaVersion: 1, id: 'sodium', version: '2.0.0', breaks: { iris: '<2.0.0' } }) });
  const incompatibleFile: ContentFile = { ...file('sodium', incompatibleJar), versionId: 'sodiumNew', version: '2.0.0', url: 'https://cdn.modrinth.com/data/sodium/versions/sodiumNew/sodium.jar' };
  responses.set(incompatibleFile.url, incompatibleJar);
  let interrupted = false;
  setNetworkTransport((async (input, init) => {
    const data = responses.get(String(input)); if (!data) throw Error('unexpected URL');
    if (String(input) === contents[1].url && interrupted) throw Object.assign(new Error('User cancellation'), { name: 'AbortError' });
    init?.signal?.throwIfAborted(); return new Response(Uint8Array.from(data).buffer);
  }) as typeof fetch);
  t.after(() => setNetworkTransport((input, init) => globalThis.fetch(input, init)));
  class Catalog extends ContentCatalog { async fabric() { return '0.19.5'; } async resolveMods(_slugs: string[], _signal?: AbortSignal, rejected?: ReadonlySet<string>) { return rejected?.has(incompatibleFile.versionId) ? contents : [incompatibleFile, contents[1]]; } async resolveShader() { return shaderFile; } }
  const minecraft = { metadata: async () => ({ id: '1.21.1', javaVersion: { majorVersion: 21, component: 'java-runtime-delta' } }), install: async (i: {id:string}) => { if (interrupted) throw Object.assign(new Error('User cancellation'), {name:'AbortError'}); await mkdir(join(store.data.settings.gameDirectory, 'instances', i.id, 'mods'), { recursive: true }); return 'fabric-1.21.1'; }, inspect: async () => {} } as unknown as Minecraft;
  const runtime = { detectJava: async () => [{ path: 'fixture-java', major: 21 }], probeJava: async () => ({ path: 'fixture-java', major: 21 }), installJava: async () => { throw Error('Java should be reused'); } };
  const service = new SmartInstallService(store, minecraft, new Catalog(), runtime);
  const plan = await service.plan(request); assert.equal(plan.java.installRequired, false);
  assert.equal(plan.files[0].version, '1.0.0'); assert.match(plan.warnings.join(' '), /recusado.*sodium.*iris/i);
  interrupted = true;
  await assert.rejects(service.install(plan.id, false, new AbortController().signal, () => {}), /cancellation/);
  const i = store.data.instances[0]; assert.equal(i.smart?.status, 'interrupted'); assert.equal(i.installed, false);
  interrupted = false; const restarted = new SmartInstallService(store, minecraft, new Catalog(), runtime); await restarted.resume(i.id, false, new AbortController().signal, () => {});
  assert.equal(i.smart?.status, 'ready'); const dir = instanceDirectory(store.data.settings, i); assert.deepEqual(await readFile(join(dir, 'mods/sodium.jar')), sodium);
  await assert.rejects(restarted.toggleMod(i.id, 'sodium', false), /iris exige sodium/); await restarted.toggleMod(i.id, 'iris', false); await restarted.toggleMod(i.id, 'sodium', false);
  const shaderPlan = await restarted.shaderPlan(i.id, 'testshader'); await restarted.install(shaderPlan.id, false, new AbortController().signal, () => {});
  assert.ok((await restarted.content(i.id)).mods.every(f => f.enabled !== false));
  await restarted.installShader(i.id, 'testshader', new AbortController().signal, () => {}); await restarted.selectShader(i.id, shaderFile.filename); assert.equal((await restarted.content(i.id)).activeShader, 'testshader.zip');
  const second = await restarted.plan({ ...request, name: 'Second' }); const secondId = await restarted.install(second.id, false, new AbortController().signal, () => {}); assert.notEqual(secondId, i.id); assert.equal((await restarted.content(secondId)).activeShader, undefined);
  await mkdir(join(dir, 'saves')); await writeFile(join(dir, 'saves/world.dat'), 'keep'); await writeFile(join(dir, 'mods/personal.txt'), 'keep'); await restarted.configure(i.id, { ...prefs, renderDistance: 6 });
  await restarted.deleteShader(i.id, shaderFile.filename); assert.equal((await restarted.content(i.id)).activeShader, undefined); assert.equal(await readFile(join(dir, 'saves/world.dat'), 'utf8'), 'keep');
  await writeFile(join(dir, 'mods/sodium.jar'), 'user edited'); await assert.rejects(restarted.resume(i.id, false, new AbortController().signal, () => {}), /pessoal|alterado/); assert.equal(await readFile(join(dir, 'mods/sodium.jar'), 'utf8'), 'user edited');
});
