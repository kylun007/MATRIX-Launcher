import { readFile, writeFile, rename, copyFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { smartPreferencesSchema, type SmartPreferences } from '../../shared/smart.ts';
import { preparePath, noLinks } from './security.ts';

export async function readOptional(file: string): Promise<string | undefined> {
  try { return await readFile(file, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; }
}
export async function atomicJson(root: string, relative: string, value: unknown): Promise<void> {
  const path = await preparePath(root, relative); const temp = await preparePath(root, `${relative}.${randomUUID()}.tmp`);
  await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 }); await rename(temp, path);
}
export async function backedUpText(root: string, relative: string, text: string): Promise<void> {
  const path = await preparePath(root, relative); const previous = await readOptional(path); if (previous === text) return;
  if (previous !== undefined) {
    const backup = await preparePath(root, `.matrix-backups/${Date.now()}-${randomUUID()}/${relative}`);
    await copyFile(path, backup);
  }
  const temp = await preparePath(root, `${relative}.${randomUUID()}.tmp`);
  await writeFile(temp, text, 'utf8'); await rename(temp, path);
}
export function mergeLines(previous: string | undefined, values: Record<string, string>, separator = ':'): string {
  const lines = (previous ?? '').split(/\r?\n/).filter((line, i, all) => line !== '' || i < all.length - 1);
  const remaining = new Map(Object.entries(values));
  const output = lines.map(line => {
    const index = line.indexOf(separator); const key = index >= 0 ? line.slice(0, index).trim() : '';
    if (!Object.hasOwn(values, key)) return line;
    remaining.delete(key); return `${key}${separator}${values[key]}`;
  });
  for (const [key, value] of remaining) output.push(`${key}${separator}${value}`);
  return `${output.join('\n')}\n`;
}
export async function applyPreferences(root: string, input: SmartPreferences): Promise<void> {
  const p = smartPreferencesSchema.parse(input);
  const path = await preparePath(root, 'options.txt');
  const previous = await readOptional(path);
  await backedUpText(root, 'options.txt', mergeLines(previous, {
    // Minecraft 1.21.1 world_version, verified from its official client version.json.
    ...(previous === undefined ? { version: '3955' } : {}),
    renderDistance: String(p.renderDistance), simulationDistance: String(p.simulationDistance),
    particles: String({ all: 0, decreased: 1, minimal: 2 }[p.particles]), graphicsMode: p.graphics === 'fast' ? '0' : '1', maxFps: String(p.maxFps),
  }));
}
function propertyValue(value: string): string {
  return Array.from(value, c => c === '\\' ? '\\\\' : c.codePointAt(0)! > 126 ? [...c].map(part => Array.from({length:part.length},(_,i)=>`\\u${part.charCodeAt(i).toString(16).padStart(4,'0')}`).join('')).join('') : c).join('');
}
export async function selectShader(root: string, filename?: string): Promise<void> {
  const path = await preparePath(root, 'config/iris.properties');
  const previous = await readOptional(path);
  await backedUpText(root, 'config/iris.properties', mergeLines(previous, { shaderPack: propertyValue(filename ?? ''), enableShaders: filename ? 'true' : 'false' }, '='));
}
export async function activeShader(root: string): Promise<string | undefined> {
  const path = await preparePath(root, 'config/iris.properties'); await noLinks(root, path);
  const text = await readOptional(path); if (!text || /^enableShaders\s*=\s*false\s*$/m.test(text)) return undefined;
  const value = text.match(/^shaderPack\s*=\s*(.*?)\s*$/m)?.[1];
  return value ? value.replace(/\\u([a-fA-F0-9]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))).replace(/\\(.)/g, '$1') : undefined;
}
