import type { BodyPart, SkinLayer, SkinModel } from './skin.ts';

export type Color = readonly [number, number, number, number];
export type SelectionRect = { x: number; y: number; width: number; height: number };
export type PixelClipboard = { width: number; height: number; pixels: Uint8ClampedArray };
export type SkinFace = SelectionRect & { part: BodyPart; layer: SkinLayer; face: 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' };
const parts: BodyPart[] = ['head', 'body', 'rightArm', 'leftArm', 'rightLeg', 'leftLeg'];
const origins: Record<BodyPart, [number, number, number, number]> = {
  head: [0, 0, 32, 0], body: [16, 16, 16, 32], rightArm: [40, 16, 40, 32],
  leftArm: [32, 48, 48, 48], rightLeg: [0, 16, 0, 32], leftLeg: [16, 48, 0, 48],
};
const maps = new Map<SkinModel, SkinFace[]>();
/** Exact skinview3d BoxGeometry UV rectangles, including three-pixel Alex arms. */
export function faces(model: SkinModel): SkinFace[] {
  const cached = maps.get(model); if (cached) return cached;
  const result: SkinFace[] = [];
  for (const part of parts) {
    const width = part === 'head' || part === 'body' ? 8 : part.endsWith('Arm') && model === 'slim' ? 3 : 4;
    const height = part === 'head' ? 8 : 12, depth = part === 'head' ? 8 : 4;
    for (const layer of ['base', 'outer'] as const) {
      const origin = origins[part], x = origin[layer === 'base' ? 0 : 2], y = origin[layer === 'base' ? 1 : 3];
      const add = (face: SkinFace['face'], dx: number, dy: number, w: number, h: number) => result.push({ part, layer, face, x: x + dx, y: y + dy, width: w, height: h });
      add('top', depth, 0, width, depth); add('bottom', depth + width, 0, width, depth);
      add('left', 0, depth, depth, height); add('front', depth, depth, width, height);
      add('right', depth + width, depth, depth, height); add('back', depth * 2 + width, depth, width, height);
    }
  }
  maps.set(model, result); return result;
}
export function faceAt(x: number, y: number, model: SkinModel): SkinFace | undefined {
  if (!Number.isInteger(x) || !Number.isInteger(y)) return undefined;
  return faces(model).find(f => x >= f.x && x < f.x + f.width && y >= f.y && y < f.y + f.height);
}
function requirePixels(pixels: Uint8ClampedArray, size = 16384) { if (pixels.length !== size) throw new Error('Dimensões RGBA da skin inválidas'); }
/** Preserve unused texels; Minecraft base faces do not support transparency. */
export function normalizePixels(pixels: Uint8ClampedArray, model: SkinModel): Uint8ClampedArray {
  requirePixels(pixels); const result = pixels.slice();
  for (const f of faces(model).filter(f => f.layer === 'base')) for (let y = f.y; y < f.y + f.height; y++) for (let x = f.x; x < f.x + f.width; x++) result[(y * 64 + x) * 4 + 3] = 255;
  return result;
}
export function encodePixels(pixels: Uint8ClampedArray): string { requirePixels(pixels); return btoa(String.fromCharCode(...pixels)); }
export function decodePixels(encoded: string): Uint8ClampedArray {
  if (!/^[A-Za-z0-9+/]{21846}==$/.test(encoded)) throw new Error('Textura RGBA inválida');
  const text = atob(encoded), result = Uint8ClampedArray.from(text, c => c.charCodeAt(0)); requirePixels(result); return result;
}
/** Matches skinview-utils/Mojang's twelve mirrored legacy limb copies exactly. */
export function convertLegacy(pixels: Uint8ClampedArray): Uint8ClampedArray {
  requirePixels(pixels, 8192); const result = new Uint8ClampedArray(16384); result.set(pixels);
  const copies = [
    [4,16,4,4,20,48], [8,16,4,4,24,48], [0,20,4,12,24,52], [4,20,4,12,20,52], [8,20,4,12,16,52], [12,20,4,12,28,52],
    [44,16,4,4,36,48], [48,16,4,4,40,48], [40,20,4,12,40,52], [44,20,4,12,36,52], [48,20,4,12,32,52], [52,20,4,12,44,52],
  ];
  for (const [sx,sy,w,h,dx,dy] of copies) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) result.set(pixels.subarray(((sy+y)*64+sx+w-1-x)*4, ((sy+y)*64+sx+w-x)*4), ((dy+y)*64+dx+x)*4);
  // Legacy opaque backgrounds mean “no hat”, as in vanilla/skinview-utils.
  let opaque = true; for (let i = 3; i < pixels.length; i += 4) if (pixels[i] !== 255) { opaque = false; break; }
  if (opaque) for (const f of faces('classic').filter(f => f.part === 'head' && f.layer === 'outer')) for (let y = f.y; y < f.y+f.height; y++) for (let x = f.x; x < f.x+f.width; x++) result.fill(0, (y*64+x)*4, (y*64+x)*4+4);
  return normalizePixels(result, 'classic');
}
/** Original MATRIX templates, generated locally; no third-party skin assets. */
export function createTemplate(kind: 'blank' | 'classic' | 'slim' | 'clothes', model: SkinModel): Uint8ClampedArray {
  const result = normalizePixels(new Uint8ClampedArray(16384), model);
  if (kind === 'blank') return result;
  for (const f of faces(model).filter(f => f.layer === 'base')) for (let y = 0; y < f.height; y++) for (let x = 0; x < f.width; x++) {
    let color: Color = [195, 149, 111, 255];
    if (f.part === 'body' || f.part.endsWith('Arm') && y < 4) color = kind === 'slim' ? [82, 133, 106, 255] : [93, 120, 145, 255];
    if (f.part.endsWith('Leg')) color = y > 9 ? [54, 47, 43, 255] : [61, 63, 84, 255];
    if (f.part === 'head' && (f.face === 'top' || f.face === 'back' || y < 2)) color = [73, 48, 36, 255];
    if (f.part === 'head' && f.face === 'front' && y === 4 && (x === 2 || x === 5)) color = [42, 58, 69, 255];
    if (kind === 'clothes' && f.part === 'body') color = x === 3 || x === 4 ? [176, 139, 89, 255] : [45, 45, 48, 255];
    result.set(color, ((f.y+y)*64+f.x+x)*4);
  }
  return result;
}

