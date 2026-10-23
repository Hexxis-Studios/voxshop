import assert from 'node:assert/strict';
import test from 'node:test';
import { GameSimulation } from '../runtime/GameSimulation';
import {
  findGridPath,
  findVoxelPath,
  segmentHitsObstacle,
  type NavigationObstacle,
} from '../runtime/navigation';
import { newProject, validateProject, type Component, type SceneNode } from '../services/projectDocument';
import { worldDocumentSchema } from '../services/worldDocument';

test('grid navigation routes around a solid obstacle with collision clearance', () => {
  const wall: NavigationObstacle = { minX: -1.5, maxX: 1.5, minZ: -0.5, maxZ: 0.5 },
    result = findGridPath({ x: 0, z: -4 }, { x: 0, z: 4 }, [wall], { clearance: 0.4 });
  assert.ok(result.path, 'the route is found');
  assert.ok(result.expanded <= 512);
  assert.ok(
    result.path.some((point) => Math.abs(point.x) > 1.9),
    'the route passes around an end',
  );
  for (let i = 1; i < result.path.length; i++)
    assert.equal(segmentHitsObstacle(result.path[i - 1], result.path[i], wall, 0.4), false);
});

test('grid navigation reports enclosed goals as unreachable without exhausting its cap', () => {
  const enclosure: NavigationObstacle[] = [
    { minX: -2, maxX: -1.5, minZ: -2, maxZ: 2 },
    { minX: 1.5, maxX: 2, minZ: -2, maxZ: 2 },
    { minX: -1.5, maxX: 1.5, minZ: -2, maxZ: -1.5 },
    { minX: -1.5, maxX: 1.5, minZ: 1.5, maxZ: 2 },
  ];
  const result = findGridPath({ x: -4, z: 0 }, { x: 0, z: 0 }, enclosure, {
    clearance: 0.1,
    maxExpanded: 4096,
  });
  assert.equal(result.path, null);
  assert.equal(result.capped, false);
});

test('grid navigation stops at the expanded-node ceiling', () => {
  const result = findGridPath({ x: -4, z: 0 }, { x: 4, z: 0 }, [], { maxExpanded: 2 });
  assert.equal(result.path, null);
  assert.equal(result.expanded, 2);
  assert.equal(result.capped, true);
});

test('grid navigation rejects a goal connector blocked after the final grid cell', () => {
  const result = findGridPath(
    { x: -2, z: 0 },
    { x: 1.49, z: 0 },
    [{ minX: 1.3, maxX: 1.6, minZ: -0.2, maxZ: 0.2 }],
    { cellSize: 1 },
  );
  assert.equal(result.path, null);
  assert.equal(result.capped, false);
});

test('grid navigation detours around terrain edges rejected by the traversability callback', () => {
  const surface = (point: { x: number; z: number }) =>
    Math.abs(point.x) <= 0.75 && Math.abs(point.z) <= 1.75 ? 2 : 0;
  const traversable = (from: { x: number; z: number }, to: { x: number; z: number }) => {
    const distance = Math.hypot(to.x - from.x, to.z - from.z),
      steps = Math.max(1, Math.ceil(distance / 0.25));
    let height = surface(from);
    for (let step = 1; step <= steps; step++) {
      const progress = step / steps,
        next = surface({ x: from.x + (to.x - from.x) * progress, z: from.z + (to.z - from.z) * progress });
      if (next - height > 0.5) return false;
      height = next;
    }
    return true;
  };
  const result = findGridPath({ x: -3, z: 0 }, { x: 3, z: 0 }, [], { traversable });
  assert.ok(result.path, 'the route is found around the steep patch');
  assert.ok(result.path.some((point) => Math.abs(point.z) > 1.75 && Math.abs(point.x) < 1.5));
});

