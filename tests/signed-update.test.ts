import { generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateManifestInfo, verifySignedManifest } from '../electron/services/signed-update.ts';

test('signed update manifest accepts only the trusted Ed25519 signature', () => {
  const keys = generateKeyPairSync('ed25519');
  const other = generateKeyPairSync('ed25519');
  const manifest = 'version: 0.3.2\nfiles: []\n';
  const signature = sign(null, Buffer.from(manifest), keys.privateKey).toString('base64');
  const publicPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const wrongPem = other.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  assert.equal(verifySignedManifest(manifest, signature, publicPem), true);
  assert.equal(verifySignedManifest(`${manifest}#changed`, signature, publicPem), false);
  assert.equal(verifySignedManifest(manifest, signature, wrongPem), false);
  assert.equal(verifySignedManifest(manifest, 'not-a-signature', publicPem), false);
});

test('manifest paths, hashes, release tags, and sizes are validated', () => {
  const valid = { version: '0.3.2', files: [{ url: 'MATRIX Launcher Setup 0.3.2.exe', sha512: Buffer.alloc(64, 7).toString('base64'), size: 1024 }] };
  const directory = new URL('https://github.com/kylun007/MATRIX-Launcher/releases/download/v0.3.2/');
  assert.doesNotThrow(() => validateManifestInfo(valid, 'v0.3.2', directory));
  assert.doesNotThrow(() => validateManifestInfo({ ...valid, files: [{ ...valid.files[0], url: 'matrix-launcher-0.3.2-x86_64.AppImage' }] }, 'v0.3.2', directory, 'linux'));
  assert.doesNotThrow(() => validateManifestInfo({ ...valid, files: [{ ...valid.files[0], url: 'matrix-launcher_0.3.2_amd64.deb' }] }, 'v0.3.2', directory, 'linux'));
  assert.throws(() => validateManifestInfo(valid, 'v0.3.2', directory, 'linux'), /caminho/);
  assert.throws(() => validateManifestInfo(valid, 'v0.3.1', directory), /versão da release/);
  assert.throws(() => validateManifestInfo({ ...valid, files: [{ ...valid.files[0], url: '../evil.exe' }] }, 'v0.3.2', directory), /caminho/);
  assert.throws(() => validateManifestInfo({ ...valid, files: [{ ...valid.files[0], sha512: '0'.repeat(128) }] }, 'v0.3.2', directory), /hash ou tamanho/);
  assert.throws(() => validateManifestInfo({ ...valid, files: [{ ...valid.files[0], size: 0 }] }, 'v0.3.2', directory), /hash ou tamanho/);
});
