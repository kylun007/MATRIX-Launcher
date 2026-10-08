import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readdir, readFile, copyFile, rename, rm, stat } from 'node:fs/promises';
import { z } from 'zod';
import type { Store } from './store.ts';
import type { Instance } from '../../shared/contracts.ts';
import type { ContentFile } from '../../shared/smart.ts';
import type { ManagedMod, ModPlan } from '../../shared/mod-center.ts';
import { ContentCatalog } from './catalog.ts';
import { downloadFile, matches, requireSpace } from './download.ts';
import { atomicJson } from './smart-config.ts';
import { noLinks, preparePath, safePath } from './security.ts';

const CDN = ['cdn.modrinth.com'];
const fileSchema = z.object({ projectId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), slug: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), title: z.string().min(1).max(250), versionId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), version: z.string().min(1).max(250), kind: z.literal('mod'), filename: z.string().min(1).max(240), url: z.string().url(), hash: z.string().regex(/^[a-f0-9]+$/), algorithm: z.enum(['sha1', 'sha256', 'sha512']), size: z.number().int().positive().max(2 ** 31), license: z.string().min(1).max(250), sourceUrl: z.string().url(), enabled: z.boolean().optional(), dependencies: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,100}$/)).max(100).optional() }).strict();
const registrySchema = z.object({ schemaVersion: z.literal(1), instanceId: z.string().uuid(), files: z.array(fileSchema).max(300) }).strict();
type Registry = z.infer<typeof registrySchema>;
type Progress = (file: string, bytes: number, total: number, speed: number) => void;
async function exists(file: string): Promise<boolean> { try { return (await stat(file)).isFile(); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; } }

