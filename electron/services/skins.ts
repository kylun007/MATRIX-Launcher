import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, unlink, lstat, copyFile } from 'node:fs/promises';
import { PNG } from 'pngjs';
import { inflateSync } from 'node:zlib';
import { z } from 'zod';
import { skinDocumentSchema, skinProjectSchema, skinSaveSchema, skinDraftSchema, type SkinDocument, type SkinProject, type SkinEntry, type SkinSave, type SkinDraft, type SkinModel } from '../../shared/skin.ts';
import { convertLegacy, normalizePixels } from '../../shared/skin-pixels.ts';
import { safePath, noLinks, preparePath } from './security.ts';

const MAX_PROJECT = 128 * 1024;
const MAX_SKIN = 1024 * 1024;
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const validId = z.string().uuid();

function inspectPNG(bytes: Buffer, maxSize: number, skin: boolean): { width: number; height: number } {
  if (bytes.length < 33 || bytes.length > maxSize || !bytes.subarray(0, 8).equals(signature) || bytes.toString('ascii', 12, 16) !== 'IHDR' || bytes.readUInt32BE(8) !== 13) throw new Error('Arquivo PNG inválido ou maior que o limite permitido.');
  const width = bytes.readUInt32BE(16); const height = bytes.readUInt32BE(20);
  if (skin ? width !== 64 || ![32, 64].includes(height) : width < 1 || height < 1 || width > 2048 || height > 2048) throw new Error(skin ? 'A skin deve ter 64×64 ou 64×32 pixels.' : 'A prévia deve ter no máximo 2048×2048 pixels.');
  const compressed: Buffer[] = []; let ended = false;
  for (let offset = 8; offset < bytes.length;) {
    if (offset + 12 > bytes.length) throw new Error('PNG incompleto.');
    const size = bytes.readUInt32BE(offset); const kind = bytes.toString('ascii', offset + 4, offset + 8);
    if (size > bytes.length - offset - 12 || (kind === 'IHDR' && offset !== 8)) throw new Error('Estrutura PNG inválida.');
    if (kind === 'IDAT') compressed.push(bytes.subarray(offset + 8, offset + 8 + size));
    if (kind === 'IEND') { if (size !== 0 || offset + 12 !== bytes.length) throw new Error('Estrutura PNG inválida.'); ended = true; }
    offset += size + 12;
  }
  if (!ended || !compressed.length) throw new Error('PNG incompleto.');
  // pngjs bounds ordinary PNG inflation, but its Adam7 branch uses unbounded inflate.
  // Bound that branch before decoding to reject compressed payloads larger than the image.
  if (bytes[28] !== 0) {
    try { inflateSync(Buffer.concat(compressed), { maxOutputLength: width * height * 8 + height * 8 + 1024 }); }
    catch { throw new Error('PNG interlaçado inválido ou expansão excessiva.'); }
  }
  return { width, height };
}

export function decodeSkinPNG(bytes: Buffer, model: SkinModel = 'classic'): SkinDocument {
  const { height } = inspectPNG(bytes, MAX_SKIN, true);
  let png: PNG;
  try { png = PNG.sync.read(bytes, { checkCRC: true }); } catch { throw new Error('PNG corrompido. Não foi possível importar a skin.'); }
  let pixels: Uint8ClampedArray = new Uint8ClampedArray(png.data);
  if (height === 32) { pixels = convertLegacy(pixels); model = 'classic'; }
  pixels = normalizePixels(pixels, model);
  return skinDocumentSchema.parse({ name: 'Skin importada', model, pixels: Buffer.from(pixels).toString('base64'), palette: [] });
}

export function encodeSkinPNG(document: SkinDocument): Buffer {
  const data = skinDocumentSchema.parse({ name: document.name, model: document.model, pixels: document.pixels, palette: document.palette });
  const pixels = normalizePixels(new Uint8ClampedArray(Buffer.from(data.pixels, 'base64')), data.model);
  return PNG.sync.write({ width: 64, height: 64, data: Buffer.from(pixels) } as PNG, { colorType: 6, bitDepth: 8 });
}

export function decodePreviewPNG(value: string): Buffer {
  const raw = value.startsWith('data:image/png;base64,') ? value.slice(22) : value;
  if (raw.length > 6_000_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(raw)) throw new Error('Prévia PNG inválida.');
  const bytes = Buffer.from(raw, 'base64'); inspectPNG(bytes, 4 * 1024 * 1024, false);
  try { const png = PNG.sync.read(bytes, { checkCRC: true }); return PNG.sync.write(png, { colorType: 6 }); } catch { throw new Error('Prévia PNG corrompida.'); }
}

