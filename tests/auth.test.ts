import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { MicrosoftAuth, Vault, type CryptoStorage, type XboxAdapter } from '../electron/services/auth.ts';
const key = randomBytes(32);
const crypto: CryptoStorage = { isEncryptionAvailable: () => true, encryptString: value => { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv); const bytes = Buffer.concat([cipher.update(value), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), bytes]); }, decryptString: value => { const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); decipher.setAuthTag(value.subarray(12, 28)); return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString(); } };
const xbox: XboxAdapter = { authenticateXboxLive: async () => ({ Token: 'live' }), authorizeXboxLive: async () => ({ Token: 'xsts', DisplayClaims: { xui: [{ uhs: 'uhs' }] } }), loginMinecraftWithXBox: async () => ({ access_token: 'minecraft-secret', expires_in: 1 }) };
const clientId = '12345678-1234-1234-1234-123456789012';
async function setup(t: { after(fn: () => Promise<void>): void }, owns = true) {
  const root = await mkdtemp(join(tmpdir(), 'matrix-auth-')); t.after(() => rm(root, { recursive: true, force: true }));
  const vault = new Vault(join(root, 'tokens'), crypto); let tokenCalls = 0;
  const fetcher = (async (input, init) => {
    const url = String(input);
    if (url.endsWith('/devicecode')) return Response.json({ device_code: 'private-device-code', user_code: 'ABCD-EFGH', verification_uri: 'https://www.microsoft.com/link', expires_in: 100, interval: .001 });
    if (url.endsWith('/token')) { tokenCalls++; return Response.json({ access_token: 'oauth', refresh_token: 'refresh-secret', expires_in: 3600 }); }
    if (url.includes('/entitlements/')) return Response.json({ items: owns ? [{ name: 'game_minecraft' }] : [] });
    if (url.endsWith('/minecraft/profile')) { assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer minecraft-secret'); return Response.json({ id: 'a'.repeat(32), name: 'MatrixPlayer', skins: [] }); }
    throw new Error('Unexpected auth URL');
  }) as typeof fetch;
  return { auth: new MicrosoftAuth(clientId, vault, xbox, fetcher), vault, root, tokenCalls: () => tokenCalls };
}
test('Microsoft login checks ownership, gets profile, encrypts secrets and renews expiry', async t => {
  const s = await setup(t); let code = ''; const account = await s.auth.login(new AbortController().signal, c => { code = c.code; });
  assert.equal(code, 'ABCD-EFGH'); assert.equal(account.kind, 'microsoft'); assert.equal(account.name, 'MatrixPlayer'); assert.equal((account as unknown as Record<string, unknown>).accessToken, undefined);
  const raw = await readFile(join(s.root, 'tokens')); assert.ok(!raw.includes(Buffer.from('refresh-secret')));
  const session = await s.auth.session(account); assert.equal(session.accessToken, 'minecraft-secret'); assert.equal(s.tokenCalls(), 2);
  await s.vault.remove(account.id); await assert.rejects(s.auth.session(account), /desconectada/);
});
test('Microsoft login without a Java license is rejected', async t => { const s = await setup(t, false); await assert.rejects(s.auth.login(new AbortController().signal, () => {}), /não possui/); });
test('Microsoft login can be cancelled and requires a real configured client ID', async t => { const s = await setup(t); const controller = new AbortController(); controller.abort(); await assert.rejects(s.auth.login(controller.signal, () => {}), { name: 'AbortError' }); await assert.rejects(new MicrosoftAuth('', s.vault, xbox).login(new AbortController().signal, () => {}), /registro/); });
test('vault refuses insecure OS storage', async t => { const s = await setup(t); const insecure = new Vault(join(s.root, 'plain'), { ...crypto, getSelectedStorageBackend: () => 'basic_text' }); await assert.rejects(insecure.get('account'), /seguro/); });
