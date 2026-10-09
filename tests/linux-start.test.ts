import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
// Script independente do ambiente Electron e importável sem iniciar a preparação.
import { desktopDirectory, desktopEntry, sourceFingerprint } from '../scripts/linux-start.mjs';

test('diretório do menu usa XDG absoluto e ignora valores relativos', () => {
  const home = resolve('test-home');
  const data = resolve('test-data');
  assert.equal(desktopDirectory({ XDG_DATA_HOME: data }, home), join(data, 'applications'));
  assert.equal(desktopDirectory({ XDG_DATA_HOME: 'relative' }, home), join(home, '.local', 'share', 'applications'));
});

test('atalho abre Electron de produção com espaços e caracteres reservados escapados', () => {
  const project = resolve('MATRIX space $cash "quote" 50% `tick`');
  const binary = join(project, 'node_modules', 'electron', 'dist', 'electron');
  const entry = desktopEntry(project, binary);
  assert.match(entry, /Terminal=false/);
  assert.match(entry, /Categories=Game;/);
  assert.ok(entry.includes('\\\\$cash'));
  assert.ok(entry.includes('\\\\"quote\\\\"'));
  assert.ok(entry.includes('50%%'));
  assert.equal((entry.match(/Exec=/g) || []).length, 1);
  assert.ok(!entry.includes('npm') && !entry.includes('--no-sandbox') && !entry.includes('MATRIX_DEV_URL'));
  assert.throws(() => desktopEntry(project + '\nExec=bad', binary), /controle/);
  assert.throws(() => desktopEntry(project, 'relative/electron'), /inválido/);
});

test('build reutilizável detecta mudanças no código e na configuração', async () => {
  const project = await mkdtemp(join(tmpdir(), 'matrix-linux-fingerprint-'));
  for (const directory of ['src', 'electron', 'shared', 'config', 'scripts', 'assets']) await mkdir(join(project, directory));
  for (const file of ['package.json', 'package-lock.json', 'index.html', 'tsconfig.json', 'vite.config.ts']) await writeFile(join(project, file), '{}');
  await writeFile(join(project, 'src', 'app.ts'), 'original');
  const initial = await sourceFingerprint(project);
  assert.equal(await sourceFingerprint(project), initial);
  await writeFile(join(project, 'src', 'app.ts'), 'changed');
  assert.notEqual(await sourceFingerprint(project), initial);
  const changed = await sourceFingerprint(project);
  await writeFile(join(project, 'config', 'distribution.json'), '{"website":"https://example.com"}');
  assert.notEqual(await sourceFingerprint(project), changed);
});
