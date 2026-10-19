import { z } from 'zod';
import { GameSimulation } from './GameSimulation';
import { idSchema, vectorSchema, type ProjectDocument } from '../services/projectDocument';
export const playtestSchema = z.object({
  sceneId: idSchema,
  steps: z
    .array(
      z.object({
        frames: z.number().int().min(1).max(3600),
        input: z
          .object({
            moveX: z.number().min(-1).max(1).optional(),
            moveZ: z.number().min(-1).max(1).optional(),
            jump: z.boolean().optional(),
            interact: z.boolean().optional(),
            attack: z.boolean().optional(),
          })
          .default({}),
      }),
    )
    .max(256),
  assertions: z
    .array(
      z.discriminatedUnion('type', [
        z.object({ type: z.literal('status'), equals: z.enum(['playing', 'won', 'lost', 'stopped']) }),
        z.object({ type: z.literal('variable'), name: idSchema, minimum: z.number().finite() }),
        z.object({
          type: z.literal('position'),
          nodeId: idSchema,
          near: vectorSchema,
          tolerance: z.number().positive().max(100),
        }),
        z.object({ type: z.literal('enabled'), nodeId: idSchema, equals: z.boolean() }),
        z.object({ type: z.literal('no-errors') }),
      ]),
    )
    .max(100)
    .default([{ type: 'no-errors' }]),
});
export function runPlaytest(project: ProjectDocument, input: unknown, signal?: AbortSignal) {
  const spec = playtestSchema.parse(input);
  if (spec.steps.reduce((n, s) => n + s.frames, 0) > 18000)
    throw new Error('Playtest exceeds 18,000 frames (five simulated minutes).');
  const simulation = new GameSimulation(project, spec.sceneId);
  const started = performance.now();
  for (const step of spec.steps)
    for (let i = 0; i < step.frames; i++) {
      signal?.throwIfAborted();
      simulation.step(step.input);
    }
  const state = simulation.inspect();
  const assertions = spec.assertions.map((a) => {
    let passed = false;
    if (a.type === 'status') passed = state.status === a.equals;
    if (a.type === 'variable') passed = (state.variables[a.name] ?? 0) >= a.minimum;
    if (a.type === 'enabled') passed = state.nodes.find((n) => n.id === a.nodeId)?.enabled === a.equals;
    if (a.type === 'no-errors') passed = state.errors.length === 0;
    if (a.type === 'position') {
      const n = state.nodes.find((n) => n.id === a.nodeId);
      passed = !!n && Math.hypot(...n.position.map((p, i) => p - a.near[i])) <= a.tolerance;
    }
    return { assertion: a, passed };
  });
  return {
    projectId: project.id,
    revision: project.revision,
    sceneId: spec.sceneId,
    passed: assertions.every((a) => a.passed),
    elapsedMs: performance.now() - started,
    assertions,
    state,
  };
}
