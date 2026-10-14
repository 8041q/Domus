import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';
import * as THREE from 'three';

const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'silent' });
after(async () => vite.close());
const { PlannerScene } = await vite.ssrLoadModule('/src/renderer/PlannerScene.ts');
const { polygonArea, pointInRoom, roomTemplate } = await vite.ssrLoadModule('/src/core/roomGeometry.ts');

const outline = (points) => points.map(([x, z], index) => ({ id: `v${index}`, x, z }));
const examples = {
  'angled C-shaped room': outline([[0, 0.7], [0.8, 0], [4.8, 0], [6, 1.2], [5.8, 2.4], [2.5, 2.4],
    [2.3, 3.8], [5.4, 5], [5.2, 6.3], [4.6, 7], [0.8, 7], [0, 6.3]]),
  'acute triangle': outline([[0, 0], [8, 0], [0.4, 1.2]]),
  'narrow concave corridor': outline([[0, 0], [6, 0], [6, 3], [5.65, 3], [5.65, 0.35], [0.35, 0.35], [0.35, 3], [0, 3]]),
  'nearly collinear walls': outline([[0, 0], [3, 0.000001], [6, 0], [6, 4], [0, 4]]),
  'short bevels': outline([[0, 0.2], [0.2, 0], [5.8, 0], [6, 0.2], [6, 3.8], [5.8, 4], [0.2, 4], [0, 3.8]]),
  'circular room': roomTemplate('circle', 6, 6),
  'rounded room': roomTemplate('rounded-rectangle', 6, 5, 1),
  'L-shaped room': roomTemplate('l-shape', 6, 5),
  'recessed room': roomTemplate('recess', 6, 5)
};

for (const [name, base] of Object.entries(examples)) for (const reversed of [false, true]) {
  test(`${name}, ${reversed ? 'reversed' : 'normal'} winding: floor and ceiling shade cover the interior once`, () => {
    let vertices = base.map((point) => ({ ...point,
      x: 7 + point.x * Math.cos(0.37) - point.z * Math.sin(0.37),
      z: -9 + point.x * Math.sin(0.37) + point.z * Math.cos(0.37) }));
    if (reversed) vertices.reverse();
    const snapshot = { room: { vertices, height: 2.6 } };
    const scene = Object.create(PlannerScene.prototype);
    Object.assign(scene, { architecturalShadeGroup: new THREE.Group(), ceilingVisible: false });
    const perimeter = scene.insetRoomVertices(snapshot, 0.025);
    scene.addFloorPerimeterShade(snapshot);
    scene.addCeilingPerimeterShade(snapshot);
    assert.equal(scene.architecturalShadeGroup.children.length, 2, 'One shade draw per surface prevents alpha stacking');
    for (const mesh of scene.architecturalShadeGroup.children) {
      const positions = mesh.geometry.getAttribute('position');
      const indices = mesh.geometry.index.array;
      let coveredArea = 0;
      for (let index = 0; index < indices.length; index += 3) {
        const triangle = Array.from(indices.slice(index, index + 3), (i) => ({ x: positions.getX(i), z: positions.getZ(i) }));
        const centre = { x: triangle.reduce((sum, p) => sum + p.x, 0) / 3, z: triangle.reduce((sum, p) => sum + p.z, 0) / 3 };
        assert.ok(pointInRoom(centre, { vertices: perimeter }), 'Shade must not bridge a recess');
        coveredArea += Math.abs(polygonArea(triangle));
      }
      assert.ok(Math.abs(coveredArea - Math.abs(polygonArea(perimeter))) < 1e-5, 'No overlapping or missing shade triangles');
      mesh.updateMatrixWorld();
      const xs = perimeter.map((p) => p.x), zs = perimeter.map((p) => p.z);
      // Sample across triangle boundaries, narrow necks and the empty notch.
      for (let x = Math.min(...xs) + 0.037; x < Math.max(...xs); x += 0.19) {
        for (let z = Math.min(...zs) + 0.053; z < Math.max(...zs); z += 0.17) {
          const ray = new THREE.Raycaster(new THREE.Vector3(x, 4, z), new THREE.Vector3(0, -1, 0));
          assert.equal(ray.intersectObject(mesh).length, pointInRoom({ x, z }, { vertices: perimeter }) ? 1 : 0,
            `Incorrect shade coverage at ${x}, ${z}`);
        }
      }
      assert.equal(mesh.material.depthWrite, false);
      assert.equal(mesh.visible, !mesh.userData.ceilingShade, 'Ceiling shade follows ceiling visibility');
    }
    scene.disposeGroup(scene.architecturalShadeGroup);
  });
}
