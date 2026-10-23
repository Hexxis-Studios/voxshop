import { z } from 'zod';
import { idSchema, vectorSchema } from './projectDocument';

const inputSchema = z
  .object({
    togglePause: z
      .boolean()
      .optional()
      .describe('Toggle transient pause/resume during an agent walkthrough.'),
    moveX: z.number().min(-1).max(1).optional(),
    moveZ: z.number().min(-1).max(1).optional(),
    sprint: z
      .boolean()
      .optional()
      .describe('Hold the configured run speed and running animation while moving.'),
    jump: z.boolean().optional(),
    interact: z.boolean().optional(),
    attack: z.boolean().optional(),
    useItem: idSchema.optional(),
    placeCell: z.boolean().optional(),
    removeCell: z.boolean().optional(),
    constructionPaint: idSchema.optional(),
    uiEventId: idSchema
      .optional()
      .describe('Dispatch one authored HUD event button through matching ui rules.'),
    uiTab: z
      .object({ groupId: idSchema, tabId: idSchema })
      .optional()
      .describe('Select a tab in the active scene HUD before capturing the walkthrough frame.'),
  })
  .superRefine((input, context) => {
    if (input.placeCell && input.removeCell)
      context.addIssue({
        code: 'custom',
        message: 'Place and remove cannot be requested in the same Play step.',
      });
  });
const stepSchema = z.object({ frames: z.number().int().min(1).max(600), input: inputSchema });
const queryFilterFields = {
  includeSensors: z.boolean().default(false),
  excludeNodeIds: z.array(idSchema).max(128).default([]),
};
const queryDimension = z.number().finite().positive().max(1000);
const queryRotationComponent = z.number().finite().min(-1).max(1);
const queryRotation = z.tuple([
  queryRotationComponent,
  queryRotationComponent,
  queryRotationComponent,
  queryRotationComponent,
]);
const physicsQueryVariantSchema = z.discriminatedUnion('shape', [
  z.object({
    shape: z.literal('ray'),
    origin: vectorSchema,
    direction: vectorSchema,
    maxDistance: z.number().finite().positive().max(10_000),
    ...queryFilterFields,
  }),
  z.object({
    shape: z.literal('shape-cast'),
    castShape: z.discriminatedUnion('shape', [
      z.object({
        shape: z.literal('box'),
        size: z.tuple([queryDimension, queryDimension, queryDimension]),
        rotation: queryRotation.default([0, 0, 0, 1]),
      }),
      z.object({ shape: z.literal('sphere'), radius: queryDimension }),
      z.object({
        shape: z.literal('capsule'),
        radius: queryDimension,
        halfHeight: z.number().finite().min(0).max(1000),
        rotation: queryRotation.default([0, 0, 0, 1]),
      }),
    ]),
    position: vectorSchema,
    direction: vectorSchema,
    maxDistance: z.number().finite().positive().max(10_000),
    ...queryFilterFields,
  }),
  z.object({
    shape: z.literal('box'),
    position: vectorSchema,
    size: z.tuple([queryDimension, queryDimension, queryDimension]),
    rotation: queryRotation.default([0, 0, 0, 1]),
    ...queryFilterFields,
  }),
  z.object({
    shape: z.literal('sphere'),
    position: vectorSchema,
    radius: queryDimension,
    ...queryFilterFields,
  }),
  z.object({
    shape: z.literal('capsule'),
    position: vectorSchema,
    radius: queryDimension,
    halfHeight: z.number().finite().min(0).max(1000),
    rotation: queryRotation.default([0, 0, 0, 1]),
    ...queryFilterFields,
  }),
]);
export const physicsQuerySchema = physicsQueryVariantSchema.superRefine((query, context) => {
  if (
    (query.shape === 'ray' || query.shape === 'shape-cast') &&
    query.direction.every((value) => Math.abs(value) < 1e-8)
  )
    context.addIssue({ code: 'custom', path: ['direction'], message: 'Query direction must be nonzero.' });
  const rotation =
    query.shape === 'shape-cast'
      ? query.castShape.shape === 'box' || query.castShape.shape === 'capsule'
        ? query.castShape.rotation
        : null
      : query.shape === 'box' || query.shape === 'capsule'
        ? query.rotation
        : null;
  if (rotation && rotation.every((value) => Math.abs(value) < 1e-8))
    context.addIssue({ code: 'custom', path: ['rotation'], message: 'Rotation quaternion must be nonzero.' });
});
export type PhysicsQuery = z.infer<typeof physicsQuerySchema>;

export const viewportCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('capture') }),
  z.object({ type: z.literal('play') }),
  z.object({ type: z.literal('stop') }),
  z.object({ type: z.literal('focus'), nodeId: idSchema }),
  z
    .object({ type: z.literal('physics-query'), queries: z.array(physicsQuerySchema).min(1).max(16) })
    .describe(
      'Run up to 16 read-only raycasts, box/sphere/capsule shape casts, or box/sphere/capsule overlap queries against the active Play physics scene. Queries do not advance simulation or mutate project data.',
    ),
  z
    .object({
      type: z.literal('benchmark'),
      frames: z.number().int().min(30).max(300),
      occlusionCullingEnabled: z
        .boolean()
        .optional()
        .describe(
          'Temporarily set occlusion culling for this benchmark; the previous setting is restored afterward.',
        ),
    })
    .describe(
      'Measure bounded active viewport frames. Reports requestAnimationFrame cadence, renderer call count and synchronous call time, WebGL GPU timer samples when supported, renderer identity, draw counts and culling/world stats. Optionally set occlusion culling on or off for a same-scene comparison; the previous setting is restored after measurement.',
    ),
  z.object({
    type: z.literal('sequence'),
    steps: z
      .array(stepSchema)
      .min(1)
      .max(128)
      .refine(
        (steps) => steps.reduce((total, step) => total + step.frames, 0) <= 600,
        'A walkthrough command supports at most 600 simulated frames.',
      ),
  }),
  z.object({ type: z.literal('camera'), position: vectorSchema, target: vectorSchema }),
  z.object({ type: z.literal('step'), ...stepSchema.shape }),
]);
export const viewportRequestSchema = z.object({
  projectId: idSchema,
  expectedRevision: z.number().int().nonnegative(),
  clientId: idSchema.optional(),
  command: viewportCommandSchema,
});
export type ViewportRequest = z.infer<typeof viewportRequestSchema> & { id: string; clientId: string };
export type ViewportCommand = z.infer<typeof viewportCommandSchema>;
export const viewportResponseSchema = z.object({
  id: idSchema,
  clientId: idSchema,
  projectId: idSchema,
  revision: z.number().int().nonnegative(),
  error: z.string().max(2000).optional(),
  image: z
    .string()
    .max(12 * 1024 * 1024)
    .regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/)
    .refine((image) => image.startsWith('data:image/png;base64,iVBORw0KGgo'), 'Expected PNG image data.')
    .optional(),
  observation: z.record(z.string(), z.unknown()).optional(),
});
