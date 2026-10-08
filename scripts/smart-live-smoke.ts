import { resolve, join } from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { launch } from '@xmcl/core';
import { Store, addOffline } from '../electron/services/store.ts';
import { Minecraft, instanceDirectory } from '../electron/services/minecraft.ts';
import { SmartInstallService } from '../electron/services/smart-install.ts';
import { detectHardware, recommendHardware } from '../electron/services/hardware.ts';
import { setNetworkTransport } from '../electron/services/download.ts';
import { nativeHttpsFetch } from '../electron/services/http.ts';
import type { SmartPreset } from '../shared/smart.ts';

setNetworkTransport(nativeHttpsFetch);
const evidence = resolve('.smoke/smart'); await mkdir(evidence, { recursive: true });
const store = new Store(join(evidence, 'settings.json'), resolve('.smoke/live-game')); await store.load();
const logs: string[] = []; const game = new Minecraft(() => {}, line => { logs.push(line); if (logs.length > 300) logs.shift(); }, options => launch({ ...options, demo: true, extraExecOption: { ...options.extraExecOption, stdio: 'pipe' } }));
const service = new SmartInstallService(store, game); let last = 0;
const progress = (label: string, bytes: number, total: number) => { if (Date.now() - last > 15000) { console.log(`${label}: ${(bytes / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB`); last = Date.now(); } };
const signal = AbortSignal.timeout(25 * 60_000);
try {
  const hardware = await detectHardware(store.data.settings); const recommendation = recommendHardware(hardware);
  await writeFile(join(evidence, 'hardware.json'), JSON.stringify({ hardware, recommendation }, null, 2));
  let instance = store.data.instances.find(i => i.smart);
  if (!instance) {
    const plan = await service.plan({ name: 'Smart Install live validation', preset: 'balanced' as SmartPreset, mods: ['sodium', 'lithium', 'ferrite-core', 'immediatelyfast', 'entityculling', 'modernfix', 'modmenu', 'iris'], shaderProject: 'complementary-reimagined', preferences: { ...recommendation.preferences, minMemory: 512, maxMemory: Math.min(2048, recommendation.preferences.maxMemory) } }, signal);
    await writeFile(join(evidence, 'plan.json'), JSON.stringify(plan, null, 2));
    const id = await service.install(plan.id, true, signal, progress); instance = store.data.instances.find(i => i.id === id)!;
  } else if (instance.smart?.status === 'interrupted') { const plan = await service.update(instance.id, signal, progress); await writeFile(join(evidence, 'plan.json'), JSON.stringify(plan, null, 2)); await service.install(plan.id, true, signal, progress); }
  else if (!process.argv.includes('--launch-only')) await service.resume(instance.id, true, signal, progress);
  await service.inspect(instance.id); await game.inspect(instance, store.data.settings);
  const content = await service.content(instance.id); console.log(`Verified ${content.mods.length} mod JARs and ${content.shaders.length} shaderpacks.`);
  let launched = false; let clientStarted = false;
  if (process.argv.includes('--launch') || process.argv.includes('--launch-only')) {
    let account = store.data.accounts.find(a => a.kind === 'offline'); account ??= addOffline(store.data, 'MatrixSmartTest'); await store.save();
    await game.play(instance, store.data.settings, account, undefined, false);
    for (let seconds = 0; seconds < 300; seconds += 5) {
      await delay(5000);
      if (game.game.status !== 'running') throw new Error(`Minecraft exited early (${game.game.exitCode}): ${logs.slice(-12).join('')}`);
      const text = await readFile(join(instanceDirectory(store.data.settings, instance), 'logs/latest.log'), 'utf8').catch(() => logs.join(''));
      if (/Sound engine started|Created:.*(?:atlas|texture)|Backend library:/i.test(text)) { clientStarted = true; console.log('Client initialization observed in real game logs.'); break; }
      if (seconds % 20 === 0) console.log(`Waiting for first Fabric client startup (${seconds + 5}s)...`);
    }
    launched = true; game.stop(); await delay(2000);
    console.log(`Real Fabric/modded demo process stopped; client initialized: ${clientStarted}. Rendering/gameplay still needs manual validation.`);
    if (!clientStarted) throw new Error('Client startup was not observed within 300s; inspect the captured game log.');
  }
  await writeFile(join(evidence, 'validation.json'), JSON.stringify({ timestamp: new Date().toISOString(), minecraft: instance.minecraft, fabric: instance.loaderVersion, java: 21, instanceId: instance.id, mods: content.mods.map(f => ({ slug: f.slug, version: f.version, algorithm: f.algorithm })), shaders: content.shaders.map(f => ({ slug: f.slug, version: f.version })), activeShader: content.activeShader, integrity: true, internalDependencies: true, launched, clientStarted }, null, 2));
} finally { game.stop(); await writeFile(join(evidence, 'game.log'), logs.join('\n')); }
