import { createServer } from 'vite';
const server = await createServer(); await server.listen();
process.env.MATRIX_DEV_URL = 'http://127.0.0.1:5173';
try { await import('./smoke.mjs'); } finally { await server.close(); }
