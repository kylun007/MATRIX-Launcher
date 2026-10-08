import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { manifestSchema, type ModpackManifest, type Instance } from '../../shared/contracts.ts';
import { downloadFile, httpsFetch, matches, requireSpace } from './download.ts';
import { preparePath, safePath, noLinks, secureUrl } from './security.ts';
import type { Transfer } from './minecraft.ts';

export function validateModpack(input: unknown, trustedHosts: readonly string[]): ModpackManifest {
  const manifest = manifestSchema.parse(input); const paths = new Set<string>();
  if (manifest.allowedHosts.some(host => !trustedHosts.includes(host))) throw new Error('Manifesto solicita hosts que não foram autorizados pelo distribuidor MATRIX');
  for (const file of manifest.files) {
    safePath('/matrix', file.path);
    if (!/^(mods|resourcepacks|shaderpacks|config)\//.test(file.path) || file.path.endsWith('.matrix-managed.json')) throw new Error('Modpack só pode gerenciar mods, resourcepacks, shaderpacks e config');
    if (paths.has(file.path.toLowerCase())) throw new Error('Manifesto contém caminhos duplicados'); paths.add(file.path.toLowerCase());
    secureUrl(file.url, manifest.allowedHosts);
  }
  if (manifest.files.reduce((s, f) => s + f.size, 0) > 20_000_000_000) throw new Error('Modpack excede o limite de 20 GB');
  return manifest;
}
const ledgerSchema = z.object({ id: z.string(), version: z.string(), files: z.array(z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })) });
export async function syncModpack(instance: Instance, root: string, url: string, expectedHash: string, trustedHosts: string[], allowRemove: boolean, signal: AbortSignal, progress: Transfer): Promise<string> {
  secureUrl(url, trustedHosts);
  const response = await httpsFetch(url, { signal }, trustedHosts); if (!response.ok || !response.body) throw new Error('Manifesto de modpack indisponível');
  const chunks: Uint8Array[] = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > 2_000_000) throw new Error('Manifesto de modpack muito grande'); chunks.push(chunk); }
  const content = Buffer.concat(chunks);
  if (createHash('sha256').update(content).digest('hex') !== expectedHash) throw new Error('Assinatura de integridade do manifesto não corresponde à configuração MATRIX');
  const manifest = validateModpack(JSON.parse(content.toString('utf8')), trustedHosts);
  if (instance.minecraft !== manifest.minecraft || instance.loader !== manifest.loader.type || instance.loaderVersion !== manifest.loader.version) throw new Error('Crie uma instalação com a versão Minecraft e loader exigidos por este modpack');
  const ledgerFile = await preparePath(root, '.matrix-managed.json');
  let ledger: z.infer<typeof ledgerSchema> = { id: manifest.id, version: '', files: [] };
  try { ledger = ledgerSchema.parse(JSON.parse(await readFile(ledgerFile, 'utf8'))); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Registro local do modpack corrompido; recuperação manual necessária'); }
  if (ledger.id !== manifest.id) throw new Error('Esta instância já usa outro modpack. Crie uma instância separada.');
  // Preflight all conflicts before downloading any file. Never overwrite personal files or edits.
  for (const file of manifest.files) {
    const target = await preparePath(root, file.path);
    const previous = ledger.files.find(f => f.path === file.path);
    let exists = true; try { await readFile(target); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') exists = false; else throw e; }
    if (exists && !await matches(target, file.sha256) && (!previous || !await matches(target, previous.sha256))) throw new Error(`Arquivo pessoal ou modificado preservado: ${file.path}. Mova-o manualmente para continuar.`);
  }
  const total = manifest.files.reduce((s, f) => s + f.size, 0); await requireSpace(root, total); let done = 0;
  for (const file of manifest.files) {
    signal.throwIfAborted(); const target = await preparePath(root, file.path);
    await downloadFile({ url: file.url, hash: file.sha256, size: file.size, destination: target, hosts: manifest.allowedHosts, signal, progress: (b, _t, s) => progress('Sincronizando modpack', done + b, total, s) }); done += file.size;
    // Journal each verified file so interruption does not classify it as a personal file on retry.
    ledger.files = ledger.files.filter(f => f.path !== file.path); ledger.files.push({ path: file.path, sha256: file.sha256 });
    await writeFile(`${ledgerFile}.tmp`, JSON.stringify(ledger)); await rename(`${ledgerFile}.tmp`, ledgerFile);
  }
  if (manifest.removalPolicy === 'managed-only' && allowRemove) for (const old of [...ledger.files]) {
    if (manifest.files.some(f => f.path === old.path)) continue;
    if (!/^(mods|resourcepacks|shaderpacks|config)\//.test(old.path)) throw new Error('Registro local contém caminho inválido');
    const target = safePath(root, old.path); await noLinks(root, target);
    if (await matches(target, old.sha256)) { await rm(target); ledger.files = ledger.files.filter(f => f.path !== old.path); }
  }
  ledger.version = manifest.version;
  await writeFile(`${ledgerFile}.tmp`, JSON.stringify(ledger, null, 2)); await rename(`${ledgerFile}.tmp`, ledgerFile); return manifest.version;
}
