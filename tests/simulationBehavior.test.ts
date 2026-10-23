import assert from 'node:assert/strict';
import test from 'node:test';
import { GameSimulation } from '../runtime/GameSimulation';
import { GameSession } from '../runtime/GameSession';
import { serializeCampaignProgress } from '../runtime/campaignProgress';
import { serializeGameProgress } from '../runtime/gameProgress';
import { createExample } from '../services/examples';
import { newProject, validateProject, type Component, type SceneNode } from '../services/projectDocument';

function node(id: string, components: Component[], position: [number, number, number]): SceneNode {
  return {
    id,
    name: id,
    parentId: null,
    assetId: null,
    enabled: true,
    transform: { position, rotation: [0, 0, 0], scale: [1, 1, 1] },
    components,
    attachments: [],
  };
}

function checkpoint(simulation: GameSimulation) {
  const snapshot = simulation.progressSnapshot();
  assert.ok(snapshot);
  const serialized = serializeGameProgress(snapshot);
  assert.ok(serialized, 'the simulation produces a valid JSON checkpoint');
  return JSON.parse(serialized) as typeof snapshot;
}

function animatedProject(id: string, markerRules: Component[] = []) {
  const project = createExample('exploration', id),
    scene = project.scenes[0],
    player = structuredClone(scene.nodes.find((entry) => entry.id === 'player')!);
  scene.nodes = [player];
  scene.variables = { crystals: 0, markers: 0, attacks: 0 };
  player.components.push(...markerRules);
  return validateProject(project);
}

test('pause freezes simulation time and ticks while allowing menu events and clean resume', () => {
  const project = newProject('pause-behavior', 'Pause behavior');
  project.scenes[0].variables = { ticks: 0, menuOpened: 0 };
  project.scenes[0].nodes = [
    node(
      'logic',
      [
        {
          type: 'rules',
          apiVersion: 1,
          rules: [
            {
              event: 'tick',
              interval: 0.05,
              once: false,
              actions: [{ type: 'add', variable: 'ticks', value: 1 }],
            },
            {
              event: 'ui',
              eventId: 'pause-menu',
              once: false,
              actions: [{ type: 'set', variable: 'menuOpened', value: 1 }],
            },
          ],
        } as Component,
      ],
      [0, 0, 0],
    ),
  ];
  const simulation = new GameSimulation(validateProject(project));
  try {
    simulation.step({}, 0.1);
    const beforePause = simulation.inspect();
    assert.ok(beforePause.variables.ticks > 0);

    simulation.step({ togglePause: true, moveX: 1, jump: true }, 0.1);
    const paused = simulation.inspect();
    assert.equal(paused.paused, true);
    assert.equal(paused.frame, beforePause.frame);
    assert.equal(paused.seconds, beforePause.seconds);
    assert.equal(paused.variables.ticks, beforePause.variables.ticks);

    simulation.step({ uiEventId: 'pause-menu' }, 0.1);
    assert.equal(simulation.inspect().variables.menuOpened, 1);
    assert.equal(simulation.inspect().frame, beforePause.frame);
    assert.equal(simulation.inspect().paused, true);

    simulation.step({ togglePause: true }, 0.1);
    assert.equal(simulation.inspect().paused, false);
    assert.equal(simulation.inspect().frame, beforePause.frame, 'the resume input does not advance gameplay');
    simulation.step({}, 0.1);
    assert.ok(simulation.inspect().variables.ticks > beforePause.variables.ticks);
  } finally {
    simulation.dispose();
  }
});

test('patrol resumes from a later route segment after a JSON checkpoint', async () => {
  const project = newProject('patrol-behavior', 'Patrol behavior');
  project.scenes[0].nodes = [
    node(
      'patrol',
      [
        {
          type: 'patrol',
          points: [
            [0, 0, 0],
            [1, 0, 0],
            [2, 0, 0],
          ],
          speed: 3,
        },
      ],
      [0, 0, 0],
    ),
  ];
  const source = new GameSimulation(validateProject(project));
  let resumed: GameSimulation | undefined;
  try {
    for (let i = 0; i < 40 && checkpoint(source).behavior?.patrolTargets.patrol !== 2; i++) source.step();
    const saved = checkpoint(source);
    assert.equal(saved.behavior?.patrolTargets.patrol, 2);
    assert.ok(source.worldPosition(source.nodes.get('patrol')!).x > 0.8);
    resumed = new GameSimulation(project, project.activeSceneId, JSON.parse(JSON.stringify(saved)));
    assert.equal(resumed.progressRestored, true);
    for (let i = 0; i < 12; i++) {
      source.step();
      resumed.step();
      assert.ok(
        Math.abs(
          source.worldPosition(source.nodes.get('patrol')!).x -
            resumed.worldPosition(resumed.nodes.get('patrol')!).x,
        ) < 1e-9,
      );
    }
    assert.ok(resumed.worldPosition(resumed.nodes.get('patrol')!).x > 1.3);
  } finally {
    source.dispose();
    resumed?.dispose();
  }
});

