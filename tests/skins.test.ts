import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, readdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PNG } from 'pngjs';
import { SkinLibrary, decodeSkinPNG, encodeSkinPNG, decodePreviewPNG } from '../electron/services/skins.ts';
import { normalizePixels } from '../shared/skin-pixels.ts';
import type { SkinDocument } from '../shared/skin.ts';

async function temp(t: { after(fn: () => Promise<void>): void }) { const root = await mkdtemp(join(tmpdir(), 'matrix-skins-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }
function document(): SkinDocument { const pixels = normalizePixels(new Uint8ClampedArray(64 * 64 * 4), 'classic'); return { name: 'Minha skin', model: 'classic', pixels: Buffer.from(pixels).toString('base64'), palette: ['#aabbcc'] }; }
function png(width: number, height: number): Buffer { return PNG.sync.write({ width, height, data: Buffer.alloc(width * height * 4, 255) } as PNG); }

test('skin PNG import/export validates dimensions, CRC, completeness and file limits', () => {
  const original = document(); const exported = encodeSkinPNG(original); const result = decodeSkinPNG(exported);
  assert.equal(result.pixels, original.pixels); assert.equal(PNG.sync.read(exported).width, 64);
  assert.throws(() => decodeSkinPNG(png(128, 64)), /64/);
  assert.throws(() => decodeSkinPNG(Buffer.alloc(1024 * 1024 + 1)), /limite/);
  const corrupt = Buffer.from(exported); corrupt[29] ^= 1; assert.throws(() => decodeSkinPNG(corrupt), /corrompido/);
  assert.throws(() => decodeSkinPNG(exported.subarray(0, -3)), /incompleto/);
  const preview = decodePreviewPNG(`data:image/png;base64,${png(16, 16).toString('base64')}`); assert.equal(PNG.sync.read(preview).height, 16);
  assert.throws(() => decodePreviewPNG(png(2049, 1).toString('base64')), /2048/);
});

test('legacy 64×32 import converts into a modern classic skin without smoothing', () => {
  const source = PNG.sync.read(png(64, 32)); source.data[(8 * 64 + 8) * 4] = 17;
  const converted = decodeSkinPNG(PNG.sync.write(source), 'slim');
  assert.equal(converted.model, 'classic'); assert.equal(Buffer.from(converted.pixels, 'base64').length, 16384);
  assert.equal(Buffer.from(converted.pixels, 'base64')[(8 * 64 + 8) * 4], 17);
  assert.equal(PNG.sync.read(encodeSkinPNG(converted)).height, 64);
});

test('library persists, renames, duplicates and serializes conflicting revisions', async t => {
  const root = await temp(t); const library = new SkinLibrary(root); const project = await library.save({ document: document() });
  assert.equal((await new SkinLibrary(root).open(project.id)).name, 'Minha skin');
  const results = await Promise.allSettled([library.save({ id: project.id, revision: project.revision, document: { ...document(), name: 'Primeira alteração' } }), library.save({ id: project.id, revision: project.revision, document: { ...document(), name: 'Desatualizada' } })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const renamed = await library.rename(project.id, 'Renomeada'); assert.equal(renamed.name, 'Renomeada');
  const copy = await library.duplicate(project.id); assert.notEqual(copy.id, project.id); assert.equal(copy.pixels, renamed.pixels);
  const entries = await library.list(); assert.equal(entries.length, 2); assert.ok(entries[0].thumbnail.startsWith('data:image/png;base64,'));
  assert.equal((await readdir(root)).filter(f => f.endsWith('.tmp')).length, 0);
});

test('library recovers valid backups and never resurrects deleted projects', async t => {
  const root = await temp(t); const library = new SkinLibrary(root); let project = await library.save({ document: document() });
  project = await library.rename(project.id, 'Depois'); await writeFile(join(root, `${project.id}.json`), '{broken');
  const recovered = await library.open(project.id); assert.equal(recovered.name, 'Minha skin');
  assert.equal(JSON.parse(await readFile(join(root, `${project.id}.json`), 'utf8')).name, 'Minha skin');
  await library.delete(project.id); assert.equal((await library.list()).length, 0); await assert.rejects(library.open(project.id), /encontrada/);
  assert.ok((await readdir(join(root, 'trash'))).length >= 1);
});

test('draft autosave is recoverable, bounded and ordered; clear removes its recovery copy', async t => {
  const root = await temp(t); const library = new SkinLibrary(root); assert.equal(await library.getDraft(), undefined);
  await library.saveDraft({ document: document(), savedAt: 10 }); await library.saveDraft({ document: { ...document(), name: 'Nova' }, savedAt: 20 });
  await assert.rejects(library.saveDraft({ document: document(), savedAt: 15 }), /desatualizado/);
  await writeFile(join(root, 'draft.json'), 'broken'); assert.equal((await library.getDraft())?.savedAt, 10);
  await library.clearDraft(); assert.equal(await library.getDraft(), undefined);
  await assert.rejects(library.save({ document: { ...document(), pixels: 'oversized' } }));
});

test('skin file access rejects traversal IDs and redirected roots', async t => {
  const root = await temp(t); const library = new SkinLibrary(root);
  for (const id of ['../secret', 'C:/file', '/etc/passwd']) await assert.rejects(library.open(id));
  const outside = await temp(t); await symlink(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(new SkinLibrary(join(root, 'linked')).save({ document: document() }), /Links/);
  assert.equal((await readdir(outside)).length, 0);
});
