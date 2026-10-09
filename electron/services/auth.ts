import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { Account } from '../../shared/contracts.ts';
import { httpsFetch } from './download.ts';

const tokenSchema = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1), expires_in: z.number().positive() });
export type OAuthToken = z.infer<typeof tokenSchema>;
type Secret = { refreshToken: string; minecraftToken: string; expiresAt: number };
export type CryptoStorage = { isEncryptionAvailable(): boolean; encryptString(value: string): Buffer; decryptString(value: Buffer): string; getSelectedStorageBackend?(): string };
export class Vault {
  private queue: Promise<void> = Promise.resolve();
  constructor(private file: string, private crypto: CryptoStorage) {}
  private check(): void {
    if (!this.crypto.isEncryptionAvailable() || this.crypto.getSelectedStorageBackend?.() === 'basic_text') throw new Error('Armazenamento seguro indisponível. Ative o cofre de credenciais do sistema para usar login Microsoft.');
  }
  private async read(): Promise<Record<string, unknown>> {
    this.check();
    try { return JSON.parse(this.crypto.decryptString(await readFile(this.file))); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw new Error('Não foi possível abrir credenciais. Entre novamente após recuperar o cofre do sistema.'); }
  }
  async get(id: string): Promise<Secret | undefined> { await this.queue; return (await this.read())[id] as Secret | undefined; }
  async getSecureValue<T>(id: string): Promise<T | undefined> { await this.queue; return (await this.read())[id] as T | undefined; }
  private mutate(action: (data: Record<string, unknown>) => void): Promise<void> {
    const next = this.queue.then(async () => {
      const data = await this.read(); action(data); await mkdir(dirname(this.file), { recursive: true });
      const temp = `${this.file}.tmp`; await writeFile(temp, this.crypto.encryptString(JSON.stringify(data)), { mode: 0o600 }); await rename(temp, this.file);
    }); this.queue = next.catch(() => {}); return next;
  }
  set(id: string, secret: Secret): Promise<void> { return this.mutate(data => { data[id] = secret; }); }
  setSecureValue<T>(id: string, value: T): Promise<void> { return this.mutate(data => { data[id] = value; }); }
  remove(id: string): Promise<void> { return this.mutate(data => { delete data[id]; }); }
}
const AUTH_BASE = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
const SCOPES = 'XboxLive.signin offline_access';
export interface XboxAdapter {
  acquireXBoxToken(token: string, signal?: AbortSignal): Promise<{ minecraftXstsResponse: { Token: string; DisplayClaims: { xui: { uhs: string }[] } } }>;
  loginMinecraftWithXBox(uhs: string, token: string, signal?: AbortSignal): Promise<{ access_token: string; expires_in: number }>;
}
export class MicrosoftAuth {
  constructor(private clientId: string, private vault: Vault, private xbox: XboxAdapter, private fetcher: typeof fetch = fetch) {}
  private configured(): void { if (!/^[a-f0-9-]{36}$/i.test(this.clientId)) throw new Error('Login Microsoft depende do registro e autorização do aplicativo MATRIX. Consulte docs/AUTHENTICATION.md.'); }
  private async post(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<Response> {
    return httpsFetch(`${AUTH_BASE}/${path}`, { method: 'POST', body: new URLSearchParams(params), signal, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, ['login.microsoftonline.com'], this.fetcher);
  }
  async login(signal: AbortSignal, showCode: (code: { code: string; url: string; expiresAt: number }) => void): Promise<Account> {
    this.configured();
    const response = await this.post('devicecode', { client_id: this.clientId, scope: SCOPES }, signal);
    if (!response.ok) throw new Error('Microsoft recusou o início do login. Verifique o registro e os fluxos de cliente público.');
    const device = z.object({ device_code: z.string(), user_code: z.string(), verification_uri: z.string().url(), expires_in: z.number().positive(), interval: z.number().positive().default(5) }).parse(await response.json());
    const expiresAt = Date.now() + device.expires_in * 1000;
    if (new URL(device.verification_uri).hostname !== 'www.microsoft.com' && new URL(device.verification_uri).hostname !== 'microsoft.com') throw new Error('Endereço de login inesperado');
    showCode({ code: device.user_code, url: device.verification_uri, expiresAt });
    let interval = device.interval;
    while (Date.now() < expiresAt) {
      await delay(interval * 1000, undefined, { signal });
      const poll = await this.post('token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: this.clientId, device_code: device.device_code }, signal);
      const body = await poll.json() as Record<string, unknown>;
      if (poll.ok) return this.complete(tokenSchema.parse(body), undefined, signal);
      if (body.error === 'authorization_pending') continue;
      if (body.error === 'slow_down') { interval += 5; continue; }
      if (body.error === 'authorization_declined' || body.error === 'access_denied') throw new Error('Login não autorizado pela conta Microsoft');
      if (body.error === 'expired_token') break;
      throw new Error('Login Microsoft falhou. Verifique o registro do aplicativo e tente novamente.');
    }
    throw new Error('O código de login expirou. Inicie um novo login.');
  }
  private async complete(oauth: OAuthToken, existing?: Account, signal?: AbortSignal): Promise<Account> {
    const { minecraftXstsResponse: xsts } = await this.xbox.acquireXBoxToken(oauth.access_token, signal).catch(() => { throw new Error('Xbox recusou a autenticacao. Verifique o perfil Xbox e as restricoes familiares.'); });
    const mc = await this.xbox.loginMinecraftWithXBox(xsts.DisplayClaims.xui[0].uhs, xsts.Token, signal).catch(error => {
      const status = (error as { status?: unknown })?.status;
      const retryable = (error as { retryable?: unknown })?.retryable === true;
      const detail = typeof status === 'number' ? ` (HTTP ${status}${retryable ? ', tente novamente mais tarde' : ''})` : '';
      throw new Error(`Minecraft recusou a troca da sessao${detail}. Confirme a conta e a autorizacao do aplicativo MATRIX.`);
    });
    const headers = { Authorization: `Bearer ${mc.access_token}` };
    const entitlementResponse = await httpsFetch('https://api.minecraftservices.com/entitlements/mcstore', { headers, signal }, ['api.minecraftservices.com'], this.fetcher);
    if (!entitlementResponse.ok) throw new Error('Não foi possível verificar a licença do Minecraft Java');
    const entitlements = z.object({ items: z.array(z.object({ name: z.string() })) }).parse(await entitlementResponse.json());
    if (!entitlements.items.some(i => ['game_minecraft', 'product_minecraft'].includes(i.name))) throw new Error('Esta conta não possui acesso ao Minecraft Java Edition');
    const profileResponse = await httpsFetch('https://api.minecraftservices.com/minecraft/profile', { headers, signal }, ['api.minecraftservices.com'], this.fetcher);
    if (!profileResponse.ok) throw new Error('Perfil Java indisponível. Crie seu nickname no site oficial do Minecraft.');
    const profile = z.object({ id: z.string().regex(/^[a-f0-9]{32}$/i), name: z.string(), skins: z.array(z.object({ url: z.string(), state: z.string() })).default([]) }).parse(await profileResponse.json());
    if (existing && existing.uuid !== profile.id) throw new Error('A sessão renovada pertence a outra conta');
    const skin = profile.skins.find(s => s.state === 'ACTIVE')?.url ?? '';
    const account: Account = { id: existing?.id ?? randomUUID(), kind: 'microsoft', name: profile.name, uuid: profile.id, skin: skin && new URL(skin).hostname === 'textures.minecraft.net' ? skin.replace(/^http:/, 'https:') : '', expiresAt: Date.now() + mc.expires_in * 1000 };
    await this.vault.set(account.id, { refreshToken: oauth.refresh_token, minecraftToken: mc.access_token, expiresAt: account.expiresAt! });
    return account;
  }
  async session(account: Account): Promise<{ account: Account; accessToken: string }> {
    this.configured(); const secret = await this.vault.get(account.id);
    if (!secret) throw new Error('Conta Microsoft desconectada. Entre novamente.');
    if (secret.expiresAt > Date.now() + 120_000) return { account, accessToken: secret.minecraftToken };
    const response = await this.post('token', { grant_type: 'refresh_token', client_id: this.clientId, refresh_token: secret.refreshToken, scope: SCOPES });
    if (!response.ok) throw new Error('Sessão Microsoft expirada. Entre novamente na tela Contas.');
    const renewed = await this.complete(tokenSchema.parse(await response.json()), account);
    return { account: renewed, accessToken: (await this.vault.get(renewed.id))!.minecraftToken };
  }
}
