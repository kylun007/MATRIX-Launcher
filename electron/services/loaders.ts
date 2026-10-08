import { MinecraftFolder } from '@xmcl/core';
import { resolveFabricInstallManifest, createModernForgeInstallWorkflow, createNodeInstallRuntime, executeInstallManifest, executeInstallWorkflow, resolveLibraryInstallFiles, type InstallFile, type InstallRuntime } from '@xmcl/installer';
import { dirname, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import type { Instance, Settings } from '../../shared/contracts.ts';
import type { ResolvedVersion } from '@xmcl/core';
import { downloadFile, httpsFetch, hashFile } from './download.ts';
import { noLinks, preparePath, safePath, secureUrl } from './security.ts';
import type { Transfer } from './minecraft.ts';

export const LOADER_HOSTS = ['piston-meta.mojang.com', 'piston-data.mojang.com', 'launchermeta.mojang.com', 'launcher.mojang.com', 'resources.download.minecraft.net', 'libraries.minecraft.net', 'maven.fabricmc.net', 'meta.fabricmc.net', 'maven.minecraftforge.net', 'files.minecraftforge.net', 'maven.neoforged.net', 'repo.maven.apache.org', 'repo1.maven.org'];
async function fileMetadata(file: InstallFile, signal: AbortSignal): Promise<{ url: string; hash: string; algorithm: 'sha1' | 'sha256'; size: number }> {
  const url = file.urls[0]; secureUrl(url, LOADER_HOSTS);
  let hash = file.checksum?.value; let algorithm = file.checksum?.algorithm;
  if (!hash) {
    const response = await httpsFetch(`${url}.sha1`, { signal }, LOADER_HOSTS);
    if (!response.ok) throw new Error(`A fonte do loader não publicou hash verificável: ${url} (HTTP ${response.status})`);
    hash = (await response.text()).trim().split(/\s/)[0]; algorithm = 'sha1';
  }
  if (algorithm !== 'sha1' && algorithm !== 'sha256') throw new Error('Algoritmo de hash do loader não suportado');
  let size = file.size;
  if (size === undefined || size < 0) {
    const response = await httpsFetch(url, { method: 'HEAD', signal }, LOADER_HOSTS);
    if (!response.ok) throw new Error('Não foi possível consultar o tamanho da biblioteca');
    const length = response.headers.get('content-length'); if (!length) throw new Error('Fonte não informa o tamanho da biblioteca'); size = Number(length);
  }
  if (!Number.isSafeInteger(size) || size < 0 || size > 2_000_000_000) throw new Error('Biblioteca excede o tamanho permitido');
  return { url, hash, algorithm, size };
}
export function guardedRuntime(root: string, java: string | undefined, settings: Settings, signal: AbortSignal, progress: Transfer): InstallRuntime {
  async function guard(path: string): Promise<void> {
    if (resolve(path) !== resolve(root)) safePath(root, relative(root, path).replaceAll('\\', '/'));
    await noLinks(root, path);
  }
  const base = createNodeInstallRuntime({ signal });
  return {
    stat: async path => { await guard(path); return base.stat(path); },
    checksum: async (path, algorithm) => { await guard(path); return hashFile(path, algorithm); },
    validate: async (path, validator) => { await guard(path); return base.validate(path, validator); },
    download: async files => {
      let index = 0; let failure: unknown; const current = new Map<string, { bytes: number; total: number; speed: number }>();
      await Promise.all(Array.from({ length: Math.min(settings.concurrency, files.length) }, async () => {
        while (index < files.length && !failure) {
          const file = files[index++];
          try {
            signal.throwIfAborted(); await guard(file.path); const meta = await fileMetadata(file, signal);
            await preparePath(root, relative(root, file.path).replaceAll('\\', '/'));
            await downloadFile({ ...meta, destination: file.path, hosts: LOADER_HOSTS, signal, progress: (bytes, total, speed) => { current.set(file.path, { bytes, total, speed }); progress('Baixando arquivos do loader', [...current.values()].reduce((s, v) => s + v.bytes, 0), [...current.values()].reduce((s, v) => s + v.total, 0), [...current.values()].reduce((s, v) => s + v.speed, 0)); } });
            current.set(file.path, { bytes: meta.size, total: meta.size, speed: 0 });
          } catch (e) { failure = e; }
        }
      })); if (failure) throw failure;
    },
    java: async command => {
      signal.throwIfAborted(); if (!java || command.executable !== java) throw new Error('Executável do processador Forge não autorizado');
      if (command.cwd) await guard(command.cwd);
      await new Promise<void>((ok, reject) => {
        const child = spawn(java, command.args, { cwd: command.cwd ?? root, windowsHide: true, shell: false, signal, stdio: 'ignore' });
        child.once('error', reject); child.once('exit', code => code === 0 ? ok() : reject(new Error(`Processador Forge encerrou com código ${code}`)));
      });
    },
    remove: async paths => { for (const path of paths) await guard(path); return base.remove(paths); },
    materialize: async operations => {
      for (const op of operations) {
        signal.throwIfAborted(); await guard(op.path);
        if ('source' in op) await guard(op.source);
        if ('archive' in op) await guard(op.archive);
        if ('archives' in op) for (const archive of op.archives) await guard(archive);
        if (op.type === 'extract') safePath(root, op.entry);
        if (op.type === 'extract-archive' || op.type === 'link') throw new Error('Extração de arquivo/link não autorizada no fluxo de loader');
      } return base.materialize(operations);
    },
  };
}
export async function installLoader(instance: Instance, root: string, java: string | undefined, settings: Settings, signal: AbortSignal, progress: Transfer): Promise<string> {
  const runtime = guardedRuntime(root, java, settings, signal, progress);
  if (instance.loader === 'fabric') {
    const resolved = await resolveFabricInstallManifest({ minecraftVersion: instance.minecraft, version: instance.loaderVersion, minecraft: root, signal, fetch: ((url: string | URL | Request, init?: RequestInit) => httpsFetch(typeof url === 'string' || url instanceof URL ? String(url) : url.url, init, LOADER_HOSTS)) as typeof fetch });
    await executeInstallManifest(resolved.plan, runtime, { signal }); return resolved.version;
  }
  if (!java) throw new Error('Instale Java compatível antes de instalar Forge/NeoForge');
  const forge = instance.loader === 'forge'; const artifactVersion = forge ? `${instance.minecraft}-${instance.loaderVersion}` : instance.loaderVersion;
  const path = forge ? `net/minecraftforge/forge/${artifactVersion}/forge-${artifactVersion}-installer.jar` : `net/neoforged/neoforge/${artifactVersion}/neoforge-${artifactVersion}-installer.jar`;
  const url = `${forge ? 'https://maven.minecraftforge.net' : 'https://maven.neoforged.net/releases'}/${path}`;
  const file: InstallFile = { path: await preparePath(root, `libraries/${path}`), urls: [url] };
  const meta = await fileMetadata(file, signal); file.size = meta.size; file.checksum = { algorithm: meta.algorithm, value: meta.hash };
  const result = await executeInstallWorkflow(createModernForgeInstallWorkflow({ id: instance.id, minecraft: MinecraftFolder.from(root), minecraftVersion: instance.minecraft, installer: file, artifactVersion, java, installOptions: { java, signal }, side: 'client' }), runtime, { signal });
  return result.version;
}
export async function installLoaderLibraries(version: ResolvedVersion, root: string, java: string | undefined, settings: Settings, signal: AbortSignal, progress: Transfer): Promise<void> {
  const files = resolveLibraryInstallFiles(version.libraries, MinecraftFolder.from(root));
  await executeInstallManifest({ schemaVersion: 1, tasks: [{ id: 'loader-libraries', type: 'files', files }] }, guardedRuntime(root, java, settings, signal, progress), { signal });
}
