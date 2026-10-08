import { generateKeyPairSync } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const keyPath = join('release-secrets', 'update-signing-key.pem');
const configPath = 'config/distribution.json';
try { await readFile(keyPath); throw new Error(`A chave já existe em ${keyPath}; não será sobrescrita.`); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
await mkdir(dirname(keyPath), { recursive: true });
await writeFile(keyPath, privatePem, { flag: 'wx', mode: 0o600 });
const config = JSON.parse(await readFile(configPath, 'utf8'));
config.updateManifestPublicKey = publicPem;
await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
console.log(`Chave pública gravada em ${configPath}. Revise e envie essa alteração ao repositório.`);
console.log(`Cadastre o conteúdo privado de ${keyPath} como GitHub Secret MATRIX_UPDATE_SIGNING_KEY. Não envie esse arquivo ao GitHub.`);
