import { open, filterEntries, readEntry, walkEntries } from '@xmcl/unzip';
import { valid, coerce, satisfies, validRange, rcompare } from 'semver';
import { z } from 'zod';
import { safePath } from './security.ts';

const predicate = z.union([z.string().max(200), z.array(z.string().max(200)).max(30)]);
const metadataSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{1,63}$/), version: z.string().min(1).max(128),
  environment: z.enum(['*', 'client', 'server']).default('*'),
  provides: z.array(z.string().regex(/^[a-z][a-z0-9_-]{1,63}$/)).max(100).default([]),
  depends: z.record(z.string(), predicate).default({}), breaks: z.record(z.string(), predicate).default({}),
  conflicts: z.record(z.string(), predicate).default({}),
  jars: z.array(z.object({ file: z.string().max(300) })).max(100).default([]),
});
export type FabricMetadata = z.infer<typeof metadataSchema> & { nested?: boolean };
export class ContentCompatibilityError extends Error {
  constructor(message: string, readonly modId: string) { super(message); }
}
export function matchesPredicate(version: string, constraint: string | string[]): boolean {
  if (Array.isArray(constraint)) return constraint.some(c => matchesPredicate(version, c));
  if (constraint === '*') return true;
  const completePrerelease = (text: string) => text
    .replace(/(?<![\d.])(\d+(?:\.\d+){0,2})-(?=\s|$)/g, (_, release: string) => `${release}${'.0'.repeat(3 - release.split('.').length)}-0`)
    .replace(/(?<![\d.])(\d+(?:\.\d+)?)(-[0-9A-Za-z.-]+(?:\+[0-9A-Za-z.-]+)?)/g, (_, release: string, suffix: string) => `${release}${'.0'.repeat(3 - release.split('.').length)}${suffix}`);
  const normalized = valid(completePrerelease(version)) ?? (/^\d+(?:\.\d+){0,2}$/.test(version) ? coerce(version)?.version : undefined);
  if (!normalized) return constraint === version;
  const range = completePrerelease(constraint);
  if (!validRange(range)) throw new Error(`Restrição Fabric não suportada: ${constraint}`);
  return satisfies(normalized, range, { includePrerelease: true });
}
export function validateFabricDependencies(mods: FabricMetadata[], loader: string, java = 21): void {
  // Fabric resolves bundled modules as candidates. Different embedded versions are
  // valid; two different top-level JARs declaring the same ID remain a conflict.
  const groups = new Map<string, FabricMetadata[]>();
  for (const mod of mods.filter(m => m.environment !== 'server')) { const group = groups.get(mod.id) ?? []; group.push(mod); groups.set(mod.id, group); }
  const selected = new Map<string, FabricMetadata>();
  for (const [id, group] of groups) {
    const roots = group.filter(m => !m.nested);
    if (new Set(roots.map(m => m.version)).size > 1) throw new Error(`Mod duplicado ou versões conflitantes: ${id}`);
    group.sort((a, b) => { const x = valid(a.version), y = valid(b.version); return x && y ? rcompare(x, y) : b.version.localeCompare(a.version, undefined, { numeric: true }); });
    selected.set(id, roots[0] ?? group[0]);
  }
  for (let iteration = 0; iteration < 150; iteration++) {
    let changed = false;
    for (const [id, group] of groups) {
      if (group.some(m => !m.nested)) continue;
      const required = [...selected.values()].flatMap(m => m.depends[id] === undefined ? [] : [m.depends[id]]);
      const candidate = group.find(m => required.every(range => matchesPredicate(m.version, range)));
      if (!candidate) { const parent = [...selected.values()].find(m => m.depends[id] !== undefined); throw new ContentCompatibilityError(`Nenhum módulo interno compatível para ${id}`, parent?.id ?? id); }
      if (candidate.version !== selected.get(id)?.version) { selected.set(id, candidate); changed = true; }
    }
    if (!changed) break;
    if (iteration === 149) throw new Error('Não foi possível resolver os módulos internos Fabric');
  }
  const registry = new Map<string, string>([['minecraft', '1.21.1'], ['fabricloader', loader], ['java', String(java)]]);
  for (const mod of selected.values()) {
    if (mod.environment === 'server') continue;
    for (const id of [mod.id, ...mod.provides]) {
      if (registry.has(id) && registry.get(id) !== mod.version) throw new Error(`Mod duplicado ou versões conflitantes: ${id}`);
      registry.set(id, mod.version);
    }
  }
  for (const mod of selected.values()) {
    if (mod.environment === 'server') continue;
    for (const [id, range] of Object.entries(mod.depends)) {
      const version = registry.get(id);
      if (!version || !matchesPredicate(version, range)) throw new ContentCompatibilityError(`${mod.id} exige ${id} ${JSON.stringify(range)}; encontrado ${version ?? 'ausente'}`, mod.id);
    }
    for (const [id, range] of Object.entries({ ...mod.conflicts, ...mod.breaks })) {
      const version = registry.get(id);
      if (version && matchesPredicate(version, range)) throw new ContentCompatibilityError(`Incompatibilidade declarada: ${mod.id} com ${id} ${JSON.stringify(range)}`, mod.id);
    }
  }
}
export async function readFabricMetadata(file: string | Buffer): Promise<FabricMetadata[]> {
  let count = 0; let expanded = 0;
  async function read(target: string | Buffer, depth: number): Promise<FabricMetadata[]> {
    if (++count > 150 || depth > 5) throw new Error('JAR contém dependências aninhadas demais');
    const zip = await open(target, { autoClose: false });
    try {
      const [entry] = await filterEntries(zip, ['fabric.mod.json']);
      if (!entry || entry.uncompressedSize > 1_000_000) throw new Error('Mod sem fabric.mod.json válido');
      const mod: FabricMetadata = { ...metadataSchema.parse(JSON.parse((await readEntry(zip, entry)).toString('utf8'))), nested: depth > 0 };
      const mods = [mod];
      // Reopen because ZIP iteration is consumed by filterEntries.
      for (const nested of mod.jars) {
        safePath('/matrix-jar', nested.file);
        const childZip = await open(target, { autoClose: false });
        try {
          const [child] = await filterEntries(childZip, [nested.file]);
          if (!child || child.uncompressedSize > 32_000_000 || (expanded += child.uncompressedSize) > 100_000_000) throw new Error('Dependência aninhada inválida ou muito grande');
          mods.push(...await read(await readEntry(childZip, child), depth + 1));
        } finally { childZip.close(); }
      }
      return mods;
    } finally { zip.close(); }
  }
  return read(file, 0);
}
export async function validateShaderArchive(file: string): Promise<void> {
  const zip = await open(file, { autoClose: false }); let count = 0; let shader = false; let size = 0;
  try {
    await walkEntries(zip, entry => {
      if (++count > 20000 || (size += entry.uncompressedSize) > 1_000_000_000) throw new Error('Shader excede os limites de segurança');
      const path = entry.fileName.replace(/\/$/, ''); if (path) safePath('/matrix-shader', path);
      if (/^shaders\/.+\.(?:fsh|vsh|glsl|properties)$/.test(path)) shader = true;
    });
    if (!shader) throw new Error('Arquivo não contém um shaderpack Iris reconhecido');
  } finally { zip.close(); }
}
