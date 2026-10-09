import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { z } from 'zod';
import type { Vault } from './auth.ts';
import type { MatrixAuthState, MatrixIdentity } from '../../shared/matrix-account.ts';
import { sendOAuthCallbackPage } from './oauth-callback-page.ts';

const sessionSchema = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1), expires_in: z.number().positive(), token_type: z.string().optional(), user: z.object({ id: z.string().uuid(), email: z.string().email().nullable().optional(), app_metadata: z.object({ provider: z.string().max(40).optional(), providers: z.array(z.string().max(40)).max(10).optional() }).optional(), user_metadata: z.object({ full_name: z.string().max(200).nullable().optional(), name: z.string().max(200).nullable().optional(), user_name: z.string().max(200).nullable().optional(), avatar_url: z.string().max(2048).nullable().optional(), picture: z.string().max(2048).nullable().optional(), avatar: z.string().max(200).nullable().optional(), provider_id: z.string().max(100).nullable().optional(), sub: z.string().max(100).nullable().optional() }).optional(), created_at: z.string().max(80).optional() }) });
type Session = z.infer<typeof sessionSchema> & { expires_at: number };
type AccountConfig = { supabaseUrl: string; supabaseAnonKey: string; googleDriveClientId?: string };
type VaultLike = Pick<Vault, 'getSecureValue' | 'setSecureValue' | 'remove'>;
type PendingEmail = { email: string; requestedAt: number };