test('voxel navigation routes over a wall while keeping every waypoint traversable', () => {
  const traversable = (point: { x: number; y: number; z: number }) =>
    !(point.x === 0 && point.y <= 3 && Math.abs(point.z) <= 5);
  const result = findVoxelPath(
    { x: -2, y: 1, z: 0 },
    { x: 2, y: 1, z: 0 },
    { cellSize: 1, paddingCells: 4, traversable },
  );
  assert.ok(result.path, 'a route is found in 3D');
  assert.ok(result.expanded <= 2048);
  assert.ok(
    result.path.some((point) => point.y > 3),
    'the route clears the wall vertically',
  );
  assert.ok(result.path.every(traversable), 'the returned route contains no blocked waypoint');
});

test('voxel navigation caps its search volume before allocating an oversized grid', () => {
  const result = findVoxelPath(
    { x: 0, y: 0, z: 0 },
    { x: 1, y: 1, z: 1 },
    { cellSize: 0.5, maxCells: 1, traversable: () => true },
  );
  assert.equal(result.path, null);
  assert.equal(result.expanded, 0);
  assert.equal(result.capped, true);
});

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

test('enemy chase walks around an authored solid wall', () => {
  const project = newProject('enemy-navigation', 'Enemy navigation');
  project.scenes[0].nodes = [
    node(
      'player',
      [
        { type: 'player', style: 'top-down', speed: 3, jump: 6 },
        { type: 'collider', size: [0.6, 1, 0.6], offset: [0, 0.5, 0], solid: true },
      ],
      [0, 0, 4],
    ),
    node(
      'enemy',
      [
        { type: 'enemy', speed: 2, damage: 1, range: 0.2 },
        { type: 'collider', size: [0.6, 1, 0.6], offset: [0, 0.5, 0], solid: true },
      ],
      [0, 0, -4],
    ),
    node('wall', [{ type: 'collider', size: [3, 3, 1], offset: [0, 0, 0], solid: true }], [0, 1.5, 0]),
  ];
  const simulation = new GameSimulation(validateProject(project));
  try {
    const enemy = simulation.nodes.get('enemy')!;
    const routeCache = (
      simulation as unknown as {
        enemyNavigationRoutes: Map<string, { path: unknown[] | null }>;
      }
    ).enemyNavigationRoutes;
    let wentAroundWall = false;
    simulation.step();
    const retainedPath = routeCache.get('enemy')?.path;
    assert.ok(retainedPath, 'the first blocked chase plans a route');
    for (let i = 0; i < 20; i++) simulation.step();
    assert.equal(routeCache.get('enemy')?.path, retainedPath, 'the unchanged route is retained');
    for (let i = 0; i < 600; i++) {
      simulation.step();
      const position = simulation.worldPosition(enemy);
      if (Math.abs(position.x) > 1.9 && Math.abs(position.z) < 0.7) wentAroundWall = true;
    }
    assert.equal(simulation.status, 'playing');
    assert.equal(simulation.errors.length, 0);
    assert.equal(wentAroundWall, true, 'the enemy passes one end of the wall');
    assert.ok(
      simulation.worldPosition(enemy).distanceTo(simulation.worldPosition(simulation.nodes.get('player')!)) <
        0.5,
    );
  } finally {
    simulation.dispose();
  }
});

