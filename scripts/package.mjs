import { build } from 'electron-builder';
import { readFile } from 'node:fs/promises';
const config = JSON.parse(await readFile('config/distribution.json', 'utf8'));
const signed = !!process.env.CSC_LINK || !!process.env.WIN_CSC_LINK || !!process.env.AZURE_TENANT_ID;
if (config.updateUrl && (!signed || !config.publisherName)) throw new Error('Atualizações exigem build assinado e publisherName configurado.');
if (process.env.MATRIX_PUBLIC_RELEASE === '1' && (!signed || !config.microsoftClientId)) throw new Error('Release pública exige assinatura e client ID Microsoft próprio.');
await build({ win: process.argv.includes('--linux') ? undefined : ['nsis'], linux: process.argv.includes('--linux') ? ['AppImage'] : undefined,
  config: { compression: process.argv.includes('--fast') ? 'store' : 'normal', win: { signtoolOptions: { publisherName: config.publisherName ? [config.publisherName] : ['MATRIX Community'] }, ...(signed ? { forceCodeSigning: true } : {}) },
    ...(config.updateUrl ? { publish: [{ provider: 'generic', url: config.updateUrl }] } : {}) } });
