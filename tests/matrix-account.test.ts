import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MatrixAccountService } from '../electron/services/matrix-account.ts';
import { identityFromSession } from '../electron/services/matrix-account.ts';
import { oauthCallbackHtml } from '../electron/services/oauth-callback-page.ts';

const config = { supabaseUrl: 'https://project.supabase.co', supabaseAnonKey: 'public-anon-key' };
function vault() {
  const values = new Map<string, unknown>();
  return { getSecureValue: async <T>(key: string) => values.get(key) as T | undefined, setSecureValue: async (key: string, value: unknown) => { values.set(key, value); }, remove: async (key: string) => { values.delete(key); }, values };
}
function session() { return { access_token: 'access-secret', refresh_token: 'refresh-secret', expires_in: 3600, token_type: 'bearer', user: { id: '0b97cbcf-1322-4ec9-835e-16c762449001', email: 'player@example.com', app_metadata: { provider: 'google', providers: ['google'] }, user_metadata: { full_name: 'Jogador MATRIX', avatar_url: 'https://example.com/avatar.png' }, created_at: '2026-10-08T10:00:00Z' } }; }

test('Drive exchange requires MATRIX login and uses only its configured authenticated function', async () => {
  const secrets = vault(); const calls: { url: string; init?: RequestInit }[] = [];
  let refreshes = 0; let exchanges = 0;
  const service = new MatrixAccountService(config, secrets, async () => {}, (async (input, init) => {
    calls.push({ url: String(input), init });
    if (String(input).includes('/auth/v1/token')) { refreshes++; return Response.json({ ...session(), access_token: 'renewed-matrix-token' }); }
    exchanges++; return exchanges === 1 ? Response.json({ error: 'matrix_login_required' }, { status: 401 }) : Response.json({ access_token: 'drive-access', expires_in: 3600 });
  }) as typeof fetch);
  await assert.rejects(service.exchangeDriveToken({}), /Entre na Conta MATRIX/); assert.equal(calls.length, 0);
  secrets.values.set('matrix-account-session', { ...session(), expires_at: Date.now() + 3_600_000 });
  await service.restore();
  const values = { client_id: 'drive.apps.googleusercontent.com', grant_type: 'refresh_token', refresh_token: 'drive-refresh' };
  const response = await service.exchangeDriveToken(values); assert.equal(response.status, 200); assert.equal(refreshes, 1); assert.equal(exchanges, 2);
  assert.equal(calls[0].url, 'https://project.supabase.co/functions/v1/matrix-drive-token');
  assert.equal(new Headers(calls[0].init?.headers).get('Authorization'), 'Bearer access-secret');
  assert.equal(new Headers(calls.at(-1)?.init?.headers).get('Authorization'), 'Bearer renewed-matrix-token');
  assert.deepEqual(JSON.parse(String(calls.at(-1)?.init?.body)), values);
  assert.doesNotMatch(JSON.stringify(service.state()), /access-secret|renewed-matrix-token|drive-refresh/);
});

test('MATRIX Account email OTP persists a session only in the secure vault and logout clears it', async () => {
  const secrets = vault(); const requests: { path: string; body?: unknown }[] = [];
  const fetcher = (async (input, init) => { const url = new URL(String(input)); const body = init?.body ? JSON.parse(String(init.body)) : undefined; requests.push({ path: url.pathname + url.search, body }); return url.pathname.endsWith('/otp') ? Response.json({}) : url.pathname.endsWith('/verify') ? Response.json(session()) : Response.json({}); }) as typeof fetch;
  const service = new MatrixAccountService(config, secrets, async () => {}, fetcher);
  assert.equal(service.configured(), true); await service.requestEmailCode('PLAYER@example.com');
  assert.deepEqual(requests[0]?.body, { email: 'player@example.com', create_user: true, data: { source: 'matrix-launcher' } });
  const user = await service.verifyEmailCode('123456'); assert.equal(user.displayName, 'Jogador MATRIX'); assert.deepEqual(user.providers, ['google']);
  assert.equal(service.state().signedIn, true); assert.ok(JSON.stringify([...secrets.values.values()]).includes('refresh-secret'));
  await service.signOut(); assert.equal(requests.at(-1)?.path, '/auth/v1/logout?scope=local'); assert.equal(service.state().signedIn, false); assert.equal(secrets.values.size, 0);
});

