import { z } from 'zod';
import { SMART_MODS, type ContentFile, type ContentProject } from '../../shared/smart.ts';
import type { ModPage, ModProject, ModSearch } from '../../shared/mod-center.ts';
import { nativeHttpsFetch } from './http.ts';
import { safePath, secureUrl } from './security.ts';
import { setTimeout as delay } from 'node:timers/promises';

const MC = '1.21.1';
const API = 'https://api.modrinth.com/v2';
const UA = 'MATRIXLauncher/0.3.1 (https://matrixcommunity.dpdns.org/)';
const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const text = z.string().max(10000);
const projectSchema = z.object({
  id: identifier, slug: identifier, title: z.string().min(1).max(250), description: text,
  project_type: z.enum(['mod', 'shader', 'modpack', 'resourcepack']), status: z.string().max(30),
  team: identifier.optional(), downloads: z.number().int().nonnegative().optional(), categories: z.array(z.string().max(100)).max(100).optional(),
  client_side: z.string().max(30), license: z.object({ id: z.string().min(1).max(150), name: z.string().max(250), url: z.string().max(2000).nullable() }),
  icon_url: z.string().max(2000).nullable().optional(),
  gallery: z.array(z.object({ url: z.string().max(2000), featured: z.boolean().optional() })).max(100).optional(),
});
const versionSchema = z.object({
  id: identifier, project_id: identifier, version_number: z.string().min(1).max(250),
  version_type: z.enum(['release', 'beta', 'alpha']), status: z.string().max(30),
  game_versions: z.array(z.string().max(100)).max(1000), loaders: z.array(z.string().max(100)).max(50),
  date_published: z.string().datetime({ offset: true }),
  dependencies: z.array(z.object({ project_id: identifier.nullable(), version_id: identifier.nullable(),
    file_name: z.string().max(500).nullable(), dependency_type: z.enum(['required', 'optional', 'incompatible', 'embedded']) })).max(100),
  files: z.array(z.object({ filename: z.string().min(1).max(240), url: z.string().max(2000), primary: z.boolean(),
    size: z.number().int().positive().max(2 ** 31), hashes: z.object({ sha512: z.string().regex(/^[a-fA-F0-9]{128}$/).optional(), sha1: z.string().regex(/^[a-fA-F0-9]{40}$/).optional() }) })).min(1).max(50),
});
type Project = z.infer<typeof projectSchema>;
type Version = z.infer<typeof versionSchema>;
type Requirement = { project: string; version?: string };
const SHADERS = ['complementary-reimagined', 'complementary-unbound', 'bsl-shaders', 'sildurs-vibrant-shaders'];

/** Resolves publisher metadata, not arbitrary remote install scripts. Downloads remain hash-checked by the launcher. */
export class ContentCatalog {
  private cache = new Map<string, { expires: number; value: unknown }>();
  constructor(private request: typeof fetch = nativeHttpsFetch) {}

