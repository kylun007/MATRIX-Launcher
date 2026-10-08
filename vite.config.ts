import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { randomBytes } from 'node:crypto';
export default defineConfig(({ command }) => {
  const nonce = randomBytes(18).toString('base64');
  return { plugins: [react(), tailwind(), { name: 'matrix-csp', transformIndexHtml(html) {
    return command === 'serve' ? html.replace("script-src 'self';", `script-src 'self' 'nonce-${nonce}';`) : html.replace(' ws://127.0.0.1:5173', '');
  } }], html: command === 'serve' ? { cspNonce: nonce } : undefined, base: './', server: { host: '127.0.0.1', port: 5173, strictPort: true, watch: { ignored: ['**/.smoke/**', '**/.npm-cache/**', '**/release/**', '**/dist/**', '**/dist-electron/**', '**/build/**'] } }, build: { outDir: 'dist' } };
});