test('real rig clip time and repeated markers continue across JSON save and resume', () => {
  const rules: Component = {
      type: 'rules',
      apiVersion: 1,
      rules: [
        {
          event: 'animation',
          marker: 'footstep',
          interval: 1,
          once: false,
          actions: [{ type: 'add', variable: 'markers', value: 1 }],
        },
      ],
    },
    project = animatedProject('animation-behavior', [rules]),
    source = new GameSimulation(project);
  let resumed: GameSimulation | undefined;
  try {
    for (let i = 0; i < 30; i++) source.step({ moveZ: -1 });
    const saved = checkpoint(source);
    assert.equal(saved.behavior?.animations.player.clip, 'walk');
    assert.ok(saved.behavior!.animations.player.time > 0.45);
    assert.equal(source.variables.markers, 1);
    resumed = new GameSimulation(project, project.activeSceneId, JSON.parse(JSON.stringify(saved)));
    assert.equal(resumed.progressRestored, true);
    for (let i = 0; i < 48; i++) {
      source.step({ moveZ: -1 });
      resumed.step({ moveZ: -1 });
      assert.equal(source.variables.markers, resumed.variables.markers);
      assert.ok(
        Math.abs(source.animationState('player')!.time - resumed.animationState('player')!.time) < 1e-9,
      );
    }
    assert.equal(source.variables.markers, 3, 'the later loop markers fire once each');
  } finally {
    source.dispose();
    resumed?.dispose();
  }
});

test('attack and damage cooldowns continue from a serialized checkpoint', () => {
  const project = newProject('cooldown-behavior', 'Cooldown behavior');
  project.scenes[0].variables = { attacks: 0 };
  project.scenes[0].nodes = [
    node(
      'player',
      [
        { type: 'player', style: 'top-down', speed: 3, jump: 0 },
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
      ],
      [0, 0, 0],
    ),
    node(
      'enemy',
      [
        { type: 'enemy', speed: 0.1, damage: 10, range: 1 },
        { type: 'health', maximum: 1000 },
      ],
      [0, 0, 0],
    ),
  ];
  const validProject = validateProject(project),
    source = new GameSimulation(validProject);
  let resumed: GameSimulation | undefined;
  try {
    source.step({ attack: true });
    source.step();
    source.step();
    source.step();
    const saved = checkpoint(source);
    assert.ok(saved.behavior!.cooldowns.attack > 0);
    assert.ok(saved.behavior!.cooldowns.damage > 0);
    resumed = new GameSimulation(validProject, validProject.activeSceneId, JSON.parse(JSON.stringify(saved)));
    assert.equal(resumed.progressRestored, true);
    for (let i = 0; i < 70; i++) {
      const input = i % 2 === 0 ? { attack: true } : {};
      source.step(input);
      resumed.step(input);
      assert.equal(source.variables.attacks, resumed.variables.attacks);
      assert.equal(source.health.player, resumed.health.player);
      assert.equal(source.health.enemy, resumed.health.enemy);
      assert.deepEqual(checkpoint(source).behavior?.cooldowns, checkpoint(resumed).behavior?.cooldowns);
    }
    assert.ok(source.variables.attacks >= 3, 'attack cooldown expires during the replay');
    assert.ok(source.health.player <= 80, 'damage cooldown expires during the replay');
  } finally {
    source.dispose();
    resumed?.dispose();
  }
});

