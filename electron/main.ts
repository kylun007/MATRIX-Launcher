import { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, clipboard } from 'electron';
import { join, basename, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, stat, open, rename, copyFile, rm } from 'node:fs/promises';
import { totalmem } from 'node:os';
import { MicrosoftAuthenticator } from '@xmcl/user';
import distribution from '../config/distribution.json';
import { commandSchemas, type Command, type Snapshot, type Operation, type Community, type ServerStatus, type Instance, type JavaState } from '../shared/contracts.ts';
import { Store, addOffline, renameOffline } from './services/store.ts';
import { Vault, MicrosoftAuth } from './services/auth.ts';
import { Minecraft, instanceDirectory, resourceDirectory } from './services/minecraft.ts';
import { canonicalDirectory, friendlyError, secureUrl, noLinks } from './services/security.ts';
import { detectJava, installJava, javaRequirement } from './services/java.ts';
import { syncModpack } from './services/modpack.ts';
import { fetchCommunity, serverStatus } from './services/community.ts';
import { Updates } from './services/updates.ts';
import { Logs } from './services/logs.ts';
import { nativeHttpsFetch } from './services/http.ts';
import { setNetworkTransport } from './services/download.ts';
import { SmartInstallService } from './services/smart-install.ts';
import { detectHardware, recommendHardware } from './services/hardware.ts';
import type { SmartProgress, SmartPlan } from '../shared/smart.ts';
import { SkinLibrary, decodeSkinPNG, encodeSkinPNG, decodePreviewPNG } from './services/skins.ts';
import { skinDocumentSchema, type SkinDraft, type SkinSave } from '../shared/skin.ts';
import { importOfficialAccountSkin, applyAccountSkin } from './services/account-skin.ts';
import { ModCenterService } from './services/mod-center.ts';

