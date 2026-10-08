import { build as viteBuild } from 'vite';
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import './icon.mjs';
await mkdir('dist-electron', { recursive: true });
await build({ entryPoints: ['electron/main.ts'], outfile: 'dist-electron/main.cjs', platform: 'node', target: 'node24', format: 'cjs', bundle: true, packages: 'external', sourcemap: true });
await build({ entryPoints: ['electron/preload.ts'], outfile: 'dist-electron/preload.cjs', platform: 'node', target: 'node24', format: 'cjs', bundle: true, external: ['electron'], sourcemap: true });
await viteBuild();
