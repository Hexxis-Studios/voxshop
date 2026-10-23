import test from 'node:test';
import assert from 'node:assert/strict';
import { Box3, Vector3 } from 'three';
import { SpatialIndex } from '../runtime/SpatialIndex';
import { GameSimulation } from '../runtime/GameSimulation';
import { createExample, exampleTests } from '../services/examples';
import { nodeSchema } from '../services/projectDocument';

test('broad phase retains every intersecting box across negatives, boundaries, moving and oversized entries', () => {
  const index = new SpatialIndex(8),
    boxes = new Map<string, Box3>();
  for (let i = 0; i < 500; i++) {
    const position = new Vector3(((i * 17) % 127) - 64, 0, ((i * 29) % 127) - 64);
    const box = new Box3(position, position.clone().addScalar((i % 7) + 1));
    boxes.set(String(i), box);
    index.set(String(i), box);
  }
  boxes.set('large', new Box3(new Vector3(-10000, -1, -10000), new Vector3(10000, 1, 10000)));
  index.set('large', boxes.get('large')!);
  for (let i = 0; i < 50; i++) {
    const query = new Box3(new Vector3(i - 25, -1, i - 25), new Vector3(i - 20, 2, i - 20));
    const candidates = index.query(query);
    for (const [id, box] of boxes) if (box.intersectsBox(query)) assert.ok(candidates.has(id), id);
  }
  index.set('0', new Box3(new Vector3(200, 0, 200), new Vector3(201, 1, 201)));
  assert.ok(!index.query(boxes.get('0')!).has('0'));
  index.delete('large');
  assert.ok(!index.query(boxes.get('large')!).has('large'));
});

test('same-cell refresh keeps membership and crossing a cell removes the old membership', () => {
  const index = new SpatialIndex(8),
    box = new Box3(new Vector3(1, 0, 1), new Vector3(2, 1, 2)),
    sameCellQuery = new Box3(new Vector3(5, 0, 1), new Vector3(6, 1, 2)),
    oldCellQuery = box.clone(),
    nextCell = new Box3(new Vector3(9, 0, 1), new Vector3(10, 1, 2));
  index.set('moving', box);
  for (let i = 0; i < 100; i++) index.set('moving', sameCellQuery);
  assert.ok(index.query(sameCellQuery).has('moving'));

  index.set('moving', nextCell);
  assert.ok(index.query(nextCell).has('moving'));
  assert.ok(!index.query(oldCellQuery).has('moving'));
});

test('indexed collisions match exhaustive checks while avoiding distant colliders', () => {
  const project = createExample('exploration', 'spatial-check');
  for (let i = 0; i < 1000; i++)
    project.scenes[0].nodes.push(
      nodeSchema.parse({
        id: `distant-${i}`,
        name: 'Distant wall',
        transform: { position: [100 + i * 2, 0, 100] },
        components: [{ type: 'collider', size: [1, 2, 1], offset: [0, 1, 0], solid: true }],
      }),
    );
  const fast = new GameSimulation(project),
    exhaustive = new GameSimulation(project);
  (exhaustive as any).nearbySolids = () => [...exhaustive.nodes.values()];
  let fastBounds = 0,
    slowBounds = 0;
  for (const [sim, increment] of [
    [fast, () => fastBounds++],
    [exhaustive, () => slowBounds++],
  ] as const) {
    const original = sim.bounds.bind(sim);
    sim.bounds = (node) => {
      increment();
      return original(node);
    };
  }
  for (const step of exampleTests.exploration.steps)
    for (let i = 0; i < step.frames; i++) {
      fast.step(step.input);
      exhaustive.step(step.input);
    }
  assert.deepEqual(fast.inspect(), exhaustive.inspect());
  assert.equal(fast.status, 'won');
  assert.ok(fastBounds < slowBounds / 10, `${fastBounds} vs ${slowBounds} bounds checks`);
});
