import assert from 'node:assert/strict';
import test from 'node:test';
import { GameSession } from '../runtime/GameSession';
import { newProject, validateProject, type Component, type SceneNode } from '../services/projectDocument';

function node(
  id: string,
  components: Component[],
  position: [number, number, number] = [0, 0, 0],
): SceneNode {
  return {
    id,
    name: id,
    assetId: null,
    parentId: null,
    transform: { position, rotation: [0, 0, 0], scale: [1, 1, 1] },
    enabled: true,
    components,
    attachments: [],
  };
}

function gate(destination: string) {
  return node('gate', [
    { type: 'interactable', prompt: 'Continue', range: 3 },
    {
      type: 'rules',
      apiVersion: 1,
      rules: [
        {
          event: 'interact',
          interval: 1,
          once: false,
          actions: [{ type: 'transition', sceneId: destination }],
        },
      ],
    },
  ]);
}

function twoSceneProject() {
  const project = newProject('held-input', 'Held input transition');
  const player = () =>
      node('player', [
        { type: 'player', style: 'top-down', speed: 3, jump: 6 },
        { type: 'inventory', slots: 4 },
        { type: 'health', maximum: 100 },
        {
          type: 'rules',
          apiVersion: 1,
          rules: [
            {
              event: 'attack',
              interval: 1,
              once: false,
              actions: [{ type: 'add', variable: 'attacks', value: 1 }],
            },
          ],
        },
      ]),
    medkit = {
      id: 'medkit',
      name: 'Medkit',
      description: '',
      maxStack: 4,
      use: { type: 'heal' as const, amount: 25 },
    };
  const first = project.scenes[0];
  first.id = 'first';
  project.activeSceneId = 'first';
  first.variables = { attacks: 0 };
  first.items = [medkit];
  first.nodes = [player(), gate('second')];
  const second = structuredClone(first);
  second.id = 'second';
  second.name = 'Second scene';
  second.nodes = [player(), gate('first')];
  project.scenes.push(second);
  return validateProject(project);
}

test('scene transition suppresses held rising-edge inputs until release', async () => {
  const project = twoSceneProject(),
    session = new GameSession(project, 'first'),
    reference = new GameSession(project, 'second');
  try {
    await session.ready;
    await reference.ready;
    session.simulation.health.player = 50;
    session.simulation.inventory = [{ itemId: 'medkit', quantity: 2 }];
    const held = { interact: true, attack: true, jump: true, useItem: 'medkit' };
    session.step(held);
    assert.equal(session.simulation.scene.id, 'second');
    assert.equal(session.simulation.health.player, 75);
    assert.deepEqual(session.simulation.inventory, [{ itemId: 'medkit', quantity: 1 }]);

    reference.step({});
    const noJumpY = reference.simulation.nodes.get('player')!.transform.position[1];
    session.step(held);
    assert.equal(
      session.simulation.scene.id,
      'second',
      'holding Interact must not activate the next scene gate',
    );
    assert.equal(session.simulation.variables.attacks, 0, 'holding Attack must not fire again');
    assert.equal(
      session.simulation.nodes.get('player')!.transform.position[1],
      noJumpY,
      'holding Jump must not jump again',
    );
    assert.equal(session.simulation.health.player, 75, 'holding Use Item must not consume another item');
    assert.deepEqual(session.simulation.inventory, [{ itemId: 'medkit', quantity: 1 }]);

    session.step({});
    session.step({ attack: true });
    assert.equal(session.simulation.variables.attacks, 1, 'Attack works after release');
    session.step({});
    session.step({ jump: true });
    assert.ok(
      session.simulation.nodes.get('player')!.transform.position[1] > noJumpY,
      'Jump works after release',
    );
    session.step({});
    session.step({ useItem: 'medkit' });
    assert.equal(session.simulation.health.player, 100, 'Use Item works after release');
    assert.deepEqual(session.simulation.inventory, []);
    session.step({});
    session.step({ interact: true });
    assert.equal(session.simulation.scene.id, 'first', 'a fresh press after release remains usable');
  } finally {
    session.dispose();
    reference.dispose();
  }
});
