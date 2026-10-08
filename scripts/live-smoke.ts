import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { launch } from '@xmcl/core';
import { Minecraft } from '../electron/services/minecraft.ts';
import { defaults, addOffline } from '../electron/services/store.ts';
import { installJava, javaRequirement } from '../electron/services/java.ts';
import { nativeHttpsFetch } from '../electron/services/http.ts';
import { setNetworkTransport } from '../electron/services/download.ts';
setNetworkTransport(nativeHttpsFetch);
const root = resolve('.smoke/live-game'); await mkdir(root, { recursive: true });
const data = defaults(root); const account = addOffline(data, 'MatrixTest');
const instance = { id: 'b4018713-6bfc-4bcf-8baa-9ae6050829e0', name: 'Live smoke', minecraft: '1.20.1', loader: 'vanilla' as const, loaderVersion: '', installed: false, versionId: '1.20.1' };
const log: string[] = []; let last = 0;
const minecraft = new Minecraft(() => {}, message => { log.push(message); if (log.length > 200) log.shift(); }, options => launch({ ...options, demo: true }));
const progress = (label: string, bytes: number, total: number) => { if (Date.now() - last > 15000) { console.log(`${label}: ${(bytes / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB`); last = Date.now(); } };
const signal = AbortSignal.timeout(12 * 60 * 1000);
try {
  instance.versionId = await minecraft.install(instance, data.settings, signal, progress); instance.installed = true;
  console.log('Minecraft 1.20.1 downloaded and hashes verified.');
  const info = await minecraft.localMetadata(instance, data.settings); const major = javaRequirement(info, instance.minecraft);
  data.settings.javaPath = await installJava(join(root, 'runtimes'), info.javaVersion!.component, major, signal, (b,t,s) => progress(`Java ${major}`, b,t));
  console.log(`Official Java ${major} installed and executable verified.`);
  await minecraft.inspect(instance, data.settings); console.log('Real installation diagnosis passed.');
  if (process.argv.includes('--launch')) {
    await minecraft.play(instance, data.settings, account, undefined, false); await delay(25000);
    if (minecraft.game.status !== 'running') throw new Error(`Minecraft exited early: ${minecraft.game.exitCode}\n${log.slice(-8).join('')}`);
    minecraft.stop(); await delay(1500); console.log('Real Minecraft demo process started, remained running for 25 seconds and stopped.');
  }
  await writeFile(join(root, 'validation.json'), JSON.stringify({ timestamp: new Date().toISOString(), minecraft: instance.minecraft, java: major, downloaded: true, diagnosis: true, launched: process.argv.includes('--launch') }, null, 2));
} finally { minecraft.stop(); await writeFile(join(root, 'game.log'), log.join('\n')); }
