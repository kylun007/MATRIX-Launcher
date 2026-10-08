import { readFile, writeFile } from 'node:fs/promises';
// Published installer 6.3.5 imports this internal subpath, omitted by core 2.16.2.
// Keep the workaround version scoped and fail visibly when upgrading XMCL.
const core = JSON.parse(await readFile('node_modules/@xmcl/core/package.json', 'utf8'));
const installer = JSON.parse(await readFile('node_modules/@xmcl/installer/package.json', 'utf8'));
if (core.version !== '2.16.2' || installer.version !== '6.3.5') throw new Error('Reavalie a compatibilidade XMCL antes de atualizar suas versões.');
await writeFile('node_modules/@xmcl/core/utils.js', "// MATRIX compatibility adapter for published XMCL packages.\nexports.isNotNull = function(value) { return value !== null && value !== undefined; };\n");
console.log('Compatibilidade XMCL aplicada (core/utils).');
