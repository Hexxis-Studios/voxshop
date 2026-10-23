import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { GameViewport } from '../runtime/GameViewport';
import { GameSession } from '../runtime/GameSession';
import { SceneVisuals } from '../runtime/SceneVisuals';
import { assetSchema, newProject, nodeSchema, validateProject } from '../services/projectDocument';
import { createModelDocument } from '../services/modelDocument';

test('Stop restores the editor camera and authored scene after Play mutations', () => {
  const project = newProject('viewport-stop', 'Viewport Stop');
  const asset = assetSchema.parse({
    id: 'rock',
    name: 'Rock',
    model: createModelDocument([{ x: 0, y: 0, z: 0, color: 0x775544 }]),
  });
  const prop = nodeSchema.parse({
    id: 'prop',
    name: 'Prop',
    assetId: asset.id,
    transform: { position: [0, 0, 0] },
  });
  const spawner = nodeSchema.parse({
    id: 'spawner',
    name: 'Spawner',
    transform: { position: [0, 0, 0] },
    components: [
      {
        type: 'rules',
        apiVersion: 1,
        rules: [
          {
            event: 'start',
            once: true,
            interval: 1,
            actions: [{ type: 'spawn', prefabId: 'rock-prefab', position: [2, 0, 0] }],
          },
        ],
      },
    ],
  });
  const prefabRoot = nodeSchema.parse({
    id: 'prefab-rock',
    name: 'Spawned rock',
    assetId: asset.id,
    transform: { position: [0, 0, 0] },
  });
  project.assets = [asset];
  project.scenes[0].nodes = [prop, spawner];
  project.prefabs = [
    {
      id: 'rock-prefab',
      name: 'Rock prefab',
      rootId: prefabRoot.id,
      attachmentParentId: null,
      nodes: [prefabRoot],
    },
  ];
  const authored = validateProject(project);
  const session = new GameSession(authored, 'main');
  const runtimeNodeId = session.simulation.scene.nodes.find((node) => node.id.startsWith('rt'))!.id;
  assert.ok(runtimeNodeId);
  const scene = new THREE.Scene();
  const visuals = new SceneVisuals(scene, authored.scenes[0].nodes, new Map([[asset.id, asset]]));
  visuals.addNodes(session.simulation.scene.nodes);
  visuals.flush();
  assert.equal(visuals.stats().instances, 2);

  const authoredJson = JSON.stringify(authored),
    editorPosition = [7, 8, 9] as const,
    editorTarget = [1, 2, 3],
    stateUpdates: unknown[] = [];
  const viewport = Object.assign(Object.create(GameViewport.prototype), {
    project: authored,
    session,
    runtimeSceneId: 'main',
    scene,
    visuals,
    audio: { clearPending() {} },
    importedAudio: { stop() {} },
    camera: new THREE.PerspectiveCamera(),
    controls: { enabled: false, target: new THREE.Vector3(1, 2, 3), update() {} },
    renderer: { capabilities: { isWebGL2: false }, domElement: { focus() {} } },
    syncTerrainRenderer() {},
    select() {},
    blur() {},
    accumulator: 0,
    agentPaused: true,
    cameraOverride: false,
    stateStamp: 'play-state',
    progressRestoredSceneId: 'main',
    editorViewBeforePlay: {
      position: new THREE.Vector3(...editorPosition),
      target: new THREE.Vector3(...editorTarget),
      near: 0.25,
      far: 900,
      cameraOverride: true,
    },
  }) as GameViewport;
  viewport.camera.position.set(7, 8, 9);
  viewport.camera.near = 0.25;
  viewport.camera.far = 900;
  viewport.onState = (state) => stateUpdates.push(state);

  viewport.simulation!.nodes.get('prop')!.transform.position = [99, 98, 97];
  viewport.camera.position.set(-10, 30, 50);
  viewport.controls.target.set(-5, 4, 6);

  viewport.stop();
  const finalVisuals = (viewport as unknown as { visuals: SceneVisuals }).visuals;

  assert.equal(viewport.simulation, null);
  assert.equal(viewport.progressRestoredSceneId, null);
  assert.equal(viewport.controls.enabled, true);
  assert.equal(Reflect.get(viewport, 'agentPaused'), false);
  assert.equal(Reflect.get(viewport, 'cameraOverride'), true);
  assert.equal(viewport.camera.near, 0.25);
  assert.equal(viewport.camera.far, 900);
  assert.deepEqual(viewport.camera.position.toArray(), editorPosition);
  assert.deepEqual(viewport.controls.target.toArray(), editorTarget);
  assert.ok(finalVisuals.nodes.has('prop'));
  assert.equal(finalVisuals.nodes.has(runtimeNodeId), false);
  assert.equal(finalVisuals.stats().instances, 1);
  let runtimeVisualFound = false;
  scene.traverse((object) => {
    if (object.userData.nodeId === runtimeNodeId || object.userData.nodeIds?.includes(runtimeNodeId))
      runtimeVisualFound = true;
  });
  assert.equal(runtimeVisualFound, false);
  assert.equal(stateUpdates.at(-1), null);
  assert.equal(JSON.stringify(authored), authoredJson);
  finalVisuals.dispose();
});
