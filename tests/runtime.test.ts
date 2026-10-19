import test from 'node:test';
import assert from 'node:assert/strict';
import { createExample, exampleTests } from '../services/examples';
import { runPlaytest } from '../runtime/playtest';
import { GameSimulation } from '../runtime/GameSimulation';
import { createNodeVisual, disposeObject } from '../runtime/assetMesh';
import { applyProjectOperations, validateProject } from '../services/projectDocument';
import { sculptedAsset } from '../services/assetAssembly';
import { createModelDocument } from '../services/modelDocument';
import { HUMANOID_SKELETON } from '../utils/riggingConstants';

for (const kind of ['exploration', 'arena'] as const)
  test(`${kind} example completes with the shared deterministic runtime and does not alter authoring state`, () => {
    const p = createExample(kind, `test-${kind}`),
      before = structuredClone(p);
    const r = runPlaytest(p, exampleTests[kind]);
    assert.equal(r.passed, true, JSON.stringify(r));
    assert.deepEqual(p, before);
  });
test('human, quadruped and machine bodies, fitted equipment, sockets and animation survive portable round trips', () => {
  let p = createExample('exploration', 'rig-test');
  p = applyProjectOperations(p, [
    { type: 'asset.character', id: 'biped', name: 'Biped', profile: 'biped' },
    { type: 'equipment.fit', bodyId: 'biped', id: 'biped-shell', name: 'Shell', kind: 'shell' },
    { type: 'asset.character', id: 'machine', name: 'Machine', profile: 'machine' },
  ]);
  const restored = validateProject(JSON.parse(JSON.stringify(p)));
  assert.deepEqual(restored, p);
  const hero = restored.scenes[0].nodes.find((n) => n.id === 'player')!;
  const visual = createNodeVisual(hero, new Map(restored.assets.map((a) => [a.id, a])));
  visual.animate('walk', 0.1);
  assert.ok(visual.bones.get('leg_left_front')!.rotation.x !== 0);
  assert.ok(visual.group.children.length > 1);
  disposeObject(visual.group);
  assert.throws(
    () =>
      applyProjectOperations(p, [
        { type: 'node.put', sceneId: 'main', node: { ...hero, assetId: 'machine' } },
      ]),
    /different body/,
  );
});
test('solid gates stop movement until their authored variable is satisfied; stopping a runtime leaves the project intact', () => {
  const p = createExample('exploration', 'collision');
  const sim = new GameSimulation(p);
  for (const n of sim.nodes.values()) if (sim.component(n, 'collectible')) n.enabled = false;
  for (let i = 0; i < 600; i++) sim.step({ moveZ: -1 });
  const pos = sim.worldPosition(sim.nodes.get('player')!);
  assert.ok(pos.z > -10);
  assert.equal(sim.status, 'playing');
  sim.variables.crystals = 5;
  for (let i = 0; i < 80; i++) sim.step({ moveZ: -1 });
  assert.equal(sim.status, 'won');
  assert.equal(p.scenes[0].variables.crystals, 0);
});
test('legacy sculpt rigs convert into animated runtime joints without discarding authored keyframes', () => {
  const p = createExample('arena', 'legacy-rig'),
    hero = p.assets.find((a) => a.id === 'hero')!;
  const model = createModelDocument(
    [{ x: 0, y: 0, z: 0, color: 0, bone: 'Torso', weights: [{ bone: 'Torso', weight: 1 }] }],
    HUMANOID_SKELETON,
  );
  const converted = sculptedAsset({ ...hero, rig: null }, model);
  assert.equal(converted.rig!.profile, 'humanoid');
  assert.ok(converted.rig!.clips.find((c) => c.name === 'Walk'));
  assert.ok(converted.rig!.clips.some((c) => c.tracks.some((t) => t.keys.some((k) => k.position))));
  validateProject({
    ...p,
    assets: [converted],
    scenes: [{ ...p.scenes[0], nodes: [] }],
    activeAssetId: null,
    editorDraft: null,
  });
});
test('animation markers run custom rules on the same fixed timeline as visual clips', () => {
  let p = createExample('exploration', 'markers');
  const n = p.scenes[0].nodes.find((n) => n.id === 'player')!;
  p = applyProjectOperations(p, [
    {
      type: 'node.put',
      sceneId: 'main',
      node: {
        ...n,
        components: [
          ...n.components,
          {
            type: 'rules',
            apiVersion: 1,
            rules: [
              {
                event: 'animation',
                marker: 'step',
                actions: [{ type: 'add', variable: 'footsteps', value: 1 }],
              },
            ],
          },
        ],
      },
    },
  ]);
  const sim = new GameSimulation(p);
  for (let i = 0; i < 60; i++) sim.step({ moveZ: -1 });
  assert.ok(sim.variables.footsteps >= 2);
  assert.ok(sim.events.some((e) => e.type === 'animation'));
  assert.ok(sim.animationState('player')!.time > 0);
});