export function identityFromSession(session: Session): MatrixIdentity {
  const meta = session.user.user_metadata ?? {};
  const displayName = [meta.full_name, meta.name, meta.user_name].find(v => typeof v === 'string' && v.trim()) as string | undefined;
  const providers = session.user.app_metadata?.providers ?? (session.user.app_metadata?.provider ? [session.user.app_metadata.provider] : []);
  const discordId = meta.provider_id ?? meta.sub;
  const discordHash = meta.avatar;
  const discordAvatar = providers.includes('discord') && discordId && /^\d{15,25}$/.test(discordId) && discordHash && /^[A-Za-z0-9_-]{2,200}$/.test(discordHash)
    ? `https://cdn.discordapp.com/avatars/${discordId}/${discordHash}.${discordHash.startsWith('a_') ? 'gif' : 'webp'}?size=128`
    : undefined;
  const suppliedAvatar = [meta.avatar_url, meta.picture].find(v => typeof v === 'string' && /^https:\/\//i.test(v)) as string | undefined;
  // Supabase's current avatar URL takes precedence when Google and Discord are linked.
  // Mixing an older Discord hash with the latest Google's provider_id produces a 404.
  let avatar = suppliedAvatar ?? discordAvatar;
  try { if (avatar) {
    const url = new URL(avatar);
    const animated = url.hostname === 'cdn.discordapp.com' && url.pathname.match(/^\/avatars\/\d+\/(a_[\w-]+)\.(?:png|jpe?g|webp|gif)$/i);
    if (animated) { url.pathname = url.pathname.replace(/\.[a-z]+$/i, '.gif'); avatar = url.toString(); }
  } } catch { avatar = undefined; }
  return { id: session.user.id, ...(session.user.email ? { email: session.user.email } : {}), displayName: (displayName ?? session.user.email?.split('@')[0] ?? 'Jogador MATRIX').slice(0, 80), ...(avatar ? { avatarUrl: avatar } : {}), providers: [...new Set(providers)].slice(0, 10), ...(session.user.created_at ? { createdAt: session.user.created_at } : {}) };
}

/** Supabase Auth client hosted entirely in Electron main; renderer receives identity only. */
export class MatrixAccountService {
  private readonly sessionKey = 'matrix-account-session';
  private readonly emailKey = 'matrix-account-email-pending';
  private readonly base?: URL;
  private readonly anonKey: string;
  private currentSession?: Session;

  constructor(config: AccountConfig, private readonly vault: VaultLike, private readonly openExternal: (url: string) => Promise<unknown>, private readonly fetcher: typeof fetch = fetch) {
    this.anonKey = config.supabaseAnonKey.trim();
    try {
      const url = new URL(config.supabaseUrl);
      if (url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash) this.base = url;
    } catch { /* optional admin configuration */ }
  }

  configured(): boolean { return !!this.base && this.anonKey.length > 10; }
  state(error?: string): MatrixAuthState { return { configured: this.configured(), signedIn: !!this.currentSession, ...(this.currentSession ? { identity: identityFromSession(this.currentSession) } : {}), ...(error ? { error } : {}) }; }

  private async request(path: string, body?: unknown, accessToken?: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (!this.base || !this.anonKey) throw new Error('MATRIX Account ainda não foi configurado pelo administrador. Consulte docs/MATRIX-ACCOUNT-CLOUD.md.');
    const url = new URL(path, this.base);
    if (url.origin !== this.base.origin || !url.pathname.startsWith('/auth/v1/')) throw new Error('Destino de autenticação não autorizado');
    const timeout = AbortSignal.timeout(20_000); const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await this.fetcher(url, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: requestSignal, headers: { apikey: this.anonKey, ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new Error(`Supabase Auth recusou a operação (HTTP ${response.status}). Verifique os provedores e a configuração do projeto.`);
    return payload;
  }

  private async saveSession(raw: unknown): Promise<MatrixIdentity> {
    const parsed = sessionSchema.parse(raw);
    const session = { ...parsed, expires_at: Date.now() + parsed.expires_in * 1000 };
    await this.vault.setSecureValue(this.sessionKey, session); this.currentSession = session;
    return identityFromSession(this.currentSession);
  }

  async restore(): Promise<MatrixAuthState> {
    if (!this.configured()) return this.state();
    const saved = await this.vault.getSecureValue<Session>(this.sessionKey);
    if (!saved) return this.state();
    const parsed = sessionSchema.safeParse(saved);
    if (!parsed.success || typeof saved.expires_at !== 'number') { await this.vault.remove(this.sessionKey); return this.state(); }
    this.currentSession = saved;
    if (saved.expires_at < Date.now() + 60_000) {
      try { await this.refresh(); } catch { this.currentSession = undefined; await this.vault.remove(this.sessionKey); }
    }
    return this.state();
  }

  private async refresh(): Promise<void> {
    if (!this.currentSession) throw new Error('Sessão MATRIX ausente');
    const payload = await this.request('/auth/v1/token?grant_type=refresh_token', { refresh_token: this.currentSession.refresh_token });
    await this.saveSession(payload);
  }

  /** Main-process integration only; tokens never pass through IPC or the renderer. */
  async exchangeDriveToken(values: Record<string, string>): Promise<Response> {
    if (!this.base || !this.configured() || !this.currentSession) throw new Error('Entre na Conta MATRIX antes de conectar ou renovar o Google Drive.');
    const url = new URL('/functions/v1/matrix-drive-token', this.base);
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!this.currentSession) throw new Error('Entre novamente na Conta MATRIX.');
      if (attempt || this.currentSession.expires_at <= Date.now() + 60_000) await this.refresh();
      const response = await this.fetcher(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000), headers: { apikey: this.anonKey, Authorization: `Bearer ${this.currentSession!.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(values) });
      if (response.status !== 401 || attempt === 1) return response;
      await response.body?.cancel();
    }
    throw new Error('Não foi possível autenticar a Conta MATRIX.');
  }

  async signIn(provider: 'google' | 'discord', signal?: AbortSignal): Promise<MatrixIdentity> {
    if (!this.configured()) throw new Error('MATRIX Account não configurado.');
    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const state = randomBytes(32).toString('base64url');
    const callbackPath = `/${randomBytes(32).toString('hex')}`;
    let server: Server | undefined; let callbackUsed = false; let callbackResponse: ServerResponse | undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      const { callback, code } = await new Promise<{ callback: URL; code: string }>((resolve, reject) => {
        const abort = () => reject(new Error('Login MATRIX cancelado.'));
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) { abort(); return; }
        server = createServer((request, response) => {
          const host = request.headers.host;
          const target = new URL(request.url ?? '/', `http://${host ?? 'invalid'}`);
          if (callbackUsed) { response.writeHead(409).end(); return; }
          if (host !== `127.0.0.1:${(server!.address() as { port: number }).port}` || target.pathname !== callbackPath) { response.writeHead(404).end(); return; }
          const gotState = Buffer.from(target.searchParams.get('state') ?? ''); const expected = Buffer.from(state);
          if (gotState.length !== expected.length || !timingSafeEqual(gotState, expected)) { response.writeHead(400).end('Retorno de autenticação inválido.'); reject(new Error('State OAuth inválido')); return; }
          const error = target.searchParams.get('error'); const authCode = target.searchParams.get('code');
          callbackUsed = true;
          callbackResponse = response;
          if (error || !authCode || authCode.length >= 4096) sendOAuthCallbackPage(response, 'matrix', false);
          if (error) reject(new Error('Login MATRIX cancelado ou recusado pelo provedor.'));
          else if (authCode && authCode.length < 4096) resolve({ callback: new URL(`http://${host}${callbackPath}`), code: authCode });
          else reject(new Error('O provedor não retornou um código válido.'));
        });
        server.on('error', reject);
        server.listen(43827, '127.0.0.1', async () => {
          if (signal?.aborted) { abort(); return; }
          const port = (server!.address() as { port: number }).port;
          const callback = new URL(`http://127.0.0.1:${port}${callbackPath}`); callback.searchParams.set('state', state);
          const authorize = new URL('/auth/v1/authorize', this.base);
          authorize.searchParams.set('provider', provider); authorize.searchParams.set('redirect_to', callback.toString()); authorize.searchParams.set('code_challenge', challenge); authorize.searchParams.set('code_challenge_method', 's256'); authorize.searchParams.set('response_type', 'code'); authorize.searchParams.set('apikey', this.anonKey);
          timer = setTimeout(() => reject(new Error('O login expirou. Inicie novamente.')), 180_000); timer.unref();
          try { await this.openExternal(authorize.toString()); } catch { reject(new Error('Não foi possível abrir o navegador padrão.')); }
        });
        signal?.addEventListener('abort', () => { if (server?.listening) server.close(); }, { once: true });
      });
      const payload = await this.request('/auth/v1/token?grant_type=pkce', { auth_code: code, code_verifier: verifier }, undefined, signal);
      const identity = await this.saveSession(payload);
      if (callbackResponse) sendOAuthCallbackPage(callbackResponse, 'matrix', true);
      return identity;
    } catch (error) {
      if (callbackResponse) sendOAuthCallbackPage(callbackResponse, 'matrix', false);
      throw error;
    } finally { if (timer) clearTimeout(timer); server?.close(); }
  }

  async requestEmailCode(email: string): Promise<void> {
    const checked = z.string().trim().email().max(254).parse(email).toLowerCase();
    await this.request('/auth/v1/otp', { email: checked, create_user: true, data: { source: 'matrix-launcher' } });
    await this.vault.setSecureValue<PendingEmail>(this.emailKey, { email: checked, requestedAt: Date.now() });
  }

  async verifyEmailCode(token: string): Promise<MatrixIdentity> {
    const pending = await this.vault.getSecureValue<PendingEmail>(this.emailKey);
    if (!pending || Date.now() - pending.requestedAt > 15 * 60_000) throw new Error('Solicite um novo código de acesso por e-mail.');
    const code = z.string().trim().regex(/^\d{6,8}$/).parse(token);
    const payload = await this.request('/auth/v1/verify', { email: pending.email, token: code, type: 'email' });
    const user = sessionSchema.shape.user.parse(payload.user);
    const session = sessionSchema.parse({ ...payload, user });
    const result = await this.saveSession(session); await this.vault.remove(this.emailKey); return result;
  }

  async signOut(): Promise<void> {
    let revokeFailed = false;
    if (this.currentSession) try { await this.request('/auth/v1/logout?scope=local', {}, this.currentSession.access_token); } catch { revokeFailed = true; }
    this.currentSession = undefined; await this.vault.remove(this.sessionKey); await this.vault.remove(this.emailKey);
    if (revokeFailed) throw new Error('Sessão removida deste computador, mas não foi possível revogá-la no Supabase agora. Ela expirará conforme as regras do projeto.');
  }
}