let window: BrowserWindow | undefined;
const smoke = !app.isPackaged && process.argv.includes('--matrix-smoke');
if (smoke) app.setPath('userData', join(process.cwd(), '.smoke/user-data'));
let store: Store; let minecraft: Minecraft; let auth: MicrosoftAuth; let vault: Vault; let updates: Updates; let logs: Logs;
let smart: SmartInstallService;
let modCenter: ModCenterService;
let skins: SkinLibrary;
let skinEditorActive = false;
async function exportSkinFile(file: string, data: Buffer): Promise<void> {
  const temp = `${file}.${randomUUID()}.tmp`;
  await noLinks(dirname(file), file); await noLinks(dirname(temp), temp);
  try {
    const exists = await stat(file).catch(e => { if (e.code === 'ENOENT') return undefined; throw e; });
    if (exists) { if (!exists.isFile()) throw new Error('Destino não é um arquivo'); await noLinks(dirname(file), `${file}.bak`); await copyFile(file, `${file}.bak`); }
    const handle = await open(temp, 'wx'); try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
    await rename(temp, file);
  } finally { await rm(temp, { force: true }); }
}
let operation: Operation | undefined; let controller: AbortController | undefined;
let community: Community | undefined; let communityError: string | undefined; let server: ServerStatus = { status: 'unconfigured' };
let authCode: Snapshot['authCode']; let lastError: string | undefined; let lastEmit = 0; let pendingEmit: NodeJS.Timeout | undefined;
let activeCommand: string | undefined;
let javaState: JavaState = { status: 'unknown' }; let javaKey = '';
let lastAutomaticUpdateCheck = 0;
const rendererPath = join(__dirname, '../dist/index.html');
const devUrl = !app.isPackaged && process.env.MATRIX_DEV_URL === 'http://127.0.0.1:5173' ? process.env.MATRIX_DEV_URL : undefined;
function snapshot(): Snapshot { return { ...store.data, game: minecraft.game, java: javaState, operation, community, communityError, server, authCode, error: lastError, update: updates.state, appVersion: app.getVersion(), microsoftConfigured: !!distribution.microsoftClientId }; }
function emit(): void {
  if (!window || window.isDestroyed() || !updates) return;
  const now = Date.now(); if (now - lastEmit < 150) { pendingEmit ??= setTimeout(() => { pendingEmit = undefined; emit(); }, 150); return; }
  lastEmit = now; window.webContents.send('matrix:snapshot', snapshot());
}
function idle(): void { if (operation || minecraft.game.status !== 'idle') throw new Error('Aguarde a operação ou encerre o Minecraft antes de alterar esta configuração'); }
function instance(id: string): Instance { const result = store.data.instances.find(i => i.id === id); if (!result) throw new Error('Instalação não encontrada'); return result; }
async function refreshJava(): Promise<void> {
  const selected = store.data.instances.find(i => i.id === store.data.selectedInstance); const settings = store.data.settings;
  const javaPath = selected?.launch?.javaPath ?? settings.javaPath;
  const key = JSON.stringify([selected?.id, selected?.installed, settings.gameDirectory, javaPath]); if (key === javaKey) return; javaKey = key;
  javaState = { status: 'unknown' };
  if (selected?.installed) {
    try {
      const info = await minecraft.localMetadata(selected, settings); const required = javaRequirement(info, selected.minecraft);
      const found = await detectJava(join(settings.gameDirectory, 'runtimes'), javaPath);
      const manual = javaPath ? found.find(j => j.path === javaPath) : undefined;
      const compatible = javaPath ? manual?.major === required : found.some(j => j.major === required);
      javaState = { status: compatible ? 'ready' : manual ? 'incompatible' : 'missing', required, major: manual?.major };
    } catch { selected.installed = false; javaState = { status: 'unknown' }; }
  }
}
async function save(): Promise<void> { await refreshJava(); await store.save(); emit(); }
async function run(kind: Operation['kind'], label: string, work: (signal: AbortSignal, progress: (label: string, bytes: number, total: number, speed: number, smart?: SmartProgress) => void) => Promise<void>): Promise<void> {
  idle(); controller = new AbortController(); operation = { kind, label, bytes: 0, total: 0, speed: 0, cancellable: true }; lastError = undefined; emit();
  try { await work(controller.signal, (label, bytes, total, speed, smart) => { operation = { kind, label, bytes, total, speed, cancellable: true, smart }; emit(); }); }
  finally { operation = undefined; controller = undefined; authCode = undefined; emit(); }
}
let refreshing: Promise<void> | undefined;
function refreshCommunity(): Promise<void> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const results = await Promise.allSettled([fetchCommunity(store.data.settings), serverStatus(store.data.settings.serverHost, store.data.settings.serverPort)]);
    if (results[0].status === 'fulfilled') { community = results[0].value; communityError = undefined; } else communityError = friendlyError(results[0].reason);
    if (results[1].status === 'fulfilled') server = results[1].value; emit();
  })().finally(() => { refreshing = undefined; }); return refreshing;
}
async function handle(command: Command, input: unknown): Promise<unknown> {
  const value = commandSchemas[command].parse(input);
  switch (command) {
    case 'skin.camera': {
      const camera = commandSchemas['skin.camera'].parse(value);
      store.data.settings.skinCamera = camera; await store.save(); emit(); return camera;
    }
    case 'skin.editor.active': skinEditorActive = value as boolean; return;
    case 'skin.editor.close': skinEditorActive = false; window?.close(); return;
    case 'skin.list': return skins.list();
    case 'skin.open': return skins.open(value as string);
    case 'skin.save': return skins.save(value as SkinSave);
    case 'skin.rename': { const data = commandSchemas['skin.rename'].parse(value); return skins.rename(data.id, data.name); }
    case 'skin.duplicate': return skins.duplicate(value as string);
    case 'skin.delete': {
      const id = value as string; const project = await skins.open(id);
      const answer = await dialog.showMessageBox(window!, { type: 'question', buttons: ['Cancelar', 'Excluir'], defaultId: 0, cancelId: 0, message: `Excluir “${project.name}” da biblioteca?`, detail: 'Um backup será preservado. Exportações e mundos permanecem intactos.' });
      if (answer.response !== 1) return;
      await skins.delete(id);
      for (const account of store.data.accounts) if (account.skinProjectId === id) delete account.skinProjectId;
      await store.save(); emit(); return;
    }
    case 'skin.import': case 'skin.project.import': {
      const project = command === 'skin.project.import';
      const result = await dialog.showOpenDialog(window!, { properties: ['openFile'], filters: [{ name: project ? 'Projeto MATRIX Skin' : 'Skin PNG', extensions: project ? ['matrixskin', 'json'] : ['png'] }] });
      if (result.canceled || !result.filePaths[0]) return;
      const file = result.filePaths[0]; const info = await stat(file);
      if (!info.isFile() || info.size > 1_000_000) throw new Error('Arquivo inválido ou maior que 1 MB');
      const data = await readFile(file);
      if (!project) return { ...decodeSkinPNG(data), name: basename(file, '.png').slice(0, 80) || 'Skin importada' };
      if (data.length > 1_000_000) throw new Error('Projeto excede o limite permitido');
      const parsed = JSON.parse(data.toString('utf8')); if (parsed.schemaVersion !== 1) throw new Error('Versão de projeto não suportada');
      return skinDocumentSchema.parse({ name: parsed.name, model: parsed.model, pixels: parsed.pixels, palette: parsed.palette });
    }
    case 'skin.export': {
      const data = commandSchemas['skin.export'].parse(value); const png = data.format === 'png';
      const result = await dialog.showSaveDialog(window!, { defaultPath: `${data.document.name.replace(/[^A-Za-z0-9 _-]/g, '_')}.${png ? 'png' : 'matrixskin'}`, filters: [{ name: png ? 'Skin PNG' : 'Projeto MATRIX Skin', extensions: [png ? 'png' : 'matrixskin'] }] });
      if (result.canceled || !result.filePath) return;
      await exportSkinFile(result.filePath, png ? encodeSkinPNG(data.document) : Buffer.from(JSON.stringify({ schemaVersion: 1, ...data.document }))); return result.filePath;
    }
    case 'skin.preview.export': {
      const png = decodePreviewPNG(commandSchemas['skin.preview.export'].parse(value).png);
      const result = await dialog.showSaveDialog(window!, { defaultPath: 'matrix-skin-preview.png', filters: [{ name: 'PNG', extensions: ['png'] }] });
      if (result.canceled || !result.filePath) return; await exportSkinFile(result.filePath, png); return result.filePath;
    }
    case 'skin.draft.get': return skins.getDraft();
    case 'skin.draft.save': return skins.saveDraft(value as SkinDraft);
    case 'skin.draft.clear': return skins.clearDraft();
    case 'skin.account.import': {
      const account = store.data.accounts.find(a => a.id === value); if (!account) throw new Error('Conta não encontrada');
      if (account.kind === 'offline') { if (!account.skinProjectId) throw new Error('Perfil sem skin local associada'); const p = await skins.open(account.skinProjectId); return skinDocumentSchema.parse({ name: p.name, model: p.model, pixels: p.pixels, palette: p.palette }); }
      const imported = await importOfficialAccountSkin(account, auth, nativeHttpsFetch); Object.assign(account, imported.account); await store.save(); emit();
      return imported.document;
    }
    case 'skin.account.assign': {
      const data = commandSchemas['skin.account.assign'].parse(value);
      const account = store.data.accounts.find(a => a.id === data.accountId);
      if (!account || account.kind !== 'offline') throw new Error('Selecione um perfil offline');
      await skins.open(data.projectId); account.skinProjectId = data.projectId; await store.save(); emit(); return;
    }
    case 'skin.account.apply': {
      idle(); const data = commandSchemas['skin.account.apply'].parse(value);
      const account = store.data.accounts.find(a => a.id === data.accountId); if (!account) throw new Error('Conta não encontrada');
      const answer = await dialog.showMessageBox(window!, { type: 'question', buttons: ['Cancelar', 'Aplicar skin'], defaultId: 0, cancelId: 0, message: `Atualizar a skin oficial de ${account.name}?` });
      if (answer.response !== 1) return false;
      const updated = await applyAccountSkin(account, data.document, auth, nativeHttpsFetch); Object.assign(account, updated); await store.save(); emit(); return true;
    }
    case 'snapshot': return snapshot();
    case 'releases': return minecraft.releases();
    case 'mod.search': return smart.catalog.searchMods(commandSchemas['mod.search'].parse(value));
    case 'mod.details': { const d = commandSchemas['mod.details'].parse(value); return smart.catalog.details(d.projectId, d.minecraft, d.loader); }
    case 'mod.plan': { const d = commandSchemas['mod.plan'].parse(value); let plan; await run('mods', 'Resolvendo mod e dependências', async signal => { plan = await modCenter.plan(d.instanceId, d.projectId, signal); }); return plan!; }
    case 'mod.install': { await run('mods', 'Instalando mods', async (signal, progress) => modCenter.install(value as string, signal, (label, bytes, total, speed) => progress(`Instalando ${label}`, bytes, total, speed))); await save(); return; }
    case 'mod.list': return modCenter.list(value as string);
    case 'mod.toggle': { idle(); const d = commandSchemas['mod.toggle'].parse(value); await modCenter.toggle(d.instanceId, d.filename, d.enabled); await save(); return; }
    case 'mod.remove': { idle(); const d = commandSchemas['mod.remove'].parse(value); await modCenter.remove(d.instanceId, d.filename); await save(); return; }
    case 'mod.favorite': { const d = commandSchemas['mod.favorite'].parse(value); await modCenter.favorite(d.projectId, d.favorite); emit(); return; }
    case 'mod.favorites': return modCenter.favorites();
    case 'settings': {
      idle(); const settings = commandSchemas.settings.parse(value);
      if (settings.maxMemory * 1024 * 1024 > totalmem() - 1024 * 1024 * 1024) throw new Error('Reserve pelo menos 1 GB de RAM para o sistema operacional');
      settings.gameDirectory = await canonicalDirectory(settings.gameDirectory);
      if (settings.gameDirectory !== store.data.settings.gameDirectory) for (const i of store.data.instances) i.installed = false;
      store.data.settings = settings; await save(); void refreshCommunity(); return;
    }
    case 'account.create': idle(); addOffline(store.data, (value as { name: string }).name); return save();
    case 'account.rename': { idle(); const data = value as { id: string; name: string }; renameOffline(store.data, data.id, data.name); return save(); }
    case 'account.select': if (!store.data.accounts.some(a => a.id === value)) throw new Error('Conta não encontrada'); store.data.selectedAccount = value as string; return save();
    case 'account.delete': { idle(); const account = store.data.accounts.find(a => a.id === value); if (account?.kind === 'microsoft') await vault.remove(account.id); store.data.accounts = store.data.accounts.filter(a => a.id !== value); if (store.data.selectedAccount === value) store.data.selectedAccount = store.data.accounts[0]?.id; return save(); }
    case 'auth.login': return run('auth', 'Aguardando autenticação Microsoft', async signal => {
      const account = await auth.login(signal, code => { authCode = code; emit(); });
      const existing = store.data.accounts.find(a => a.kind === 'microsoft' && a.uuid === account.uuid);
      if (existing) { const secret = await vault.get(account.id); await vault.set(existing.id, secret!); await vault.remove(account.id); account.id = existing.id; store.data.accounts = store.data.accounts.filter(a => a.id !== existing.id); }
      store.data.accounts.push(account); store.data.selectedAccount = account.id; await save();
    });
    case 'instance.create': {
      idle(); const data = commandSchemas['instance.create'].parse(value);
      const created = { ...data, id: randomUUID(), installed: false }; store.data.instances.push(created); store.data.selectedInstance = created.id; return save();
    }
    case 'instance.select': instance(value as string); store.data.selectedInstance = value as string; return save();
    case 'instance.discover': { idle(); return minecraft.scan(store.data.settings); }
    case 'instance.rename': { idle(); const data = commandSchemas['instance.rename'].parse(value); instance(data.id).name = data.name; return save(); }
    case 'smart.hardware': return detectHardware(store.data.settings);
    case 'smart.recommend': return recommendHardware(await detectHardware(store.data.settings), commandSchemas['smart.recommend'].parse(value));
    case 'smart.catalog': return smart.catalog.catalog();
    case 'smart.plan': { let plan: SmartPlan | undefined; await run('smart', 'Resolvendo compatibilidade dos mods', async (signal, progress) => { plan = await smart.plan(commandSchemas['smart.plan'].parse(value), signal, undefined, (l, b, t, s) => progress(l, b, t, s)); }); return plan!; }
    case 'smart.update': { let plan: SmartPlan | undefined; await run('smart', 'Revisando componentes compatíveis', async (signal, progress) => { plan = await smart.update(value as string, signal, (l, b, t, s) => progress(l, b, t, s)); }); return plan!; }
    case 'smart.install': {
      const data = commandSchemas['smart.install'].parse(value); let id = '';
      await run('smart', 'Preparando Smart Install', async (signal, progress) => { id = await smart.install(data.planId, data.allowJavaInstall, signal, progress); }); await save(); return id;
    }
    case 'smart.resume': {
      const data = commandSchemas['smart.resume'].parse(value);
      await run('smart', 'Retomando Smart Install', async (signal, progress) => smart.resume(data.id, data.allowJavaInstall, signal, progress)); return save();
    }
    case 'smart.content': return smart.content(value as string);
    case 'smart.configure': { idle(); const data = commandSchemas['smart.configure'].parse(value); await smart.configure(data.id, data.preferences); return save(); }
    case 'smart.mod.toggle': { idle(); const data = commandSchemas['smart.mod.toggle'].parse(value); await smart.toggleMod(data.id, data.projectId, data.enabled); return save(); }
    case 'shader.search': return smart.catalog.searchShaders(commandSchemas['shader.search'].parse(value).query);
    case 'shader.plan': { const data = commandSchemas['shader.plan'].parse(value); let plan: SmartPlan | undefined; await run('smart', 'Resolvendo Iris e shader', async (signal, progress) => { plan = await smart.shaderPlan(data.id, data.projectId, signal, (l, b, t, s) => progress(l, b, t, s)); }); return plan!; }
    case 'shader.install': {
      const data = commandSchemas['shader.install'].parse(value);
      await run('smart', 'Baixando shader', async (signal, progress) => smart.installShader(data.id, data.projectId, signal, (l, b, t, s) => progress(l, b, t, s))); return save();
    }
    case 'shader.select': { idle(); const data = commandSchemas['shader.select'].parse(value); await smart.selectShader(data.id, data.filename); return save(); }
    case 'shader.delete': { idle(); const data = commandSchemas['shader.delete'].parse(value); await smart.deleteShader(data.id, data.filename); return save(); }
    case 'instance.delete': idle(); instance(value as string); store.data.instances = store.data.instances.filter(i => i.id !== value); if (store.data.selectedInstance === value) store.data.selectedInstance = store.data.instances[0]?.id; return save();
    case 'instance.open': { const directory = instanceDirectory(store.data.settings, instance(value as string)); await noLinks(store.data.settings.gameDirectory, directory); await mkdir(directory, { recursive: true }); const error = await shell.openPath(directory); if (error) throw new Error(error); return; }
    case 'instance.inspect': { idle(); try { const selected = instance(value as string); await minecraft.inspect(selected, store.data.settings); if (selected.smart) await smart.inspect(selected.id); return { valid: true, message: 'Arquivos verificados. Instalação íntegra.' }; } catch (e) { return { valid: false, message: `Reparação necessária: ${friendlyError(e)}` }; } }
    case 'instance.install': return run('minecraft', 'Preparando instalação', async (signal, progress) => {
      const selected = instance(value as string); selected.installed = false; await save();
      if (selected.smart) await smart.resume(selected.id, false, signal, (l, b, t, s) => progress(l, b, t, s));
      else { selected.versionId = await minecraft.install(selected, store.data.settings, signal, (l, b, t, s) => progress(l, b, t, s)); selected.installed = true; } await save();
    });
    case 'java.detect': return detectJava(join(store.data.settings.gameDirectory, 'runtimes'), store.data.settings.javaPath);
    case 'java.choose': { const result = await dialog.showOpenDialog(window!, { title: 'Selecione o executável Java', properties: ['openFile'], filters: process.platform === 'win32' ? [{ name: 'Java', extensions: ['exe'] }] : [] }); return result.canceled ? undefined : result.filePaths[0]; }
    case 'directory.choose': { const result = await dialog.showOpenDialog(window!, { properties: ['openDirectory', 'createDirectory'], title: 'Pasta das instalações Minecraft' }); return result.canceled ? undefined : result.filePaths[0]; }
    case 'java.install': return run('java', 'Baixando Java oficial da Mojang', async (signal, progress) => {
      const selected = instance(value as string); const info = await minecraft.metadata(selected, store.data.settings, signal); const major = javaRequirement(info, info.id);
      const component = info.javaVersion?.component ?? (major === 8 ? 'jre-legacy' : major === 16 ? 'java-runtime-alpha' : major === 17 ? 'java-runtime-gamma' : 'java-runtime-delta');
      await installJava(join(store.data.settings.gameDirectory, 'runtimes'), component, major, signal, (b, t, s) => progress(`Instalando Java ${major}`, b, t, s), store.data.settings.concurrency);
      store.data.settings.javaPath = ''; javaKey = ''; await save();
    });
    case 'game.play': {
      idle(); const data = value as { id: string; connect: boolean }; const selected = instance(data.id);
      if (selected.smart) await smart.inspect(selected.id);
      let account = store.data.accounts.find(a => a.id === store.data.selectedAccount); if (!account) throw new Error('Crie ou selecione uma conta na tela Contas');
      let token: string | undefined;
      if (account.kind === 'microsoft') { const session = await auth.session(account); account = session.account; token = session.accessToken; logs.protect(token); store.data.accounts = store.data.accounts.map(a => a.id === account!.id ? account! : a); await save(); }
      try { await minecraft.play(selected, store.data.settings, account, token, data.connect); }
      catch (e) { try { await minecraft.inspect(selected, store.data.settings); } catch { selected.installed = false; await save(); } throw e; }
      selected.lastPlayed = Date.now(); await save(); return;
    }
    case 'game.stop': return minecraft.stop();
    case 'cancel': return controller?.abort();
    case 'community.refresh': return refreshCommunity();
    case 'server.copy': { if (!store.data.settings.serverHost) throw new Error('Configure o servidor primeiro'); clipboard.writeText(`${store.data.settings.serverHost}:${store.data.settings.serverPort}`); return; }
    case 'link.open': {
      const url = secureUrl(value as string); const allowed = [new URL(distribution.website).hostname, 'www.minecraft.net', 'www.microsoft.com', 'microsoft.com', 'discord.gg', 'discord.com', 'modrinth.com', 'github.com'];
      if (store.data.settings.discordUrl) allowed.push(new URL(store.data.settings.discordUrl).hostname);
      if (!allowed.includes(url.hostname)) throw new Error('Link externo não autorizado'); await shell.openExternal(url.href); return;
    }
    case 'modpack.sync': { const data = value as { id: string; url: string; sha256: string; allowRemove: boolean }; return run('modpack', 'Validando manifesto do modpack', async (signal, progress) => {
      const selected = instance(data.id); if (!selected.installed) throw new Error('Instale o Minecraft e o loader antes de sincronizar');
      if (selected.smart) throw new Error('Use as ferramentas do Smart Install para gerenciar esta instância; crie outra instalação para um modpack externo.');
      selected.modpackVersion = await syncModpack(selected, instanceDirectory(store.data.settings, selected), data.url, data.sha256, distribution.modpackAllowedHosts, data.allowRemove, signal, (l, b, t, s) => progress(l, b, t, s)); await save();
    }); }
    case 'logs.open': await mkdir(logs.directory, { recursive: true }); { const error = await shell.openPath(logs.directory); if (error) throw new Error(error); } return;
    case 'logs.export': {
      const result = await dialog.showSaveDialog(window!, { title: 'Exportar diagnóstico', defaultPath: 'matrix-diagnostico.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
      if (result.canceled || !result.filePath) return; await logs.flush();
      await writeFile(result.filePath, JSON.stringify({ app: app.getVersion(), os: process.platform, arch: process.arch, electron: process.versions.electron, game: minecraft.game, operation, error: lastError, accounts: store.data.accounts.map(a => ({ kind: a.kind, expired: a.expiresAt ? a.expiresAt < Date.now() : undefined })), instances: store.data.instances.map(i => ({ minecraft: i.minecraft, loader: i.loader, installed: i.installed })), memory: { min: store.data.settings.minMemory, max: store.data.settings.maxMemory } }, null, 2)); return result.filePath;
    }
    case 'update.check': return updates.check(store.data.settings.updateChannel);
    case 'update.download': return updates.download();
    case 'update.apply': idle(); if (skinEditorActive) throw new Error('Salve ou feche o Skin Studio antes de reiniciar para atualizar'); store.data.pendingUpdateVersion = updates.state.version; await store.save(); return updates.apply();
  }
}
async function createWindow(): Promise<void> {
  window = new BrowserWindow({ show: !smoke, width: 1280, height: 820, minWidth: 900, minHeight: 640, backgroundColor: '#141416', title: 'MATRIX Launcher', icon: join(__dirname, '../build/icon.png'), autoHideMenuBar: true, webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  const allowedFullscreen = (contents: Electron.WebContents | null, permission: string, details: { isMainFrame: boolean; requestingUrl?: string }) => {
    const expected = devUrl ? `${devUrl}/` : pathToFileURL(rendererPath).href;
    return permission === 'fullscreen' && contents === window?.webContents && details.isMainFrame && details.requestingUrl === expected && contents?.mainFrame.url === expected;
  };
  window.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => callback(allowedFullscreen(contents, permission, details)));
  window.webContents.session.setPermissionCheckHandler((contents, permission, _origin, details) => allowedFullscreen(contents, permission, details));
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  if (devUrl) await window.loadURL(devUrl); else await window.loadFile(rendererPath);
  window.on('close', event => {
    if (skinEditorActive && !operation && minecraft.game.status === 'idle') { event.preventDefault(); window!.webContents.send('matrix:skin-close'); return; }
    if (operation || minecraft.game.status !== 'idle') { event.preventDefault(); void dialog.showMessageBox(window!, { type: 'info', message: 'Cancele a operação e encerre o Minecraft antes de fechar o launcher.' }); }
  });
}
const lock = app.requestSingleInstanceLock();
if (!lock) app.quit();
else {
  app.on('second-instance', () => { window?.restore(); window?.focus(); });
  app.whenReady().then(async () => {
    const userData = app.getPath('userData'); logs = new Logs(join(userData, 'logs'));
    store = new Store(join(userData, 'settings.json'), join(userData, 'games')); await store.load();
    if (!store.data.settings.communityApi) store.data.settings.communityApi = distribution.communityApi;
    if (!store.data.settings.discordUrl) store.data.settings.discordUrl = distribution.discordUrl;
    vault = new Vault(join(userData, 'credentials.bin'), safeStorage);
    setNetworkTransport(nativeHttpsFetch);
    auth = new MicrosoftAuth(distribution.microsoftClientId, vault, new MicrosoftAuthenticator({ fetch: nativeHttpsFetch }), nativeHttpsFetch);
    minecraft = new Minecraft(emit, message => logs.write(message));
    let loggedUpdateStatus = '';
    updates = new Updates(() => {
      if (updates.state.status !== loggedUpdateStatus) { loggedUpdateStatus = updates.state.status; logs.write(`Atualizador: ${loggedUpdateStatus}${updates.state.version ? ` (${updates.state.version})` : ''}`); }
      emit();
    });
    if (store.data.pendingUpdateVersion) {
      updates.confirmRestart(store.data.pendingUpdateVersion, app.getVersion());
      logs.write(updates.state.message ?? 'Resultado da atualização observado na inicialização');
      delete store.data.pendingUpdateVersion; await store.save();
    }
    smart = new SmartInstallService(store, minecraft);
    modCenter = new ModCenterService(store, smart.catalog, async id => (await smart.content(id)), (id, projectId, enabled) => smart.toggleMod(id, projectId, enabled));
    skins = new SkinLibrary(join(userData, 'skin-studio'));
    for (const i of store.data.instances) if (i.smart?.status === 'installing') { i.smart.status = 'interrupted'; i.installed = false; }
    await refreshJava();
    ipcMain.handle('matrix:command', async (event, command: unknown, input: unknown) => {
      const url = event.senderFrame?.url;
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || url !== (devUrl ? `${devUrl}/` : pathToFileURL(rendererPath).href)) return { ok: false, error: 'Origem IPC não autorizada' };
      if (typeof command !== 'string' || !Object.hasOwn(commandSchemas, command)) return { ok: false, error: 'Comando desconhecido' };
      const independent = ['snapshot', 'cancel', 'game.stop', 'server.copy', 'link.open', 'logs.open', 'community.refresh', 'skin.camera', 'skin.list', 'skin.open', 'skin.save', 'skin.draft.get', 'skin.draft.save', 'skin.draft.clear', 'skin.editor.active', 'skin.editor.close'].includes(command);
      if (!independent && activeCommand) return { ok: false, error: `Aguarde a operação ${activeCommand}` };
      if (!independent) activeCommand = command;
      try { const value = await handle(command as Command, input); return { ok: true, value }; }
      catch (error) { lastError = friendlyError(error); logs.write(`${command}: ${lastError}`); emit(); return { ok: false, error: lastError }; }
      finally { if (!independent) activeCommand = undefined; }
    });
    await createWindow(); logs.write('MATRIX Launcher iniciado'); void refreshCommunity();
    const timer = setInterval(() => void refreshCommunity(), 60000); timer.unref();
    const checkUpdates = () => {
      if (!store.data.settings.checkUpdates || updates.state.status === 'disabled' || operation || minecraft.game.status !== 'idle' || skinEditorActive) return;
      lastAutomaticUpdateCheck = Date.now();
      void updates.check(store.data.settings.updateChannel).catch(error => logs.write(`update.check: ${friendlyError(error)}`));
    };
    const initialUpdateCheck = setTimeout(checkUpdates, 45000); initialUpdateCheck.unref();
    const updateTimer = setInterval(() => { if (Date.now() - lastAutomaticUpdateCheck >= store.data.settings.updateCheckIntervalHours * 60 * 60 * 1000) checkUpdates(); }, 15 * 60 * 1000); updateTimer.unref();
  }).catch(error => { dialog.showErrorBox('MATRIX Launcher', friendlyError(error)); app.quit(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
