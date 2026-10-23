import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { DEFAULT_SCENE_LIGHTING } from '../services/sceneLightingDefaults';
import { updateSceneLighting } from '../runtime/sceneLighting';

test('shared scene lighting keeps the legacy rig and replaces it with authored values', () => {
  const group = new THREE.Group();
  updateSceneLighting(group);
  assert.equal(group.children.length, 2);
  const defaultHemisphere = group.children[0] as THREE.HemisphereLight;
  const defaultSun = group.children[1] as THREE.DirectionalLight;
  assert.ok(defaultHemisphere instanceof THREE.HemisphereLight);
  assert.equal(defaultHemisphere.color.getHex(), 0xc5e3ff);
  assert.equal(defaultHemisphere.groundColor.getHex(), 0x334025);
  assert.equal(defaultHemisphere.intensity, 2);
  assert.equal(defaultSun.color.getHex(), 0xffe8ce);
  assert.equal(defaultSun.intensity, 3);
  assert.deepEqual(defaultSun.position.toArray(), [12, 24, 8]);
  assert.equal(defaultSun.castShadow, true);
  assert.deepEqual(defaultSun.shadow.mapSize.toArray(), [2048, 2048]);
  const sunShadow = defaultSun.shadow;

  updateSceneLighting(group, {
    ...structuredClone(DEFAULT_SCENE_LIGHTING),
    hemisphere: { skyColor: 0x123456, groundColor: 0x654321, intensity: 0.4 },
    directional: { color: 0xabcdef, intensity: 1.2, position: [-4, 8, 2], castShadow: false },
  });
  assert.equal(group.children.length, 2);
  const hemisphere = group.children[0] as THREE.HemisphereLight;
  const sun = group.children[1] as THREE.DirectionalLight;
  assert.equal(hemisphere, defaultHemisphere);
  assert.equal(sun, defaultSun);
  assert.equal(sun.shadow, sunShadow);
  assert.equal(hemisphere.color.getHex(), 0x123456);
  assert.equal(hemisphere.groundColor.getHex(), 0x654321);
  assert.equal(hemisphere.intensity, 0.4);
  assert.equal(sun.color.getHex(), 0xabcdef);
  assert.equal(sun.intensity, 1.2);
  assert.deepEqual(sun.position.toArray(), [-4, 8, 2]);
  assert.equal(sun.castShadow, false);
});
