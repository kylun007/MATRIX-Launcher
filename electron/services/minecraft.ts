import { Version, launch, type ResolvedVersion } from '@xmcl/core';
import { diagnoseInstallation } from '@xmcl/installer';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { readdir, readFile, mkdir, writeFile, rename, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type { Account, Instance, Settings, Release, GameState } from '../../shared/contracts.ts';
import { identifier } from '../../shared/contracts.ts';
import { downloadFile, jsonFetch, OFFICIAL_HOSTS, requireSpace, matches, httpsFetch } from './download.ts';
import { noLinks, preparePath, safePath, secureUrl } from './security.ts';
import { detectJava, javaRequirement } from './java.ts';
import { installLoader, installLoaderLibraries, LOADER_HOSTS } from './loaders.ts';

const MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const entrySchema = z.object({ id: z.string().max(120), type: z.string(), url: z.string().url(), sha1: z.string().regex(/^[a-f0-9]{40}$/), releaseTime: z.string() });
const listSchema = z.object({ versions: z.array(entrySchema) });
const fileInfo = z.object({ url: z.string().url(), sha1: z.string().regex(/^[a-f0-9]{40}$/), size: z.number().int().nonnegative() });
const infoSchema = z.object({ id: identifier, javaVersion: z.object({ component: identifier, majorVersion: z.number().int().positive() }).optional(), downloads: z.object({ client: fileInfo }), assetIndex: fileInfo.extend({ id: identifier }), logging: z.object({ client: z.object({ file: fileInfo.extend({ id: identifier }) }) }).optional(), libraries: z.array(z.unknown()) });
const assetsSchema = z.object({ objects: z.record(z.string(), z.object({ hash: z.string().regex(/^[a-f0-9]{40}$/), size: z.number().int().nonnegative() })) });
export function instanceDirectory(settings: Settings, instance: Instance): string { return safePath(settings.gameDirectory, `instances/${instance.id}`); }
export function resourceDirectory(settings: Settings): string {
  return existsSync(join(settings.gameDirectory, 'versions')) ? settings.gameDirectory : safePath(settings.gameDirectory, 'minecraft');
}
export type Transfer = (label: string, bytes: number, total: number, speed: number, detail?: { file: string; filesDone: number; filesTotal: number }) => void;
async function parallel<T>(items: T[], concurrency: number, task: (item: T) => Promise<void>, signal: AbortSignal): Promise<void> {
  let index = 0; let failure: unknown;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length && !failure) { const item = items[index++]; try { signal.throwIfAborted(); await task(item); } catch (e) { failure = e; } }
  })); if (failure) throw failure;
}
export class Minecraft {
  private releasesCache?: z.infer<typeof listSchema>;
  private process?: ChildProcess;
  private stopping = false;
  game: GameState = { status: 'idle' };
  constructor(private changed: () => void, private log: (message: string) => void, private launchGame: typeof launch = launch, private javaDetector: typeof detectJava = detectJava) {}
  async releases(): Promise<Release[]> {
    this.releasesCache = listSchema.parse(await jsonFetch(MANIFEST, undefined, OFFICIAL_HOSTS));
    return this.releasesCache.versions.filter(v => v.type === 'release' && identifier.safeParse(v.id).success).map(v => ({ id: v.id, releaseTime: v.releaseTime }));
  }
  async metadata(instance: Instance, settings: Settings, signal?: AbortSignal): Promise<z.infer<typeof infoSchema>> {
    this.releasesCache ??= listSchema.parse(await jsonFetch(MANIFEST, signal, OFFICIAL_HOSTS));
    const entry = this.releasesCache.versions.find(v => v.id === instance.minecraft && v.type === 'release');
    if (!entry) throw new Error('Versão estável não encontrada no catálogo oficial');
    identifier.parse(entry.id);
    const root = resourceDirectory(settings); const path = await preparePath(root, `versions/${entry.id}/${entry.id}.json`);
    const response = await httpsFetch(entry.url, { signal }, OFFICIAL_HOSTS);
    if (!response.ok) throw new Error('Não foi possível consultar metadados da versão');
    const bytes = Buffer.from(await response.arrayBuffer()); if (bytes.length > 8_000_000) throw new Error('Metadados excedem o limite');
    const { createHash } = await import('node:crypto');
    if (createHash('sha1').update(bytes).digest('hex') !== entry.sha1) throw new Error('Metadados oficiais corrompidos');
    const info = infoSchema.parse(JSON.parse(bytes.toString('utf8'))); if (info.id !== entry.id) throw new Error('Versão dos metadados não corresponde ao catálogo');
    if (!await matches(path, entry.sha1, 'sha1')) { await writeFile(`${path}.tmp`, bytes); await rename(`${path}.tmp`, path); }
    return info;
  }
  async localMetadata(instance: Instance, settings: Settings): Promise<z.infer<typeof infoSchema>> {
    const path = safePath(resourceDirectory(settings), `versions/${instance.minecraft}/${instance.minecraft}.json`);
    return infoSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  }
  async scan(settings: Settings): Promise<string[]> {
    const root = resourceDirectory(settings);
    const entries = await readdir(join(root, 'versions'), { withFileTypes: true }).catch(() => []);
    const found: string[] = [];
    for (const entry of entries) if (entry.isDirectory() && identifier.safeParse(entry.name).success) {
      try { const version = await Version.parse(root, entry.name); if (version.type === 'release' && version.id === version.minecraftVersion) found.push(version.id); } catch { /* Incomplete installations remain repairable. */ }
    } return found;
  }
  private async validateResolved(root: string, version: ResolvedVersion): Promise<void> {
    identifier.parse(version.id); identifier.parse(version.minecraftVersion);
    for (const library of version.libraries) {
      const file = safePath(root, `libraries/${library.download.path}`); await noLinks(root, file);
      if (library.download.url) secureUrl(library.download.url, LOADER_HOSTS);
    }
    if (version.assetIndex) { identifier.parse(version.assetIndex.id); secureUrl(version.assetIndex.url, OFFICIAL_HOSTS); }
  }
  async install(instance: Instance, settings: Settings, signal: AbortSignal, progress: Transfer): Promise<string> {
    const root = resourceDirectory(settings); await requireSpace(root, 1_500_000_000);
    const info = await this.metadata(instance, settings, signal);
    const base = await Version.parse(root, instance.minecraft); await this.validateResolved(root, base);
    type File = { path: string; url: string; hash: string; size: number; hosts: string[] };
    const files: File[] = [{ path: `versions/${info.id}/${info.id}.jar`, url: info.downloads.client.url, hash: info.downloads.client.sha1, size: info.downloads.client.size, hosts: OFFICIAL_HOSTS }];
    if (info.logging?.client) { const log = info.logging.client.file; files.push({ path: `assets/log_configs/${log.id}`, url: log.url, hash: log.sha1, size: log.size, hosts: OFFICIAL_HOSTS }); }
    for (const library of base.libraries) {
      if (!library.download.sha1 || library.download.size < 0) throw new Error('Biblioteca oficial sem metadados de integridade');
      files.push({ path: `libraries/${library.download.path}`, url: library.download.url, hash: library.download.sha1, size: library.download.size, hosts: OFFICIAL_HOSTS });
    }
    const indexFile = await preparePath(root, `assets/indexes/${info.assetIndex.id}.json`);
    await downloadFile({ url: info.assetIndex.url, destination: indexFile, hash: info.assetIndex.sha1, algorithm: 'sha1', size: info.assetIndex.size, hosts: OFFICIAL_HOSTS, signal, progress: (b, t, s) => progress('Índice de recursos', b, t, s) });
    const assets = assetsSchema.parse(JSON.parse(await readFile(indexFile, 'utf8')));
    const hashedIndex = await preparePath(root, `assets/indexes/${info.assetIndex.sha1}.json`);
    if (!await matches(hashedIndex, info.assetIndex.sha1, 'sha1')) await copyFile(indexFile, hashedIndex);
    for (const asset of Object.values(assets.objects)) files.push({ path: `assets/objects/${asset.hash.slice(0, 2)}/${asset.hash}`, url: `https://resources.download.minecraft.net/${asset.hash.slice(0, 2)}/${asset.hash}`, hash: asset.hash, size: asset.size, hosts: OFFICIAL_HOSTS });
    const unique = [...new Map(files.map(f => [f.path, f])).values()]; const total = unique.reduce((s, f) => s + f.size, 0);
    await requireSpace(root, total);
    const current = new Map<string, { bytes: number; speed: number }>();
    let receivedTotal = 0; let speedTotal = 0; let filesDone = 0;
    await parallel(unique, settings.concurrency, async file => {
      const destination = await preparePath(root, file.path);
      await downloadFile({ ...file, destination, algorithm: 'sha1', signal, progress: (bytes, _total, speed) => { const old = current.get(file.path) ?? { bytes: 0, speed: 0 }; receivedTotal += bytes - old.bytes; speedTotal += speed - old.speed; current.set(file.path, { bytes, speed }); progress('Minecraft, bibliotecas e recursos', receivedTotal, total, Math.max(0, speedTotal), { file: file.path, filesDone, filesTotal: unique.length }); } });
      filesDone++;
      const old = current.get(file.path); speedTotal -= old?.speed ?? 0; current.set(file.path, { bytes: file.size, speed: 0 });
    }, signal);
    let versionId = instance.minecraft;
    if (instance.loader !== 'vanilla') {
      progress(`Instalando ${instance.loader}`, 0, 0, 0);
      const java = (await detectJava(join(settings.gameDirectory, 'runtimes'), settings.javaPath)).find(j => j.major === javaRequirement(info, info.id));
      if (instance.loader !== 'fabric' && !java) throw new Error('Instale um Java compatível antes de instalar Forge/NeoForge');
      versionId = await installLoader(instance, root, java?.path, settings, signal, progress);
      identifier.parse(versionId);
      const resolved = await Version.parse(root, versionId); await this.validateResolved(root, resolved);
      await installLoaderLibraries(resolved, root, java?.path, settings, signal, progress);
    }
    const gameDir = instanceDirectory(settings, instance); await noLinks(settings.gameDirectory, gameDir);
    await mkdir(gameDir, { recursive: true });
    for (const dir of ['mods', 'resourcepacks', 'shaderpacks', 'config', 'saves']) await mkdir(await preparePath(gameDir, `${dir}/.matrix-directory`).then(p => join(p, '..')), { recursive: true });
    return versionId;
  }
  async inspect(instance: Instance, settings: Settings): Promise<void> {
    if (!instance.versionId) throw new Error('Minecraft ainda não foi instalado');
    const root = resourceDirectory(settings); const version = await Version.parse(root, instance.versionId);
    await this.validateResolved(root, version);
    if (await diagnoseInstallation(version, { strict: true })) throw new Error('Há arquivos ausentes ou corrompidos. Use Reparar na tela Instalações.');
  }
  async play(instance: Instance, settings: Settings, account: Account, accessToken: string | undefined, connect: boolean): Promise<void> {
    if (this.game.status !== 'idle') throw new Error('Minecraft já está em execução');
    if (!instance.installed || !instance.versionId) throw new Error('Instale ou repare esta instalação antes de jogar');
    if (connect && !settings.serverHost) throw new Error('Configure o endereço do servidor em Configurações');
    if (connect && account.kind === 'offline' && settings.serverOnlineMode) throw new Error('Este servidor exige autenticação online. Selecione uma conta Microsoft com Minecraft Java.');
    this.game = { status: 'starting', instanceId: instance.id }; this.changed();
    this.stopping = false;
    try {
      const info = await this.localMetadata(instance, settings); const required = javaRequirement(info, info.id);
      const javaPath = instance.launch?.javaPath ?? settings.javaPath;
      const detected = await this.javaDetector(join(settings.gameDirectory, 'runtimes'), javaPath);
      const java = javaPath ? detected.find(j => j.path === javaPath && j.major === required) : detected.find(j => j.major === required);
      if (!java) throw new Error(`Minecraft ${instance.minecraft} exige Java ${required}. Instale o runtime na tela Instalações ou escolha um Java compatível.`);
      await this.inspect(instance, settings);
      const root = resourceDirectory(settings); const version = await Version.parse(root, instance.versionId);
      const quickPlay = version.arguments.game.some(arg => JSON.stringify(arg).includes('quickPlayMultiplayer'));
      const host = settings.serverHost.includes(':') ? `[${settings.serverHost}]:${settings.serverPort}` : `${settings.serverHost}:${settings.serverPort}`;
      const child = await this.launchGame({ gamePath: instanceDirectory(settings, instance), resourcePath: root, version, javaPath: java.path,
        gameProfile: { name: account.name, id: account.uuid }, accessToken: account.kind === 'microsoft' ? accessToken : '',
        ...(account.kind === 'offline' ? { userType: 'legacy' as const, spawn: (command: string, args: readonly string[] = [], options = {}) => {
          const sanitized = [...args]; for (const key of ['--accessToken', '--session']) { const tokenIndex = sanitized.indexOf(key); if (tokenIndex >= 0) sanitized[tokenIndex + 1] = ''; }
          return spawn(command, sanitized, options);
        } } : {}),
        minMemory: instance.launch?.minMemory ?? settings.minMemory, maxMemory: instance.launch?.maxMemory ?? settings.maxMemory, resolution: { width: settings.width, height: settings.height },
        extraJVMArgs: settings.jvmArgs, launcherName: 'MATRIX Launcher', launcherBrand: 'MATRIX',
        useHashAssetsIndex: true,
        ...(connect ? quickPlay ? { quickPlayMultiplayer: host } : { server: { ip: settings.serverHost, port: settings.serverPort } } : {}),
        extraExecOption: { windowsHide: true, shell: false },
      });
      this.process = child; this.game = { status: 'running', instanceId: instance.id }; this.changed();
      child.stdout?.on('data', data => this.log(String(data))); child.stderr?.on('data', data => this.log(String(data)));
      child.once('error', () => { if (this.process !== child) return; this.log('Não foi possível iniciar o processo Minecraft'); this.finish(null); });
      child.once('exit', code => { if (this.process === child) this.finish(code); });
    } catch (e) { this.game = { status: 'idle' }; this.changed(); throw e; }
  }
  private finish(code: number | null): void { this.process = undefined; this.game = { status: 'idle', exitCode: code, stoppedByUser: this.stopping }; this.log(`Minecraft encerrado${this.stopping ? ' pelo launcher' : ''}; código ${code}`); this.changed(); }
  stop(): void { if (!this.process) return; this.stopping = true; if (!this.process.kill()) this.stopping = false; }
}
