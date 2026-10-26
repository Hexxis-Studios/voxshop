import { z } from 'zod';
import { attachmentSchema, nodeSchema, transformSchema } from './projectDocument';
import { worldEditSchema } from './worldDocument';

/** Version 1 wire boundary shared by the WebSocket transport and host simulation bridge. */
export const MULTIPLAYER_PROTOCOL_VERSION = 1 as const;
export const MULTIPLAYER_MAX_PLAYERS = 128;
export const MULTIPLAYER_MAX_GAME_NODES = 10_128;
export const MULTIPLAYER_MAX_TERRAIN_EDITS = 10_000;

export const multiplayerIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
const tickSchema = z.number().int().nonnegative().max(2_147_483_647);
const nextInputSequenceSchema = z.number().int().nonnegative().max(2_147_483_648);
export const multiplayerProjectBindingSchema = z
  .object({
    projectId: multiplayerIdSchema,
    revision: z.number().int().nonnegative().max(2_147_483_647),
    sceneId: multiplayerIdSchema,
  })
  .strict();
export type MultiplayerProjectBinding = z.infer<typeof multiplayerProjectBindingSchema>;
const axisSchema = z.number().finite().min(-1).max(1);
const coordinateSchema = z.number().finite().min(-100_000).max(100_000);
const vectorSchema = z.tuple([coordinateSchema, coordinateSchema, coordinateSchema]);
export const multiplayerServerTickSchema = tickSchema;
export const multiplayerPlayerSnapshotSchema = z
  .object({
    playerId: multiplayerIdSchema,
    position: vectorSchema,
    rotation: vectorSchema,
    velocity: vectorSchema,
    health: z.number().finite().nonnegative().max(100_000),
    maxHealth: z.number().finite().positive().max(100_000),
  })
  .strict()
  .refine((player) => player.health <= player.maxHealth, 'Player health cannot exceed maxHealth.');
export type MultiplayerPlayerSnapshot = z.infer<typeof multiplayerPlayerSnapshotSchema>;
const inventoryStackSchema = z
  .object({ itemId: multiplayerIdSchema, quantity: z.number().int().min(1).max(9999) })
  .strict();
const terrainEditIntentSchema = worldEditSchema
  .extend({
    x: coordinateSchema,
    y: coordinateSchema,
    z: coordinateSchema,
  })
  .strict();
const variableStateSchema = z.record(multiplayerIdSchema, z.number().finite().min(-1e12).max(1e12));
export const multiplayerGameNodeSchema = z
  .object({
    nodeId: multiplayerIdSchema,
    playerId: multiplayerIdSchema.optional(),
    transform: transformSchema,
    enabled: z.boolean(),
    attachments: z.array(attachmentSchema).max(16),
    health: z.number().finite().nonnegative().max(100_000).optional(),
    maxHealth: z.number().finite().positive().max(100_000).optional(),
    animation: z
      .object({ clip: multiplayerIdSchema, time: z.number().finite().min(0).max(1e9) })
      .strict()
      .optional(),
    runtimeNode: nodeSchema.optional(),
  })
  .strict()
  .refine((node) => !node.runtimeNode || node.runtimeNode.id === node.nodeId);
export const multiplayerGamePlayerSchema = z
  .object({
    playerId: multiplayerIdSchema,
    nodeId: multiplayerIdSchema,
    connected: z.boolean(),
    health: z.number().finite().nonnegative().max(100_000),
    maxHealth: z.number().finite().positive().max(100_000),
    inventory: z.array(inventoryStackSchema).max(128),
    constructionPaint: multiplayerIdSchema.optional(),
    attackCooldown: z.number().finite().min(0).max(60),
    damageCooldown: z.number().finite().min(0).max(60),
  })
  .strict()
  .refine((player) => player.health <= player.maxHealth);
