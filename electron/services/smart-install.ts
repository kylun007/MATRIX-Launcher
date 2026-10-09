import { randomUUID } from 'node:crypto';
import { totalmem } from 'node:os';
import { join } from 'node:path';
import { readFile, stat, copyFile, rename, rm, readdir } from 'node:fs/promises';
import { z } from 'zod';
import { smartRequestSchema, smartPreferencesSchema, type SmartRequest, type SmartPlan, type SmartProgress, type ContentFile, type InstalledContent } from '../../shared/smart.ts';
import type { Instance } from '../../shared/contracts.ts';
import { Store } from './store.ts';
import { Minecraft, instanceDirectory, type Transfer } from './minecraft.ts';
import { ContentCatalog } from './catalog.ts';
import { detectJava, installJava, javaRequirement, probeJava } from './java.ts';
import { downloadFile, matches, requireSpace } from './download.ts';
import { preparePath, safePath, noLinks, secureUrl, friendlyError } from './security.ts';
import { atomicJson, applyPreferences, selectShader, activeShader } from './smart-config.ts';
import { readFabricMetadata, validateFabricDependencies, validateShaderArchive, ContentCompatibilityError, type FabricMetadata } from './content-validation.ts';

const contentSchema = z.object({
  projectId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), slug: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), title: z.string().min(1).max(250),
  versionId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), version: z.string().min(1).max(250), kind: z.enum(['mod', 'shader']),
  filename: z.string().min(1).max(240), url: z.string().url(), hash: z.string().regex(/^[a-f0-9]+$/), algorithm: z.enum(['sha1', 'sha256', 'sha512']),
  size: z.number().int().positive().max(2 ** 31), license: z.string().min(1).max(250), sourceUrl: z.string().url(), enabled: z.boolean().optional(), dependencies: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,100}$/)).max(100).optional(),
}).strict();
const planSchema = z.object({ id: z.string().uuid(), request: smartRequestSchema, minecraft: z.literal('1.21.1'), fabric: z.string().regex(/^[A-Za-z0-9._+-]{1,80}$/), files: z.array(contentSchema).max(100), warnings: z.array(z.string().max(2000)).max(100), java: z.object({ major: z.literal(21), component: z.string().regex(/^[A-Za-z0-9._-]+$/), path: z.string().max(1024).optional(), installRequired: z.boolean() }), contentBytes: z.number().nonnegative(), requiredDiskBytes: z.number().nonnegative(), createdAt: z.number() });
const journalSchema = z.object({ schemaVersion: z.literal(1), instanceId: z.string().uuid(), plan: planSchema, managed: z.array(contentSchema).max(150), preferences: smartPreferencesSchema, completedStages: z.array(z.string().max(100)).max(20), configurationApplied: z.boolean(), enableIris: z.boolean().optional() });
type Journal = z.infer<typeof journalSchema>;
export type SmartTransfer = (label: string, bytes: number, total: number, speed: number, detail: SmartProgress) => void;
const CDN = ['cdn.modrinth.com'];
const JOURNAL = '.matrix-smart.json';
function validateContent(file: ContentFile): void {
  secureUrl(file.url, CDN); secureUrl(file.sourceUrl, ['modrinth.com']);
  if (file.filename.includes('/') || file.filename.includes('\\') || /[\r\n=]/.test(file.filename)) throw new Error('Nome de conteúdo inválido');
  safePath('/matrix', file.filename);
  if (!file.filename.endsWith(file.kind === 'mod' ? '.jar' : '.zip')) throw new Error('Extensão de conteúdo inválida');
  const length = file.algorithm === 'sha512' ? 128 : file.algorithm === 'sha256' ? 64 : 40;
  if (!new RegExp(`^[a-f0-9]{${length}}$`).test(file.hash)) throw new Error('Hash de conteúdo inválido');
}
function memoryCheck(maxMemory: number): void {
  if (maxMemory * 1048576 > totalmem() - 1073741824) throw new Error('Reserve pelo menos 1 GB de RAM para o sistema; reduza a memória da instância');
}
export class SmartInstallService {
  private plans = new Map<string, { plan: SmartPlan; instanceId?: string; enableIris?: boolean }>();
  private libraryLookup?: (file: ContentFile) => Promise<string | undefined>;
  constructor(private store: Store, private minecraft: Minecraft, readonly catalog = new ContentCatalog(), private runtime = { detectJava, installJava, probeJava }) {}
  setLibraryLookup(lookup: (file: ContentFile) => Promise<string | undefined>): void { this.libraryLookup = lookup; }
  private instance(id: string): Instance { const i = this.store.data.instances.find(i => i.id === id); if (!i?.smart) throw new Error('Instância Smart Install não encontrada'); return i; }
  private root(i: Instance): string { return instanceDirectory(this.store.data.settings, i); }
  private async journal(i: Instance): Promise<Journal> {
    const root = this.root(i); const path = safePath(root, JOURNAL); await noLinks(this.store.data.settings.gameDirectory, path);
    const journal = journalSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    if (journal.instanceId !== i.id || journal.plan.minecraft !== i.minecraft) throw new Error('Registro Smart Install não corresponde à instância');
    for (const file of [...journal.plan.files, ...journal.managed]) validateContent(file);
    return journal;
  }
  private async saveJournal(i: Instance, journal: Journal): Promise<void> { await atomicJson(this.root(i), JOURNAL, journalSchema.parse(journal)); }
  private async compatibleMods(slugs: string[], loader: string, signal: AbortSignal, progress?: Transfer): Promise<{ files: ContentFile[]; warnings: string[] }> {
    const rejected = new Set<string>(); const metadataCache = new Map<string, FabricMetadata[]>(); const warnings: string[] = [];
    for (let attempt = 0; attempt < 20; attempt++) {
      signal.throwIfAborted(); const files = await this.catalog.resolveMods(slugs, signal, rejected);
      const records: { file: ContentFile; metadata: FabricMetadata[] }[] = []; let received = 0; const total = files.reduce((s, f) => s + f.size, 0);
      await requireSpace(this.store.data.settings.gameDirectory, total * 2);
      for (let index = 0; index < files.length; index++) {
        const file = files[index]; let metadata = metadataCache.get(file.hash);
        if (!metadata) {
          const cache = await this.cached(file, signal, (b, _t, speed) => progress?.(`Verificando ${file.title}`, received + b, total, speed, { file: file.filename, filesDone: index, filesTotal: files.length }));
          metadata = await readFabricMetadata(cache); metadataCache.set(file.hash, metadata);
        }
        received += file.size; records.push({ file, metadata });
      }
      try { validateFabricDependencies(records.flatMap(r => r.metadata), loader); return { files, warnings }; }
      catch (e) {
        if (!(e instanceof ContentCompatibilityError)) throw e;
        const offender = records.find(r => r.metadata.some(m => m.id === e.modId));
        if (!offender || rejected.has(offender.file.versionId)) throw e;
        rejected.add(offender.file.versionId); warnings.push(`${offender.file.title} ${offender.file.version} recusado: ${e.message}`);
      }
    }
    throw new Error('Não foi possível encontrar uma combinação compatível em 20 tentativas. Remova um mod opcional e revise o plano.');
  }
  async plan(input: SmartRequest, signal?: AbortSignal, instanceId?: string, progress?: Transfer): Promise<SmartPlan> {
    signal ??= AbortSignal.timeout(15 * 60_000);
    const request = smartRequestSchema.parse(input); memoryCheck(request.preferences.maxMemory);
    await requireSpace(this.store.data.settings.gameDirectory, 2_500_000_000);
    if (request.shaderProject && !request.mods.includes('iris')) request.mods.push('iris');
    const fabric = await this.catalog.fabric(signal);
    const probe: Instance = { id: randomUUID(), name: request.name, minecraft: '1.21.1', loader: 'fabric', loaderVersion: fabric, installed: false };
    const info = await this.minecraft.metadata(probe, this.store.data.settings, signal);
    const major = javaRequirement(info, info.id); if (major !== 21 || !info.javaVersion?.component) throw new Error('Metadados oficiais Java 21 não reconhecidos');
    const compatible = await this.compatibleMods(request.mods, fabric, signal, progress); const files = compatible.files.map(file => ({ ...file }));
    if (request.shaderProject) files.push(await this.catalog.resolveShader(request.shaderProject, signal));
    const names = new Set<string>(); for (const file of files) { validateContent(file); const key = `${file.kind}/${file.filename}`.toLowerCase(); if (names.has(key)) throw new Error('Arquivos duplicados no plano'); names.add(key); }
    const settings = this.store.data.settings; const found = await this.runtime.detectJava(join(settings.gameDirectory, 'runtimes'), settings.javaPath);
    const java = found.find(j => j.major === major); const contentBytes = files.reduce((s, f) => s + f.size, 0);
    const plan: SmartPlan = { id: randomUUID(), request, minecraft: '1.21.1', fabric, files, java: { major, component: info.javaVersion.component, path: java?.path, installRequired: !java }, contentBytes, requiredDiskBytes: 2_500_000_000 + contentBytes * 2, createdAt: Date.now(), warnings: ['A recomendação de hardware é uma estimativa, sem garantia de FPS.', 'O plano confere dependências publicadas. Os requisitos internos dos JARs serão verificados antes de ativar os mods.', 'Os arquivos são baixados diretamente dos autores via Modrinth; suas licenças continuam aplicáveis.'] };
    await requireSpace(settings.gameDirectory, plan.requiredDiskBytes);
    plan.warnings.push(...compatible.warnings);
    if (instanceId) plan.warnings.push('Atualização autorizada: somente arquivos gerenciados intactos serão substituídos, com backups. Configurações, mods pessoais e mundos serão preservados.');
    this.plans.set(plan.id, { plan, instanceId }); if (this.plans.size > 20) this.plans.delete(this.plans.keys().next().value!);
    return plan;
  }
  async update(id: string, signal?: AbortSignal, progress?: Transfer): Promise<SmartPlan> { const i = this.instance(id); const j = await this.journal(i); return this.plan({ ...j.plan.request, name: i.name, preferences: j.preferences }, signal, id, progress); }
  async shaderPlan(id: string, projectId: string, signal?: AbortSignal, progress?: Transfer): Promise<SmartPlan> { const i = this.instance(id); const j = await this.journal(i); const plan = await this.plan({ ...j.plan.request, name: i.name, preferences: j.preferences, shaderProject: projectId }, signal, id, progress); this.plans.get(plan.id)!.enableIris = true; plan.warnings.push('Este plano inclui ativar Iris e suas dependências para oferecer suporte ao shader.'); return plan; }
  async install(planId: string, allowJava: boolean, signal: AbortSignal, progress: SmartTransfer): Promise<string> {
    const held = this.plans.get(planId); if (!held || Date.now() - held.plan.createdAt > 30 * 60_000) throw new Error('Plano expirado. Revise um novo plano antes de instalar.');
    const plan = planSchema.parse(held.plan) as SmartPlan;
    if (plan.java.installRequired && !allowJava) throw new Error('Autorize explicitamente a instalação do Java oficial para continuar');
    await requireSpace(this.store.data.settings.gameDirectory, plan.requiredDiskBytes); signal.throwIfAborted();
    let i: Instance;
    if (held.instanceId) {
      i = this.instance(held.instanceId); const journal = await this.journal(i);
      journal.plan = plan; journal.completedStages = []; journal.enableIris = held.enableIris; await this.saveJournal(i, journal);
    } else {
      if (this.store.data.instances.length >= 100) throw new Error('Limite de 100 instalações atingido');
      i = { id: randomUUID(), name: plan.request.name, minecraft: plan.minecraft, loader: 'fabric', loaderVersion: plan.fabric, installed: false, smart: { preset: plan.request.preset, status: 'pending', planId: plan.id } };
      // Persist the plan before exposing the new profile; resume never trusts renderer-supplied URLs.
      await this.saveJournal(i, { schemaVersion: 1, instanceId: i.id, plan, managed: [], preferences: plan.request.preferences, completedStages: [], configurationApplied: false });
      this.store.data.instances.push(i);
    }
    this.plans.delete(planId); this.store.data.selectedInstance = i.id;
    i.smart = { preset: plan.request.preset, status: 'pending', planId: plan.id }; await this.store.save();
    await this.execute(i, allowJava, signal, progress); return i.id;
  }
  async resume(id: string, allowJava: boolean, signal: AbortSignal, progress: SmartTransfer): Promise<void> { await this.execute(this.instance(id), allowJava, signal, progress); }
  private async cached(file: ContentFile, signal: AbortSignal, progress?: (bytes: number, total: number, speed: number) => void): Promise<string> {
    validateContent(file); const root = this.store.data.settings.gameDirectory;
    const destination = await preparePath(root, `.smart-cache/${file.hash}.${file.kind === 'mod' ? 'jar' : 'zip'}`);
    const local = await this.libraryLookup?.(file);
    if (local) {
      signal.throwIfAborted(); if (await matches(destination, file.hash, file.algorithm, file.size)) { progress?.(file.size, file.size, 0); return destination; }
      const temp = await preparePath(root, `.smart-cache/.${randomUUID()}.tmp`); await noLinks(root, temp);
      try { await copyFile(local, temp); if (!await matches(temp, file.hash, file.algorithm, file.size)) throw new Error('A cópia da biblioteca falhou na validação de integridade.'); signal.throwIfAborted(); await rename(temp, destination); progress?.(file.size, file.size, 0); return destination; }
      catch (error) { await rm(temp, { force: true }).catch(() => {}); throw error; }
    }
    await downloadFile({ ...file, destination, hosts: CDN, signal, progress }); return destination;
  }
  private path(root: string, f: ContentFile, enabled = f.enabled !== false): string { return safePath(root, `${f.kind === 'mod' ? 'mods' : 'shaderpacks'}/${f.filename}${!enabled && f.kind === 'mod' ? '.disabled' : ''}`); }
  private async preflight(root: string, files: ContentFile[], old: ContentFile[]): Promise<void> {
    for (const f of files) {
      const path = this.path(root, f); await noLinks(root, path); const existing = await stat(path).catch(e => { if (e.code === 'ENOENT') return undefined; throw e; });
      if (!existing || await matches(path, f.hash, f.algorithm, f.size)) continue;
      const previous = old.find(o => this.path(root, o).toLowerCase() === path.toLowerCase());
      if (!previous || !await matches(path, previous.hash, previous.algorithm, previous.size)) throw new Error(`Arquivo pessoal ou modificado preservado: ${f.filename}. Mova-o manualmente antes de continuar.`);
    }
    for (const previous of old) {
      if (files.some(f => f.projectId === previous.projectId && f.hash === previous.hash && this.path(root, f).toLowerCase() === this.path(root, previous).toLowerCase())) continue;
      const path = this.path(root, previous); await noLinks(root, path);
      const exists = await stat(path).catch(e => { if (e.code === 'ENOENT') return undefined; throw e; });
      if (exists && !await matches(path, previous.hash, previous.algorithm, previous.size)) throw new Error(`Arquivo gerenciado foi alterado; preservado: ${previous.filename}`);
    }
  }
  private async backupFile(root: string, path: string, filename: string): Promise<void> {
    const backup = await preparePath(root, `.matrix-backups/${Date.now()}-${randomUUID()}/${filename}`); await noLinks(root, path); await copyFile(path, backup);
  }
  private async execute(i: Instance, allowJava: boolean, signal: AbortSignal, progress: SmartTransfer): Promise<void> {
    const journal = await this.journal(i); const plan = journal.plan; const settings = this.store.data.settings; const root = this.root(i);
    memoryCheck(journal.preferences.maxMemory); await requireSpace(settings.gameDirectory, plan.requiredDiskBytes);
    let stage = 'Java'; const completed = new Set(journal.completedStages);
    const transfer: Transfer = (label, b, t, s, detail) => progress(label, b, t, s, { stage, completedStages: [...completed], file: detail?.file, filesDone: detail?.filesDone ?? 0, filesTotal: detail?.filesTotal ?? 0 });
    const finish = async (name: string) => { completed.add(name); journal.completedStages = [...completed]; await this.saveJournal(i, journal); };
    i.installed = false; i.smart = { preset: plan.request.preset, status: 'installing', planId: plan.id }; await this.store.save();
    try {
      transfer('Verificando Java 21', 0, 0, 0);
      let java = plan.java.path ? await this.runtime.probeJava(plan.java.path).catch(() => undefined) : undefined;
      if (java?.major !== 21) java = (await this.runtime.detectJava(join(settings.gameDirectory, 'runtimes'), settings.javaPath)).find(j => j.major === 21);
      if (!java) {
        if (!allowJava) throw new Error('Esta instalação exige Java 21. Autorize o download oficial ou selecione um Java compatível.');
        const path = await this.runtime.installJava(join(settings.gameDirectory, 'runtimes'), plan.java.component, 21, signal, (b, t, s, detail) => transfer('Java 21 oficial', b, t, s, detail), settings.concurrency);
        java = { path, major: 21 };
      }
      i.launch = { minMemory: journal.preferences.minMemory, maxMemory: journal.preferences.maxMemory, javaPath: java.path }; await finish('Java');
      stage = 'Minecraft e Fabric'; i.loaderVersion = plan.fabric;
      i.versionId = await this.minecraft.install(i, settings, signal, transfer); await finish('Minecraft e Fabric');
      stage = 'Mods e shaders';
      const files: ContentFile[] = plan.files.map(f => ({ ...f, enabled: f.slug === 'iris' && journal.enableIris ? true : journal.managed.find(o => o.projectId === f.projectId)?.enabled !== false }));
      files.push(...journal.managed.filter(f => f.kind === 'shader' && !files.some(p => p.projectId === f.projectId)));
      await this.preflight(root, files, journal.managed);
      const total = files.reduce((s, f) => s + f.size, 0); let received = 0; const cached = new Map<string, string>();
      for (let index = 0; index < files.length; index++) {
        const f = files[index]; cached.set(f.hash, await this.cached(f, signal, (b, _t, speed) => transfer(`${f.title} · ${f.filename}`, received + b, total, speed, { file: f.filename, filesDone: index, filesTotal: files.length }))); received += f.size;
      }
      stage = 'Compatibilidade'; transfer('Verificando dependências internas dos mods', 0, 0, 0);
      const metadata: FabricMetadata[] = [];
      const modRecords: { file: ContentFile; metadata: FabricMetadata[] }[] = [];
      for (const f of files) { signal.throwIfAborted(); const file = cached.get(f.hash)!; if (f.kind === 'mod') modRecords.push({ file: f, metadata: await readFabricMetadata(file) }); else await validateShaderArchive(file); }
      if (journal.enableIris) {
        const required = modRecords.filter(r => r.file.slug === 'iris'); const visited = new Set<string>();
        while (required.length) { const record = required.shift()!; if (visited.has(record.file.projectId)) continue; visited.add(record.file.projectId); record.file.enabled = true;
          for (const id of record.metadata.flatMap(m => Object.keys(m.depends))) { const owner = modRecords.find(r => r.metadata.some(m => m.id === id || m.provides.includes(id))); if (owner) required.push(owner); }
        }
      }
      for (const record of modRecords) if (record.file.enabled !== false) metadata.push(...record.metadata);
      await this.preflight(root, files, journal.managed);
      const activeBefore = await activeShader(root);
      const personal = await readdir(safePath(root, 'mods')).catch(() => []);
      for (const name of personal.filter(name => name.endsWith('.jar') && !journal.managed.some(f => f.filename === name))) { const path = safePath(root, `mods/${name}`); await noLinks(root, path); metadata.push(...await readFabricMetadata(path)); }
      validateFabricDependencies(metadata, plan.fabric); await finish('Compatibilidade');
      // Validate all content before changing active JARs. Keep a recoverable journal after each copy.
      stage = 'Aplicando arquivos';
      for (const f of files) {
        signal.throwIfAborted();
        const old = journal.managed.find(o => f.kind === 'mod' ? o.projectId === f.projectId : o.kind === 'shader' && o.filename === f.filename); const destination = this.path(root, f); await noLinks(root, destination);
        if (old && this.path(root, old).toLowerCase() !== destination.toLowerCase()) {
          const oldPath = this.path(root, old); if (await stat(oldPath).catch(() => undefined)) { await this.backupFile(root, oldPath, `${old.kind === 'mod' ? 'mods' : 'shaderpacks'}/${old.filename}`); await rm(oldPath); }
        } else if (old && old.hash !== f.hash && await stat(destination).catch(() => undefined)) await this.backupFile(root, destination, `${f.kind === 'mod' ? 'mods' : 'shaderpacks'}/${f.filename}`);
        if (!await matches(destination, f.hash, f.algorithm, f.size)) {
          await preparePath(root, `${f.kind === 'mod' ? 'mods' : 'shaderpacks'}/${f.filename}${f.enabled === false && f.kind === 'mod' ? '.disabled' : ''}`);
          const temp = `${destination}.${randomUUID()}.tmp`; await noLinks(root, temp); await copyFile(cached.get(f.hash)!, temp); await rename(temp, destination);
        }
        journal.managed = journal.managed.filter(o => f.kind === 'mod' ? o.projectId !== f.projectId : o.kind !== 'shader' || o.filename !== f.filename); journal.managed.push(f); await this.saveJournal(i, journal);
      }
      await finish('Mods e shaders');
      if (activeBefore && !await stat(safePath(root, `shaderpacks/${activeBefore}`)).catch(() => undefined)) { const shader = files.find(f => f.kind === 'shader'); await selectShader(root, shader?.filename); }
      stage = 'Configurações';
      if (!journal.configurationApplied) { await applyPreferences(root, journal.preferences); if (files.some(f => f.slug === 'iris')) await selectShader(root, files.find(f => f.kind === 'shader')?.filename); journal.configurationApplied = true; await this.saveJournal(i, journal); }
      await finish('Configurações'); stage = 'Diagnóstico'; await this.minecraft.inspect(i, settings); await this.inspect(i.id); await finish('Diagnóstico');
      signal.throwIfAborted(); journal.enableIris = undefined; await this.saveJournal(i, journal); i.installed = true; i.smart = { preset: plan.request.preset, status: 'ready', planId: plan.id }; await this.store.save();
      transfer('Smart Install concluído', received, total, 0, { file: '', filesDone: files.length, filesTotal: files.length });
    } catch (e) { i.installed = false; i.smart = { preset: plan.request.preset, status: 'interrupted', planId: plan.id, error: friendlyError(e) }; await this.store.save(); throw e; }
  }
  async content(id: string): Promise<InstalledContent> {
    const i = this.instance(id); const j = await this.journal(i);
    return { mods: j.managed.filter(f => f.kind === 'mod'), shaders: j.managed.filter(f => f.kind === 'shader'), activeShader: await activeShader(this.root(i)), preferences: j.preferences, warnings: j.plan.warnings };
  }
  async inspect(id: string): Promise<void> {
    const i = this.instance(id); const j = await this.journal(i); const metadata: FabricMetadata[] = [];
    for (const f of j.managed) {
      const path = this.path(this.root(i), f); await noLinks(this.root(i), path);
      if (!await matches(path, f.hash, f.algorithm, f.size)) throw new Error(`Arquivo Smart Install ausente ou corrompido: ${f.filename}. Use Retomar/reparar no Smart Install.`);
      if (f.kind === 'mod' && f.enabled !== false) metadata.push(...await readFabricMetadata(path));
    }
    const personal = await readdir(safePath(this.root(i), 'mods')).catch(() => []);
    if (personal.length > 1000) throw new Error('Há mods demais nesta instância para um diagnóstico seguro');
    for (const name of personal.filter(name => name.endsWith('.jar') && !j.managed.some(f => f.filename === name))) { const path = safePath(this.root(i), `mods/${name}`); await noLinks(this.root(i), path); metadata.push(...await readFabricMetadata(path)); }
    validateFabricDependencies(metadata, i.loaderVersion);
  }
  async configure(id: string, preferences: InstalledContent['preferences']): Promise<void> {
    const i = this.instance(id); const p = smartPreferencesSchema.parse(preferences); memoryCheck(p.maxMemory);
    const j = await this.journal(i); await applyPreferences(this.root(i), p); j.preferences = p; i.launch = { ...i.launch, minMemory: p.minMemory, maxMemory: p.maxMemory };
    await this.saveJournal(i, j); await this.store.save();
  }
  async toggleMod(id: string, projectId: string, enabled: boolean): Promise<void> {
    const i = this.instance(id); const j = await this.journal(i); const f = j.managed.find(f => f.kind === 'mod' && f.projectId === projectId); if (!f) throw new Error('Mod gerenciado não encontrado');
    if ((f.enabled !== false) === enabled) return;
    const metadata: FabricMetadata[] = [];
    for (const mod of j.managed.filter(m => m.kind === 'mod' && (m.projectId === projectId ? enabled : m.enabled !== false))) metadata.push(...await readFabricMetadata(this.path(this.root(i), mod)));
    validateFabricDependencies(metadata, i.loaderVersion);
    const from = this.path(this.root(i), f); const to = this.path(this.root(i), f, enabled); await noLinks(this.root(i), from); await noLinks(this.root(i), to);
    if (!await matches(from, f.hash, f.algorithm, f.size)) throw new Error('Mod alterado ou corrompido; arquivo preservado');
    if (await stat(to).catch(() => undefined)) throw new Error('Já existe um arquivo pessoal com este nome');
    await rename(from, to); f.enabled = enabled; await this.saveJournal(i, j);
    if (f.slug === 'iris' && !enabled) await selectShader(this.root(i));
  }
  async installShader(id: string, projectId: string, signal: AbortSignal, progress: Transfer): Promise<void> {
    const i = this.instance(id); const j = await this.journal(i);
    if (!j.managed.some(f => f.slug === 'iris' && f.enabled !== false)) throw new Error('Ative o Iris nesta instância. Para adicioná-lo, crie um perfil com suporte a shaders.');
    const f = await this.catalog.resolveShader(projectId, signal); await requireSpace(this.root(i), f.size * 2); await this.preflight(this.root(i), [f], []);
    const cache = await this.cached(f, signal, (b, t, s) => progress(f.filename, b, t, s)); await validateShaderArchive(cache);
    const destination = await preparePath(this.root(i), `shaderpacks/${f.filename}`); signal.throwIfAborted();
    if (!await matches(destination, f.hash, f.algorithm, f.size)) { const temp = `${destination}.${randomUUID()}.tmp`; await noLinks(this.root(i), temp); await copyFile(cache, temp); await rename(temp, destination); }
    const duplicate = j.managed.find(old => old.kind === 'shader' && old.filename === f.filename);
    if (!duplicate) j.managed.push(f); await this.saveJournal(i, j);
  }
  async selectShader(id: string, filename?: string): Promise<void> {
    const i = this.instance(id); const j = await this.journal(i);
    if (filename) {
      const f = j.managed.find(f => f.kind === 'shader' && f.filename === filename);
      if (!f || !await matches(this.path(this.root(i), f), f.hash, f.algorithm, f.size)) throw new Error('Shader instalado não encontrado ou corrompido');
      if (!j.managed.some(f => f.slug === 'iris' && f.enabled !== false)) throw new Error('Ative Iris antes de selecionar um shader');
    }
    await selectShader(this.root(i), filename);
  }
  async deleteShader(id: string, filename: string): Promise<void> {
    const i = this.instance(id); const j = await this.journal(i); const f = j.managed.find(f => f.kind === 'shader' && f.filename === filename); if (!f) throw new Error('Shader não encontrado');
    const path = this.path(this.root(i), f); await noLinks(this.root(i), path);
    if (!await matches(path, f.hash, f.algorithm, f.size)) throw new Error('Shader pessoal/modificado preservado');
    if (await activeShader(this.root(i)) === filename) await selectShader(this.root(i));
    await this.backupFile(this.root(i), path, `shaderpacks/${f.filename}`); await rm(path);
    j.managed = j.managed.filter(file => file !== f); await this.saveJournal(i, j);
    j.plan.files = j.plan.files.filter(file => file.kind !== 'shader' || file.filename !== filename);
    if (j.plan.request.shaderProject === f.slug || j.plan.request.shaderProject === f.projectId) j.plan.request.shaderProject = undefined;
    await this.saveJournal(i, j);
  }
}