/** Mod Center shares the Modrinth catalog, verified downloader and per-instance directory used by Smart Install. */
export class ModCenterService {
  private plans = new Map<string, ModPlan>();
  constructor(private store: Store, private catalog: ContentCatalog, private smartContent: (id: string) => Promise<{ mods: ContentFile[] }>, private storeSmartToggle?: (id: string, projectId: string, enabled: boolean) => Promise<void>) {}
  private instance(id: string): Instance { const i = this.store.data.instances.find(x => x.id === id); if (!i || !i.installed) throw new Error('Selecione uma instância instalada.'); return i; }
  private root(i: Instance): string { return safePath(this.store.data.settings.gameDirectory, `instances/${i.id}`); }
  private mods(i: Instance): string { return safePath(this.root(i), 'mods'); }
  private async registry(i: Instance): Promise<Registry> {
    const root = this.root(i); const file = safePath(root, '.matrix-mod-center.json'); await noLinks(this.store.data.settings.gameDirectory, file);
    try { const parsed = registrySchema.parse(JSON.parse(await readFile(file, 'utf8'))); if (parsed.instanceId !== i.id) throw new Error('Registro de mods pertence a outra instância.'); for (const entry of parsed.files) this.validate(entry); return parsed; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, instanceId: i.id, files: [] }; throw e; }
  }
  private async save(i: Instance, registry: Registry): Promise<void> { await atomicJson(this.root(i), '.matrix-mod-center.json', registrySchema.parse(registry)); }
  private validate(file: ContentFile): asserts file is ContentFile & { kind: 'mod' } {
    const f = fileSchema.parse(file); if (f.filename.includes('/') || f.filename.includes('\\') || /[\r\n]/.test(f.filename) || !f.filename.toLowerCase().endsWith('.jar')) throw new Error('Arquivo de mod inválido.');
    if (!f.sourceUrl.startsWith('https://modrinth.com/')) throw new Error('Fonte do mod inválida.');
    const hashLength = f.algorithm === 'sha512' ? 128 : f.algorithm === 'sha256' ? 64 : 40; if (f.hash.length !== hashLength) throw new Error('Hash de mod inválido.');
    safePath('/matrix', f.filename);
  }
  async plan(instanceId: string, projectId: string, signal?: AbortSignal): Promise<ModPlan> {
    const i = this.instance(instanceId);
    if (i.loader === 'vanilla') throw new Error('Esta instância não possui loader de mods. Crie ou selecione uma instância Fabric, Forge ou NeoForge.');
    const files = await this.catalog.resolveProject(projectId, i.minecraft, i.loader, signal);
    for (const f of files) this.validate(f);
    const registry = await this.registry(i); const smart = i.smart ? await this.smartContent(i.id) : { mods: [] }; const smartIds = new Set(smart.mods.map(f => f.projectId));
    const current = new Map(registry.files.map(f => [f.projectId, f]));
    const planFiles = files.filter(f => { if (smartIds.has(f.projectId)) return false; const old = current.get(f.projectId); return !old || old.versionId !== f.versionId; });
    const replacements = planFiles.map(f => current.get(f.projectId)).filter((f): f is ContentFile & { kind: 'mod' } => !!f);
    if (!planFiles.length) throw new Error('Este mod e suas dependências já estão instalados.');
    const names = new Set<string>(); for (const f of planFiles) { const key = f.filename.toLocaleLowerCase(); if (names.has(key)) throw new Error('Há arquivos com nomes repetidos no plano.'); names.add(key); }
    const plan = { id: randomUUID(), instanceId, projectId, files: planFiles, totalBytes: planFiles.reduce((s, f) => s + f.size, 0), warnings: ['Mods são código de terceiros; instale apenas projetos em que confia.', 'Dependências obrigatórias compatíveis serão incluídas no mesmo plano.'] };
    Object.assign(plan, { replacements }); if (replacements.length) plan.warnings.push('A versão atual será substituída com backup; os outros mods, configurações e mundos serão preservados.'); this.plans.set(plan.id, plan); if (this.plans.size > 30) this.plans.delete(this.plans.keys().next().value!); return plan;
  }
  async install(planId: string, signal: AbortSignal, progress: Progress): Promise<void> {
    const plan = this.plans.get(planId); if (!plan) throw new Error('Plan expired; review the installation again.');
    const i = this.instance(plan.instanceId); const registry = await this.registry(i); const previous = registry.files.slice(); const root = this.root(i); const mods = this.mods(i);
    await requireSpace(root, plan.totalBytes * 2); await noLinks(this.store.data.settings.gameDirectory, root);
    const added: { file: ContentFile; path: string }[] = []; const backups: { backup: string; original: string }[] = []; let staging: string | undefined;
    try {
      let done = 0;
      for (const f of plan.files) {
        signal.throwIfAborted(); this.validate(f); const old = registry.files.find(x => x.projectId === f.projectId);
        const enabledPath = old ? safePath(mods, old.filename) : undefined; const disabledPath = old ? safePath(mods, `${old.filename}.disabled`) : undefined;
        const enabled = old ? old.enabled ?? await matches(enabledPath!, old.hash, old.algorithm, old.size) : true;
        const oldPath = old ? enabled ? enabledPath! : disabledPath! : undefined;
        if (old && !await matches(oldPath!, old.hash, old.algorithm, old.size)) throw new Error(`Managed file changed or missing: ${old.filename}; it was preserved.`);
        const target = safePath(mods, `${f.filename}${enabled ? '' : '.disabled'}`); await noLinks(root, target);
        const cache = safePath(this.store.data.settings.gameDirectory, `.matrix-cache/mods/${f.hash}.${f.algorithm}`); await noLinks(this.store.data.settings.gameDirectory, cache);
        await downloadFile({ url: f.url, destination: cache, hash: f.hash, algorithm: f.algorithm, size: f.size, hosts: CDN, signal, progress: (b, _t, s) => progress(f.filename, done + b, plan.totalBytes, s) });
        staging = safePath(mods, `.${f.filename}.${randomUUID()}.tmp`); await noLinks(root, staging); await copyFile(cache, staging); signal.throwIfAborted();
        if (old && oldPath) {
          const backup = await preparePath(root, `.matrix-backups/mod-center/${plan.id}/${old.filename}${enabled ? '' : '.disabled'}`);
          await rename(oldPath, backup); backups.push({ backup, original: oldPath });
        }
        if (await exists(target)) throw new Error(`Existing personal file preserved: ${f.filename}.`);
        await rename(staging, target); staging = undefined; added.push({ file: { ...f, enabled }, path: target });
        registry.files = registry.files.filter(entry => entry.projectId !== f.projectId); registry.files.push({ ...f, enabled }); await this.save(i, registry); done += f.size;
      }
      this.plans.delete(planId);
    } catch (error) {
      if (staging) await rm(staging, { force: true }).catch(() => {});
      for (const entry of added.reverse()) if (await matches(entry.path, entry.file.hash, entry.file.algorithm, entry.file.size)) await rm(entry.path, { force: true });
      for (const backup of backups.reverse()) { await noLinks(root, backup.backup); await noLinks(root, backup.original); await rename(backup.backup, backup.original); }
      registry.files = previous; await this.save(i, registry); throw error;
    }
  }
  async list(instanceId: string): Promise<ManagedMod[]> {
    const i = this.instance(instanceId); const registry = await this.registry(i); const entries = new Map<string, ManagedMod>();
    for (const f of registry.files) { const on = safePath(this.mods(i), f.filename); const off = safePath(this.mods(i), `${f.filename}.disabled`); const enabled = await matches(on, f.hash, f.algorithm, f.size); const intact = enabled || await matches(off, f.hash, f.algorithm, f.size); entries.set(f.filename, { filename: f.filename, title: f.title, version: f.version, projectId: f.projectId, enabled, managed: true, source: 'mod-center', status: intact ? 'ok' : 'modified' }); }
    for (const f of (i.smart ? (await this.smartContent(i.id)).mods : [])) entries.set(f.filename, { filename: f.filename, title: f.title, version: f.version, projectId: f.projectId, enabled: f.enabled !== false, managed: true, source: 'smart', status: await matches(safePath(this.mods(i), `${f.filename}${f.enabled === false ? '.disabled' : ''}`), f.hash, f.algorithm, f.size) ? 'ok' : 'modified' });
    await noLinks(this.root(i), this.mods(i)); const names = await readdir(this.mods(i), { withFileTypes: true }).catch(e => e.code === 'ENOENT' ? [] : Promise.reject(e));
    if (names.length > 1000) throw new Error('Há muitos arquivos na pasta mods.');
    for (const entry of names) { if (!entry.isFile() || (!entry.name.toLowerCase().endsWith('.jar') && !entry.name.toLowerCase().endsWith('.jar.disabled'))) continue; const enabled = entry.name.toLowerCase().endsWith('.jar'); const filename = enabled ? entry.name : entry.name.slice(0, -'.disabled'.length); if (!entries.has(filename)) entries.set(filename, { filename, title: filename.replace(/\.jar$/i, ''), enabled, managed: false, source: 'manual', status: 'manual' }); }
    return [...entries.values()].sort((a, b) => a.title.localeCompare(b.title));
  }
  async toggle(instanceId: string, filename: string, enabled: boolean): Promise<void> {
    const i = this.instance(instanceId); const root = this.root(i); const mods = this.mods(i); const registry = await this.registry(i);
    const file = registry.files.find(f => f.filename === filename); const smart = file || !i.smart ? undefined : (await this.smartContent(i.id)).mods.find(f => f.filename === filename);
    if (file && !enabled && registry.files.some(other => other.projectId !== file.projectId && other.dependencies?.includes(file.projectId))) throw new Error('Outro mod instalado depende deste arquivo; remova ou atualize primeiro o mod dependente.');
    if (smart) { if (!this.storeSmartToggle) throw new Error('Gerenciador Smart indisponível.'); await this.storeSmartToggle(i.id, smart.projectId, enabled); return; }
    const fromName = enabled ? `${filename}.disabled` : filename; const toName = enabled ? filename : `${filename}.disabled`;
    const from = safePath(mods, fromName); const to = safePath(mods, toName); await noLinks(root, from); await noLinks(root, to);
    if (file && !await matches(from, file.hash, file.algorithm, file.size)) throw new Error('O arquivo foi alterado ou está corrompido; nenhuma mudança foi feita.');
    if (await exists(to)) throw new Error('Já existe um arquivo no destino.');
    await rename(from, to);
  }
  async remove(instanceId: string, filename: string): Promise<void> {
    const i = this.instance(instanceId); const root = this.root(i); const mods = this.mods(i); const registry = await this.registry(i); const f = registry.files.find(x => x.filename === filename);
    if (!f) { const smart = i.smart ? (await this.smartContent(i.id)).mods.find(x => x.filename === filename) : undefined; if (smart) throw new Error('Este mod pertence ao Smart Install. Para preservar o plano e a reparação, gerencie-o na aba Smart Install.'); throw new Error('Somente mods instalados pelo MATRIX Mod Center podem ser removidos aqui. Mods pessoais foram preservados.'); }
    if (registry.files.some(other => other.projectId !== f.projectId && other.dependencies?.includes(f.projectId))) throw new Error('Outro mod instalado depende deste projeto; remova primeiro o mod dependente.');
    const enabledPath = safePath(mods, filename); const disabledPath = safePath(mods, `${filename}.disabled`); const path = await matches(enabledPath, f.hash, f.algorithm, f.size) ? enabledPath : disabledPath; await noLinks(root, path); if (!await matches(path, f.hash, f.algorithm, f.size)) throw new Error('Arquivo modificado preservado. Abra a pasta da instância para inspecioná-lo.');
    await rm(path); registry.files = registry.files.filter(x => x.projectId !== f.projectId); await this.save(i, registry);
  }
  favorites(): string[] { return this.store.data.modFavorites; }
  async favorite(projectId: string, favorite: boolean): Promise<void> { const next = new Set(this.store.data.modFavorites); if (favorite) next.add(projectId); else next.delete(projectId); this.store.data.modFavorites = [...next].slice(0, 500); await this.store.save(); }
}