/** Project files only. Original imports and account tokens never enter this directory. */
export class SkinLibrary {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly root: string) {}

  private serialized<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action); this.queue = result.catch(() => undefined); return result;
  }
  private async path(file: string): Promise<string> { const path = safePath(this.root, file); await noLinks(this.root, path); return path; }
  private async initialize(): Promise<void> {
    await noLinks(this.root, this.root); await mkdir(this.root, { recursive: true }); await noLinks(this.root, this.root);
  }
  private async boundedRead(file: string): Promise<string> {
    const path = await this.path(file); const info = await lstat(path);
    if (!info.isFile() || info.size > MAX_PROJECT) throw new Error('Projeto de skin inválido ou muito grande.');
    const contents = await readFile(path); if (contents.length > MAX_PROJECT) throw new Error('Projeto muito grande.'); return contents.toString('utf8');
  }
  private async write(file: string, value: unknown, preserve = true): Promise<void> {
    await this.initialize(); const target = await preparePath(this.root, file);
    const temporary = await preparePath(this.root, `${file}.${randomUUID()}.tmp`);
    const bytes = Buffer.from(JSON.stringify(value)); if (bytes.length > MAX_PROJECT) throw new Error('Projeto muito grande.');
    let handle;
    try {
      handle = await open(temporary, 'wx'); await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = undefined;
      await noLinks(this.root, target);
      if (preserve) {
        const backup = await this.path(`${file}.bak`);
        try { await copyFile(target, backup); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      }
      await rename(temporary, target);
    } finally { await handle?.close(); await unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
  }
  private async readRecover<T>(file: string, schema: z.ZodType<T>): Promise<T | undefined> {
    try { return schema.parse(JSON.parse(await this.boundedRead(file))); }
    catch (original) {
      try { const recovered = schema.parse(JSON.parse(await this.boundedRead(`${file}.bak`))); await this.write(file, recovered, false); return recovered; }
      catch (backup) {
        if ((original as NodeJS.ErrnoException).code === 'ENOENT' && (backup as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw new Error('Projeto corrompido. Preserve os arquivos e use um backup válido para recuperá-lo.');
      }
    }
  }
  private async readProject(id: string): Promise<SkinProject> {
    validId.parse(id); const project = await this.readRecover(`${id}.json`, skinProjectSchema);
    if (!project) throw new Error('Skin não encontrada na biblioteca.');
    if (project.id !== id) throw new Error('Identidade do projeto inválida.'); return project;
  }
  async list(): Promise<SkinEntry[]> {
    return this.serialized(async () => {
      await this.initialize(); const files = await readdir(this.root); const entries: SkinEntry[] = [];
      for (const file of files) {
        if (!file.endsWith('.json') || !validId.safeParse(file.slice(0, -5)).success) continue;
        if (entries.length >= 500) break;
        try { const project = await this.readProject(file.slice(0, -5)); const { pixels: _pixels, ...entry } = project; entries.push({ ...entry, thumbnail: `data:image/png;base64,${encodeSkinPNG(project).toString('base64')}` }); }
        catch { /* A damaged project is retained for diagnosis; other skins remain usable. */ }
      }
      return entries.sort((a, b) => b.createdAt - a.createdAt);
    });
  }
  async open(id: string): Promise<SkinProject> { return this.serialized(() => this.readProject(id)); }
  private async saveInternal(input: SkinSave): Promise<SkinProject> {
    const request = skinSaveSchema.parse(input); let previous: SkinProject | undefined;
    if (request.id) {
      previous = await this.readProject(request.id);
      if (request.revision !== previous.revision) throw new Error('A skin foi alterada em outra operação. Reabra o projeto antes de salvar.');
    } else {
      await this.initialize(); const files = await readdir(this.root);
      if (files.filter(f => f.endsWith('.json') && validId.safeParse(f.slice(0, -5)).success).length >= 500) throw new Error('A biblioteca atingiu o limite de 500 skins. Exporte projetos antes de remover arquivos.');
    }
    const document = skinDocumentSchema.parse(request.document);
    const pixels = normalizePixels(new Uint8ClampedArray(Buffer.from(document.pixels, 'base64')), document.model);
    const now = Date.now(); const project = skinProjectSchema.parse({ ...document, pixels: Buffer.from(pixels).toString('base64'), schemaVersion: 1, id: previous?.id ?? randomUUID(), revision: (previous?.revision ?? -1) + 1, createdAt: previous?.createdAt ?? now, updatedAt: now });
    await this.write(`${project.id}.json`, project); return project;
  }
  async save(input: SkinSave): Promise<SkinProject> { return this.serialized(() => this.saveInternal(input)); }
  async rename(id: string, name: string): Promise<SkinProject> {
    return this.serialized(async () => { const project = await this.readProject(id); return this.saveInternal({ id, revision: project.revision, document: { name, model: project.model, pixels: project.pixels, palette: project.palette } }); });
  }
  async duplicate(id: string): Promise<SkinProject> {
    return this.serialized(async () => { const project = await this.readProject(id); return this.saveInternal({ document: { name: `${project.name.slice(0, 72)} (cópia)`, model: project.model, pixels: project.pixels, palette: project.palette } }); });
  }
  async delete(id: string): Promise<void> {
    return this.serialized(async () => {
      await this.readProject(id); const target = await preparePath(this.root, `trash/${id}-${Date.now()}-${randomUUID()}.json`);
      // Backup is preserved in the trash too; readRecover must never resurrect a deleted entry.
      try { await rename(await this.path(`${id}.json.bak`), `${target}.bak`); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      await rename(await this.path(`${id}.json`), target);
    });
  }
  async getDraft(): Promise<SkinDraft | undefined> { return this.serialized(() => this.readRecover('draft.json', skinDraftSchema)); }
  async saveDraft(value: SkinDraft): Promise<void> {
    return this.serialized(async () => {
      const draft = skinDraftSchema.parse(value); const previous = await this.readRecover('draft.json', skinDraftSchema);
      if (previous && previous.savedAt > draft.savedAt) throw new Error('Rascunho desatualizado.');
      await this.write('draft.json', draft);
    });
  }
  async clearDraft(): Promise<void> {
    return this.serialized(async () => {
      for (const file of ['draft.json', 'draft.json.bak']) { try { await unlink(await this.path(file)); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } }
    });
  }
}
