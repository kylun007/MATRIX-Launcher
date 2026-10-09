import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, readFile, chmod, symlink, lstat, readlink, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { downloadFile, jsonFetch, OFFICIAL_HOSTS, requireSpace } from './download.ts';
import { noLinks, preparePath } from './security.ts';
const exec = promisify(execFile);
export async function probeJava(path: string): Promise<{ path: string; major: number }> {
  const result = await exec(path, ['-XshowSettings:properties', '-version'], { timeout: 10000, windowsHide: true, maxBuffer: 32_000 });
  const text = `${result.stderr} ${result.stdout}`;
  const match = text.match(/(?:openjdk|java) version "(?:1\.)?(\d+)/i);
  if (!match) throw new Error('Não foi possível identificar a versão deste Java');
  if (process.arch === 'x64' && /sun\.arch\.data\.model\s*=\s*32/.test(text)) throw new Error('Selecione Java 64 bits para este launcher');
  const major = Number(match[1]); return { path, major };
}
export function javaRequirement(version: { javaVersion?: { majorVersion: number } }, minecraft: string): number {
  if (version.javaVersion?.majorVersion) return version.javaVersion.majorVersion;
  const [, minor = 0, patch = 0] = minecraft.split('.').map(Number);
  return minor > 20 || (minor === 20 && patch >= 5) ? 21 : minor >= 18 ? 17 : minor === 17 ? 16 : 8;
}
export async function detectJava(runtimeRoot: string, configured: string): Promise<{ path: string; major: number }[]> {
  const candidates = new Set<string>([configured]);
  if (process.env.JAVA_HOME) candidates.add(join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'));
  for (const dir of (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) if (dir) candidates.add(join(dir, process.platform === 'win32' ? 'java.exe' : 'java'));
  for (const dir of await readdir(runtimeRoot, { withFileTypes: true }).catch(() => [])) if (dir.isDirectory()) candidates.add(join(runtimeRoot, dir.name, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'));
  if (process.platform === 'win32') for (const base of ['C:/Program Files/Java', 'C:/Program Files/Eclipse Adoptium', 'C:/Program Files/Microsoft']) {
    for (const dir of await readdir(base, { withFileTypes: true }).catch(() => [])) if (dir.isDirectory()) candidates.add(join(base, dir.name, 'bin/java.exe'));
  }
  const found = await Promise.all([...candidates].filter(Boolean).map(p => probeJava(p).catch(() => undefined)));
  return found.filter((p): p is { path: string; major: number } => !!p);
}
const RUNTIME_INDEX = 'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';
const download = z.object({ url: z.string().url(), sha1: z.string().regex(/^[a-f0-9]{40}$/), size: z.number().int().nonnegative() });
const runtimeIndex = z.record(z.string(), z.record(z.string(), z.array(z.object({ manifest: download, version: z.object({ name: z.string() }) }))));
const runtimeManifest = z.object({ files: z.record(z.string(), z.discriminatedUnion('type', [z.object({ type: z.literal('directory') }), z.object({ type: z.literal('link'), target: z.string() }), z.object({ type: z.literal('file'), executable: z.boolean(), downloads: z.object({ raw: download }) })])) });
export function runtimeSymlinkTarget(root: string, path: string, target: string): string {
  const destination = resolveRuntimePath(root, path);
  if (!target || target.includes('\\') || target.includes(':') || /[\x00-\x1f]/.test(target) || isAbsolute(target)) throw new Error('Invalid runtime link target');
  const resolvedTarget = resolve(dirname(destination), target);
  const rel = relative(resolve(root), resolvedTarget);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Runtime link escapes installation');
  return target;
}
function resolveRuntimePath(root: string, path: string): string {
  if (!path || path.includes('\\') || path.includes(':') || /[\x00-\x1f]/.test(path) || isAbsolute(path)) throw new Error('Invalid runtime path');
  const destination = resolve(root, path);
  const rel = relative(resolve(root), destination);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Runtime path escapes installation');
  return destination;
}
export async function installJava(root: string, component: string, major: number, signal: AbortSignal, progress: (bytes: number, total: number, speed: number, detail?: { file: string; filesDone: number; filesTotal: number }) => void, concurrency = 4): Promise<string> {
  const platform = process.platform === 'win32' && process.arch === 'x64' ? 'windows-x64' : process.platform === 'linux' && process.arch === 'x64' ? 'linux' : '';
  if (!platform) throw new Error('Instalação automática de Java disponível em Windows/Linux x64. Selecione um Java manualmente.');
  const index = runtimeIndex.parse(await jsonFetch(RUNTIME_INDEX, signal, OFFICIAL_HOSTS));
  const entry = index[platform]?.[component]?.[0]; if (!entry) throw new Error('Runtime oficial indisponível para esta versão. Selecione um Java compatível manualmente.');
  const destination = await preparePath(root, `${component}/manifest.json`);
  await downloadFile({ ...entry.manifest, hash: entry.manifest.sha1, algorithm: 'sha1', destination, hosts: OFFICIAL_HOSTS, signal });
  const manifest = runtimeManifest.parse(JSON.parse(await readFile(destination, 'utf8')));
  const runtimeDir = join(root, component); const files = Object.entries(manifest.files).filter(([, e]) => e.type === 'file');
  const total = files.reduce((sum, [, e]) => sum + (e.type === 'file' ? e.downloads.raw.size : 0), 0);
  await requireSpace(runtimeDir, total);
  let indexFile = 0; let failure: unknown; let received = 0; let speedTotal = 0; let filesDone = 0;
  const counts = new Map<string, { bytes: number; speed: number }>();
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, async () => {
    while (indexFile < files.length && !failure) {
      const [path, entry] = files[indexFile++]; if (entry.type !== 'file') continue;
      try {
        signal.throwIfAborted(); const file = await preparePath(runtimeDir, path);
        await downloadFile({ ...entry.downloads.raw, hash: entry.downloads.raw.sha1, algorithm: 'sha1', destination: file, hosts: OFFICIAL_HOSTS, signal, progress: (bytes, _total, speed) => { const old = counts.get(path) ?? { bytes: 0, speed: 0 }; received += bytes - old.bytes; speedTotal += speed - old.speed; counts.set(path, { bytes, speed }); progress(received, total, Math.max(0, speedTotal), { file: path, filesDone, filesTotal: files.length }); } });
        filesDone++;
        speedTotal -= counts.get(path)?.speed ?? 0; counts.set(path, { bytes: entry.downloads.raw.size, speed: 0 });
        if (entry.executable && process.platform !== 'win32') await chmod(file, 0o755);
      } catch (e) { failure = e; }
    }
  })); if (failure) throw failure;
  const links = Object.entries(manifest.files).filter((entry): entry is [string, { type: 'link'; target: string }] => entry[1].type === 'link');
  if (links.length && process.platform !== 'linux') throw new Error('Symbolic runtime links are currently supported only on Linux x64.');
  for (const [path, entry] of links) {
    signal.throwIfAborted(); const linkPath = resolveRuntimePath(runtimeDir, path);
    await noLinks(runtimeDir, dirname(linkPath));
    runtimeSymlinkTarget(runtimeDir, path, entry.target);
    try {
      const existing = await lstat(linkPath);
      if (!existing.isSymbolicLink() || await readlink(linkPath) !== entry.target) throw new Error('Unexpected file at a managed Java runtime link path');
      await unlink(linkPath);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await noLinks(runtimeDir, resolve(dirname(linkPath), entry.target));
  }
  for (const [path, entry] of links) {
    signal.throwIfAborted();
    const linkPath = await preparePath(runtimeDir, path);
    await symlink(entry.target, linkPath, 'file');
  }
  const executable = join(runtimeDir, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  const java = await probeJava(executable); if (java.major !== major) throw new Error(`Java instalado é ${java.major}, mas Minecraft exige ${major}`);
  return executable;
}
