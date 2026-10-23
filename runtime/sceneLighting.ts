import * as THREE from 'three';
import type { SceneLighting } from '../services/projectDocument';
import { DEFAULT_SCENE_LIGHTING } from '../services/sceneLightingDefaults';

export function updateSceneLighting(group: THREE.Group, lighting?: SceneLighting) {
  const settings = lighting ?? DEFAULT_SCENE_LIGHTING;
  let hemisphere = group.children.find((child) => child instanceof THREE.HemisphereLight) as
    THREE.HemisphereLight | undefined;
  let sun = group.children.find((child) => child instanceof THREE.DirectionalLight) as
    THREE.DirectionalLight | undefined;
  if (!hemisphere || !sun) {
    group.clear();
    hemisphere = new THREE.HemisphereLight();
    sun = new THREE.DirectionalLight();
    group.add(hemisphere, sun);
  }
  hemisphere.color.setHex(settings.hemisphere.skyColor);
  hemisphere.groundColor.setHex(settings.hemisphere.groundColor);
  hemisphere.intensity = settings.hemisphere.intensity;
  sun.color.setHex(settings.directional.color);
  sun.intensity = settings.directional.intensity;
  sun.position.set(...settings.directional.position);
  sun.castShadow = settings.directional.castShadow;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -40;
  sun.shadow.camera.right = 40;
  sun.shadow.camera.top = 40;
  sun.shadow.camera.bottom = -40;
}