test('invalid patrol and animation references reject atomically, including stale authored and overrun clips', () => {
  const project = animatedProject('invalid-behavior');
  project.scenes[0].nodes.push(
    node(
      'patrol',
      [
        {
          type: 'patrol',
          points: [
            [0, 0, 0],
            [2, 0, 0],
          ],
          speed: 1,
        },
      ],
      [0, 0, 0],
    ),
  );
  const hero = project.assets.find((asset) => asset.id === 'hero')!;
  const walk = structuredClone(hero.rig!.clips.find((clip) => clip.name === 'walk')!);
  hero.rig!.clips.push({ ...walk, name: 'extra', duration: 0.2, loop: false, tracks: [], events: [] });
  const validProject = validateProject(project),
    simulation = new GameSimulation(validProject);
  let overrun: GameSimulation | undefined;
  try {
    for (let i = 0; i < 30; i++) simulation.step({ moveZ: -1 });
    const before = checkpoint(simulation);
    assert.equal(before.behavior?.patrolTargets.patrol, 1);
    for (const invalid of [
      (snapshot: typeof before) => (snapshot.behavior!.patrolTargets.patrol = 2),
      (snapshot: typeof before) => (snapshot.behavior!.animations.player.clip = 'missing'),
      (snapshot: typeof before) => (snapshot.behavior!.animations.player.clip = 'extra'),
      (snapshot: typeof before) => (snapshot.behavior!.cooldowns.attack = 0.350001),
      (snapshot: typeof before) => (snapshot.behavior!.cooldowns.damage = 0.800001),
    ]) {
      const candidate = structuredClone(before);
      invalid(candidate);
      assert.equal(simulation.restoreProgress(candidate), false);
      assert.deepEqual(checkpoint(simulation), before);
    }

    const detached = simulation.progressSnapshot()!;
    detached.behavior!.animations.player.time += 10;
    assert.equal(simulation.animationState('player')!.time, before.behavior!.animations.player.time);
    assert.deepEqual(checkpoint(simulation), before);
    const legacy = structuredClone(before);
    delete legacy.behavior;
    assert.equal(simulation.restoreProgress(legacy), true);
    assert.equal(
      simulation.animationState('player'),
      undefined,
      'legacy saves clear the restored animation clock',
    );

    const nonLoopProject = structuredClone(validProject),
      nonLoopPlayer = nonLoopProject.scenes[0].nodes.find((entry) => entry.id === 'player')!;
    nonLoopPlayer.components.find((component) => component.type === 'animation')!.moving = 'extra';
    overrun = new GameSimulation(validateProject(nonLoopProject));
    overrun.step({ moveZ: -1 });
    const nonLoopBefore = checkpoint(overrun),
      tooLate = structuredClone(nonLoopBefore);
    tooLate.behavior!.animations.player.time = 0.21;
    assert.equal(overrun.restoreProgress(tooLate), false);
    assert.deepEqual(checkpoint(overrun), nonLoopBefore);
  } finally {
    simulation.dispose();
    overrun?.dispose();
  }
});

test('marker-triggered A-to-B-to-A JSON resume does not replay the transition marker', async () => {
  const transitionRules: Component = {
      type: 'rules',
      apiVersion: 1,
      rules: [
        {
          event: 'animation',
          marker: 'footstep',
          interval: 1,
          once: false,
          actions: [{ type: 'add', variable: 'markers', value: 1 }],
        },
        {
          event: 'animation',
          marker: 'footstep',
          interval: 1,
          once: false,
          condition: { variable: 'markers', op: '>=', value: 1 },
          actions: [{ type: 'transition', sceneId: 'second' }],
        },
      ],
    },
    project = createExample('exploration', 'marker-transition'),
    first = project.scenes[0],
    playerInFirst = structuredClone(first.nodes.find((entry) => entry.id === 'player')!),
    second = structuredClone(first),
    playerInSecond = second.nodes.find((entry) => entry.id === 'player')!;
  first.nodes = [playerInFirst];
  first.variables = { crystals: 0, markers: 0, attacks: 0 };
  playerInFirst.components.push(transitionRules);
  second.nodes = [playerInSecond];
  second.id = 'second';
  second.name = 'Second scene';
  playerInSecond.components = playerInSecond.components.filter((component) => component.type !== 'rules');
  second.nodes.push(
    node(
      'return-portal',
      [
        { type: 'interactable', prompt: 'Return', range: 3 },
        {
          type: 'rules',
          apiVersion: 1,
          rules: [
            {
              event: 'interact',
              interval: 1,
              once: false,
              actions: [{ type: 'transition', sceneId: first.id }],
            },
          ],
        },
      ],
      [0, 0, 8],
    ),
  );
  project.scenes.push(second);
  const validProject = validateProject(project),
    session = new GameSession(validProject, first.id);
  let resumed: GameSession | undefined;
  try {
    await session.ready;
    for (let i = 0; i < 40 && session.simulation.scene.id === first.id; i++) session.step({ moveZ: -1 });
    assert.equal(session.simulation.scene.id, 'second');
    const campaign = session.progressSnapshot();
    assert.ok(campaign);
    const serialized = serializeCampaignProgress(campaign);
    assert.ok(serialized);
    const firstSaved = campaign.scenes.find((scene) => scene.sceneId === first.id)!;
    assert.equal(firstSaved.variables.markers, 1);
    assert.ok(firstSaved.behavior!.animations.player.time >= 0.225);

    resumed = new GameSession(validProject, first.id, JSON.parse(serialized));
    await resumed.ready;
    assert.equal(resumed.simulation.scene.id, 'second');
    resumed.step({ interact: true });
    assert.equal(resumed.simulation.scene.id, first.id);
    assert.equal(resumed.simulation.variables.markers, 1);
    assert.equal(resumed.progressWasRestored(first.id), true);

    resumed.step({ moveZ: -1 });
    assert.equal(
      resumed.simulation.scene.id,
      first.id,
      'the saved first footstep marker does not immediately transition again',
    );
    assert.equal(resumed.simulation.variables.markers, 1);
    assert.deepEqual(resumed.scenePath, [first.id, 'second', first.id]);
  } finally {
    session.dispose();
    resumed?.dispose();
  }
});
