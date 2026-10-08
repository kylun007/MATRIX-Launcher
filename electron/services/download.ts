import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, stat, rename, rm, mkdir, statfs } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { secureUrl, noLinks } from './security.ts';

export const OFFICIAL_HOSTS = ['piston-meta.mojang.com', 'piston-data.mojang.com', 'launchermeta.mojang.com', 'launcher.mojang.com', 'resources.download.minecraft.net', 'libraries.minecraft.net'];
let networkFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);
export function setNetworkTransport(transport: typeof fetch): void { networkFetch = transport; }
export async function httpsFetch(url: string, init: RequestInit = {}, hosts?: readonly string[], fetcher: typeof fetch = networkFetch): Promise<Response> {
  let target = secureUrl(url, hosts);
  for (let i = 0; i < 6; i++) {
    const response = await fetcher(target, { ...init, redirect: 'manual', signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location'); await response.body?.cancel();
      if (!location) throw new Error('Redirecionamento inválido');
      const next = secureUrl(new URL(location, target).href, hosts);
      // Never forward authorization headers to another origin.
      if (next.origin !== target.origin && init.headers && new Headers(init.headers).has('authorization')) throw new Error('Redirecionamento de credenciais bloqueado');
      target = next; continue;
    }
    return response;
  }
  throw new Error('Muitos redirecionamentos de download');
}
export async function jsonFetch<T>(url: string, signal?: AbortSignal, hosts?: readonly string[], maxBytes = 8_000_000): Promise<T> {
  const response = await httpsFetch(url, { signal }, hosts);
  if (!response.ok) throw new Error(`Fonte indisponível (HTTP ${response.status})`);
  const chunks: Uint8Array[] = []; let length = 0;
  if (!response.body) throw new Error('Resposta vazia');
  for await (const chunk of response.body) { length += chunk.length; if (length > maxBytes) { await response.body.cancel().catch(() => {}); throw new Error('Manifesto excede o tamanho permitido'); } chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
}
export async function hashFile(file: string, algorithm = 'sha256'): Promise<string> {
  const hash = createHash(algorithm); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex');
}
export async function matches(file: string, hash: string, algorithm = 'sha256', size?: number): Promise<boolean> {
  try { if (size !== undefined && (await stat(file)).size !== size) return false; return await hashFile(file, algorithm) === hash; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
}
export async function requireSpace(directory: string, bytes: number): Promise<void> {
  await mkdir(directory, { recursive: true }); const fs = await statfs(directory);
  if (fs.bavail * fs.bsize < bytes + 256_000_000) throw Object.assign(new Error('Sem espaço em disco'), { code: 'ENOSPC' });
}
export type DownloadSpec = { url: string; destination: string; hash: string; algorithm?: 'sha1' | 'sha256' | 'sha512'; size: number; hosts: readonly string[]; signal?: AbortSignal; progress?: (received: number, total: number, speed: number) => void; fetcher?: typeof fetch };
export async function downloadFile(spec: DownloadSpec): Promise<void> {
  const algorithm = spec.algorithm ?? 'sha256';
  if (!(algorithm === 'sha1' ? /^[a-f0-9]{40}$/ : algorithm === 'sha512' ? /^[a-f0-9]{128}$/ : /^[a-f0-9]{64}$/).test(spec.hash) || !Number.isSafeInteger(spec.size) || spec.size < 0) throw new Error('Metadados de integridade inválidos');
  secureUrl(spec.url, spec.hosts); spec.signal?.throwIfAborted();
  await noLinks(dirname(spec.destination), spec.destination);
  if (await matches(spec.destination, spec.hash, algorithm, spec.size)) { spec.progress?.(spec.size, spec.size, 0); return; }
  await mkdir(dirname(spec.destination), { recursive: true });
  const part = `${spec.destination}.${spec.hash.slice(0, 12)}.part`;
  await noLinks(dirname(spec.destination), part);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      spec.signal?.throwIfAborted();
      let offset = await stat(part).then(s => s.size).catch(() => 0);
      if (offset > spec.size) { await rm(part, { force: true }); offset = 0; }
      if (offset === spec.size && await matches(part, spec.hash, algorithm, spec.size)) { await rename(part, spec.destination); return; }
      const response = await httpsFetch(spec.url, { signal: spec.signal, headers: offset ? { Range: `bytes=${offset}-` } : {} }, spec.hosts, spec.fetcher);
      if (response.status === 416) { await response.body?.cancel(); await rm(part, { force: true }); throw new Error('Download parcial precisa ser reiniciado'); }
      if (!response.ok || !response.body) throw new Error(`Download indisponível (HTTP ${response.status})`);
      if (response.status === 206) {
        const range = response.headers.get('content-range');
        if (!range || !range.startsWith(`bytes ${offset}-`) || !range.endsWith(`/${spec.size}`)) { await response.body.cancel(); throw new Error('Resposta parcial inválida'); }
      } else offset = 0;
      const file = await open(part, offset ? 'a' : 'w', 0o600); let received = offset; const started = Date.now();
      try {
        for await (const chunk of response.body) {
          spec.signal?.throwIfAborted(); received += chunk.length;
          if (received > spec.size) throw new Error('Download maior que o tamanho autorizado');
          let written = 0; while (written < chunk.length) written += (await file.write(chunk, written, chunk.length - written)).bytesWritten;
          spec.progress?.(received, spec.size, (received - offset) / Math.max(0.001, (Date.now() - started) / 1000));
        }
        await file.sync();
      } finally { await file.close(); }
      if (!await matches(part, spec.hash, algorithm, spec.size)) { await rm(part, { force: true }); throw new Error('Arquivo corrompido: hash ou tamanho não corresponde à fonte'); }
      spec.signal?.throwIfAborted(); await rename(part, spec.destination); return;
    } catch (error) {
      if (spec.signal?.aborted || (error as NodeJS.ErrnoException).code === 'ENOSPC' || attempt === 2) throw error;
      await delay(500 * (attempt + 1), undefined, { signal: spec.signal });
    }
  }
}
