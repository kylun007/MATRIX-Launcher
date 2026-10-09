import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { open as openZip, openEntryReadStream, walkEntriesGenerator } from '@xmcl/unzip';
import { deflateRawSync } from 'node:zlib';
import { z } from 'zod';
import semver from 'semver';
import type { Instance } from '../../shared/contracts.ts';
import { libraryModSchema, type LibraryApplyPlan, type LibraryCollection, type LibraryMod, type LibraryModView, type LibraryModpack, type LibrarySnapshot, type LibraryScan } from '../../shared/mod-library.ts';
import { downloadFile, hashFile, matches, requireSpace } from './download.ts';
import type { ContentFile } from '../../shared/smart.ts';
import { atomicJson } from './smart-config.ts';
import { noLinks, safePath } from './security.ts';

const MAX_MOD_BYTES = 250 * 1024 * 1024;
const MAX_BATCH_BYTES = 5 * 1024 * 1024 * 1024;
const MAX_BATCH_FILES = 200;
const MAX_ARCHIVE_ENTRIES = 20_000;
const MAX_METADATA_BYTES = 512 * 1024;
const MAX_MODPACK_BYTES = 1024 * 1024 * 1024;
const collectionSchema = z.object({ id: z.string().uuid(), name: z.string().min(1).max(60), description: z.string().max(300), hashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(500), createdAt: z.number().int(), updatedAt: z.number().int() }).strict();
const modpackSchema = z.object({ id: z.string().uuid(), name: z.string().min(1).max(80), summary: z.string().max(300), minecraft: z.string().regex(/^\d+(?:\.\d+){1,2}$/), loader: z.enum(['vanilla', 'fabric', 'forge', 'neoforge']), loaderVersion: z.string().max(80), hashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(100), createdAt: z.number().int(), updatedAt: z.number().int() }).strict();
const historySchema = z.array(z.object({ at: z.number().int(), action: z.string().max(40), detail: z.string().max(240) }).strict()).max(500);
const indexSchema = z.object({ schemaVersion: z.literal(2), mods: z.array(libraryModSchema).max(20_000), collections: z.array(collectionSchema).max(500), modpacks: z.array(modpackSchema).max(500), history: historySchema }).strict();
const oldIndexSchema = z.object({ schemaVersion: z.literal(1), mods: z.array(libraryModSchema).max(20_000), collections: z.array(collectionSchema).max(500), history: historySchema }).strict();
type Index = z.infer<typeof indexSchema>;
const ledgerSchema = z.object({ schemaVersion: z.literal(1), files: z.array(z.object({ hash: z.string().regex(/^[a-f0-9]{64}$/), filename: z.string().min(1).max(240) }).strict()).max(1000) }).strict();
const mrpackIndexSchema = z.object({ formatVersion: z.literal(1), game: z.literal('minecraft'), versionId: z.string().min(1).max(100), name: z.string().min(1).max(80), summary: z.string().max(300).optional(), files: z.array(z.object({ path: z.string().min(1).max(500), hashes: z.object({ sha1: z.string().regex(/^[a-f0-9]{40}$/), sha512: z.string().regex(/^[a-f0-9]{128}$/) }).strict(), env: z.object({ client: z.enum(['required', 'optional', 'unsupported']), server: z.enum(['required', 'optional', 'unsupported']) }).optional(), downloads: z.array(z.string().url()).min(1).max(10), fileSize: z.number().int().positive().max(MAX_MOD_BYTES) }).strict()).max(MAX_BATCH_FILES), dependencies: z.record(z.string(), z.string().max(120)) }).strict();
const matrixpackSchema = z.object({ schemaVersion: z.literal(1), name: z.string().min(1).max(80), summary: z.string().max(300), minecraft: z.string().regex(/^\d+(?:\.\d+){1,2}$/), loader: z.enum(['vanilla', 'fabric', 'forge', 'neoforge']), loaderVersion: z.string().max(80), mods: z.array(z.object({ hash: z.string().regex(/^[a-f0-9]{64}$/), name: z.string().min(1).max(200), version: z.string().max(120).optional(), source: z.object({ projectId: z.string(), versionId: z.string(), url: z.string().url(), hash: z.string(), algorithm: z.enum(['sha1', 'sha512']) }).strict().optional() }).strict()).min(1).max(100) }).strict();
type Candidate = { path: string; item: LibraryModView };
type Progress = (label: string, done: number, total: number, speed: number) => void;
type JarMetadata = Omit<LibraryMod, 'hash' | 'file' | 'size' | 'originalName' | 'importedAt'>;

