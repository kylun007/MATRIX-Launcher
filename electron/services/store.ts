import { readFile, writeFile, rename, mkdir, copyFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { storeSchema, nickname, type StoreData, type Account } from '../../shared/contracts.ts';
import { skinCameraSchema } from '../../shared/skin.ts';

export function defaults(gameDirectory: string): StoreData {
  return { schemaVersion: 2, accounts: [], instances: [], modFavorites: [], settings: { minMemory: 1024, maxMemory: 4096, width: 1280, height: 720, gameDirectory, javaPath: '', jvmArgs: [], concurrency: 4, serverHost: '', serverPort: 25565, serverOnlineMode: true, communityApi: '', discordUrl: '', theme: 'dark', checkUpdates: true, updateChannel: 'stable', updateCheckIntervalHours: 6, skinCamera: skinCameraSchema.parse(undefined) } };
}
export function migrateStore(value: unknown): StoreData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Formato de configurações inválido');
  const data = value as Record<string, unknown>;
  if (data.schemaVersion === 1) return storeSchema.parse({ ...data, schemaVersion: 2, settings: { ...(data.settings as Record<string, unknown>), updateChannel: 'stable', updateCheckIntervalHours: 6 } });
  return storeSchema.parse(value);
}
export function offlineIdentity(name: string): string {
  nickname.parse(name);
  const bytes = createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x30; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytes.toString('hex');
}
export function addOffline(data: StoreData, name: string): Account {
  nickname.parse(name);
  if (data.accounts.some(a => a.kind === 'offline' && a.name.toLowerCase() === name.toLowerCase())) throw new Error('Este perfil offline já existe');
  const account: Account = { id: randomUUID(), kind: 'offline', name, uuid: offlineIdentity(name), skin: '' };
  data.accounts.push(account); data.selectedAccount = account.id; return account;
}
export function renameOffline(data: StoreData, id: string, name: string): void {
  nickname.parse(name); const account = data.accounts.find(a => a.id === id);
  if (!account || account.kind !== 'offline') throw new Error('Só perfis offline podem ser renomeados');
  if (data.accounts.some(a => a.id !== id && a.kind === 'offline' && a.name.toLowerCase() === name.toLowerCase())) throw new Error('Este perfil offline já existe');
  account.name = name; account.uuid = offlineIdentity(name);
}
export class Store {
  data: StoreData;
  private queue: Promise<void> = Promise.resolve();
  constructor(readonly file: string, gameDirectory: string) { this.data = defaults(gameDirectory); }
  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as { schemaVersion?: number };
      this.data = migrateStore(raw);
      if (raw.schemaVersion !== this.data.schemaVersion) await this.save();
    }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') { await this.save(); return; }
      try { this.data = migrateStore(JSON.parse(await readFile(`${this.file}.bak`, 'utf8'))); }
      catch { throw new Error('Configuração corrompida. Preserve os arquivos settings.json e .bak antes de recuperar.'); }
    }
  }
  save(): Promise<void> {
    const content = JSON.stringify(storeSchema.parse(this.data), null, 2);
    const next = this.queue.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const temp = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temp, content, { mode: 0o600 });
      try { await copyFile(this.file, `${this.file}.bak`); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      await rename(temp, this.file);
    });
    this.queue = next.catch(() => {}); return next;
  }
}