  private async json(url: string, signal?: AbortSignal): Promise<unknown> {
    secureUrl(url, ['api.modrinth.com', 'meta.fabricmc.net']);
    const cached = this.cache.get(url); if (cached && cached.expires > Date.now()) return cached.value;
    const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000);
    let response: Response | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      response = await this.request(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, redirect: 'manual', signal: combined });
      if (response.ok || ![429, 500, 502, 503, 504].includes(response.status) || attempt === 2) break;
      const retryAfter = Number(response.headers.get('retry-after')); await response.body?.cancel();
      await delay(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(2000, retryAfter * 1000) : 400 * 2 ** attempt, undefined, { signal });
    }
    if (!response) throw new Error('Catálogo indisponível.');
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Catálogo indisponível (HTTP ${response.status}). Tente novamente.`); }
    const reader = response.body?.getReader(); if (!reader) throw new Error('Catálogo vazio');
    let size = 0; const chunks: Uint8Array[] = [];
    try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 12 * 1024 * 1024) throw new Error('Catálogo excede o limite seguro'); chunks.push(value); } }
    catch (error) { await reader.cancel().catch(() => {}); throw error; }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (this.cache.size >= 200) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(url, { value, expires: Date.now() + 120_000 }); return value;
  }

  private async project(id: string, kind: 'mod' | 'shader', signal?: AbortSignal): Promise<Project> {
    identifier.parse(id);
    const p = projectSchema.parse(await this.json(`${API}/project/${encodeURIComponent(id)}`, signal));
    if (p.project_type !== kind || !['approved', 'archived'].includes(p.status) || p.client_side === 'unsupported' || /^(unknown|unlicensed)$/i.test(p.license.id)) throw new Error(`${p.title}: projeto sem suporte ou licença verificável para esta instalação.`);
    return p;
  }

  private async versions(p: Project, kind: 'mod' | 'shader', signal?: AbortSignal, minecraft = MC, loader = kind === 'mod' ? 'fabric' : 'iris'): Promise<Version[]> {
    const params = new URLSearchParams({ game_versions: JSON.stringify([minecraft]), loaders: JSON.stringify([loader]), include_changelog: 'false' });
    const versions = z.array(versionSchema).max(3000).parse(await this.json(`${API}/project/${p.id}/version?${params}`, signal));
    return versions.filter(v => v.project_id === p.id && v.version_type === 'release' && ['listed', 'archived'].includes(v.status) && v.game_versions.includes(minecraft) && v.loaders.includes(loader))
      .sort((a, b) => Date.parse(b.date_published) - Date.parse(a.date_published));
  }

  private file(p: Project, v: Version, kind: 'mod' | 'shader'): ContentFile {
    const extension = kind === 'mod' ? '.jar' : '.zip';
    const matching = v.files.filter(f => f.filename.toLowerCase().endsWith(extension));
    const f = matching.find(f => f.primary) ?? (matching.length === 1 ? matching[0] : undefined);
    if (!f) throw new Error(`${p.title}: arquivo principal ${extension} não identificado.`);
    if (f.filename.includes('/') || f.filename.includes('\\')) throw new Error('Nome de arquivo inseguro');
    safePath(process.cwd(), f.filename);
    const u = secureUrl(f.url, ['cdn.modrinth.com']);
    if (u.search || !u.pathname.startsWith(`/data/${p.id}/versions/${v.id}/`)) throw new Error('URL não corresponde ao arquivo publicado pelo projeto');
    const algorithm = f.hashes.sha512 ? 'sha512' : 'sha1'; const hash = f.hashes[algorithm];
    if (!hash) throw new Error(`${p.title}: hash de integridade ausente.`);
    return { projectId: p.id, slug: p.slug, title: p.title, versionId: v.id, version: v.version_number, kind,
      filename: f.filename, url: u.href, size: f.size, hash: hash.toLowerCase(), algorithm,
      license: p.license.name || p.license.id, sourceUrl: `https://modrinth.com/${kind}/${p.slug}` };
  }

  private display(p: Project, available: boolean, reason?: string): ContentProject {
    const image = (raw?: string | null) => { if (!raw) return undefined; try { const url = secureUrl(raw, ['cdn.modrinth.com']); return url.search ? undefined : url.href; } catch { return undefined; } };
    return { id: p.id, slug: p.slug, title: p.title, description: p.description, license: p.license.name || p.license.id,
      sourceUrl: `https://modrinth.com/${p.project_type}/${p.slug}`, icon: image(p.icon_url), image: image(p.gallery?.find(g => g.featured)?.url ?? p.gallery?.[0]?.url), available, reason };
  }

  async catalog(signal?: AbortSignal): Promise<ContentProject[]> {
    const results: ContentProject[] = [];
    for (const slug of SMART_MODS) {
      signal?.throwIfAborted();
      try { const p = await this.project(slug, 'mod', signal); const versions = await this.versions(p, 'mod', signal); results.push(this.display(p, versions.length > 0, versions.length ? undefined : 'Sem release Fabric compatível com Minecraft 1.21.1.')); }
      catch (e) { signal?.throwIfAborted(); results.push({ id: slug, slug, title: slug, description: '', license: 'Não disponível', sourceUrl: `https://modrinth.com/mod/${slug}`, available: false, reason: (e as Error).message.slice(0, 300) }); }
    }
    return results;
  }

  async fabric(signal?: AbortSignal): Promise<string> {
    const entries = z.array(z.object({ loader: z.object({ version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+.][A-Za-z0-9.-]+)?$/), stable: z.boolean() }) })).max(1000).parse(await this.json(`https://meta.fabricmc.net/v2/versions/loader/${MC}`, signal));
    const stable = entries.find(e => e.loader.stable);
    if (!stable) throw new Error('Nenhum Fabric Loader estável disponível para Minecraft 1.21.1.');
    return stable.loader.version;
  }

  async resolveMods(slugs: string[], signal?: AbortSignal, rejectedVersions: ReadonlySet<string> = new Set(), minecraft = MC, loader = 'fabric', restrictSmartCatalog = true): Promise<ContentFile[]> {
    z.array(restrictSmartCatalog ? z.enum(SMART_MODS) : identifier).min(1).max(restrictSmartCatalog ? 8 : 30).parse(slugs);
    const projects = new Map<string, Project>(); const lists = new Map<string, Version[]>(); const exact = new Map<string, Version>();
    const getProject = async (id: string) => { if (projects.has(id)) return projects.get(id)!; const p = await this.project(id, 'mod', signal); projects.set(id, p); projects.set(p.id, p); return p; };
    const getVersion = async (id: string) => { if (!exact.has(id)) { identifier.parse(id); const v = versionSchema.parse(await this.json(`${API}/version/${id}`, signal)); if (v.id !== id) throw new Error('Identidade de versão inválida'); exact.set(id, v); } return exact.get(id)!; };
    const roots: Requirement[] = [];
    for (const slug of new Set(slugs)) roots.push({ project: (await getProject(slug)).id });
    let attempts = 0; let failure = 'Não foi encontrada uma combinação compatível dos mods selecionados.';
    const search = async (pending: Requirement[], chosen: Map<string, Version>): Promise<Map<string, Version> | undefined> => {
      signal?.throwIfAborted(); if (++attempts > 2000 || chosen.size > 64) throw new Error('Resolução excedeu o limite seguro; selecione menos mods.');
      if (!pending.length) return chosen;
      const [requirement, ...rest] = pending; const p = await getProject(requirement.project); const previous = chosen.get(p.id);
      if (previous) return (!requirement.version || previous.id === requirement.version) ? search(rest, chosen) : undefined;
      if (!lists.has(p.id)) lists.set(p.id, await this.versions(p, 'mod', signal, minecraft, loader));
      const candidates = requirement.version
        ? (rejectedVersions.has(requirement.version) ? [] : [await getVersion(requirement.version)])
        : lists.get(p.id)!.filter(v => !rejectedVersions.has(v.id)).slice(0, 40);
      for (const v of candidates) {
        if (v.project_id !== p.id || !lists.get(p.id)!.some(allowed => allowed.id === v.id)) continue;
        const next = new Map(chosen); next.set(p.id, v); const dependencies: Requirement[] = []; let valid = true;
        try {
          this.file(p, v, 'mod');
          for (const dep of v.dependencies.filter(d => d.dependency_type === 'required')) {
            const pinned = dep.version_id ? await getVersion(dep.version_id) : undefined;
            const project = dep.project_id ?? pinned?.project_id;
            if (!project || (pinned && pinned.project_id !== project)) throw new Error(`${p.title}: dependência externa obrigatória não resolvida.`);
            dependencies.push({ project, version: pinned?.id });
          }
          for (const selected of next.values()) for (const dep of selected.dependencies.filter(d => d.dependency_type === 'incompatible')) {
            if (!dep.project_id && !dep.version_id) throw new Error('Incompatibilidade externa não verificável.');
            if ([...next.values()].some(other => dep.version_id ? other.id === dep.version_id : other.project_id === dep.project_id)) { valid = false; failure = 'Mods selecionados declaram incompatibilidade entre si.'; }
          }
          if (valid) { const resolved = await search([...dependencies, ...rest], next); if (resolved) return resolved; }
        } catch (error) { signal?.throwIfAborted(); if (/limite seguro/.test((error as Error).message)) throw error; failure = (error as Error).message; }
      }
      return undefined;
    };
    const result = await search(roots, new Map()); if (!result) throw new Error(failure);
    const files = [...result.values()].map(v => ({ ...this.file(projects.get(v.project_id)!, v, 'mod'), dependencies: v.dependencies.filter(d => d.dependency_type === 'required').map(d => d.project_id ?? '').filter(Boolean) }));
    if (new Set(files.map(f => f.filename.toLowerCase())).size !== files.length) throw new Error('Mods possuem nomes de arquivo conflitantes.');
    return files;
  }

  async searchMods(input: ModSearch, signal?: AbortSignal): Promise<ModPage> {
    const facets: string[][] = [[`project_type:${input.type}`]];
    if (input.compatibleOnly) {
      facets.push([`versions:${input.minecraft}`]);
      if (input.loader !== 'vanilla') facets.push([`categories:${input.loader}`]);
    }
    const params = new URLSearchParams({ query: input.query, limit: String(input.limit), offset: String(input.offset), index: input.index, facets: JSON.stringify(facets) });
    const response = z.object({ hits: z.array(z.object({ project_id: identifier, slug: identifier, title: z.string().min(1).max(250), description: text, author: z.string().max(250), downloads: z.number().int().nonnegative(), categories: z.array(z.string().max(100)).max(100), versions: z.array(z.string().max(100)).max(1000), license: z.string().max(150), icon_url: z.string().max(2000).nullable().optional(), gallery: z.array(z.string().max(2000)).max(100).optional() })).max(30), offset: z.number().int().nonnegative(), limit: z.number().int().nonnegative(), total_hits: z.number().int().nonnegative() }).parse(await this.json(`${API}/search?${params}`, signal));
    const projects = response.hits.map(hit => {
      const image = (raw?: string | null) => { if (!raw) return undefined; try { return secureUrl(raw, ['cdn.modrinth.com']).href; } catch { return undefined; } };
      const compatible = input.loader !== 'vanilla' && hit.versions.includes(input.minecraft) && hit.categories.includes(input.loader);
      return { id: hit.project_id, slug: hit.slug, title: hit.title, description: hit.description, author: hit.author, downloads: hit.downloads, license: hit.license || 'Licença não informada', categories: hit.categories, icon: image(hit.icon_url), gallery: (hit.gallery ?? []).map(image).filter((u): u is string => !!u), sourceUrl: `https://modrinth.com/${input.type}/${hit.slug}`, compatible, versions: hit.versions, ...(input.compatibleOnly && !compatible ? { reason: 'Compatibilidade não confirmada para esta instância.' } : {}) } satisfies ModProject;
    });
    return { projects, offset: response.offset, limit: response.limit, total: response.total_hits };
  }

  async details(projectId: string, minecraft: string, loader: string, signal?: AbortSignal): Promise<ModProject> {
    const raw = projectSchema.parse(await this.json(`${API}/project/${encodeURIComponent(projectId)}`, signal));
    if (raw.project_type !== 'mod' || !['approved', 'archived'].includes(raw.status)) throw new Error('Projeto Modrinth indisponível ou não aprovado.');
    const supported = loader === 'vanilla' ? [] : await this.versions(raw, 'mod', signal, minecraft, loader);
    const icon = raw.icon_url ? secureUrl(raw.icon_url, ['cdn.modrinth.com']).href : undefined;
    const gallery = (raw.gallery ?? []).map(g => { try { return secureUrl(g.url, ['cdn.modrinth.com']).href; } catch { return undefined; } }).filter((u): u is string => !!u);
    return { id: raw.id, slug: raw.slug, title: raw.title, description: raw.description, author: raw.team ?? 'Autor no Modrinth', downloads: raw.downloads ?? 0, license: raw.license.name || raw.license.id, categories: raw.categories ?? [], icon, gallery, sourceUrl: `https://modrinth.com/mod/${raw.slug}`, compatible: supported.length > 0, versions: supported.map(v => v.version_number), ...(!supported.length ? { reason: `Sem versão release compatível com Minecraft ${minecraft} e ${loader}.` } : {}) };
  }

  async resolveProject(projectId: string, minecraft: string, loader: string, signal?: AbortSignal): Promise<ContentFile[]> {
    if (loader === 'vanilla') throw new Error('Instalações Vanilla não aceitam mods. Escolha uma instância com Fabric, Forge ou NeoForge.');
    return this.resolveMods([projectId], signal, new Set(), minecraft, loader, false);
  }

  async resolveShader(projectId: string, signal?: AbortSignal): Promise<ContentFile> {
    const p = await this.project(projectId, 'shader', signal); const versions = await this.versions(p, 'shader', signal);
    for (const version of versions) if (!version.dependencies.some(d => d.dependency_type === 'required' || d.dependency_type === 'incompatible')) return this.file(p, version, 'shader');
    throw new Error(`${p.title}: nenhum shader release compatível com Iris e Minecraft 1.21.1 sem dependências externas.`);
  }

  async searchShaders(query: string, signal?: AbortSignal): Promise<ContentProject[]> {
    z.string().trim().max(100).parse(query); let ids = SHADERS;
    if (query.trim()) {
      const params = new URLSearchParams({ query: query.trim(), limit: '12', facets: JSON.stringify([['project_type:shader'], [`versions:${MC}`], ['categories:iris']]) });
      ids = z.object({ hits: z.array(z.object({ project_id: identifier })).max(12) }).parse(await this.json(`${API}/search?${params}`, signal)).hits.map(h => h.project_id);
    }
    const result: ContentProject[] = [];
    for (const id of ids) { signal?.throwIfAborted(); try { const p = await this.project(id, 'shader', signal); await this.resolveShader(p.id, signal); result.push(this.display(p, true)); } catch { signal?.throwIfAborted(); } }
    return result;
  }
}
