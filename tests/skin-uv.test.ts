import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Mesh, Raycaster, Vector3 } from 'three';
import { PlayerObject } from 'skinview3d';
import { faces, faceAt } from '../shared/skin-pixels.ts';
import type { BodyPart, SkinModel } from '../shared/skin.ts';

const parts: BodyPart[] = ['head', 'body', 'rightArm', 'leftArm', 'rightLeg', 'leftLeg'];
const boxFaceOrder = ['right', 'left', 'top', 'bottom', 'front', 'back'];
for (const model of ['classic', 'slim'] as SkinModel[]) test(`2D UV regions match actual skinview3d mesh UVs: ${model}`, () => {
  const player = new PlayerObject(); player.skin.modelType = model === 'slim' ? 'slim' : 'default';
  for (const part of parts) for (const layer of ['base', 'outer'] as const) {
    let mesh: Mesh | undefined;
    (layer === 'base' ? player.skin[part].innerLayer : player.skin[part].outerLayer).traverse(object => { if (object instanceof Mesh) mesh = object; });
    assert.ok(mesh);
    const uv = mesh.geometry.getAttribute('uv');
    for (let faceIndex = 0; faceIndex < 6; faceIndex++) {
      const mapped = faces(model).find(face => face.part === part && face.layer === layer && face.face === boxFaceOrder[faceIndex]);
      assert.ok(mapped);
      const xs: number[] = [], ys: number[] = [];
      for (let vertex = faceIndex * 4; vertex < faceIndex * 4 + 4; vertex++) { xs.push(uv.getX(vertex) * 64); ys.push((1 - uv.getY(vertex)) * 64); }
      assert.deepEqual([Math.round(Math.min(...xs)), Math.round(Math.min(...ys)), Math.round(Math.max(...xs)), Math.round(Math.max(...ys))], [mapped.x, mapped.y, mapped.x + mapped.width, mapped.y + mapped.height], `${part}/${layer}/${mapped.face}`);
    }
  }
  player.traverse(object => { if (object instanceof Mesh) object.geometry.dispose(); });
});

test('3D raycaster selects the corresponding head-front texel with CanvasTexture flipY', () => {
  const player = new PlayerObject(); player.updateMatrixWorld(true);
  // Head occupies x=-4..4, y=8..16, z=-4..4; texture front is x=8..16, y=8..16.
  const raycaster = new Raycaster(new Vector3(-1.5, 10.5, 100), new Vector3(0, 0, -1));
  const hit = raycaster.intersectObject(player.skin.head.innerLayer, true)[0];
  assert.ok(hit?.uv);
  const x = Math.floor(hit.uv.x * 64), y = Math.floor((1 - hit.uv.y) * 64);
  assert.deepEqual([x, y], [10, 13]);
  assert.equal(faceAt(x, y, 'classic')?.part, 'head');
  assert.equal(faceAt(x, y, 'classic')?.face, 'front');
  player.traverse(object => { if (object instanceof Mesh) object.geometry.dispose(); });
});