test('0.8 rectangular enemy chase keeps yaw-independent clearance and respects parent scale', () => {
  const scenarios: { parentScale: [number, number, number] | null; expectedClearance: number }[] = [
    { parentScale: null, expectedClearance: 0.55 },
    { parentScale: [1.5, 1, 0.75], expectedClearance: 0.8 },
  ];
  for (const [index, scenario] of scenarios.entries()) {
    const project = newProject(`enemy-navigation-${index}`, 'Rectangular enemy navigation');
    const scaledParent = scenario.parentScale ? node('enemy-scale', [], [0, 0, 0]) : null;
    if (scaledParent) scaledParent.transform.scale = scenario.parentScale!;
    const enemy = node(
      'enemy',
      [
        { type: 'enemy', speed: 2, damage: 1, range: 0.2 },
        { type: 'collider', size: [0.8, 1, 0.6], offset: [0, 0.5, 0], solid: true },
      ],
      [0, 0, -4 / (scenario.parentScale?.[2] ?? 1)],
    );
    enemy.parentId = scaledParent?.id ?? null;
    project.scenes[0].nodes = [
      ...(scaledParent ? [scaledParent] : []),
      node(
        'player',
        [
          { type: 'player', style: 'top-down', speed: 3, jump: 6 },
          { type: 'collider', size: [0.6, 1, 0.6], offset: [0, 0.5, 0], solid: true },
        ],
        [0, 0, 4],
      ),
      enemy,
      node('wall', [{ type: 'collider', size: [3, 3, 1], offset: [0, 0, 0], solid: true }], [0, 1.5, 0]),
    ];
    const simulation = new GameSimulation(validateProject(project));
    try {
      const runtimeEnemy = simulation.nodes.get('enemy')!;
      const routes = (
        simulation as unknown as {
          enemyNavigationRoutes: Map<string, { path: unknown[] | null; clearance: number }>;
        }
      ).enemyNavigationRoutes;
      simulation.step();
      const route = routes.get('enemy');
      assert.ok(route?.path, 'the initial blocked chase plans a route');
      assert.ok(
        Math.abs(route.clearance - scenario.expectedClearance) < 1e-8,
        'clearance includes the authored collider and parent scale',
      );
      for (let i = 0; i < 30; i++) simulation.step();
      assert.equal(routes.get('enemy'), route, 'yaw changes do not invalidate the cached route');

      let wentAroundWall = false;
      for (let i = 0; i < 570; i++) {
        simulation.step();
        const position = simulation.worldPosition(runtimeEnemy);
        if (Math.abs(position.x) > 2.25 && Math.abs(position.z) < 0.7) wentAroundWall = true;
      }
      assert.equal(simulation.status, 'playing');
      assert.equal(simulation.errors.length, 0);
      assert.equal(wentAroundWall, true, 'the rectangular enemy clears a wall end');
      assert.ok(
        simulation
          .worldPosition(runtimeEnemy)
          .distanceTo(simulation.worldPosition(simulation.nodes.get('player')!)) < 0.5,
        'the enemy reaches the player after going around the wall',
      );
    } finally {
      simulation.dispose();
    }
  }
});

test('enemy chase routes around a steep heightfield ridge', () => {
  const project = newProject('enemy-terrain-navigation', 'Enemy terrain navigation');
  project.worlds.push(
    worldDocumentSchema.parse({
      id: 'ridge-world',
      name: 'Flat ground with a steep ridge',
      seed: 9,
      chunkSize: 16,
      voxelSize: 0.5,
      generator: {
        type: 'terrain',
        version: 1,
        origin: [-32, -32],
        size: [64, 64],
        minY: 0,
        maxY: 31,
        baseHeight: 8,
        amplitude: 0,
        noise: 1,
        palette: {
          surface: 0x55aa44,
          subsurface: 0x725439,
          deep: 0x686b70,
          materialType: 'STANDARD',
        },
      },
      edits: [-3, -2, -1, 0, 1, 2, 3].flatMap((z) =>
        [9, 10, 11].map((y) => ({ x: 0, y, z, value: { color: 0x55aa44, materialType: 'STANDARD' } })),
      ),
    }),
  );
  project.scenes[0].worldId = 'ridge-world';
  project.scenes[0].nodes = [
    node(
      'player',
      [
        { type: 'player', style: 'top-down', speed: 3, jump: 6 },
        { type: 'collider', size: [0.6, 1, 0.6], offset: [0, 0.5, 0], solid: true },
      ],
      [2.5, 4.25, 0],
    ),
    node(
      'enemy',
      [
        { type: 'enemy', speed: 2, damage: 1, range: 0.2 },
        { type: 'collider', size: [0.6, 1, 0.6], offset: [0, 0.5, 0], solid: true },
      ],
      [-2.5, 4.25, 0],
    ),
  ];
  const simulation = new GameSimulation(validateProject(project));
  try {
    const routeCache = (
      simulation as unknown as {
        enemyNavigationRoutes: Map<string, { path: { x: number; z: number }[] | null; revision: number }>;
      }
    ).enemyNavigationRoutes;
    simulation.step();
    const path = routeCache.get('enemy')?.path;
    assert.ok(path, 'the steep direct route triggers bounded pathfinding');
    assert.ok(
      path.some((point) => Math.abs(point.z) > 1.75),
      'the route goes around the ridge end',
    );
    const revision = routeCache.get('enemy')!.revision;
    assert.ok(
      simulation.editTerrain({ x: 0, y: 11, z: 0, value: null }),
      'a runtime terrain edit is accepted',
    );
    simulation.step();
    assert.ok(routeCache.get('enemy')!.revision > revision, 'terrain edits invalidate the cached route');
    assert.notEqual(routeCache.get('enemy')!.path, path, 'the changed terrain receives a new route');
    assert.equal(simulation.errors.length, 0);
  } finally {
    simulation.dispose();
  }
});

