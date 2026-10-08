import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const rows = [];
async function scan(base) { for (const entry of await readdir(base, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
  const path = join(base, entry.name); if (entry.name.startsWith('@')) { await scan(path); continue; }
  try { const pkg = JSON.parse(await readFile(join(path, 'package.json'), 'utf8')); rows.push({ name: pkg.name, version: pkg.version, license: pkg.license ?? 'VERIFICAR', repository: pkg.repository?.url ?? pkg.homepage ?? '' }); } catch {}
} }
await scan('node_modules'); await mkdir('docs', { recursive: true });
await writeFile('docs/dependency-licenses.json', JSON.stringify(rows.sort((a,b) => a.name.localeCompare(b.name)), null, 2));
console.log(`${rows.length} licenças registradas em docs/dependency-licenses.json`);
