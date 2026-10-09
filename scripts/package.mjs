import { build } from 'electron-builder';
import { readFile } from 'node:fs/promises';
const config = JSON.parse(await readFile('config/distribution.json', 'utf8'));
const publicRelease = process.env.MATRIX_PUBLIC_RELEASE === '1';
const channel = process.env.MATRIX_UPDATE_CHANNEL ?? 'stable';
if (!['stable', 'beta'].includes(channel)) throw new Error('MATRIX_UPDATE_CHANNEL deve ser stable ou beta.');
if (publicRelease && (!process.env.MATRIX_UPDATE_SIGNING_KEY || !config.updateManifestPublicKey || !config.microsoftClientId || !config.githubOwner || !config.githubRepo || !process.env.GH_TOKEN)) {
  throw new Error('Release requer chave privada Ed25519 no secret MATRIX_UPDATE_SIGNING_KEY, chave pública no config/distribution.json, client ID, destino GitHub e GH_TOKEN.');
}
const publish = publicRelease ? [{ provider: 'github', owner: config.githubOwner, repo: config.githubRepo, channel: channel === 'stable' ? 'latest' : 'beta', releaseType: channel === 'stable' ? 'release' : 'prerelease' }] : undefined;
await build({ win: process.argv.includes('--linux') ? undefined : ['nsis'], linux: process.argv.includes('--linux') ? ['AppImage', 'deb', 'rpm'] : undefined,
  publish: 'never',
  config: { compression: process.argv.includes('--fast') ? 'store' : 'normal', extraMetadata: { homepage: config.website }, win: { verifyUpdateCodeSignature: false, signExecutable: false },
    ...(publish ? { publish } : {}) } });