test('enemy chase navigates over a solid wall in a voxel3d world', () => {
  const project = newProject('enemy-voxel-navigation', 'Enemy voxel navigation');
  project.worlds.push(
    worldDocumentSchema.parse({
      id: 'voxel-world',
      name: 'Voxel world with a wall',
      seed: 9,
      chunkSize: 16,
      voxelSize: 1,
      generator: {
        type: 'terrain',
        version: 1,
        mode: 'voxel3d',
        origin: [-4, -4],
        size: [9, 9],
        minY: 0,
        maxY: 8,
        baseHeight: 0,
        amplitude: 0,
        noise: 1,
        palette: {
          surface: 0x55aa44,
          subsurface: 0x725439,
          deep: 0x686b70,
          materialType: 'STANDARD',
        },
      },
      edits: [-4, -3, -2, -1, 0, 1, 2, 3, 4].flatMap((z) =>
        [1, 2, 3].map((y) => ({ x: 0, y, z, value: { color: 0x725439, materialType: 'STANDARD' } })),
      ),
    }),
  );
  project.scenes[0].worldId = 'voxel-world';
  project.scenes[0].nodes = [
    node(
      'player',
      [
        { type: 'player', style: 'top-down', speed: 3, jump: 6 },
        { type: 'collider', size: [0.6, 1, 0.6], offset: [0, 0.5, 0], solid: true },
      ],
      [2, 1, 0],
    ),
    node(
      'enemy',
      [
        { type: 'enemy', speed: 2, damage: 1, range: 0.2 },
        { type: 'collider', size: [0.6, 1, 0.6], offset: [0, 0.5, 0], solid: true },
      ],
      [-2, 1, 0],
    ),
  ];
  const simulation = new GameSimulation(validateProject(project));
  try {
    const enemy = simulation.nodes.get('enemy')!;
    const routeCache = (
      simulation as unknown as {
        enemyVoxelNavigationRoutes: Map<string, { path: { x: number; y: number; z: number }[] | null }>;
      }
    ).enemyVoxelNavigationRoutes;
    simulation.step();
    const path = routeCache.get('enemy')?.path;
    assert.ok(path, 'the blocked direct chase plans a 3D route');
    assert.ok(
      path.some((point) => point.y > 3),
      'the route clears the voxel wall',
    );
    for (let i = 0; i < 400; i++) simulation.step();
    assert.equal(simulation.errors.length, 0);
    assert.ok(
      simulation.worldPosition(enemy).distanceTo(simulation.worldPosition(simulation.nodes.get('player')!)) <
        0.6,
      'the enemy reaches the player after routing around the wall',
    );
  } finally {
    simulation.dispose();
  }
});