export const multiplayerGameStateSchema = z
  .object({
    version: z.literal(1),
    projectId: multiplayerIdSchema,
    revision: z.number().int().nonnegative().max(2_147_483_647),
    entrySceneId: multiplayerIdSchema.optional(),
    sceneId: multiplayerIdSchema,
    frame: tickSchema,
    seconds: z.number().finite().min(0).max(1e9),
    status: z.enum(['playing', 'won', 'lost', 'stopped']),
    paused: z.boolean(),
    message: z.string().max(4096),
    variables: variableStateSchema,
    campaignVariables: variableStateSchema,
    terrainEdits: z.array(terrainEditIntentSchema).max(MULTIPLAYER_MAX_TERRAIN_EDITS),
    firedRules: z.array(z.string().min(1).max(128)).max(50_000),
    tickDeadlines: z
      .record(z.string().min(1).max(128), z.number().finite().min(0).max(1e9))
      .refine((value) => Object.keys(value).length <= 50_000),
    nodes: z.array(multiplayerGameNodeSchema).max(MULTIPLAYER_MAX_GAME_NODES),
    players: z.array(multiplayerGamePlayerSchema).max(MULTIPLAYER_MAX_PLAYERS),
    objectives: z
      .array(
        z
          .object({
            playerId: multiplayerIdSchema,
            id: multiplayerIdSchema,
            current: z.number().finite().min(-1e12).max(1e12),
            available: z.boolean(),
            completed: z.boolean(),
          })
          .strict(),
      )
      .max(16 * MULTIPLAYER_MAX_PLAYERS),
    events: z
      .array(
        z
          .object({
            frame: tickSchema,
            type: z.string().min(1).max(64),
            nodeId: multiplayerIdSchema.optional(),
            data: z.union([
              z.string().max(4096),
              z
                .record(
                  z.string().max(64),
                  z.union([z.string().max(1024), z.number().finite(), z.boolean(), z.null()]),
                )
                .refine((value) => Object.keys(value).length <= 32),
            ]).optional(),
          })
          .strict(),
      )
      .max(200),
  })
  .strict()
  .superRefine((game, context) => {
    const nodeIds = new Set<string>();
    game.nodes.forEach((node, index) => {
      if (nodeIds.has(node.nodeId))
        context.addIssue({
          code: 'custom',
          path: ['nodes', index, 'nodeId'],
          message: 'Game node IDs must be unique.',
        });
      nodeIds.add(node.nodeId);
    });
    const playerIds = new Set<string>();
    game.players.forEach((player, index) => {
      if (playerIds.has(player.playerId))
        context.addIssue({
          code: 'custom',
          path: ['players', index, 'playerId'],
          message: 'Game player IDs must be unique.',
        });
      playerIds.add(player.playerId);
      if (!nodeIds.has(player.nodeId))
        context.addIssue({
          code: 'custom',
          path: ['players', index, 'nodeId'],
          message: 'Each game player must refer to a snapshot node.',
        });
    });
  });
export type MultiplayerGameState = z.infer<typeof multiplayerGameStateSchema>;
const envelope = { version: z.literal(MULTIPLAYER_PROTOCOL_VERSION) };
const roomCredentialSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

// Inputs are intentions only. Interactions and attacks omit targets so the
// authoritative simulation resolves targets and validates inventory/state.
const gameplayInputSchema = z
  .object({
    moveX: axisSchema.optional(),
    moveZ: axisSchema.optional(),
    lookX: axisSchema.optional(),
    lookY: axisSchema.optional(),
    sprint: z.boolean().optional(),
    jump: z.boolean().optional(),
    interact: z.boolean().optional(),
    attack: z.boolean().optional(),
    useItem: multiplayerIdSchema.optional(),
    uiEventId: multiplayerIdSchema.optional(),
    constructionPaint: multiplayerIdSchema.optional(),
    inventoryMove: z
      .object({
        fromIndex: z.number().int().min(0).max(127),
        toIndex: z.number().int().min(0).max(127),
      })
      .strict()
      .optional(),
    inventorySort: z.boolean().optional(),
    terrainEdit: terrainEditIntentSchema.optional(),
  })
  .strict();

export const clientMessageSchema = z.discriminatedUnion('type', [
  z
    .object({
      ...envelope,
      type: z.literal('join'),
      gameId: multiplayerIdSchema,
      credential: roomCredentialSchema.optional(),
      reconnect: z.boolean().optional(),
      resumeCredential: roomCredentialSchema.optional(),
    })
    .strict()
    .refine((message) => !!message.credential || !!message.resumeCredential, {
      message: 'Room credential or resume credential is required.',
      path: ['credential'],
    }),
  z
    .object({
      ...envelope,
      type: z.literal('input'),
      sequence: tickSchema,
      input: gameplayInputSchema,
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal('leave'),
      reason: z.enum(['user-request', 'disconnect']).optional(),
    })
    .strict(),
]);

export const serverMessageSchema = z.discriminatedUnion('type', [
  z
    .object({
      ...envelope,
      type: z.literal('joined'),
      gameId: multiplayerIdSchema,
      playerId: multiplayerIdSchema,
      resumeCredential: roomCredentialSchema.optional(),
      nextInputSequence: nextInputSequenceSchema.optional(),
    })
    .strict(),
  z.object({ ...envelope, type: z.literal('queued'), inputSequence: tickSchema }).strict(),
  z
    .object({
      ...envelope,
      type: z.literal('error'),
      code: z.enum([
        'join-required',
        'unknown-room',
        'invalid-credential',
        'invalid-message',
        'wrong-room',
        'already-joined',
        'not-joined',
        'room-full',
        'stale-sequence',
        'input-queue-full',
      ]),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal('ack'),
      inputSequence: tickSchema,
      serverTick: tickSchema,
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal('snapshot'),
      serverTick: tickSchema,
      players: z.array(multiplayerPlayerSnapshotSchema).max(MULTIPLAYER_MAX_PLAYERS),
      game: multiplayerGameStateSchema.optional(),
    })
    .strict()
    .superRefine((snapshot, context) => {
      const playerIds = new Set<string>();
      snapshot.players.forEach((player, index) => {
        if (playerIds.has(player.playerId))
          context.addIssue({
            code: 'custom',
            path: ['players', index, 'playerId'],
            message: 'Player IDs must be unique within a snapshot.',
          });
        playerIds.add(player.playerId);
      });
    }),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type ServerMessage = z.infer<typeof serverMessageSchema>;

export const parseClientMessage = (value: unknown): ClientMessage => clientMessageSchema.parse(value);
export const parseServerMessage = (value: unknown): ServerMessage => serverMessageSchema.parse(value);
