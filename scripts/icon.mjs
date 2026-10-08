import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Pre-sized versions of the supplied artwork, preserving its aspect ratio.
// Repository assets keep future builds from regenerating the previous icon.
const source = new URL('../assets/app-icon/', import.meta.url);
const output = new URL('../build/', import.meta.url);
const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = await Promise.all(sizes.map(async size => {
  const png = await readFile(new URL(`${size}.png`, source));
  if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || png.readUInt32BE(16) !== size || png.readUInt32BE(20) !== size) throw new Error(`Ícone PNG inválido: ${size}`);
  return png;
}));
const header = Buffer.alloc(6 + sizes.length * 16);
header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
for (let i = 0; i < sizes.length; i++) {
  const entry = 6 + i * 16;
  header[entry] = sizes[i] % 256; header[entry + 1] = sizes[i] % 256;
  header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(images[i].length, entry + 8); header.writeUInt32LE(offset, entry + 12);
  offset += images[i].length;
}
await mkdir(fileURLToPath(output), { recursive: true });
await copyFile(new URL('512.png', source), new URL('icon.png', output));
await writeFile(new URL('icon.ico', output), Buffer.concat([header, ...images]));
