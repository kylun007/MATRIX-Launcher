import { isAbsolute, resolve, relative, sep, dirname, parse } from 'node:path';
import { lstat, realpath, mkdir } from 'node:fs/promises';

export function safePath(root: string, untrusted: string): string {
  if (!untrusted || untrusted.includes('\\') || untrusted.includes(':') || /[\x00-\x1f]/.test(untrusted) || isAbsolute(untrusted)) throw new Error('Caminho de arquivo inválido');
  const parts = untrusted.split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw new Error('Caminho de arquivo inseguro');
  const target = resolve(root, untrusted); const rel = relative(resolve(root), target);
  if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) throw new Error('Arquivo fora do diretório permitido');
  return target;
}
export async function noLinks(root: string, target: string): Promise<void> {
  const base = resolve(root); const rel = relative(base, resolve(target));
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Arquivo fora do diretório permitido');
  // Check the root and its ancestors too: Windows junctions must never redirect writes.
  let current = parse(base).root;
  for (const part of relative(current, target).split(sep).filter(Boolean)) {
    current = resolve(current, part);
    try { const stat = await lstat(current); if (stat.isSymbolicLink()) throw new Error('Links simbólicos/junctions não são permitidos na instalação'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
}
export async function preparePath(root: string, path: string): Promise<string> {
  const target = safePath(root, path); await noLinks(root, target);
  await mkdir(dirname(target), { recursive: true }); await noLinks(root, target); return target;
}
export async function canonicalDirectory(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error('Selecione um diretório absoluto');
  await mkdir(path, { recursive: true }); const result = await realpath(path);
  if (result === parse(result).root) throw new Error('Escolha uma pasta, não a raiz do disco');
  await noLinks(result, result); return result;
}
export function secureUrl(raw: string, hosts?: readonly string[]): URL {
  const u = new URL(raw);
  if (u.protocol !== 'https:' || u.username || u.password || u.hash || (u.port && u.port !== '443')) throw new Error('Download deve usar HTTPS sem credenciais');
  if (hosts && !hosts.includes(u.hostname.toLowerCase())) throw new Error(`Host não autorizado: ${u.hostname}`);
  return u;
}
export function redact(text: string): string {
  return text.replace(/(Bearer\s+|XBL3\.0\s+x=)[^\s"<>]+/gi, '$1[REDACTED]')
    .replace(/((?:access_token|refresh_token|device_code|identityToken|client_secret|Authorization|--accessToken)["\s:=]+)[^\s",}]+/gi, '$1[REDACTED]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED]');
}
export function friendlyError(error: unknown): string {
  const e = error as NodeJS.ErrnoException;
  if (e?.name === 'AbortError') return 'Operação cancelada. Você pode tentar novamente.';
  if (e?.code === 'ENOSPC') return 'Sem espaço em disco. Libere espaço e tente novamente.';
  if (e?.code === 'EACCES' || e?.code === 'EPERM') return 'Sem permissão para acessar esta pasta ou arquivo. Escolha outro diretório.';
  if (/fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|TimeoutError/i.test(e?.message ?? '')) return 'Falha de rede. Verifique sua conexão e tente novamente.';
  return redact(e?.message || 'Não foi possível concluir a operação. Consulte o diagnóstico.').slice(0, 800);
}
