import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { SkinObject } from 'skinview3d';
import type { Mesh } from 'three';
import { faces, faceAt, createTemplate, convertLegacy, normalizePixels, encodePixels, decodePixels, PixelEditor, type Color } from '../shared/skin-pixels.ts';
const red: Color = [230,10,20,255];
const colorAt = (pixels: Uint8ClampedArray, x: number, y: number) => Array.from(pixels.slice((y*64+x)*4,(y*64+x)*4+4));

test('UV rectangles agree with actual skinview3d geometry for both models and layers', () => {
  for (const model of ['classic','slim'] as const) {
    const skin = new SkinObject(); skin.modelType = model === 'slim' ? 'slim' : 'default';
    for (const f of faces(model)) {
      assert.ok(f.x >= 0 && f.y >= 0 && f.x+f.width <= 64 && f.y+f.height <= 64);
      const part = skin[f.part], mesh = f.layer === 'base' ? part.innerLayer : part.outerLayer;
      const uv = (mesh as Mesh).geometry.attributes.uv;
      const index = ['right','left','top','bottom','front','back'].indexOf(f.face);
      const xs: number[] = [], ys: number[] = [];
      for (let i = index*4; i < index*4+4; i++) { xs.push(Math.round(uv.getX(i)*64)); ys.push(Math.round((1-uv.getY(i))*64)); }
      assert.deepEqual([Math.min(...xs),Math.min(...ys),Math.max(...xs)-Math.min(...xs),Math.max(...ys)-Math.min(...ys)], [f.x,f.y,f.width,f.height]);
      assert.equal(faceAt(f.x,f.y,model),f);
    }
    skin.traverse(o => { if ('geometry' in o) (o.geometry as { dispose(): void }).dispose(); });
    assert.equal(faces(model).length,72);
  }
});

test('legacy conversion mirrors all twelve faces without shifting top/bottom or swapping limb sides incorrectly', () => {
  const input = new Uint8ClampedArray(8192);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 64; x++) input.set([x,y,(x+y)%256,255],(y*64+x)*4);
  const output = convertLegacy(input);
  const copies = [[4,16,4,4,20,48],[8,16,4,4,24,48],[0,20,4,12,24,52],[4,20,4,12,20,52],[8,20,4,12,16,52],[12,20,4,12,28,52],[44,16,4,4,36,48],[48,16,4,4,40,48],[40,20,4,12,40,52],[44,20,4,12,36,52],[48,20,4,12,32,52],[52,20,4,12,44,52]];
  for (const [sx,sy,w,h,dx,dy] of copies) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) assert.deepEqual(colorAt(output,dx+x,dy+y),[sx+w-1-x,sy+y,(sx+w-1-x+sy+y)%256,255]);
  assert.equal(colorAt(output,40,8)[3],0);
  assert.equal(colorAt(output,0,48)[3],0);
  assert.throws(() => convertLegacy(new Uint8ClampedArray(100)));
});

test('base pixels remain opaque, outer alpha is preserved, unused UV pixels untouched', () => {
  const editor = new PixelEditor(createTemplate('blank','slim'),'slim');
  editor.setPixel(4,8,[1,2,3,0]); editor.setPixel(40,8,[1,2,3,24]); editor.setPixel(63,63,red);
  assert.deepEqual(colorAt(editor.pixels,4,8),[1,2,3,255]);
  assert.deepEqual(colorAt(editor.pixels,40,8),[1,2,3,24]);
  assert.deepEqual(colorAt(editor.pixels,63,63),[0,0,0,0]);
  assert.equal(faceAt(47,16,'slim')?.face,'bottom');
  assert.equal(faceAt(50,16,'slim'),undefined);
  assert.deepEqual(normalizePixels(editor.pixels,'slim'),editor.pixels);
});

test('stroke transactions, cancellation, undo/redo and redo invalidation operate atomically', () => {
  const editor = new PixelEditor(createTemplate('blank','classic'),'classic');
  const original = editor.pixels.slice(); editor.begin(); editor.setPixel(8,8,red); editor.setPixel(9,8,red); editor.commit();
  assert.equal(editor.canUndo,true); assert.equal(editor.undo(),true); assert.deepEqual(editor.pixels,original);
  assert.equal(editor.redo(),true); assert.deepEqual(colorAt(editor.pixels,9,8),red);
  editor.begin(); editor.setPixel(10,8,red); editor.cancel(); assert.deepEqual(colorAt(editor.pixels,10,8),[0,0,0,255]);
  editor.undo(); editor.setPixel(11,8,red); assert.equal(editor.canRedo,false);
  for (let i = 0; i < 110; i++) editor.setPixel(8,8,[i,1,2,255]);
  let count = 0; while (editor.undo()) count++; assert.equal(count,100);
});

test('bucket stops at UV face boundaries; lines, selection, gradients, copy/paste and shading are raster operations', () => {
  const editor = new PixelEditor(createTemplate('blank','classic'),'classic');
  editor.fill(8,8,red); assert.deepEqual(colorAt(editor.pixels,15,15),red); assert.deepEqual(colorAt(editor.pixels,16,8),[0,0,0,255]);
  editor.line(8,8,15,15,[0,0,200,255]); assert.deepEqual(colorAt(editor.pixels,11,11),[0,0,200,255]);
  editor.region({x:8,y:8,width:2,height:3},[0,0,0,255],[100,100,100,255]);
  assert.deepEqual(colorAt(editor.pixels,8,9),[50,50,50,255]);
  const clipboard = editor.copy({x:8,y:8,width:2,height:3}); editor.paste(16,8,clipboard);
  assert.deepEqual(colorAt(editor.pixels,16,10),[100,100,100,255]); editor.shade(16,10,200); assert.deepEqual(colorAt(editor.pixels,16,10),[255,255,255,255]);
  assert.throws(() => editor.region({x:0,y:0,width:10000,height:1},red)); assert.throws(() => editor.line(0,0,1e9,0,red));
});

test('body symmetry swaps side faces, is reversible, and copying limbs preserves separate UVs', () => {
  const editor = new PixelEditor(createTemplate('blank','classic'),'classic');
  editor.setPixel(0,8,red); editor.setPixel(8,8,[4,5,6,255]); const before = editor.pixels.slice();
  editor.mirror('head','base'); assert.deepEqual(colorAt(editor.pixels,23,8),red); assert.deepEqual(colorAt(editor.pixels,15,8),[4,5,6,255]);
  editor.mirror('head','base'); assert.deepEqual(editor.pixels,before);
  editor.setPixel(44,20,red); editor.copyPart('rightArm','leftArm','base'); assert.deepEqual(colorAt(editor.pixels,36,52),red);
  assert.throws(() => editor.copyPart('head','body','base'));
});

test('original templates and raw encoding round-trip, PNG export retains exact pixels and alpha', () => {
  for (const kind of ['blank','classic','slim','clothes'] as const) {
    const model = kind === 'slim' ? 'slim' : 'classic', pixels = createTemplate(kind,model);
    assert.deepEqual(decodePixels(encodePixels(pixels)),pixels);
    const png = PNG.sync.write({width:64,height:64,data:Buffer.from(pixels)} as PNG);
    const decoded = PNG.sync.read(png); assert.equal(decoded.width,64); assert.equal(decoded.height,64); assert.deepEqual(new Uint8ClampedArray(decoded.data),pixels);
  }
  assert.throws(() => decodePixels('garbage')); assert.throws(() => encodePixels(new Uint8ClampedArray(1)));
});
