import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { ModLibraryService } from '../electron/services/mod-library.ts';
import { setNetworkTransport } from '../electron/services/download.ts';

function crc32(buffer: Buffer) { let crc = 0xffffffff; for (const byte of buffer) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; }
function jar(entries: Record<string, string>) {
  const locals: Buffer[] = []; const central: Buffer[] = []; let offset = 0;
  for (const [filename, text] of Object.entries(entries)) {
    const name = Buffer.from(filename); const raw = Buffer.from(text); const compressed = deflateRawSync(raw); const crc = crc32(raw);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(8, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(name.length, 26);
    locals.push(local, name, compressed);
    const dir = Buffer.alloc(46); dir.writeUInt32LE(0x02014b50); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(0x800, 8); dir.writeUInt16LE(8, 10); dir.writeUInt32LE(crc, 16); dir.writeUInt32LE(compressed.length, 20); dir.writeUInt32LE(raw.length, 24); dir.writeUInt16LE(name.length, 28); dir.writeUInt32LE(offset, 42);
    central.push(dir, name); offset += local.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(entries).length, 8); end.writeUInt16LE(Object.keys(entries).length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

test('Mod Library hashes, identifies Fabric metadata, deduplicates, applies isolated copies and preserves edited files', async t => {
  const base = await mkdtemp(join(tmpdir(), 'matrix-mod-library-')); t.after(() => rm(base, { recursive: true, force: true }));
  const instanceId = randomUUID(); const instanceRoot = join(base, 'instances', instanceId); await mkdir(join(instanceRoot, 'mods'), { recursive: true });
  const instance = { id: instanceId, name: 'Fabric test', minecraft: '1.21.1', loader: 'fabric', loaderVersion: '0.16.0', installed: true } as const;
  const service = new ModLibraryService(join(base, 'user-data', 'mod-library'), () => [instance as never], () => base);
  const payload = jar({ 'fabric.mod.json': JSON.stringify({ schemaVersion: 1, id: 'samplemod', version: '1.2.3', name: 'Sample Mod', depends: { minecraft: '~1.21.1', fabricloader: '>=0.15.0' } }) });
  const source = join(base, 'samplemod.jar'); const duplicate = join(base, 'copy.jar'); await writeFile(source, payload); await writeFile(duplicate, payload);
  const scan = await service.scanFiles([source, duplicate], () => {}, new AbortController().signal); assert.equal(scan.candidates[0].name, 'Sample Mod'); assert.equal(scan.candidates[0].metadata, 'fabric'); assert.equal(scan.candidates[0].hash, createHash('sha256').update(payload).digest('hex')); assert.equal(scan.candidates[1].duplicate, true);
  await service.commitImport(scan.jobId, [scan.candidates[0].hash], new AbortController().signal, () => {});
  const duplicateScan = await service.scanFiles([duplicate], () => {}, new AbortController().signal); assert.equal(duplicateScan.candidates[0].duplicate, true);
  const collection = await service.createCollection({ name: 'Otimização', description: '', hashes: [scan.candidates[0].hash] });
  await assert.rejects(service.remove(scan.candidates[0].hash), /coleções/);
  assert.equal(await service.findContent({ kind: 'mod', size: payload.length, hash: scan.candidates[0].hash, algorithm: 'sha256' } as never), join(base, 'user-data', 'mod-library', 'objects', `${scan.candidates[0].hash}.jar`));
  const pack = await service.createModpack({ instanceId, name: 'Pack pessoal', summary: 'Teste', hashes: [scan.candidates[0].hash] }); const manifest = join(base, 'pack.matrixpack'); await service.exportModpack(pack.id, 'matrixpack', manifest);
  const importedPack = await service.importModpack(manifest, new AbortController().signal, () => {}); assert.equal(importedPack.name, pack.name);
  await assert.rejects(service.exportModpack(pack.id, 'mrpack', join(base, 'pack.mrpack')), /origem autorizada/);
  await service.deleteCollection(collection.id);
  const plan = await service.planApply(instanceId, [scan.candidates[0].hash], true); await service.apply(plan.planId, new AbortController().signal, () => {});
  const copied = join(instanceRoot, 'mods', 'samplemod.jar'); assert.deepEqual(await readFile(copied), payload); assert.ok((await service.list()).mods[0].usedBy.includes(instance.name));
  await writeFile(copied, 'player edit'); await service.removeFromInstance(instanceId, scan.candidates[0].hash); assert.equal(await readFile(copied, 'utf8'), 'player edit');
  assert.deepEqual((await service.list()).mods[0].usedBy, []);
  await assert.rejects(service.remove(scan.candidates[0].hash), /modpacks/);
});

test('Mod Library marks a corrupt JAR invalid without executing or importing it', async t => {
  const base = await mkdtemp(join(tmpdir(), 'matrix-mod-library-invalid-')); t.after(() => rm(base, { recursive: true, force: true }));
  const instanceId = randomUUID(); await mkdir(join(base, 'instances', instanceId), { recursive: true }); const instance = { id: instanceId, name: 'Forge', minecraft: '1.20.1', loader: 'forge', loaderVersion: '47.0.0', installed: true };
  const service = new ModLibraryService(join(base, 'library'), () => [instance as never], () => base); const corrupt = join(base, 'bad.jar'); await writeFile(corrupt, 'not a zip');
  const scan = await service.scanFiles([corrupt], () => {}, new AbortController().signal); assert.equal(scan.candidates[0].valid, false);
});

test('Mod Library saves Modrinth files and exports/imports a verified .mrpack manifest', async t => {
  const base = await mkdtemp(join(tmpdir(), 'matrix-mrpack-')); t.after(() => rm(base, { recursive: true, force: true }));
  const payload = jar({ 'fabric.mod.json': JSON.stringify({ schemaVersion: 1, id: 'remotemod', version: '2.0', name: 'Remote Mod', depends: { minecraft: '1.21.1' } }) }); const id = randomUUID();
  const fetch = globalThis.fetch; setNetworkTransport((async () => new Response(payload)) as typeof fetch); t.after(() => setNetworkTransport(fetch));
  const item = { projectId: 'remotemod', slug: 'remotemod', title: 'Remote Mod', versionId: 'v2', version: '2.0', kind: 'mod', filename: 'remotemod.jar', url: 'https://cdn.modrinth.com/data/remotemod/versions/v2/remotemod.jar', hash: createHash('sha512').update(payload).digest('hex'), algorithm: 'sha512', size: payload.length, license: 'MIT', sourceUrl: 'https://modrinth.com/mod/remotemod' } as const;
  const instance = { id, name: 'Fabric 1.21', minecraft: '1.21.1', loader: 'fabric', loaderVersion: '0.16.0', installed: true };
  const first = new ModLibraryService(join(base, 'library-a'), () => [instance as never], () => base); await first.saveModrinth([item as never], new AbortController().signal, () => {});
  const library = await first.list(); assert.equal(library.mods[0].source?.projectId, item.projectId);
  const pack = await first.createModpack({ instanceId: id, name: 'Distribuível', summary: '', hashes: [library.mods[0].hash] }); const file = join(base, 'export.mrpack'); await first.exportModpack(pack.id, 'mrpack', file);
  const second = new ModLibraryService(join(base, 'library-b'), () => [], () => base); const imported = await second.importModpack(file, new AbortController().signal, () => {});
  assert.equal(imported.name, pack.name); assert.equal((await second.list()).mods[0].hash, library.mods[0].hash);
});
