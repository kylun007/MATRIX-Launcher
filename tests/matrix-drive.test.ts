import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { MatrixDriveService } from '../electron/services/matrix-drive.ts';

function vault() {
  const values = new Map<string, unknown>();
  return { getSecureValue: async <T>(key: string) => values.get(key) as T | undefined, setSecureValue: async (key: string, value: unknown) => { values.set(key, value); }, remove: async (key: string) => { values.delete(key); }, values };
}
const config = { googleDriveClientId: 'test-desktop.apps.googleusercontent.com' };

test('Drive confirms connection only after PKCE token exchange and secure persistence', async () => {
  const secrets = vault(); let authorization: URL | undefined; let browser: Promise<Response> | undefined;
  const service = new MatrixDriveService(config, secrets, async url => {
    authorization = new URL(url);
    const callback = new URL(authorization.searchParams.get('redirect_uri')!);
    callback.searchParams.set('state', authorization.searchParams.get('state')!);
    callback.searchParams.set('code', 'valid-code'); browser = fetch(callback);
  }, undefined, undefined, async values => {
    const form = new URLSearchParams(values);
    assert.equal(form.get('grant_type'), 'authorization_code');
    assert.equal(form.get('redirect_uri'), authorization?.searchParams.get('redirect_uri'));
    assert.equal(createHash('sha256').update(form.get('code_verifier')!).digest('base64url'), authorization?.searchParams.get('code_challenge'));
    return Response.json({ access_token: 'access-secret', refresh_token: 'refresh-secret', expires_in: 3600 });
  });
  await service.connect();
  const response = await browser!;
  assert.equal(response.status, 200); assert.match(await response.text(), /Google Drive conectado/);
  assert.equal(service.state().connected, true); assert.ok(secrets.values.has('matrix-drive-session'));
});

test('Drive token rejection shows a failure page and an actionable error without exposing tokens', async () => {
  const secrets = vault(); let browser: Promise<Response> | undefined;
  const service = new MatrixDriveService(config, secrets, async url => {
    const auth = new URL(url); const callback = new URL(auth.searchParams.get('redirect_uri')!);
    callback.searchParams.set('state', auth.searchParams.get('state')!);
    callback.searchParams.set('code', 'valid-code'); browser = fetch(callback);
  }, undefined, undefined, async () => Response.json({ error: 'invalid_request', error_description: 'client_secret is missing; sensitive-value' }, { status: 400 }));
  await assert.rejects(service.connect(), error => {
    assert.match((error as Error).message, /invalid_request.*HTTP 400/);
    assert.match((error as Error).message, /autenticação adicional/);
    assert.doesNotMatch((error as Error).message, /sensitive-value/); return true;
  });
  const response = await browser!;
  assert.equal(response.status, 400); assert.match(await response.text(), /Não foi possível concluir/);
  assert.equal(service.state().connected, false); assert.equal(secrets.values.size, 0);
});

test('Drive does not fall back to sending token requests without the secure backend', async () => {
  const service = new MatrixDriveService(config, vault(), async () => { throw new Error('must not open browser'); });
  assert.equal(service.state().configured, false);
  await assert.rejects(service.connect(), /matrix-drive-token/);
});