test('MATRIX Account browser flow uses PKCE, loopback state validation and exchanges the one-time code', async () => {
  const secrets = vault(); let authorization = ''; let exchanged: Record<string, unknown> | undefined;
  const fetcher = (async (_input, init) => { exchanged = JSON.parse(String(init?.body)); return Response.json(session()); }) as typeof fetch;
  const service = new MatrixAccountService(config, secrets, async url => {
    authorization = url; const auth = new URL(url); const redirect = new URL(auth.searchParams.get('redirect_to')!);
    assert.equal(auth.searchParams.get('code_challenge_method'), 's256'); assert.ok(auth.searchParams.get('code_challenge'));
    const callback = new URL(redirect); callback.searchParams.set('code', 'one-time-auth-code');
    const response = await fetch(callback); assert.equal(response.status, 200);
  }, fetcher);
  const user = await service.signIn('discord'); assert.equal(user.id, session().user.id);
  const auth = new URL(authorization); assert.equal(auth.searchParams.get('provider'), 'discord');
  assert.equal(exchanged?.auth_code, 'one-time-auth-code'); assert.ok(typeof exchanged?.code_verifier === 'string');
});

test('MATRIX Account refuses unconfigured endpoints and a callback with a forged state', async () => {
  const secrets = vault(); const disabled = new MatrixAccountService({ supabaseUrl: '', supabaseAnonKey: '' }, secrets, async () => {});
  assert.equal(disabled.configured(), false); await assert.rejects(disabled.requestEmailCode('player@example.com'), /não foi configurado|não configurado/);
  const service = new MatrixAccountService(config, secrets, async url => {
    const redirect = new URL(new URL(url).searchParams.get('redirect_to')!); redirect.searchParams.set('state', 'forged'); redirect.searchParams.set('code', 'attacker-code');
    const response = await fetch(redirect); assert.equal(response.status, 400);
  }, (async () => { throw new Error('must reject callback before token exchange'); }) as typeof fetch);
  await assert.rejects(service.signIn('google'), /State OAuth inválido/);
});

test('Discord profile avatars preserve animated GIFs and use an image fallback for other avatar formats', () => {
  const base = session();
  const discord = { ...base, expires_at: Date.now() + 60_000, user: { ...base.user, app_metadata: { provider: 'discord', providers: ['discord'] }, user_metadata: { provider_id: '12345678901234567', avatar: 'a_animatedHash' } } };
  assert.equal(identityFromSession(discord).avatarUrl, 'https://cdn.discordapp.com/avatars/12345678901234567/a_animatedHash.gif?size=128');
  const staticDiscord = { ...discord, user: { ...discord.user, user_metadata: { ...discord.user.user_metadata, avatar: 'staticHash' } } };
  assert.equal(identityFromSession(staticDiscord).avatarUrl, 'https://cdn.discordapp.com/avatars/12345678901234567/staticHash.webp?size=128');
});

test('OAuth confirmation is a branded self-contained page without remote scripts', () => {
  const page = oauthCallbackHtml('matrix', true);
  assert.match(page, /MATRIX LAUNCHER/);
  assert.match(page, /MATRIX COMMUNITY/);
  assert.match(page, /Pode voltar ao MATRIX Launcher/);
  assert.doesNotMatch(page, /<script|https?:\/\//i);
  assert.match(oauthCallbackHtml('drive', false), /Não foi possível concluir/);
});

test('Linked providers use the current avatar URL and preserve animated Discord photos', () => {
  const base = session();
  const identity = identityFromSession({ ...base, expires_at: Date.now() + 60_000, user: { ...base.user, app_metadata: { providers: ['google', 'discord'] }, user_metadata: { provider_id: '12345678901234567', avatar: 'oldHash', avatar_url: 'https://lh3.googleusercontent.com/current-photo' } } });
  assert.equal(identity.avatarUrl, 'https://lh3.googleusercontent.com/current-photo');
  const animated = identityFromSession({ ...base, expires_at: Date.now() + 60_000, user: { ...base.user, user_metadata: { avatar_url: 'https://cdn.discordapp.com/avatars/12345678901234567/a_animation.png?size=128' } } });
  assert.equal(animated.avatarUrl, 'https://cdn.discordapp.com/avatars/12345678901234567/a_animation.gif?size=128');
});

test('Browser confirmation reports failure when secure session storage fails', async () => {
  let browser: Promise<Response> | undefined;
  const secrets = { ...vault(), setSecureValue: async () => { throw new Error('Vault unavailable'); } };
  const service = new MatrixAccountService(config, secrets, async url => {
    const callback = new URL(new URL(url).searchParams.get('redirect_to')!);
    callback.searchParams.set('code', 'valid-code'); browser = fetch(callback);
  }, (async () => Response.json(session())) as typeof fetch);
  await assert.rejects(service.signIn('google'), /Vault unavailable/);
  const response = await browser!;
  assert.equal(response.status, 400);
  assert.match(await response.text(), /Não foi possível concluir/);
  assert.equal(service.state().signedIn, false);
});
