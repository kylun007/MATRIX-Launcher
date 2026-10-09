import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDriveTokenHandler } from '../supabase/functions/matrix-drive-token/index.ts';

const config = { supabaseUrl: 'https://project.supabase.co', supabaseKey: 'public-key', clientId: 'desktop.apps.googleusercontent.com', clientSecret: 'server-only-secret' };
const input = { client_id: config.clientId, grant_type: 'authorization_code', code: 'one-time-code', code_verifier: 'v'.repeat(64), redirect_uri: 'http://127.0.0.1:43827' };
const authorization = `Bearer ${'user-jwt.'.repeat(4)}`;
function request(body: unknown = input, auth: string = authorization) { return new Request('https://project.supabase.co/functions/v1/matrix-drive-token', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth }, body: JSON.stringify(body) }); }
const user = { id: '0b97cbcf-1322-4ec9-835e-16c762449001' };

test('Drive backend verifies MATRIX session and adds secret only to the Google token request', async () => {
  const calls: string[] = [];
  const handler = createDriveTokenHandler(config, (async (url, init) => {
    calls.push(String(url));
    if (calls.length === 1) { assert.equal(String(url), 'https://project.supabase.co/auth/v1/user'); assert.equal(new Headers(init?.headers).get('Authorization'), authorization); return Response.json(user); }
    assert.equal(String(url), 'https://oauth2.googleapis.com/token');
    const body = new URLSearchParams(String(init?.body)); assert.equal(body.get('client_secret'), config.clientSecret); assert.equal(body.get('code_verifier'), input.code_verifier); assert.equal(init?.redirect, 'error');
    return Response.json({ access_token: 'google-access', refresh_token: 'google-refresh', expires_in: 3600, scope: 'https://www.googleapis.com/auth/drive.file', client_secret: config.clientSecret, extra: 'must-not-return' });
  }) as typeof fetch);
  const response = await handler(request()); assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const body = await response.text(); assert.match(body, /google-access/); assert.doesNotMatch(body, /server-only-secret|must-not-return/);
  assert.equal(calls.length, 2);
});

test('Drive backend blocks anonymous callers, invalid sessions and missing server configuration', async () => {
  let called = false;
  const handler = createDriveTokenHandler(config, (async () => { called = true; return Response.json({ error: 'expired' }, { status: 401 }); }) as typeof fetch);
  assert.equal((await handler(request(input, ''))).status, 401); assert.equal(called, false);
  assert.equal((await handler(request())).status, 401); assert.equal(called, true);
  const missingSecret = createDriveTokenHandler({ ...config, clientSecret: '' }, async () => { throw new Error('must not contact Google'); });
  assert.equal((await missingSecret(request())).status, 503);
});

test('Drive accepts Google identity scopes accompanying its required per-file permission', async () => {
  for (const scope of [
    'openid https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile',
    '  profile  email  https://www.googleapis.com/auth/drive.file  openid  openid ',
  ]) {
    const handler = createDriveTokenHandler(config, (async url => String(url).includes('/auth/v1/user') ? Response.json(user) : Response.json({ access_token: 'google-access', refresh_token: 'google-refresh', expires_in: 3599, scope })) as typeof fetch);
    const response = await handler(request()); assert.equal(response.status, 200);
    const token = await response.json(); assert.ok(token.scope.split(' ').includes('https://www.googleapis.com/auth/drive.file')); assert.doesNotMatch(token.scope, / {2}/);
    assert.doesNotMatch(JSON.stringify(token), /server-only-secret/);
  }
});

test('Drive rejects missing permission, broader Drive access and malformed token fields with safe diagnostics', async () => {
  const valid = { access_token: 'secret-access-token', refresh_token: 'secret-refresh-token', expires_in: 3600, scope: 'https://www.googleapis.com/auth/drive.file' };
  const cases = [
    { token: { ...valid, scope: 'openid email' }, reason: 'missing_drive_permission' },
    { token: { ...valid, scope: valid.scope + ' https://www.googleapis.com/auth/drive' }, reason: 'unexpected_scope' },
    { token: { ...valid, scope: '' }, reason: 'invalid_scope_format' },
    { token: { ...valid, access_token: '' }, reason: 'invalid_access_token' },
    { token: { ...valid, expires_in: 0 }, reason: 'invalid_expiration' },
    { token: { ...valid, refresh_token: 123 }, reason: 'invalid_refresh_token' },
  ];
  const messages: unknown[][] = []; const warn = console.warn; console.warn = (...args: unknown[]) => { messages.push(args); };
  try {
    for (const item of cases) {
      const handler = createDriveTokenHandler(config, (async url => String(url).includes('/auth/v1/user') ? Response.json(user) : Response.json(item.token)) as typeof fetch);
      const response = await handler(request()); assert.equal(response.status, 502); assert.deepEqual(await response.json(), { error: 'invalid_token_response', reason: item.reason });
    }
    assert.equal(messages.length, cases.length); assert.doesNotMatch(JSON.stringify(messages), /secret-access-token|secret-refresh-token|server-only-secret/);
  } finally { console.warn = warn; }
});

test('Drive renewal accepts a successful Google response that omits unchanged scope and refresh token', async () => {
  const handler = createDriveTokenHandler(config, (async (url, init) => {
    if (String(url).includes('/auth/v1/user')) return Response.json(user);
    const form = new URLSearchParams(String(init?.body)); assert.equal(form.get('grant_type'), 'refresh_token'); assert.equal(form.get('refresh_token'), 'saved-refresh');
    return Response.json({ access_token: 'renewed-access', expires_in: 3600, token_type: 'Bearer' });
  }) as typeof fetch);
  const response = await handler(request({ client_id: config.clientId, grant_type: 'refresh_token', refresh_token: 'saved-refresh' }));
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { access_token: 'renewed-access', expires_in: 3600 });
});

test('Drive backend rejects unsafe redirects, missing PKCE, different clients and unexpected parameters', async () => {
  const handler = createDriveTokenHandler(config, async () => { throw new Error('invalid input must not reach network'); });
  for (const redirect_uri of ['https://attacker.example', 'http://localhost:43827', 'http://127.0.0.1', 'http://127.0.0.1:80', 'http://127.0.0.1:43827/private', 'http://user@127.0.0.1:43827', 'http://127.0.0.1:43827?code=bad']) {
    assert.equal((await handler(request({ ...input, redirect_uri }))).status, 400, redirect_uri);
  }
  for (const body of [{ ...input, code_verifier: '' }, { ...input, client_id: 'attacker.apps.googleusercontent.com' }, { ...input, client_secret: 'client-supplied-secret' }, { ...input, scope: 'drive' }, { ...input, grant_type: 'client_credentials' }, { ...input, code: 'x'.repeat(20_000) }]) assert.equal((await handler(request(body))).status, 400);
});

test('Drive backend renews tokens, sanitizes Google failures and limits repeated exchanges', async () => {
  let tokens = 0;
  const handler = createDriveTokenHandler(config, (async url => {
    if (String(url).includes('/auth/v1/user')) return Response.json(user);
    tokens++;
    return Response.json({ error: 'invalid_grant', error_description: 'private-provider-details server-only-secret' }, { status: 400 });
  }) as typeof fetch);
  const body = { client_id: config.clientId, grant_type: 'refresh_token', refresh_token: 'saved-refresh' };
  for (let attempt = 0; attempt < 10; attempt++) {
    const response = await handler(request(body)); assert.equal(response.status, 400); assert.deepEqual(await response.json(), { error: 'invalid_grant' });
  }
  assert.equal((await handler(request(body))).status, 429); assert.equal(tokens, 10);
});
