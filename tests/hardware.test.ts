import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { tmpdir, totalmem, arch } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaults } from '../electron/services/store.ts';
import { detectHardware, diskAvailable, parseWindowsHardware, presetPreferences, recommendHardware } from '../electron/services/hardware.ts';
import { smartPreferencesSchema, type Hardware } from '../shared/smart.ts';
const GB = 1024 ** 3;
const hardware = (): Hardware => ({ cpu: { model: 'test', cores: 8, threads: 16 }, memory: { total: 32 * GB, available: 20 * GB }, gpus: [{ name: 'test', integrated: false, vram: 8 * GB }], os: 'test', arch: 'x64', java: [], warnings: [] });

test('CIM parser sums physical cores, identifies GPU conservatively and never invents VRAM', () => {
  const parsed = parseWindowsHardware(JSON.stringify({ cpus: [{ name: 'CPU', cores: 4, threads: 8 }, { name: 'CPU', cores: 4, threads: 8 }], gpus: [{ name: 'NVIDIA GeForce RTX 3070' }, { name: 'Intel UHD Graphics' }, { name: 'Unknown adapter' }], os: 'Windows', architecture: '64-bit' }));
  assert.equal(parsed.cpu.cores, 8); assert.equal(parsed.cpu.threads, 16);
  assert.equal(parsed.gpus[0].integrated, false); assert.equal(parsed.gpus[1].integrated, true); assert.equal(parsed.gpus[2].integrated, undefined);
  assert.ok(parsed.gpus.every(g => g.vram === undefined));
  assert.throws(() => parseWindowsHardware('{"cpus":"bad"}'));
});
test('recommendations consider CPU, GPU and free RAM, preserve raw data and allow estimates', () => {
  const h = hardware(); assert.equal(recommendHardware(h).preset, 'ultra');
  assert.equal(recommendHardware({ ...h, cpu: { model: 'weak', cores: 2, threads: 4 } }).preset, 'performance');
  assert.equal(recommendHardware({ ...h, gpus: [{ name: 'unknown' }] }).preset, 'performance');
  assert.equal(recommendHardware({ ...h, gpus: [{ name: 'integrated', integrated: true }] }).preset, 'balanced');
  assert.equal(recommendHardware({ ...h, memory: { total: 32 * GB, available: 2 * GB } }).preset, 'performance');
  const raw = JSON.stringify(h); const manual = recommendHardware(h, { gpu: 'unknown' });
  assert.equal(manual.shadersSuggested, false); assert.equal(JSON.stringify(h), raw); assert.ok(manual.reasons.some(s => s.includes('manuais')));
  assert.throws(() => recommendHardware(h, { cpuThreads: -1 }));
});
test('presets respect a conservative memory budget and valid Minecraft options', () => {
  const h = hardware(); h.memory = { total: 4 * GB, available: 2 * GB };
  for (const preset of ['performance', 'balanced', 'ultra'] as const) {
    const preferences = presetPreferences(preset, h); smartPreferencesSchema.parse(preferences);
    assert.ok(preferences.maxMemory <= 1280); assert.ok(preferences.minMemory <= preferences.maxMemory);
  }
  assert.equal(presetPreferences('performance', hardware()).graphics, 'fast');
  assert.equal(recommendHardware({ ...hardware(), gpus: [{ name: 'dedicated', integrated: false }] }).shadersSuggested, false);
});
test('disk detection checks nearest existing ancestor without creating directories', async () => {
  const missing = join(tmpdir(), `matrix-hardware-${randomUUID()}`, 'instance');
  const free = await diskAvailable(missing); assert.equal(existsSync(missing), false); assert.ok(free !== undefined && free >= 0);
});
test('real local hardware detection reports OS memory, architecture and Java discovery safely', { timeout: 45000 }, async () => {
  const settings = defaults(tmpdir()).settings; const h = await detectHardware(settings);
  assert.equal(h.memory.total, totalmem()); assert.equal(h.arch, arch()); assert.ok(h.cpu.threads > 0); assert.ok(h.memory.available > 0);
  assert.ok(h.diskAvailable !== undefined); assert.ok(h.java.every(j => j.major > 0));
  assert.ok(h.gpus.every(g => g.vram === undefined));
});
