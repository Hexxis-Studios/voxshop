import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  multiplayerIdSchema,
  multiplayerPlayerSnapshotSchema,
  multiplayerProjectBindingSchema,
  multiplayerGameStateSchema,
  multiplayerServerTickSchema,
  MULTIPLAYER_MAX_PLAYERS,
} from '../services/multiplayerProtocol';

const storedPlayerSchema = z
  .object({
    playerId: multiplayerIdSchema,
    credentialHash: z.string().regex(/^[a-f0-9]{64}$/),
    expiresAt: z.number().int().positive().nullable(),
    lastAcceptedSequence: z.number().int().min(-1).max(2_147_483_647),
    lastTickSequence: z.number().int().min(0).max(2_147_483_647).optional(),
  })
  .strict();

const storedSnapshotSchema = z
  .object({
    version: z.literal(1),
    type: z.literal('snapshot'),
    serverTick: multiplayerServerTickSchema,
    players: z.array(multiplayerPlayerSnapshotSchema).max(MULTIPLAYER_MAX_PLAYERS),
    game: multiplayerGameStateSchema.optional(),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const playerIds = new Set<string>();
    for (const [index, player] of snapshot.players.entries()) {
      if (playerIds.has(player.playerId))
        context.addIssue({
          code: 'custom',
          path: ['players', index, 'playerId'],
          message: 'Snapshot player IDs must be unique.',
        });
      playerIds.add(player.playerId);
    }
  });

const storedRoomSchema = z
  .object({
    gameId: multiplayerIdSchema,
    projectBinding: multiplayerProjectBindingSchema.optional(),
    credentialHash: z.string().regex(/^[a-f0-9]{64}$/),
    maxPlayers: z.number().int().min(1).max(MULTIPLAYER_MAX_PLAYERS),
    nextPlayerNumber: z.number().int().min(1).max(2_147_483_648),
    lastServerTick: z.number().int().min(-1).max(2_147_483_647),
    players: z.array(storedPlayerSchema).max(MULTIPLAYER_MAX_PLAYERS),
    lastSnapshot: storedSnapshotSchema.nullable(),
  })
  .strict()
  .superRefine((room, context) => {
    if (room.players.length > room.maxPlayers)
      context.addIssue({ code: 'custom', message: 'Stored player count exceeds room capacity.' });
    const playerIds = new Set<string>();
    for (const [index, player] of room.players.entries()) {
      if (playerIds.has(player.playerId))
        context.addIssue({
          code: 'custom',
          path: ['players', index, 'playerId'],
          message: 'Stored player IDs must be unique within a room.',
        });
      playerIds.add(player.playerId);
    }
    if (room.lastSnapshot && room.lastSnapshot.serverTick !== room.lastServerTick)
      context.addIssue({ code: 'custom', path: ['lastSnapshot'], message: 'Snapshot tick mismatch.' });
  });

export const multiplayerPersistenceSchema = z
  .object({ version: z.literal(1), rooms: z.array(storedRoomSchema).max(128) })
  .strict()
  .superRefine((state, context) => {
    const roomIds = new Set<string>();
    for (const [index, room] of state.rooms.entries()) {
      if (roomIds.has(room.gameId))
        context.addIssue({
          code: 'custom',
          path: ['rooms', index, 'gameId'],
          message: 'Stored room IDs must be unique.',
        });
      roomIds.add(room.gameId);
    }
  });

export type PersistedMultiplayerRoom = z.infer<typeof storedRoomSchema>;
export type MultiplayerPersistence = z.infer<typeof multiplayerPersistenceSchema>;

export async function loadMultiplayerPersistence(filename: string): Promise<MultiplayerPersistence> {
  try {
    return multiplayerPersistenceSchema.parse(JSON.parse(await fs.readFile(filename, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, rooms: [] };
    throw new Error('VoxShop multiplayer state is unreadable; it was left intact for recovery.', {
      cause: error,
    });
  }
}

export async function saveMultiplayerPersistence(filename: string, value: MultiplayerPersistence) {
  const state = multiplayerPersistenceSchema.parse(value);
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    const file = await fs.open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(state));
      await file.sync();
    } finally {
      await file.close();
    }
    await fs.rename(temporary, filename);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}
