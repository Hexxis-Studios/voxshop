import test from 'node:test';
import assert from 'node:assert/strict';
import {
  componentSchema,
  constructionPaintSchema,
  identityTransform,
  newProject,
  nodeSchema,
  validateProject,
} from '../services/projectDocument';
import { viewportCommandSchema } from '../services/viewportProtocol';
import {
  GAME_PROGRESS_VERSION,
  parseGameProgress,
  serializeGameProgress,
  type GameProgressSnapshot,
} from '../runtime/gameProgress';

const paint = { id: 'stone', name: 'Stone', color: 0x918b7d, materialType: 'METALLIC' as const };

function projectWithPalette(palette: unknown, extra: Record<string, unknown> = {}) {
  const project = newProject('palette-project', 'Palette test');
  project.scenes[0].items = [{ id: 'wood', name: 'Wood', description: '', maxStack: 99 }];
  project.scenes[0].nodes.push(
    nodeSchema.parse({
      id: 'builder',
      name: 'Builder',
      transform: identityTransform(),
      components: [
        { type: 'player', style: 'third-person', speed: 3 },
        { type: 'construction', ...extra, palette },
      ],
    }),
  );
  return project;
}

function progressSnapshot(): GameProgressSnapshot {
  return {
    version: GAME_PROGRESS_VERSION,
    projectId: 'palette-project',
    sceneId: 'main',
    variables: {},
    inventory: [],
    health: {},
    nodes: {},
    motion: { actors: { player: 0 }, bodies: {} },
    status: 'playing',
  };
}

test('construction paint schema validates rows and keeps the optional palette absent on old components', () => {
  assert.deepEqual(componentSchema.parse({ type: 'construction' }), {
    type: 'construction',
    place: true,
    remove: true,
    range: 6,
    placeCost: [],
    removeYield: [],
  });
  assert.deepEqual(constructionPaintSchema.parse({ ...paint, name: ' Stone ' }), { ...paint, name: 'Stone' });
  const parsedConstruction = componentSchema.parse({ type: 'construction', palette: [paint] });
  if (parsedConstruction.type !== 'construction') throw new Error('Expected construction component.');
  assert.deepEqual(parsedConstruction.palette, [paint]);

  for (const invalid of [
    { ...paint, id: 'bad id' },
    { ...paint, name: ' ' },
    { ...paint, name: 'x'.repeat(121) },
    { ...paint, color: -1 },
    { ...paint, color: 0x1000000 },
    { ...paint, color: 1.5 },
    { ...paint, materialType: 'WOOD' },
  ])
    assert.equal(constructionPaintSchema.safeParse(invalid).success, false);
  assert.equal(
    componentSchema.safeParse({
      type: 'construction',
      palette: Array.from({ length: 33 }, (_, index) => ({ ...paint, id: `paint-${index}` })),
    }).success,
    false,
  );
});

test('project validation rejects duplicate paint IDs but permits duplicate appearances and keeps cell costs', () => {
  const duplicate = projectWithPalette([paint, { ...paint, name: 'Another name' }]);
  assert.throws(() => validateProject(duplicate), /Duplicate construction paint ID/);

  const sharedAppearance = projectWithPalette([paint, { ...paint, id: 'stone-copy' }], {
    placeCost: [{ itemId: 'wood', quantity: 2 }],
    removeYield: [{ itemId: 'wood', quantity: 1 }],
  });
  assert.equal(validateProject(sharedAppearance).scenes[0].nodes.length, 1);
});

test('viewport paint selection is optional and validates a palette ID', () => {
  assert.deepEqual(viewportCommandSchema.parse({ type: 'step', frames: 1, input: { placeCell: true } }), {
    type: 'step',
    frames: 1,
    input: { placeCell: true },
  });
  assert.deepEqual(
    viewportCommandSchema.parse({
      type: 'step',
      frames: 1,
      input: { placeCell: true, constructionPaint: 'stone' },
    }),
    { type: 'step', frames: 1, input: { placeCell: true, constructionPaint: 'stone' } },
  );
  for (const constructionPaint of ['', 'bad id', 'x'.repeat(65)])
    assert.equal(
      viewportCommandSchema.safeParse({ type: 'step', frames: 1, input: { constructionPaint } }).success,
      false,
    );
});

test('progress preserves optional construction paint with legacy behavior and motion', () => {
  const legacy = progressSnapshot();
  assert.deepEqual(parseGameProgress(JSON.stringify(legacy), legacy.projectId, legacy.sceneId), legacy);
  const oldBehavior: GameProgressSnapshot = {
    ...legacy,
    behavior: { patrolTargets: {}, animations: {}, cooldowns: { attack: 0, damage: 0 } },
  };
  assert.deepEqual(
    parseGameProgress(JSON.stringify(oldBehavior), oldBehavior.projectId, oldBehavior.sceneId),
    oldBehavior,
  );

  const withPaint = {
    ...oldBehavior,
    behavior: { ...oldBehavior.behavior!, constructionPaint: 'stone' },
  };
  const serialized = serializeGameProgress(withPaint);
  assert.ok(serialized);
  assert.deepEqual(parseGameProgress(serialized, withPaint.projectId, withPaint.sceneId), withPaint);
  const invalid = { ...withPaint, behavior: { ...withPaint.behavior, constructionPaint: 'bad id' } };
  assert.equal(parseGameProgress(JSON.stringify(invalid), invalid.projectId, invalid.sceneId), null);
});