type Change = { offsets: Uint16Array; before: Uint8ClampedArray; after: Uint8ClampedArray };
const boundedRect = (rect: SelectionRect): SelectionRect => {
  if (![rect.x,rect.y,rect.width,rect.height].every(Number.isInteger) || rect.width < 1 || rect.height < 1 || rect.width > 64 || rect.height > 64) throw new Error('Seleção inválida');
  const x = Math.max(0, Math.min(63, rect.x)), y = Math.max(0, Math.min(63, rect.y));
  return { x, y, width: Math.min(64-x, rect.width), height: Math.min(64-y, rect.height) };
};
/** Sparse, atomic history. At most 100 edits and 2 MiB; a drag is one transaction. */
export class PixelEditor {
  readonly pixels: Uint8ClampedArray;
  readonly model: SkinModel;
  private pending?: Uint8ClampedArray;
  private history: Change[] = [];
  private future: Change[] = [];
  constructor(pixels: Uint8ClampedArray, model: SkinModel) { this.pixels = normalizePixels(pixels, model); this.model = model; }
  get canUndo() { return this.history.length > 0; }
  get canRedo() { return this.future.length > 0; }
  begin() { if (!this.pending) this.pending = this.pixels.slice(); }
  commit(): boolean {
    const before = this.pending; this.pending = undefined; if (!before) return false;
    const offsets: number[] = [];
    for (let p = 0; p < 4096; p++) { const i = p*4; if (this.pixels.subarray(i,i+4).some((v,c) => v !== before[i+c])) offsets.push(p); }
    if (!offsets.length) return false;
    const old = new Uint8ClampedArray(offsets.length*4), next = new Uint8ClampedArray(offsets.length*4);
    offsets.forEach((p,i) => { old.set(before.subarray(p*4,p*4+4),i*4); next.set(this.pixels.subarray(p*4,p*4+4),i*4); });
    this.history.push({ offsets: Uint16Array.from(offsets), before: old, after: next }); this.future = [];
    let bytes = this.history.reduce((sum,c) => sum + c.offsets.byteLength + c.before.byteLength + c.after.byteLength, 0);
    while (this.history.length > 100 || bytes > 2*1024*1024) { const c = this.history.shift()!; bytes -= c.offsets.byteLength+c.before.byteLength+c.after.byteLength; }
    return true;
  }
  cancel() { if (this.pending) this.pixels.set(this.pending); this.pending = undefined; }
  private apply(change: Change, values: Uint8ClampedArray) { change.offsets.forEach((p,i) => this.pixels.set(values.subarray(i*4,i*4+4), p*4)); }
  undo(): boolean { this.cancel(); const c = this.history.pop(); if (!c) return false; this.apply(c,c.before); this.future.push(c); return true; }
  redo(): boolean { this.cancel(); const c = this.future.pop(); if (!c) return false; this.apply(c,c.after); this.history.push(c); return true; }
  private transaction(work: () => void) { const own = !this.pending; if (own) this.begin(); try { work(); if (own) this.commit(); } catch (e) { if (own) this.cancel(); throw e; } }
  private write(x: number, y: number, color: Color) {
    const face = faceAt(x,y,this.model); if (!face) return;
    if (!color.every(Number.isFinite)) throw new Error('Cor inválida');
    const i = (y*64+x)*4; this.pixels.set(color, i); if (face.layer === 'base') this.pixels[i+3] = 255;
  }
  setPixel(x: number, y: number, color: Color) { this.transaction(() => this.write(x,y,color)); }
  fill(x: number, y: number, color: Color) {
    const face = faceAt(x,y,this.model); if (!face) return;
    this.transaction(() => {
      const i = (y*64+x)*4, target = this.pixels.slice(i,i+4), stack: [number,number][] = [[x,y]], seen = new Uint8Array(4096);
      while (stack.length) {
        const [px,py] = stack.pop()!; if (px < face.x || px >= face.x+face.width || py < face.y || py >= face.y+face.height || seen[py*64+px]) continue;
        seen[py*64+px] = 1; const offset = (py*64+px)*4; if (!target.every((v,c) => v === this.pixels[offset+c])) continue;
        this.write(px,py,color); stack.push([px-1,py],[px+1,py],[px,py-1],[px,py+1]);
      }
    });
  }
  line(x0: number, y0: number, x1: number, y1: number, color: Color) {
    if (![x0,y0,x1,y1].every(Number.isInteger) || Math.max(Math.abs(x0),Math.abs(y0),Math.abs(x1),Math.abs(y1)) > 128) throw new Error('Linha inválida');
    this.transaction(() => { const dx = Math.abs(x1-x0), sx = x0 < x1 ? 1 : -1, dy = -Math.abs(y1-y0), sy = y0 < y1 ? 1 : -1; let err = dx+dy;
      for (;;) { this.write(x0,y0,color); if (x0 === x1 && y0 === y1) break; const e2 = 2*err; if (e2 >= dy) { err += dy; x0 += sx; } if (e2 <= dx) { err += dx; y0 += sy; } }
    });
  }
  region(rect: SelectionRect, color: Color, gradient?: Color) {
    const r = boundedRect(rect); this.transaction(() => { for (let y = 0; y < r.height; y++) for (let x = 0; x < r.width; x++) {
      const t = gradient && r.height > 1 ? y/(r.height-1) : 0;
      const c = color.map((v,i) => Math.round(v + ((gradient?.[i] ?? v)-v)*t)) as unknown as Color; this.write(r.x+x,r.y+y,c);
    } });
  }
  copy(rect: SelectionRect): PixelClipboard {
    const r = boundedRect(rect), pixels = new Uint8ClampedArray(r.width*r.height*4);
    for (let y = 0; y < r.height; y++) for (let x = 0; x < r.width; x++) if (faceAt(r.x+x,r.y+y,this.model)) { const i = ((r.y+y)*64+r.x+x)*4; pixels.set(this.pixels.subarray(i,i+4), (y*r.width+x)*4); }
    return { width: r.width, height: r.height, pixels };
  }
  paste(x: number, y: number, clipboard: PixelClipboard) {
    if (![x,y,clipboard.width,clipboard.height].every(Number.isInteger) || clipboard.width < 1 || clipboard.height < 1 || clipboard.width > 64 || clipboard.height > 64 || clipboard.pixels.length !== clipboard.width*clipboard.height*4) throw new Error('Região copiada inválida');
    this.transaction(() => { for (let py = 0; py < clipboard.height; py++) for (let px = 0; px < clipboard.width; px++) { const i = (py*clipboard.width+px)*4; this.write(x+px,y+py,Array.from(clipboard.pixels.subarray(i,i+4)) as unknown as Color); } });
  }
  mirror(part: BodyPart, layer: SkinLayer) {
    const selected = faces(this.model).filter(f => f.part === part && f.layer === layer), before = this.pixels.slice();
    this.transaction(() => { for (const to of selected) { const source = selected.find(f => f.face === (to.face === 'left' ? 'right' : to.face === 'right' ? 'left' : to.face))!;
      for (let y = 0; y < to.height; y++) for (let x = 0; x < to.width; x++) { const i = ((source.y+y)*64+source.x+source.width-1-x)*4; this.write(to.x+x,to.y+y,Array.from(before.subarray(i,i+4)) as unknown as Color); }
    } });
  }
  copyPart(from: BodyPart, to: BodyPart, layer: SkinLayer) {
    const all = faces(this.model), source = all.filter(f => f.part === from && f.layer === layer), target = all.filter(f => f.part === to && f.layer === layer);
    if (target.some(f => { const s = source.find(s => s.face === f.face)!; return s.width !== f.width || s.height !== f.height; })) throw new Error('Partes do corpo com dimensões incompatíveis');
    const before = this.pixels.slice(); this.transaction(() => { for (const f of target) { const s = source.find(s => s.face === f.face)!; for (let y = 0; y < f.height; y++) for (let x = 0; x < f.width; x++) { const i = ((s.y+y)*64+s.x+x)*4; this.write(f.x+x,f.y+y,Array.from(before.subarray(i,i+4)) as unknown as Color); } } });
  }
  shade(x: number, y: number, delta: number) { if (!faceAt(x,y,this.model)) return; if (!Number.isFinite(delta)) throw new Error('Tonalidade inválida'); const i = (y*64+x)*4; this.setPixel(x,y,[this.pixels[i]+delta,this.pixels[i+1]+delta,this.pixels[i+2]+delta,this.pixels[i+3]]); }
}
