import { z } from 'zod';
import { GameSession } from './GameSession';
import { idSchema, vectorSchema, type ProjectDocument } from '../services/projectDocument';
import { worldEditSchema } from '../services/worldDocument';
const healthAssertionSchema = z
  .object({
    type: z.literal('health'),
    nodeId: idSchema,
    minimum: z.number().finite().min(0).max(100000).optional(),
    maximum: z.number().finite().min(0).max(100000).optional(),
  })
  .refine((assertion) => assertion.minimum !== undefined || assertion.maximum !== undefined, {
    message: 'A health assertion needs a minimum or maximum.',
  })
  .refine(
    (assertion) =>
      assertion.minimum === undefined ||
      assertion.maximum === undefined ||
      assertion.minimum <= assertion.maximum,
    { message: 'Health assertion minimum must not exceed its maximum.' },
  );
export const playtestSchema = z.object({
  sceneId: idSchema,
  steps: z
    .array(
      z.object({
        frames: z.number().int().min(1).max(3600),
        terrainEdit: worldEditSchema
          .describe(
            'Attempt one player terrain edit before this step; construction permissions and costs apply.',
          )
          .optional(),
        input: z
          .object({
            togglePause: z.boolean().optional(),
            moveX: z.number().min(-1).max(1).optional(),
            moveZ: z.number().min(-1).max(1).optional(),
            sprint: z.boolean().optional(),
            jump: z.boolean().optional(),
            interact: z.boolean().optional(),
            attack: z.boolean().optional(),
            useItem: idSchema.optional(),
            constructionPaint: idSchema.optional(),
            uiEventId: idSchema.optional(),
          })
          .default({}),
      }),
    )
    .max(256),
  assertions: z
    .array(
      z.discriminatedUnion('type', [
        z.object({ type: z.literal('status'), equals: z.enum(['playing', 'won', 'lost', 'stopped']) }),
        z.object({ type: z.literal('paused'), equals: z.boolean() }),
        z.object({ type: z.literal('variable'), name: idSchema, minimum: z.number().finite() }),
        z.object({
          type: z.literal('position'),
          nodeId: idSchema,
          near: vectorSchema,
          tolerance: z.number().positive().max(100),
        }),
        z.object({ type: z.literal('enabled'), nodeId: idSchema, equals: z.boolean() }),
        z.object({
          type: z.literal('equipment'),
          nodeId: idSchema,
          assetId: idSchema,
          equipped: z.boolean(),
        }),
        z.object({ type: z.literal('no-errors') }),
        z.object({ type: z.literal('terrain-cell'), ...worldEditSchema.shape }),
        z.object({ type: z.literal('construction-paint'), equals: idSchema }),
        z.object({ type: z.literal('active-scene'), equals: idSchema }),
        z.object({ type: z.literal('objective'), objectiveId: idSchema, equals: z.boolean() }),
        z.object({
          type: z.literal('inventory'),
          itemId: idSchema,
          equals: z.number().int().min(0).max(1000000),
        }),
        healthAssertionSchema,
        z.object({ type: z.literal('scene-path'), equals: z.array(idSchema).min(1).max(64) }),
      ]),
    )
    .max(100)
    .default([{ type: 'no-errors' }]),
});
export async function runPlaytest(project: ProjectDocument, input: unknown, signal?: AbortSignal) {
  const spec = playtestSchema.parse(input);
  if (spec.steps.reduce((n, s) => n + s.frames, 0) > 18000)
    throw new Error('Playtest exceeds 18,000 frames (five simulated minutes).');
  const session = new GameSession(project, spec.sceneId);
  const started = performance.now();
  try {
    await session.ready;
    signal?.throwIfAborted();
    for (const step of spec.steps) {
      const { constructionPaint, ...simulationInput } = step.input;
      if (
        !step.input.togglePause &&
        constructionPaint !== undefined &&
        session.simulation.status === 'playing' &&
        !session.simulation.selectConstructionPaint(constructionPaint)
      )
        throw new Error(session.simulation.message);
      if (step.terrainEdit && !step.input.togglePause) {
        await session.ready;
        signal?.throwIfAborted();
        session.simulation.editTerrain(step.terrainEdit);
      }
      for (let i = 0; i < step.frames; i++) {
        signal?.throwIfAborted();
        session.step(
          i === 0 ? simulationInput : { ...simulationInput, uiEventId: undefined, togglePause: undefined },
        );
      }
    }
    await session.ready;
    const state = session.simulation.inspect();
    const assertions = spec.assertions.map((a) => {
      let passed = false;
      let expected: unknown;
      let actual: unknown;
      if (a.type === 'status') {
        expected = { status: a.equals };
        actual = state.status;
        passed = actual === a.equals;
      }
      if (a.type === 'paused') {
        expected = { paused: a.equals };
        actual = state.paused;
        passed = actual === a.equals;
      }
      if (a.type === 'variable') {
        const value = state.variables[a.name] ?? 0;
        expected = { name: a.name, minimum: a.minimum };
        actual = value;
        passed = value >= a.minimum;
      }
      if (a.type === 'enabled') {
        expected = { nodeId: a.nodeId, enabled: a.equals };
        actual = state.nodes.find((n) => n.id === a.nodeId)?.enabled ?? null;
        passed = actual === a.equals;
      }
      if (a.type === 'equipment') {
        expected = { nodeId: a.nodeId, assetId: a.assetId, equipped: a.equipped };
        const node = session.simulation.nodes.get(a.nodeId);
        actual = node?.attachments.some((attachment) => attachment.assetId === a.assetId) ?? null;
        passed = actual === a.equipped;
      }
      if (a.type === 'no-errors') {
        expected = [];
        actual = state.errors;
        passed = state.errors.length === 0;
      }
      if (a.type === 'construction-paint') {
        expected = a.equals;
        actual = state.construction?.selectedId ?? null;
        passed = actual === a.equals;
      }
      if (a.type === 'position') {
        const n = state.nodes.find((n) => n.id === a.nodeId);
        expected = { nodeId: a.nodeId, near: a.near, tolerance: a.tolerance };
        actual = n?.position ?? null;
        passed = !!n && Math.hypot(...n.position.map((p, i) => p - a.near[i])) <= a.tolerance;
      }
      if (a.type === 'active-scene') {
        expected = a.equals;
        actual = state.sceneId;
        passed = actual === a.equals;
      }
      if (a.type === 'objective') {
        expected = { objectiveId: a.objectiveId, completed: a.equals };
        actual = state.objectives.find((objective) => objective.id === a.objectiveId)?.completed ?? null;
        passed = actual === a.equals;
      }
      if (a.type === 'inventory') {
        expected = { itemId: a.itemId, quantity: a.equals };
        actual = session.simulation.items.has(a.itemId)
          ? state.inventory.reduce(
              (total, stack) => total + (stack.itemId === a.itemId ? stack.quantity : 0),
              0,
            )
          : null;
        passed = actual === a.equals;
      }
      if (a.type === 'health') {
        expected = {
          nodeId: a.nodeId,
          ...(a.minimum !== undefined ? { minimum: a.minimum } : {}),
          ...(a.maximum !== undefined ? { maximum: a.maximum } : {}),
        };
        actual = state.health[a.nodeId] ?? null;
        passed =
          typeof actual === 'number' &&
          (a.minimum === undefined || actual >= a.minimum) &&
          (a.maximum === undefined || actual <= a.maximum);
      }
      if (a.type === 'terrain-cell') {
        const cell = session.simulation.inspectTerrainCell(a);
        expected = { x: a.x, y: a.y, z: a.z, value: a.value };
        actual = { x: a.x, y: a.y, z: a.z, value: cell ?? null, inBounds: cell !== undefined };
        passed =
          cell !== undefined &&
          (a.value === null
            ? cell === null
            : cell !== null && cell.color === a.value.color && cell.materialType === a.value.materialType);
      }
      if (a.type === 'scene-path') {
        const path = [...session.scenePath];
        expected = a.equals;
        actual = path;
        passed =
          path.length === a.equals.length && path.every((sceneId, index) => sceneId === a.equals[index]);
      }
      return {
        assertion: a,
        passed,
        expected,
        actual,
        ...(!passed
          ? { message: `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.` }
          : {}),
      };
    });
    return {
      projectId: project.id,
      revision: project.revision,
      sceneId: spec.sceneId,
      activeSceneId: state.sceneId,
      scenePath: [...session.scenePath],
      passed: assertions.every((a) => a.passed),
      elapsedMs: performance.now() - started,
      assertions,
      state,
    };
  } finally {
    session.dispose();
  }
}