function safeDisplayName(value: string, fallback: string): string { const name = value.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim().slice(0, 180); return name || fallback; }
function crc32(data: Buffer): number { let crc = 0xffffffff; for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; }
function storedZip(entries: { name: string; data: Buffer }[]): Buffer {
  const local: Buffer[] = []; const central: Buffer[] = []; let offset = 0;
  for (const { name: filename, data } of entries) {
    const name = Buffer.from(filename, 'utf8'); if (name.length > 65535 || data.length > 0xffffffff || offset > 0xffffffff) throw new Error('Modpack excede os limites do formato ZIP.');
    const compressed = deflateRawSync(data); const crc = crc32(data); const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8); header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26); local.push(header, name, compressed);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8); directory.writeUInt16LE(8, 10); directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(compressed.length, 20); directory.writeUInt32LE(data.length, 24); directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42); central.push(directory, name); offset += header.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16); return Buffer.concat([...local, directory, end]);
}
function exactMinecraft(value: unknown): string[] { if (typeof value !== 'string') return []; const v = value.trim(); return /^\d+(?:\.\d+){1,2}$/.test(v) ? [v] : []; }
function normalizeAuthors(value: unknown): string[] { if (typeof value === 'string') return [value.slice(0, 120)]; if (Array.isArray(value)) return value.map(v => typeof v === 'string' ? v : v && typeof v === 'object' && 'name' in v && typeof v.name === 'string' ? v.name : '').filter(Boolean).slice(0, 30).map(v => v.slice(0, 120)); return []; }
function parseTomlLite(text: string): { mods: Record<string, unknown>[]; dependencies: Record<string, Record<string, unknown>[]> } {
  const mods: Record<string, unknown>[] = []; const dependencies: Record<string, Record<string, unknown>[]> = {}; let section = ''; let current: Record<string, unknown> | undefined;
  for (const line of text.split(/\r?\n/)) {
    const table = line.match(/^\s*\[\[(mods|dependencies\.([A-Za-z0-9_.-]+))\]\]\s*(?:#.*)?$/);
    if (table) { section = table[1]; current = {}; if (section === 'mods') mods.push(current); else (dependencies[table[2]] ??= []).push(current); continue; }
    if (/^\s*\[/.test(line) || !current) continue;
    const pair = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(.*?)\s*(?:#.*)?$/); if (!pair) continue;
    const raw = pair[2]; let value: unknown;
    if (/^(true|false)$/.test(raw)) value = raw === 'true';
    else if (/^["']/.test(raw)) { const match = raw.match(/^["']((?:\\.|[^"'])*)["']/); value = match ? match[1].replace(/\\(["'\\])/g, '$1') : undefined; }
    else if (/^\[.*\]$/.test(raw)) value = [...raw.matchAll(/["']([^"']+)["']/g)].map(m => m[1]);
    else continue;
    if (value !== undefined) current[pair[1]] = value;
  }
  return { mods, dependencies };
}
function dependencyList(entries: Record<string, unknown>[], skip = new Set(['minecraft', 'java', 'fabricloader', 'forge', 'neoforge'])) {
  return entries.flatMap(entry => {
    const id = typeof entry.modId === 'string' ? entry.modId : '';
    if (!id || skip.has(id.toLowerCase())) return [];
    return [{ id: id.slice(0, 120), ...(typeof entry.versionRange === 'string' ? { range: entry.versionRange.slice(0, 120) } : {}), optional: entry.mandatory === false }];
  }).slice(0, 100);
}
function loaderFromFabric(value: unknown): 'fabric'[] { return value && typeof value === 'object' && !Array.isArray(value) ? ['fabric'] : []; }
function supportsMinecraft(mod: LibraryMod, version: string): boolean | undefined {
  if (mod.minecraftVersions.length) return mod.minecraftVersions.includes(version);
  const range = mod.minecraftRange?.trim(); if (!range || range.includes('${')) return undefined;
  if ('(['.includes(range[0]) && ')]'.includes(range.at(-1)!) && range.includes(',')) {
    const [low, high] = range.slice(1, -1).split(',', 2); const left = range[0]; const right = range.at(-1);
    const clauses = [low ? `${left === '[' ? '>=' : '>'}${low}` : '', high ? `${right === ']' ? '<=' : '<'}${high}` : ''].filter(Boolean);
    const normalized = clauses.join(' '); return normalized ? semver.satisfies(version, normalized, { loose: true }) : true;
  }
  const exact = range.match(/^\[?(\d+(?:\.\d+){1,2})\]?$/); if (exact) return exact[1] === version;
  const npmRange = range.replace(/\*/g, 'x'); return semver.validRange(npmRange, { loose: true }) ? semver.satisfies(version, npmRange, { loose: true }) : undefined;
}

async function readBoundedEntry(zip: Awaited<ReturnType<typeof openZip>>, entry: import('yauzl').Entry): Promise<string> {
  if (entry.uncompressedSize > MAX_METADATA_BYTES) throw new Error('Metadado do mod excede o limite permitido.');
  const stream = await openEntryReadStream(zip, entry); const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of stream) { size += chunk.length; if (size > MAX_METADATA_BYTES) { stream.destroy(); throw new Error('Metadado descompactado excede o limite permitido.'); } chunks.push(Buffer.from(chunk)); }
  return Buffer.concat(chunks).toString('utf8');
}
async function inspectJar(path: string): Promise<JarMetadata> {
  const zip = await openZip(path, { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: true });
  try {
    if (zip.entryCount > MAX_ARCHIVE_ENTRIES) throw new Error('JAR contém quantidade excessiva de entradas.');
    let fabric: import('yauzl').Entry | undefined; let neo: import('yauzl').Entry | undefined; let forge: import('yauzl').Entry | undefined; let legacy: import('yauzl').Entry | undefined;
    for await (const entry of walkEntriesGenerator(zip)) {
      const name = entry.fileName.toLowerCase();
      if (name === 'fabric.mod.json') fabric ??= entry;
      else if (name === 'meta-inf/neoforge.mods.toml') neo ??= entry;
      else if (name === 'meta-inf/mods.toml') forge ??= entry;
      else if (name === 'mcmod.info') legacy ??= entry;
    }
    if (fabric) {
      const data = JSON.parse(await readBoundedEntry(zip, fabric)) as Record<string, unknown>;
      const depends = data.depends && typeof data.depends === 'object' && !Array.isArray(data.depends) ? data.depends as Record<string, unknown> : {};
      const dependencies = Object.entries(depends).filter(([id]) => !['minecraft', 'java', 'fabricloader'].includes(id)).flatMap(([id, range]) => [{ id: id.slice(0, 120), ...(typeof range === 'string' ? { range: range.slice(0, 120) } : Array.isArray(range) ? { range: range.filter(x => typeof x === 'string').join(' || ').slice(0, 120) } : {}), optional: false }]).slice(0, 100);
      const conflicts = data.breaks && typeof data.breaks === 'object' && !Array.isArray(data.breaks) ? Object.keys(data.breaks as object).filter(x => !['minecraft', 'java'].includes(x)).slice(0, 100) : [];
      const gameRange = typeof depends.minecraft === 'string' ? depends.minecraft : undefined;
      return { id: typeof data.id === 'string' ? data.id.slice(0, 120) : undefined, name: safeDisplayName(typeof data.name === 'string' ? data.name : '', 'Mod Fabric desconhecido'), version: typeof data.version === 'string' ? data.version.slice(0, 120) : undefined, description: typeof data.description === 'string' ? data.description.slice(0, 1000) : undefined, authors: normalizeAuthors(data.authors), loaders: loaderFromFabric(data), minecraftVersions: exactMinecraft(gameRange), minecraftRange: gameRange?.slice(0, 120), dependencies, conflicts, metadata: 'fabric' };
    }
    const entry = neo ?? forge;
    if (entry) {
      const kind = neo ? 'neoforge' : 'forge'; const parsed = parseTomlLite(await readBoundedEntry(zip, entry)); const mod = parsed.mods[0];
      if (!mod) throw new Error('Metadados TOML não declaram uma seção [[mods]].');
      const id = typeof mod.modId === 'string' ? mod.modId : undefined; const depEntries = id ? parsed.dependencies[id] ?? [] : [];
      const gameRange = depEntries.find(d => d.modId === 'minecraft' && typeof d.versionRange === 'string')?.versionRange as string | undefined;
      return { id: id?.slice(0, 120), name: safeDisplayName(typeof mod.displayName === 'string' ? mod.displayName : '', 'Mod Forge/NeoForge desconhecido'), version: typeof mod.version === 'string' ? mod.version.slice(0, 120) : undefined, description: typeof mod.description === 'string' ? mod.description.slice(0, 1000) : undefined, authors: normalizeAuthors(mod.authors), loaders: [kind], minecraftVersions: exactMinecraft(gameRange), minecraftRange: gameRange?.slice(0, 120), dependencies: dependencyList(depEntries), conflicts: [], metadata: kind };
    }
    if (legacy) {
      const data = JSON.parse(await readBoundedEntry(zip, legacy)) as unknown; const first = Array.isArray(data) ? data[0] as Record<string, unknown> | undefined : undefined;
      if (first) return { id: typeof first.modid === 'string' ? first.modid.slice(0, 120) : undefined, name: safeDisplayName(typeof first.name === 'string' ? first.name : '', 'Mod Forge legado'), version: typeof first.version === 'string' ? first.version.slice(0, 120) : undefined, description: typeof first.description === 'string' ? first.description.slice(0, 1000) : undefined, authors: normalizeAuthors(first.authorList), loaders: ['forge'], minecraftVersions: [], dependencies: [], conflicts: [], metadata: 'legacy-forge' };
    }
    return { name: safeDisplayName(basename(path, '.jar'), 'Mod desconhecido'), loaders: [], minecraftVersions: [], dependencies: [], conflicts: [], authors: [], metadata: 'unknown' };
  } finally { zip.close(); }
}

export class ModLibraryService {
  private jobs = new Map<string, Candidate[]>(); private plans = new Map<string, LibraryApplyPlan>();
  constructor(private readonly root: string, private readonly instances: () => Instance[], private readonly instanceBasePath: () => string) {}
  private async load(): Promise<Index> {
    const path = safePath(this.root, 'index.json'); await noLinks(this.root, path);
    try {
      const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
      try { return indexSchema.parse(raw); } catch { const old = oldIndexSchema.parse(raw); return { ...old, schemaVersion: 2 as const, modpacks: [] }; }
    } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 2, mods: [], collections: [], modpacks: [], history: [] }; throw new Error('Índice da biblioteca inválido; os arquivos foram preservados.'); }
  }
  private async save(index: Index, action?: string, detail?: string): Promise<void> {
    if (action) index.history.push({ at: Date.now(), action: action.slice(0, 40), detail: (detail ?? '').slice(0, 240) });
    index.history = index.history.slice(-500); await mkdir(this.root, { recursive: true }); await noLinks(this.root, this.root); await atomicJson(this.root, 'index.json', indexSchema.parse(index));
  }
  private async object(hash: string): Promise<string> { const path = safePath(this.root, `objects/${hash}.jar`); await noLinks(this.root, path); return path; }
  private async scan(paths: string[], progress: Progress, signal: AbortSignal): Promise<LibraryScan> {
    if (paths.length > MAX_BATCH_FILES) throw new Error(`Selecione no máximo ${MAX_BATCH_FILES} arquivos por vez.`);
    const total = paths.length; let bytes = 0; let processed = 0; const candidates: Candidate[] = []; let rejected = 0; const known = new Set((await this.load()).mods.map(m => m.hash)); const inBatch = new Set<string>();
    for (const file of paths) {
      signal.throwIfAborted(); const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink()) { rejected++; continue; }
      if (!file.toLowerCase().endsWith('.jar') || info.size <= 0 || info.size > MAX_MOD_BYTES || bytes + info.size > MAX_BATCH_BYTES) { rejected++; continue; }
      bytes += info.size;
      const hash = createHash('sha256'); let actualSize = 0;
      try {
        for await (const chunk of createReadStream(file, { signal })) { signal.throwIfAborted(); actualSize += chunk.length; if (actualSize > MAX_MOD_BYTES) throw new Error('Arquivo excede o limite de 250 MB.'); hash.update(chunk); }
        if (actualSize !== info.size) throw new Error('O arquivo mudou durante a leitura.');
        const digest = hash.digest('hex'); let metadata: JarMetadata; let valid = true; let error: string | undefined;
        try { metadata = await inspectJar(file); } catch (e) { metadata = { name: safeDisplayName(basename(file, '.jar'), 'Mod desconhecido'), loaders: [], minecraftVersions: [], dependencies: [], conflicts: [], authors: [], metadata: 'unknown' }; valid = false; error = (e as Error).message.slice(0, 240); }
        const mod = libraryModSchema.parse({ ...metadata, hash: digest, file: `${digest}.jar`, size: actualSize, originalName: basename(file).slice(0, 240), importedAt: Date.now() });
        const item = { ...mod, compatibility: 'unknown' as const, usedBy: [], duplicate: known.has(digest) || inBatch.has(digest), valid, ...(error ? { error } : {}) };
        candidates.push({ path: file, item }); inBatch.add(digest);
      } catch (e) { rejected++; if ((e as Error).name === 'AbortError') throw e; }
      processed++; progress(basename(file), processed, total, 0);
    }
    const jobId = randomUUID(); this.jobs.set(jobId, candidates); if (this.jobs.size > 5) this.jobs.delete(this.jobs.keys().next().value!);
    return { jobId, candidates: candidates.map(c => c.item), rejected };
  }
  async scanFiles(paths: string[], progress: Progress, signal: AbortSignal): Promise<LibraryScan> { return this.scan(paths, progress, signal); }
  async scanFolder(folder: string, progress: Progress, signal: AbortSignal): Promise<LibraryScan> {
    const dir = await lstat(folder); if (!dir.isDirectory() || dir.isSymbolicLink()) throw new Error('A pasta selecionada não é um diretório seguro.');
    const entries = await readdir(folder, { withFileTypes: true }); const files = entries.filter(e => e.isFile() && e.name.toLowerCase().endsWith('.jar')).map(e => join(folder, e.name));
    if (files.length > MAX_BATCH_FILES) throw new Error(`A pasta contém ${files.length} JARs; selecione pastas menores (máximo ${MAX_BATCH_FILES}).`);
    return this.scan(files, progress, signal);
  }
  async saveModrinth(files: ContentFile[], signal: AbortSignal, progress: Progress): Promise<{ imported: number; duplicates: number }> {
    if (!files.length || files.length > MAX_BATCH_FILES) throw new Error('O plano Modrinth está vazio ou excede o limite de arquivos.');
    const root = this.root; const staging = safePath(root, `staging/${randomUUID()}`); await mkdir(staging, { recursive: true }); await noLinks(root, staging);
    try {
      const paths: string[] = []; const remoteByHash = new Map<string, ContentFile>(); const total = files.reduce((sum, file) => sum + file.size, 0); if (total > MAX_BATCH_BYTES) throw new Error('O conjunto Modrinth excede o limite de 5 GB.'); await requireSpace(staging, total * 2); let completed = 0;
      for (let index = 0; index < files.length; index++) {
        signal.throwIfAborted(); const file = files[index];
        if (file.kind !== 'mod' || file.size <= 0 || file.size > MAX_MOD_BYTES || !/^[A-Za-z0-9_-]{1,100}$/.test(file.projectId) || !/^[A-Za-z0-9_-]{1,100}$/.test(file.versionId) || !file.url.startsWith(`https://cdn.modrinth.com/data/${file.projectId}/versions/${file.versionId}/`) || file.url.includes('?') || file.filename !== basename(file.filename) || file.filename.includes('\\') || !['sha1', 'sha512'].includes(file.algorithm)) throw new Error('O catálogo retornou dados de download inválidos.');
        const destination = safePath(staging, `${index}/${file.filename}`); await downloadFile({ url: file.url, destination, hash: file.hash, algorithm: file.algorithm, size: file.size, hosts: ['cdn.modrinth.com'], signal, progress: (done) => progress(file.filename, completed + done, total, 0) }); paths.push(destination); const sha256 = await hashFile(destination, 'sha256'); remoteByHash.set(sha256, file); completed += file.size;
      }
      const preview = await this.scan(paths, () => {}, signal); const result = await this.commitImport(preview.jobId, preview.candidates.filter(item => item.valid).map(item => item.hash), signal, progress);
      const index = await this.load();
      for (const candidate of preview.candidates) {
        const source = remoteByHash.get(candidate.hash); const entry = index.mods.find(mod => mod.hash === candidate.hash);
        if (source && entry && !entry.source) entry.source = { projectId: source.projectId, versionId: source.versionId, url: source.url, hash: source.hash, algorithm: source.algorithm as 'sha1' | 'sha512' };
      }
      await this.save(index, 'modrinth.save', `${result.imported} mod(s) salvos do Modrinth`); return result;
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
  async commitImport(jobId: string, hashes: string[], signal: AbortSignal, progress: Progress): Promise<{ imported: number; duplicates: number }> {
    const candidates = this.jobs.get(jobId); if (!candidates) throw new Error('Prévia de importação expirou; selecione os arquivos novamente.');
    const selected = new Set(hashes); const chosen: Candidate[] = []; const found = new Set<string>();
    for (const candidate of candidates) if (selected.has(candidate.item.hash) && candidate.item.valid && !found.has(candidate.item.hash)) { chosen.push(candidate); found.add(candidate.item.hash); }
    if (selected.size !== chosen.length) throw new Error('A seleção contém arquivo inválido ou não incluído na prévia.');
    const index = await this.load(); const known = new Set(index.mods.map(m => m.hash)); let imported = 0; let duplicates = 0; const created: string[] = [];
    try {
      let processed = 0;
      for (const candidate of chosen) {
        signal.throwIfAborted();
        if (known.has(candidate.item.hash)) { duplicates++; processed++; progress(candidate.item.originalName, processed, chosen.length, 0); continue; }
        const destination = await this.object(candidate.item.hash); const temp = safePath(this.root, `objects/.${candidate.item.hash}.${randomUUID()}.tmp`); await mkdir(join(this.root, 'objects'), { recursive: true }); await noLinks(this.root, destination); await noLinks(this.root, temp);
        const sourceInfo = await lstat(candidate.path); if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() || sourceInfo.size !== candidate.item.size) throw new Error(`O arquivo ${candidate.item.originalName} mudou depois da prévia.`);
        await copyFile(candidate.path, temp); if (!await matches(temp, candidate.item.hash, 'sha256', candidate.item.size)) throw new Error(`Hash do arquivo ${candidate.item.originalName} mudou durante a importação.`);
        if (await lstat(destination).then(() => true, e => e.code === 'ENOENT' ? false : Promise.reject(e))) { await rm(temp, { force: true }); duplicates++; continue; }
        signal.throwIfAborted(); await rename(temp, destination); created.push(destination);
        const { compatibility: _compatibility, usedBy: _usedBy, duplicate: _duplicate, valid: _valid, error: _error, ...stored } = candidate.item;
        index.mods.push(libraryModSchema.parse(stored)); known.add(candidate.item.hash); imported++; processed++; progress(candidate.item.originalName, processed, chosen.length, 0);
      }
      this.jobs.delete(jobId); await this.save(index, 'import', `${imported} importado(s), ${duplicates} duplicado(s)`); return { imported, duplicates };
    } catch (e) { for (const file of created) await rm(file, { force: true }).catch(() => {}); throw e; }
  }
  async list(): Promise<LibrarySnapshot> {
    const index = await this.load(); const byHash = new Map<string, string[]>();
    for (const instance of this.instances()) {
      if (!instance.installed) continue;
      const instanceRoot = safePath(this.instanceBase(), `instances/${instance.id}`); const ledgerPath = safePath(instanceRoot, '.matrix-library.json'); await noLinks(this.instanceBase(), ledgerPath);
      try { const ledger = ledgerSchema.parse(JSON.parse(await readFile(ledgerPath, 'utf8'))); for (const file of ledger.files) byHash.set(file.hash, [...(byHash.get(file.hash) ?? []), instance.name]); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') continue; }
    }
    return { mods: index.mods.map(mod => ({ ...mod, compatibility: 'unknown', usedBy: byHash.get(mod.hash) ?? [] })), collections: index.collections, modpacks: index.modpacks };
  }
  async findContent(file: ContentFile): Promise<string | undefined> {
    if (file.kind !== 'mod') return undefined;
    const index = await this.load();
    for (const item of index.mods) {
      if (item.size !== file.size) continue;
      const path = await this.object(item.hash);
      if (await matches(path, item.hash, 'sha256', item.size) && await matches(path, file.hash, file.algorithm, file.size)) return path;
    }
    return undefined;
  }
  private instanceBase(): string { const root = this.instanceBasePath(); if (!root) throw new Error('Diretório de instâncias não configurado.'); return root; }
  async remove(hash: string): Promise<void> {
    const index = await this.load(); const mod = index.mods.find(m => m.hash === hash); if (!mod) throw new Error('Mod não encontrado na biblioteca.');
    if (index.collections.some(c => c.hashes.includes(hash)) || index.modpacks.some(p => p.hashes.includes(hash))) throw new Error('Remova este mod das coleções e modpacks antes de excluí-lo.');
    const used = await this.list(); if (used.mods.find(m => m.hash === hash)?.usedBy.length) throw new Error('Este arquivo ainda está sendo usado por uma instância.');
    index.mods = index.mods.filter(m => m.hash !== hash); await rm(await this.object(hash)); await this.save(index, 'remove', mod.name);
  }
  async removeFromInstance(instanceId: string, hash: string): Promise<void> {
    const instance = this.instances().find(i => i.id === instanceId && i.installed); if (!instance) throw new Error('Selecione uma instância instalada.');
    const root = safePath(this.instanceBase(), `instances/${instance.id}`); const ledgerPath = safePath(root, '.matrix-library.json'); await noLinks(root, ledgerPath);
    const ledger = ledgerSchema.parse(JSON.parse(await readFile(ledgerPath, 'utf8'))); const entry = ledger.files.find(file => file.hash === hash); if (!entry) throw new Error('Este mod não é gerenciado pela biblioteca nesta instância.');
    const modsDir = safePath(root, 'mods'); const target = safePath(modsDir, entry.filename); await noLinks(root, target);
    if (await lstat(target).then(info => info.isFile() && !info.isSymbolicLink(), error => error.code === 'ENOENT' ? false : Promise.reject(error))) {
      const mod = (await this.load()).mods.find(item => item.hash === hash);
      if (mod && await matches(target, hash, 'sha256', mod.size)) await rm(target);
    }
    ledger.files = ledger.files.filter(file => file.hash !== hash); await atomicJson(root, '.matrix-library.json', ledger); const index = await this.load(); await this.save(index, 'instance.remove', `${entry.filename} de ${instance.name}`);
  }
  async createCollection(input: { name: string; description: string; hashes: string[] }): Promise<LibraryCollection> {
    const index = await this.load(); const allowed = new Set(index.mods.map(m => m.hash)); if (input.hashes.some(hash => !allowed.has(hash))) throw new Error('A coleção referencia um mod que não existe na biblioteca.');
    if (index.collections.some(c => c.name.toLocaleLowerCase() === input.name.toLocaleLowerCase())) throw new Error('Já existe uma coleção com esse nome.');
    const now = Date.now(); const collection = { id: randomUUID(), name: input.name.trim(), description: input.description.trim(), hashes: [...new Set(input.hashes)], createdAt: now, updatedAt: now }; index.collections.push(collection); await this.save(index, 'collection.create', collection.name); return collection;
  }
  async updateCollection(input: Pick<LibraryCollection, 'id' | 'name' | 'description' | 'hashes'>): Promise<LibraryCollection> {
    const index = await this.load(); const current = index.collections.find(c => c.id === input.id); if (!current) throw new Error('Coleção não encontrada.'); const allowed = new Set(index.mods.map(m => m.hash)); if (input.hashes.some(hash => !allowed.has(hash))) throw new Error('A coleção referencia um mod que não existe na biblioteca.');
    Object.assign(current, { name: input.name.trim(), description: input.description.trim(), hashes: [...new Set(input.hashes)], updatedAt: Date.now() }); await this.save(index, 'collection.update', current.name); return current;
  }
  async deleteCollection(id: string): Promise<void> { const index = await this.load(); const item = index.collections.find(c => c.id === id); if (!item) return; index.collections = index.collections.filter(c => c.id !== id); await this.save(index, 'collection.delete', item.name); }
  async createModpack(input: { instanceId: string; name: string; summary: string; hashes: string[] }): Promise<LibraryModpack> {
    const instance = this.instances().find(item => item.id === input.instanceId && item.installed); if (!instance) throw new Error('Selecione uma instância instalada como base do modpack.');
    if (instance.loader === 'vanilla') throw new Error('Modpacks com mods exigem uma instância com loader.');
    const index = await this.load(); const hashes = [...new Set(input.hashes)]; if (hashes.length !== input.hashes.length) throw new Error('A seleção contém mods repetidos.');
    if (hashes.some(hash => !index.mods.some(item => item.hash === hash))) throw new Error('O modpack referencia um arquivo que não está na biblioteca.');
    const now = Date.now(); const pack = modpackSchema.parse({ id: randomUUID(), name: input.name.trim(), summary: input.summary.trim(), minecraft: instance.minecraft, loader: instance.loader, loaderVersion: instance.loaderVersion, hashes, createdAt: now, updatedAt: now }); index.modpacks.push(pack); await this.save(index, 'modpack.create', pack.name); return pack;
  }
  async deleteModpack(id: string): Promise<void> { const index = await this.load(); const pack = index.modpacks.find(item => item.id === id); if (!pack) return; index.modpacks = index.modpacks.filter(item => item.id !== id); await this.save(index, 'modpack.delete', pack.name); }
  async exportModpack(id: string, format: 'matrixpack' | 'mrpack', destination: string): Promise<void> {
    const index = await this.load(); const pack = index.modpacks.find(item => item.id === id); if (!pack) throw new Error('Modpack não encontrado.');
    const mods = pack.hashes.map(hash => index.mods.find(item => item.hash === hash)); if (mods.some(item => !item)) throw new Error('Um arquivo referenciado pelo modpack está ausente.');
    const manifest = matrixpackSchema.parse({ schemaVersion: 1, name: pack.name, summary: pack.summary, minecraft: pack.minecraft, loader: pack.loader, loaderVersion: pack.loaderVersion, mods: mods.map(item => ({ hash: item!.hash, name: item!.name, ...(item!.version ? { version: item!.version } : {}), ...(item!.source ? { source: item!.source } : {}) })) });
    let output: Buffer;
    if (format === 'matrixpack') output = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
    else {
      if (pack.loader === 'vanilla') throw new Error('Um .mrpack com mods precisa declarar Fabric, Forge ou NeoForge.');
      const entries: z.infer<typeof mrpackIndexSchema>['files'] = [];
      for (const item of mods as LibraryMod[]) {
        if (!item.source) throw new Error(`${item.name} não tem uma origem autorizada; ele pode permanecer no manifesto MATRIX, mas não será incluído no .mrpack compartilhável.`);
        const u = new URL(item.source.url); if (u.protocol !== 'https:' || u.hostname !== 'cdn.modrinth.com' || !u.pathname.startsWith(`/data/${item.source.projectId}/versions/${item.source.versionId}/`) || u.search) throw new Error(`${item.name}: origem Modrinth inválida para exportação.`);
        const source = await this.object(item.hash); if (!await matches(source, item.hash, 'sha256', item.size)) throw new Error(`${item.name}: arquivo local não passou na verificação SHA-256.`);
        const filename = safeDisplayName(item.originalName, `${item.id ?? item.hash}.jar`).replace(/[. ]+$/g, ''); const path = `mods/${filename}`;
        if (entries.some(entry => entry.path.toLowerCase() === path.toLowerCase())) throw new Error('Dois mods possuem o mesmo nome de arquivo; renomeie um deles na origem e importe novamente.');
        entries.push({ path, hashes: { sha1: await hashFile(source, 'sha1'), sha512: await hashFile(source, 'sha512') }, downloads: [u.href], fileSize: item.size });
      }
      const loaderKey = pack.loader === 'fabric' ? 'fabric-loader' : pack.loader;
      const indexFile = { formatVersion: 1, game: 'minecraft', versionId: randomUUID(), name: pack.name, ...(pack.summary ? { summary: pack.summary } : {}), files: entries, dependencies: { minecraft: pack.minecraft, [loaderKey]: pack.loaderVersion } };
      output = storedZip([{ name: 'modrinth.index.json', data: Buffer.from(JSON.stringify(indexFile, null, 2), 'utf8') }]);
    }
    const dir = dirname(destination); const target = safePath(dir, basename(destination)); const temp = safePath(dir, `.${basename(destination)}.${randomUUID()}.tmp`); await noLinks(dir, target); await noLinks(dir, temp); await mkdir(dir, { recursive: true });
    try { await writeFile(temp, output, { flag: 'wx' }); await rename(temp, target); } catch (error) { await rm(temp, { force: true }); throw error; }
    await this.save(index, 'modpack.export', `${pack.name} (${format})`);
  }
  async importModpack(file: string, signal: AbortSignal, progress: Progress): Promise<LibraryModpack> {
    const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > MAX_MODPACK_BYTES) throw new Error('Arquivo de modpack inválido ou acima do limite de 1 GB.');
    if (file.toLowerCase().endsWith('.matrixpack') || file.toLowerCase().endsWith('.matrixpack.json')) {
      const raw = await readFile(file, 'utf8'); if (Buffer.byteLength(raw) > MAX_METADATA_BYTES) throw new Error('Manifesto MATRIX excede o limite permitido.'); const manifest = matrixpackSchema.parse(JSON.parse(raw)); const index = await this.load(); const hashes = manifest.mods.map(mod => mod.hash);
      if (hashes.some(hash => !index.mods.some(mod => mod.hash === hash))) throw new Error('Este manifesto MATRIX referencia arquivos que não existem nesta biblioteca. Ele mantém referências locais e não inclui os JARs.');
      const now = Date.now(); const pack = modpackSchema.parse({ id: randomUUID(), name: manifest.name, summary: manifest.summary, minecraft: manifest.minecraft, loader: manifest.loader, loaderVersion: manifest.loaderVersion, hashes, createdAt: now, updatedAt: now }); index.modpacks.push(pack); await this.save(index, 'modpack.import', pack.name); return pack;
    }
    if (!file.toLowerCase().endsWith('.mrpack')) throw new Error('Formato não suportado. Selecione .mrpack ou .matrixpack.');
    const zip = await openZip(file, { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: true }); let indexEntry: import('yauzl').Entry | undefined;
    try {
      if (zip.entryCount > MAX_ARCHIVE_ENTRIES) throw new Error('Modpack contém quantidade excessiva de arquivos.');
      for await (const entry of walkEntriesGenerator(zip)) {
        const name = entry.fileName.replace(/\\/g, '/'); safePath('/matrix-modpack', name.replace(/\/$/, '') || 'folder');
        if (name === 'modrinth.index.json') indexEntry = entry;
        else if (name.startsWith('overrides/') || name.startsWith('client-overrides/') || name.startsWith('server-overrides/')) { if (!name.endsWith('/')) throw new Error('Este modpack contém arquivos de configuração/overrides. A importação segura de overrides ainda não está disponível, então nenhum arquivo foi alterado.'); }
        else if (!name.endsWith('/')) throw new Error(`Arquivo inesperado no modpack: ${name}`);
      }
      if (!indexEntry) throw new Error('O arquivo modrinth.index.json não foi encontrado na raiz do .mrpack.');
      const packIndex = mrpackIndexSchema.parse(JSON.parse(await readBoundedEntry(zip, indexEntry))); const deps = packIndex.dependencies;
      const loaderEntries = Object.entries(deps).filter(([key]) => ['fabric-loader', 'forge', 'neoforge'].includes(key)); if (loaderEntries.length !== 1) throw new Error('O modpack precisa declarar exatamente um loader suportado: Fabric, Forge ou NeoForge.'); const loaderEntry = loaderEntries[0];
      const loader = loaderEntry[0] === 'fabric-loader' ? 'fabric' : loaderEntry[0] as 'forge' | 'neoforge'; const minecraft = deps.minecraft; if (!minecraft || !/^\d+(?:\.\d+){1,2}$/.test(minecraft)) throw new Error('Versão Minecraft inválida no manifesto.');
      const files = packIndex.files.filter(item => item.env?.client !== 'unsupported'); const paths = new Set<string>();
      for (const item of files) { const relative = item.path.replace(/\\/g, '/'); safePath('/matrix-modpack', relative); if (!relative.toLowerCase().startsWith('mods/') || !relative.toLowerCase().endsWith('.jar')) throw new Error(`Somente mods JAR são aceitos nesta versão do importador: ${relative}`); if (paths.has(relative.toLowerCase())) throw new Error('O manifesto repete um caminho de destino.'); paths.add(relative.toLowerCase()); }
      if (!files.length || files.length > MAX_BATCH_FILES) throw new Error('O modpack precisa conter de 1 a 200 mods para importação.');
      const staging = safePath(this.root, `staging/${randomUUID()}`); await mkdir(staging, { recursive: true }); await noLinks(this.root, staging);
      try {
        const paths: string[] = []; const fileByHash = new Map<string, typeof files[number]>(); const total = files.reduce((sum, item) => sum + item.fileSize, 0); if (total > MAX_BATCH_BYTES) throw new Error('O modpack excede o limite de 5 GB.'); await requireSpace(staging, total * 2); let completed = 0;
        for (let i = 0; i < files.length; i++) {
          signal.throwIfAborted(); const entry = files[i]; const url = entry.downloads.map(value => { try { const u = new URL(value); return u.protocol === 'https:' && u.hostname === 'cdn.modrinth.com' ? u : undefined; } catch { return undefined; } }).find(Boolean);
          if (!url) throw new Error(`Nenhuma URL permitida para ${entry.path}; atualmente apenas cdn.modrinth.com é aceita.`);
          const name = basename(entry.path); const destination = safePath(staging, `${i}/${name}`); await downloadFile({ url: url.href, destination, hash: entry.hashes.sha512, algorithm: 'sha512', size: entry.fileSize, hosts: ['cdn.modrinth.com'], signal, progress: (done) => progress(name, completed + done, total, 0) });
          if (await hashFile(destination, 'sha1') !== entry.hashes.sha1) throw new Error(`SHA-1 inválido para ${name}.`); paths.push(destination); fileByHash.set(await hashFile(destination, 'sha256'), entry); completed += entry.fileSize;
        }
        const preview = await this.scan(paths, () => {}, signal); if (preview.candidates.length !== files.length || preview.candidates.some(item => !item.valid)) throw new Error('Um ou mais mods baixados não são JARs válidos.');
        const imported = await this.commitImport(preview.jobId, preview.candidates.map(item => item.hash), signal, progress); const index = await this.load();
        for (const item of preview.candidates) {
          const manifestFile = fileByHash.get(item.hash); const sourceUrl = manifestFile?.downloads.map(value => { try { const u = new URL(value); return u.hostname === 'cdn.modrinth.com' && u.protocol === 'https:' ? u : undefined; } catch { return undefined; } }).find(Boolean); const entry = index.mods.find(mod => mod.hash === item.hash);
          const match = sourceUrl?.pathname.match(/^\/data\/([A-Za-z0-9_-]+)\/versions\/([A-Za-z0-9_-]+)\//);
          if (entry && sourceUrl && match) entry.source ??= { projectId: match[1], versionId: match[2], url: sourceUrl.href, hash: manifestFile!.hashes.sha512, algorithm: 'sha512' };
        }
        const now = Date.now(); const pack = modpackSchema.parse({ id: randomUUID(), name: packIndex.name, summary: packIndex.summary ?? '', minecraft, loader, loaderVersion: loaderEntry[1], hashes: preview.candidates.map(item => item.hash), createdAt: now, updatedAt: now }); index.modpacks.push(pack); await this.save(index, 'modpack.import', `${pack.name}; ${imported.imported} mod(s)`); return pack;
      } finally { await rm(staging, { recursive: true, force: true }); }
    } finally { zip.close(); }
  }
  async planApply(instanceId: string, hashes: string[], allowUnknown: boolean): Promise<LibraryApplyPlan> {
    const instance = this.instances().find(i => i.id === instanceId && i.installed); if (!instance) throw new Error('Selecione uma instância instalada.'); if (instance.loader === 'vanilla') throw new Error('Mods exigem uma instância com Fabric, Forge ou NeoForge.');
    const index = await this.load(); const requested = [...new Set(hashes)]; const selected = requested.map(hash => index.mods.find(m => m.hash === hash)).filter((m): m is LibraryMod => !!m); if (selected.length !== requested.length) throw new Error('Um ou mais mods selecionados não existem na biblioteca.');
    const selectedIds = new Set(selected.flatMap(m => m.id ? [m.id] : [])); const warnings: string[] = []; const incompatible: string[] = [];
    for (const mod of selected) {
      if (mod.loaders.length && !mod.loaders.includes(instance.loader as 'fabric' | 'forge' | 'neoforge')) incompatible.push(`${mod.name}: loader ${mod.loaders.join('/')} não corresponde a ${instance.loader}`);
      const gameSupport = supportsMinecraft(mod, instance.minecraft);
      if (gameSupport === false) incompatible.push(`${mod.name}: incompatível com Minecraft ${instance.minecraft}`);
      if (!mod.loaders.length || gameSupport === undefined) warnings.push(`${mod.name}: compatibilidade desconhecida; confirme que foi criado para este Minecraft e loader.`);
      for (const dep of mod.dependencies.filter(d => !d.optional && !selectedIds.has(d.id))) warnings.push(`${mod.name}: requer ${dep.id}${dep.range ? ` (${dep.range})` : ''}; verifique se já está instalado ou adicione-o à seleção.`);
      for (const conflict of mod.conflicts) if (selectedIds.has(conflict)) incompatible.push(`${mod.name}: conflito declarado com ${conflict}.`);
    }
    if (incompatible.length) throw new Error(incompatible.join('\n'));
    if (warnings.length && !allowUnknown) throw new Error('Há mods com compatibilidade desconhecida ou dependências que precisam de confirmação. Revise os avisos para continuar.');
    const root = safePath(this.instanceBase(), `instances/${instance.id}`); const modsDir = safePath(root, 'mods'); const names = await readdir(modsDir).catch(e => e.code === 'ENOENT' ? [] : Promise.reject(e));
    const ledgerPath = safePath(root, '.matrix-library.json'); let ledger = { schemaVersion: 1 as const, files: [] as { hash: string; filename: string }[] };
    try { ledger = ledgerSchema.parse(JSON.parse(await readFile(ledgerPath, 'utf8'))); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Registro dos mods da biblioteca corrompido; instalação recusada.'); }
    const existingHashes = new Set(ledger.files.map(f => f.hash)); const usedNames = new Set(names.map(n => n.toLocaleLowerCase())); const files: LibraryApplyPlan['files'] = [];
    for (const mod of selected) {
      if (existingHashes.has(mod.hash)) continue;
      const filename = safeDisplayName(basename(mod.originalName, '.jar'), mod.hash).replace(/[. ]+$/g, '') + '.jar';
      if (usedNames.has(filename.toLocaleLowerCase())) throw new Error(`A instância já contém ${filename}; nenhum arquivo será sobrescrito.`);
      files.push({ hash: mod.hash, name: filename, size: mod.size }); usedNames.add(filename.toLocaleLowerCase());
    }
    if (!files.length) throw new Error('Os mods selecionados já estão nesta instância.');
    const plan = { planId: randomUUID(), instanceId, files, warnings, totalBytes: files.reduce((n, f) => n + f.size, 0) }; this.plans.set(plan.planId, plan); if (this.plans.size > 30) this.plans.delete(this.plans.keys().next().value!); return plan;
  }
  async apply(planId: string, signal: AbortSignal, progress: Progress): Promise<void> {
    const plan = this.plans.get(planId); if (!plan) throw new Error('Plano expirou. Faça a seleção novamente.');
    const instance = this.instances().find(i => i.id === plan.instanceId && i.installed); if (!instance || instance.loader === 'vanilla') throw new Error('Instância indisponível ou sem loader.');
    const root = safePath(this.instanceBase(), `instances/${instance.id}`); const modsDir = safePath(root, 'mods'); await mkdir(modsDir, { recursive: true }); await noLinks(root, modsDir);
    const ledgerPath = safePath(root, '.matrix-library.json'); await noLinks(root, ledgerPath); let ledger = { schemaVersion: 1 as const, files: [] as { hash: string; filename: string }[] };
    try { ledger = ledgerSchema.parse(JSON.parse(await readFile(ledgerPath, 'utf8'))); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Registro dos mods da biblioteca corrompido.'); }
    const index = await this.load(); const added: string[] = []; const previous = ledger.files.slice(); let done = 0;
    try {
      for (const item of plan.files) {
        signal.throwIfAborted(); const mod = index.mods.find(m => m.hash === item.hash); if (!mod) throw new Error('Um mod foi removido da biblioteca durante a operação.');
        const source = await this.object(mod.hash); if (!await matches(source, mod.hash, 'sha256', mod.size)) throw new Error(`${mod.name} não passou na verificação SHA-256.`);
        const target = safePath(modsDir, item.name); await noLinks(root, target); const temp = safePath(modsDir, `.${item.name}.${randomUUID()}.tmp`); await noLinks(root, temp);
        if (await lstat(target).then(() => true, e => e.code === 'ENOENT' ? false : Promise.reject(e))) throw new Error(`Arquivo existente preservado: ${item.name}`);
        await copyFile(source, temp); if (!await matches(temp, mod.hash, 'sha256', mod.size)) { await rm(temp, { force: true }); throw new Error(`Falha de integridade ao copiar ${item.name}.`); }
        signal.throwIfAborted(); await rename(temp, target); added.push(target); ledger.files.push({ hash: mod.hash, filename: item.name }); await atomicJson(root, '.matrix-library.json', ledger); done += item.size; progress(item.name, done, plan.totalBytes, 0);
      }
      await this.save(index, 'apply', `${plan.files.length} mod(s) na instância ${instance.name}`); this.plans.delete(planId);
    } catch (e) { for (const file of added.reverse()) if (await lstat(file).then(() => true, () => false)) await rm(file, { force: true }); ledger.files = previous; await atomicJson(root, '.matrix-library.json', ledger); throw e; }
  }
}
