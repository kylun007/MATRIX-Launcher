import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, open, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function desktopDirectory(env = process.env, home = homedir()) {
  return join(env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : join(home, '.local', 'share'), 'applications');
}

function desktopValue(value) {
  if (/[\x00-\x1f\x7f]/.test(value)) throw new Error('O caminho contém caracteres de controle não suportados.');
  return value.replaceAll('\\', '\\\\');
}

export function desktopEntry(projectRoot, executable) {
  if (!isAbsolute(projectRoot) || !isAbsolute(executable) || executable.includes('=')) throw new Error('Caminho inválido para o atalho Linux.');
  const argument = (value) => desktopValue('"' + value.replaceAll('%', '%%').replace(/[\\"`$]/g, '\\$&') + '"');
  return `[Desktop Entry]\nType=Application\nVersion=1.0\nName=MATRIX Launcher\nComment=Launcher Minecraft Java da MATRIX Community\nExec=${argument(executable)} ${argument(projectRoot)}\nPath=${desktopValue(projectRoot)}\nIcon=${desktopValue(join(projectRoot, 'build', 'icon.png'))}\nTerminal=false\nCategories=Game;\nStartupNotify=true\n`;
}

export async function sourceFingerprint(projectRoot) {
  const hash = createHash('sha256');
  async function visit(name) {
    const path = join(projectRoot, name);
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = join(name, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) hash.update(child).update('\0').update(await readFile(join(projectRoot, child))).update('\0');
    }
  }
  for (const directory of ['src', 'electron', 'shared', 'config', 'scripts', 'assets']) await visit(directory);
  for (const name of ['package.json', 'package-lock.json', 'index.html', 'tsconfig.json', 'vite.config.ts']) hash.update(name).update(await readFile(join(projectRoot, name)));
  return hash.digest('hex');
}

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

async function linuxElectron(path) {
  let file;
  try {
    await access(path, constants.X_OK);
    file = await open(path, 'r');
    const header = Buffer.alloc(4);
    await file.read(header, 0, 4, 0);
    return header.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  } catch { return false; } finally { await file?.close(); }
}

async function run(command, args, env = process.env) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? accept() : reject(new Error(`${command} terminou com ${signal || `código ${code}`}.`)));
  });
}

async function atomicWrite(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, value, { mode: 0o600 });
  await rename(temporary, path);
}

export async function startLinux() {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Use este iniciador no Linux x86_64.');
  if (process.getuid?.() === 0) throw new Error('Abra como seu usuário normal, sem sudo.');
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 24 || (major === 24 && minor < 19)) throw new Error('É necessário Node.js 24.19 ou superior. Veja LEIA-ME-LINUX.md.');
  if (!process.argv.includes('--preparar') && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) throw new Error('Abra dentro da sessão gráfica do Linux, em vez de uma sessão SSH sem tela.');

  const executable = join(root, 'node_modules', 'electron', 'dist', 'electron');
  const markerPath = join(root, 'node_modules', '.matrix-linux-setup.json');
  const lockHash = createHash('sha256').update(await readFile(join(root, 'package-lock.json'))).digest('hex');
  let previous = {};
  try { previous = JSON.parse(await readFile(markerPath, 'utf8')); } catch { /* Primeira preparação. */ }
  if (previous.lockHash !== lockHash || !await linuxElectron(executable)) {
    console.log('\nPreparando dependências Linux. Esta etapa precisa de internet e pode levar alguns minutos.');
    await run('npm', ['ci', '--include=dev']);
    if (!await linuxElectron(executable)) throw new Error('Electron Linux não está executável. Extraia o projeto em sua pasta pessoal Linux e confira as permissões do disco.');
    previous = {};
  }
  const fingerprint = await sourceFingerprint(root);
  const outputs = ['dist/index.html', 'dist-electron/main.cjs', 'dist-electron/preload.cjs', 'build/icon.png'];
  if (previous.fingerprint !== fingerprint || !(await Promise.all(outputs.map(name => exists(join(root, name))))).every(Boolean)) {
    console.log('\nCompilando o MATRIX Launcher. Nas próximas aberturas este build será reutilizado.');
    await run('npm', ['run', 'build']);
  }
  await atomicWrite(markerPath, JSON.stringify({ lockHash, fingerprint }));
  const shortcut = join(desktopDirectory(), 'org.matrixcommunity.launcher-source.desktop');
  await atomicWrite(shortcut, desktopEntry(root, executable));
  // Um atalho de menu é legível pelo usuário; não exige bit de execução ou acesso administrativo.
  console.log('\nPronto! Procure MATRIX Launcher no menu de aplicativos e adicione aos favoritos.');
  if (process.argv.includes('--preparar')) return;
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.MATRIX_DEV_URL;
  await run(executable, [root], environment);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startLinux().catch(error => {
    console.error(`\nNão foi possível abrir o MATRIX Launcher: ${error.message}\nVeja LEIA-ME-LINUX.md para diagnóstico. Nenhuma conta, mundo ou instância foi apagada.`);
    process.exitCode = 1;
  });
}
