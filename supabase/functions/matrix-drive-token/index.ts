// Server only. No client secret or Google token is stored in the database or logged.
type Config = { supabaseUrl: string; supabaseKey: string; clientId: string; clientSecret: string };
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers });
const text = (value: unknown, max = 4096): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const driveScope = 'https://www.googleapis.com/auth/drive.file';
// Google may combine existing project-level identity grants with the requested Drive grant.
const allowedScopes = new Set([driveScope, 'openid', 'email', 'profile', 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/userinfo.profile']);
function invalidToken(reason: string): Response {
  // Static reason only: never log the response, token values, email or OAuth secrets.
  console.warn('MATRIX Drive token validation:', reason);
  return reply({ error: 'invalid_token_response', reason }, 502);
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('body');
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > 16_384) { await reader.cancel(); throw new Error('size'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('body');
  return value as Record<string, unknown>;
}

function tokenParameters(body: Record<string, unknown>, clientId: string): Record<string, string> | undefined {
  if (body.client_id !== clientId) return;
  if (body.grant_type === 'refresh_token' && text(body.refresh_token) && Object.keys(body).every(key => ['client_id', 'grant_type', 'refresh_token'].includes(key))) {
    return { client_id: clientId, grant_type: 'refresh_token', refresh_token: body.refresh_token };
  }
  if (body.grant_type !== 'authorization_code' || !text(body.code) || !text(body.code_verifier, 128) || !/^[A-Za-z0-9._~-]{43,128}$/.test(body.code_verifier) || !text(body.redirect_uri, 100) || !Object.keys(body).every(key => ['client_id', 'grant_type', 'code', 'code_verifier', 'redirect_uri'].includes(key))) return;
  let redirect: URL; try { redirect = new URL(body.redirect_uri); } catch { return; }
  if (redirect.protocol !== 'http:' || redirect.hostname !== '127.0.0.1' || +redirect.port < 1024 || +redirect.port > 65535 || redirect.pathname !== '/' || redirect.search || redirect.hash || redirect.username || redirect.password) return;
  return { client_id: clientId, grant_type: 'authorization_code', code: body.code, code_verifier: body.code_verifier, redirect_uri: body.redirect_uri };
}

export function createDriveTokenHandler(config: Config, fetcher: typeof fetch = fetch) {
  // Best-effort per-worker limit; use Supabase gateway quotas for a global limit.
  const attempts = new Map<string, { count: number; until: number }>();
  return async (request: Request): Promise<Response> => {
    if (request.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405);
    const authorization = request.headers.get('authorization') ?? '';
    if (!/^Bearer [A-Za-z0-9._-]{20,8192}$/.test(authorization)) return reply({ error: 'matrix_login_required' }, 401);
    if (!config.supabaseUrl || !config.supabaseKey || !config.clientId.endsWith('.apps.googleusercontent.com') || !config.clientSecret) return reply({ error: 'drive_server_not_configured' }, 503);
    if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return reply({ error: 'invalid_request' }, 400);
    let body: Record<string, unknown>;
    try { body = await readBody(request); } catch { return reply({ error: 'invalid_request' }, 400); }
    const parameters = tokenParameters(body, config.clientId);
    if (!parameters) return reply({ error: 'invalid_request' }, 400);
    try {
      const base = new URL(config.supabaseUrl);
      if (base.protocol !== 'https:' || base.username || base.password) return reply({ error: 'drive_server_not_configured' }, 503);
      // Verify against Supabase Auth, not untrusted JWT payload fields or the public API key.
      const auth = await fetcher(new URL('/auth/v1/user', base), { headers: { apikey: config.supabaseKey, Authorization: authorization }, redirect: 'error', signal: AbortSignal.timeout(10_000) });
      if (!auth.ok) return reply({ error: auth.status === 401 || auth.status === 403 ? 'matrix_login_required' : 'auth_unavailable' }, auth.status === 401 || auth.status === 403 ? 401 : 503);
      const user = await auth.json() as { id?: unknown };
      if (typeof user.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(user.id)) return reply({ error: 'matrix_login_required' }, 401);
      const now = Date.now();
      for (const [id, item] of attempts) if (item.until <= now) attempts.delete(id);
      const entry = attempts.get(user.id) ?? { count: 0, until: now + 60_000 };
      if (entry.count >= 10 || !attempts.has(user.id) && attempts.size >= 1000) return reply({ error: 'rate_limited' }, 429);
      entry.count++; attempts.set(user.id, entry);
      const google = await fetcher('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...parameters, client_secret: config.clientSecret }), redirect: 'error', signal: AbortSignal.timeout(15_000) });
      const token = await google.json().catch(() => ({})) as Record<string, unknown>;
      if (!google.ok) {
        const error = ['invalid_grant', 'invalid_client', 'access_denied', 'invalid_request'].includes(String(token.error)) ? String(token.error) : 'google_unavailable';
        return reply({ error }, google.status === 429 ? 429 : google.status >= 500 ? 503 : 400);
      }
      if (!text(token.access_token, 16_384)) return invalidToken('invalid_access_token');
      if (typeof token.expires_in !== 'number' || !Number.isFinite(token.expires_in) || token.expires_in <= 0 || token.expires_in > 86_400) return invalidToken('invalid_expiration');
      if (token.refresh_token !== undefined && !text(token.refresh_token)) return invalidToken('invalid_refresh_token');
      if (token.scope !== undefined) {
        if (!text(token.scope) || !token.scope.trim()) return invalidToken('invalid_scope_format');
        const scopes = token.scope.trim().split(/\s+/);
        if (!scopes.includes(driveScope)) return invalidToken('missing_drive_permission');
        if (scopes.some(scope => !allowedScopes.has(scope))) return invalidToken('unexpected_scope');
        token.scope = [...new Set(scopes)].join(' ');
      }
      // Return only fields required by the secure local vault. Never echo client_secret.
      return reply({ access_token: token.access_token, expires_in: token.expires_in, ...(token.refresh_token ? { refresh_token: token.refresh_token } : {}), ...(token.scope ? { scope: token.scope } : {}) });
    } catch { return reply({ error: 'service_unavailable' }, 503); }
  };
}

declare const Deno: { env: { get(name: string): string | undefined }; serve(handler: (request: Request) => Promise<Response>): unknown };
if (typeof Deno !== 'undefined') {
  let keys: Record<string, string> = {};
  try { keys = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') ?? '{}'); } catch { /* configuration checked by handler */ }
  Deno.serve(createDriveTokenHandler({
    supabaseUrl: Deno.env.get('SUPABASE_URL') ?? '',
    supabaseKey: Deno.env.get('MATRIX_SUPABASE_PUBLISHABLE_KEY') ?? keys.default ?? Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    clientId: Deno.env.get('GOOGLE_DRIVE_CLIENT_ID') ?? '',
    clientSecret: Deno.env.get('GOOGLE_DRIVE_CLIENT_SECRET') ?? '',
  }));
}
