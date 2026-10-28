import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import * as THREE from 'three';
import { createTestServer } from './helpers/vite.mjs';
const vite = await createTestServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'silent' });
after(() => vite.close());
const { normalizeLightingControls, LIGHTING_MOODS } = await vite.ssrLoadModule('/src/core/lighting.ts');
const { PlannerScene } = await vite.ssrLoadModule('/src/renderer/PlannerScene.ts');
const { emptyRoomSnapshot, parseProjectSnapshot, getSnapshot, usePlannerStore: store } = await vite.ssrLoadModule('/src/store.ts');

test('legacy lighting keeps unit brightness and malformed controls are bounded', () => {
  const snapshot = emptyRoomSnapshot();
  for (const key of Object.keys(normalizeLightingControls())) delete snapshot.room.lighting[key];
  assert.deepEqual(normalizeLightingControls(parseProjectSnapshot(snapshot).room.lighting), {
    ceilingBrightness: 1, ceilingWarmth: .5, sunlightStrength: 1, ambientBrightness: 1
  });
  assert.deepEqual(normalizeLightingControls({ ceilingBrightness: -2, ceilingWarmth: 50, sunlightStrength: Infinity, ambientBrightness: NaN }), {
    ceilingBrightness: 0, ceilingWarmth: 1, sunlightStrength: 1, ambientBrightness: 1
  });
});

test('moods and manual adjustments survive serialization and undo/redo', () => {
  store.getState().resetProject();
  const before = getSnapshot();
  store.getState().setRoomLighting(LIGHTING_MOODS[1].lighting);
  const evening = getSnapshot();
  assert.deepEqual(parseProjectSnapshot(JSON.parse(JSON.stringify(evening))).room.lighting, evening.room.lighting);
  store.getState().undo(); assert.deepEqual(getSnapshot().room.lighting, before.room.lighting);
  store.getState().redo(); assert.deepEqual(getSnapshot().room.lighting, evening.room.lighting);
  store.getState().setRoomLighting({ ceilingBrightness: 0.7 });
  assert.equal(getSnapshot().room.lighting.ceilingBrightness, .7);
  assert.equal(getSnapshot().room.lighting.ambientBrightness, .3);
});

test('dimming isolates ceiling, sun, and fill without accumulating multipliers', () => {
  const scene = Object.create(PlannerScene.prototype);
  const ceiling = new THREE.SpotLight(); ceiling.userData.baseIntensity = 1;
  const daylight = new THREE.SpotLight();
  const studio = new THREE.Texture();
  Object.assign(scene, {
    scene: new THREE.Scene(), renderer: {}, lightFixtureGroup: new THREE.Group(),
    daylightGroup: new THREE.Group(), interiorLightGroup: new THREE.Group(),
    sunsetLights: [new THREE.DirectionalLight(), new THREE.DirectionalLight()],
    hemiLight: new THREE.HemisphereLight(), ambientLight: new THREE.AmbientLight(),
    mainLight: new THREE.DirectionalLight(), fillLight: new THREE.DirectionalLight(),
    productEnvironment: () => studio, pairedSunsEnvironment: () => studio
  });
  scene.interiorLightGroup.add(ceiling); scene.daylightGroup.add(daylight);
  const snapshot = emptyRoomSnapshot();
  Object.assign(snapshot.room.lighting, { ambientBrightness: 0, sunlightStrength: 0, ceilingBrightness: 1.5, ceilingWarmth: 1 });
  scene.applyRoomLighting(snapshot);
  assert.equal(scene.hemiLight.intensity, 0); assert.equal(scene.mainLight.intensity, 0);
  assert.equal(daylight.intensity, 0); assert.equal(scene.scene.environmentIntensity, 0);
  assert.equal(scene.sunsetLights[0].intensity, 0);
  assert.ok(ceiling.intensity > 0); assert.ok(ceiling.color.r > ceiling.color.b);
  const intensity = ceiling.intensity;
  scene.applyRoomLighting(snapshot); assert.equal(ceiling.intensity, intensity);
  snapshot.room.lighting.ceilingBrightness = 0;
  scene.applyRoomLighting(snapshot); assert.equal(ceiling.intensity, 0);
  studio.dispose();
});

test('ceiling shadow targets are released with the rig', () => {
  const scene = Object.create(PlannerScene.prototype);
  scene.interiorLightGroup = new THREE.Group();
  let releases = 0;
  for (let i = 0; i < 9; i++) {
    const light = new THREE.SpotLight();
    light.shadow.map = new THREE.WebGLRenderTarget(8, 8);
    light.shadow.map.addEventListener('dispose', () => releases++);
    scene.interiorLightGroup.add(light, light.target);
  }
  scene.disposeCeilingLights();
  assert.equal(releases, 9); assert.equal(scene.interiorLightGroup.children.length, 0);
});
