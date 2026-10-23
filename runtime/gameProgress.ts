/** Browser-local progress format for standalone games. Keep this module free of editor/server imports. */
export const GAME_PROGRESS_VERSION = 1;
export const MAX_GAME_PROGRESS_BYTES = 256 * 1024;
export const MAX_GAME_WORLD_EDITS = 10_000;
const MAX_PROGRESS_ENTRIES = 5000;
const MAX_PHYSICS_ENTRIES = 100_000;
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export type GameProgressAttachment = {
  assetId: string;
  socket: string;
  slot: string;
  transform: {
    position: [number, number, number];
    rotation: [number, number, number];
    scale: [number, number, number];
  };
  hiddenBones: string[];
};

export type GameProgressNode = {
  transform?: {
    position?: [number, number, number];
    rotation?: [number, number, number];
    scale?: [number, number, number];
  };
  enabled?: boolean;
  attachments?: GameProgressAttachment[];
};

export type GameProgressTerrainEdit = {
  x: number;
  y: number;
  z: number;
  value: { color: number; materialType: 'STANDARD' | 'METALLIC' | 'GLASS' | 'EMISSIVE' } | null;
};
export type GameProgressTerrain = {
  worldId: string;
  signature: string;
  edits: GameProgressTerrainEdit[];
};
export type BodyMotion = {
  linearVelocity: [number, number, number];
  angularVelocity: [number, number, number];
  sleeping: boolean;
};
export type GameProgressMotion = {
  actors: Record<string, number>;
  bodies: Record<string, BodyMotion>;
};
/** JSON-safe Rapier solver checkpoint. World bytes use base64 and stay inside the progress size limit. */
export type GameProgressPhysics = {
  format: 1;
  rapierVersion: string;
  compatibilityKey: string;
  world: string;
  bodyHandles: { nodeId: string; handle: number }[];
  colliderHandles: { nodeId: string; handle: number }[];
  jointHandles?: { nodeId: string; handle: number }[];
  terrainBodyHandle?: number;
  terrainColliderHandles?: { key: string; hash: string; handle: number }[];
  worldBodyCount: number;
  worldColliderCount: number;
};
export type GameProgressBehavior = {
  patrolTargets: Record<string, number>;
  animations: Record<string, { clip: string; time: number }>;
  cooldowns: { attack: number; damage: number };
  constructionPaint?: string;
};
export type GameProgressSpawn = {
  prefabId: string;
  signature: string;
  instanceId: string;
  nodeIds: string[];
  rootPosition: [number, number, number];
  rootRotation?: [number, number, number];
  rootScale?: [number, number, number];
};

export type GameProgressSnapshot = {
  version: 1;
  projectId: string;
  sceneId: string;
  variables: Record<string, number>;
  inventory: { itemId: string; quantity: number }[];
  health: Record<string, number>;
  nodes: Record<string, GameProgressNode>;
  spawnedPrefabs?: GameProgressSpawn[];
  terrain?: GameProgressTerrain;
  motion?: GameProgressMotion;
  physics?: GameProgressPhysics;
  behavior?: GameProgressBehavior;
  execution?: {
    frame: number;
    seconds: number;
    firedRules: string[];
    tickDeadlines: Record<string, number>;
  };
  status: 'playing' | 'won' | 'lost';
};

export type ProgressStorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export type ProgressStorageLoadResult<T> =
  { status: 'empty' } | { status: 'loaded'; snapshot: T } | { status: 'invalid' } | { status: 'unavailable' };
export type ProgressLoadResult = ProgressStorageLoadResult<GameProgressSnapshot>;
export type ProgressSaveResult = 'saved' | 'too-large' | 'invalid' | 'unavailable';

export function getBrowserProgressStorage(): ProgressStorageLike | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function progressStorageAvailable(getStorage: () => ProgressStorageLike | null) {
  try {
    return !!getStorage();
  } catch {
    return false;
  }
}

export function loadProgressFromStorage<T>(
  key: string,
  getStorage: () => ProgressStorageLike | null,
  parse: (serialized: string) => T | null,
): ProgressStorageLoadResult<T> {
  let storage: ProgressStorageLike | null;
  let serialized: string | null;
  try {
    storage = getStorage();
    if (!storage) return { status: 'unavailable' };
    serialized = storage.getItem(key);
  } catch {
    return { status: 'unavailable' };
  }
  if (serialized === null) return { status: 'empty' };
  const snapshot = parse(serialized);
  if (snapshot) return { status: 'loaded', snapshot };
  try {
    storage.removeItem(key);
  } catch {
    // Invalid data remains ignored even when browser storage is read-only.
  }
  return { status: 'invalid' };
}

export function clearProgressStorage(key: string, getStorage: () => ProgressStorageLike | null) {
  try {
    const storage = getStorage();
    if (!storage) return false;
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

export function gameProgressStorageKey(projectId: string, sceneId: string) {
  if (
    typeof projectId !== 'string' ||
    typeof sceneId !== 'string' ||
    !idPattern.test(projectId) ||
    !idPattern.test(sceneId)
  )
    throw new Error('Invalid game identity.');
  return `voxshop:game-progress:v${GAME_PROGRESS_VERSION}:${projectId}:${sceneId}`;
}

function finite(value: unknown, limit = 1_000_000_000): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit;
}

function record(value: unknown, maximum = MAX_PROGRESS_ENTRIES): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= maximum && entries.every(([key]) => idPattern.test(key));
}

function vector(value: unknown, limit: number): value is [number, number, number] {
  return Array.isArray(value) && value.length === 3 && value.every((n) => finite(n, limit));
}

function serializedBytes(serialized: string) {
  return new TextEncoder().encode(serialized).byteLength;
}

function parseExecution(value: unknown): GameProgressSnapshot['execution'] | null {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const ruleKey = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}:([0-9]|[1-5][0-9]|6[0-3])$/;
  if (
    Object.keys(raw).some((key) => !['frame', 'seconds', 'firedRules', 'tickDeadlines'].includes(key)) ||
    !Number.isSafeInteger(raw.frame) ||
    (raw.frame as number) < 0 ||
    !finite(raw.seconds, Number.MAX_SAFE_INTEGER) ||
    raw.seconds < 0 ||
    !Array.isArray(raw.firedRules) ||
    raw.firedRules.length > 320_000 ||
    raw.firedRules.some((key) => typeof key !== 'string' || !ruleKey.test(key)) ||
    new Set(raw.firedRules).size !== raw.firedRules.length ||
    !raw.tickDeadlines ||
    typeof raw.tickDeadlines !== 'object' ||
    Array.isArray(raw.tickDeadlines)
  )
    return null;
  const deadlines = Object.entries(raw.tickDeadlines);
  if (
    deadlines.length > 320_000 ||
    deadlines.some(
      ([key, value]) => !ruleKey.test(key) || !finite(value, Number.MAX_SAFE_INTEGER) || value < 0,
    )
  )
    return null;
  return {
    frame: raw.frame as number,
    seconds: raw.seconds,
    firedRules: [...raw.firedRules] as string[],
    tickDeadlines: Object.fromEntries(deadlines) as Record<string, number>,
  };
}

function parseTerrainProgress(value: unknown): GameProgressTerrain | null | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const terrain = value as Record<string, unknown>;
  if (
    Object.keys(terrain).some((key) => !['worldId', 'signature', 'edits'].includes(key)) ||
    typeof terrain.worldId !== 'string' ||
    !idPattern.test(terrain.worldId) ||
    typeof terrain.signature !== 'string' ||
    terrain.signature.length > 16_384 ||
    !Array.isArray(terrain.edits) ||
    terrain.edits.length > MAX_GAME_WORLD_EDITS
  )
    return null;

  const edits: GameProgressTerrainEdit[] = [];
  const coordinates = new Set<string>();
  for (const entry of terrain.edits) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const edit = entry as Record<string, unknown>;
    if (
      Object.keys(edit).some((key) => !['x', 'y', 'z', 'value'].includes(key)) ||
      ![edit.x, edit.y, edit.z].every(
        (coordinate) => Number.isSafeInteger(coordinate) && Math.abs(coordinate as number) <= 1_000_000_000,
      ) ||
      !Object.hasOwn(edit, 'value')
    )
      return null;
    const key = `${edit.x},${edit.y},${edit.z}`;
    if (coordinates.has(key)) return null;
    coordinates.add(key);
    if (edit.value !== null) {
      if (!edit.value || typeof edit.value !== 'object' || Array.isArray(edit.value)) return null;
      const cell = edit.value as Record<string, unknown>;
      if (
        Object.keys(cell).some((field) => !['color', 'materialType'].includes(field)) ||
        !Number.isInteger(cell.color) ||
        (cell.color as number) < 0 ||
        (cell.color as number) > 0xffffff ||
        !['STANDARD', 'METALLIC', 'GLASS', 'EMISSIVE'].includes(String(cell.materialType))
      )
        return null;
      edits.push({
        x: edit.x as number,
        y: edit.y as number,
        z: edit.z as number,
        value: {
          color: cell.color as number,
          materialType: cell.materialType as NonNullable<GameProgressTerrainEdit['value']>['materialType'],
        },
      });
    } else {
      edits.push({ x: edit.x as number, y: edit.y as number, z: edit.z as number, value: null });
    }
  }
  return { worldId: terrain.worldId, signature: terrain.signature, edits };
}

function parseMotion(value: unknown): GameProgressMotion | null | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const motion = value as Record<string, unknown>;
  if (
    Object.keys(motion).some((key) => key !== 'actors' && key !== 'bodies') ||
    !record(motion.actors) ||
    !record(motion.bodies)
  )
    return null;

  const actors: GameProgressMotion['actors'] = {};
  for (const [id, speed] of Object.entries(motion.actors)) {
    if (!finite(speed, 10_000)) return null;
    actors[id] = speed;
  }

  const bodies: GameProgressMotion['bodies'] = {};
  for (const [id, value] of Object.entries(motion.bodies)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const body = value as Record<string, unknown>;
    if (Object.keys(body).some((key) => !['linearVelocity', 'angularVelocity', 'sleeping'].includes(key)))
      return null;
    const linearVelocity = body.linearVelocity;
    const angularVelocity = body.angularVelocity;
    if (
      !vector(linearVelocity, 10_000) ||
      !vector(angularVelocity, 10_000) ||
      typeof body.sleeping !== 'boolean' ||
      (body.sleeping && [...linearVelocity, ...angularVelocity].some((velocity) => velocity !== 0))
    )
      return null;
    bodies[id] = {
      linearVelocity: [...linearVelocity] as [number, number, number],
      angularVelocity: [...angularVelocity] as [number, number, number],
      sleeping: body.sleeping,
    };
  }
  return { actors, bodies };
}

function parsePhysics(value: unknown): GameProgressPhysics | null | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const physics = value as Record<string, unknown>;
  const rapierHandleIndex = (value: unknown): number | null => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
    if (Number.isSafeInteger(value)) return value;
    if (value >= 2 ** -1022) return null;
    const index = value / Number.MIN_VALUE;
    return Number.isSafeInteger(index) && index >= 0 ? index : null;
  };
  const handleRecords = (value: unknown) => {
    if (!Array.isArray(value) || value.length > MAX_PHYSICS_ENTRIES) return null;
    const ids = new Set<string>(),
      handles = new Set<number>();
    const result: GameProgressPhysics['bodyHandles'] = [];
    for (const entry of value) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
      const raw = entry as Record<string, unknown>;
      const handleIndex = rapierHandleIndex(raw.handle);
      if (
        Object.keys(raw).some((key) => key !== 'nodeId' && key !== 'handle') ||
        typeof raw.nodeId !== 'string' ||
        !idPattern.test(raw.nodeId) ||
        handleIndex === null ||
        handleIndex > MAX_PHYSICS_ENTRIES ||
        ids.has(raw.nodeId) ||
        handles.has(raw.handle as number)
      )
        return null;
      ids.add(raw.nodeId);
      handles.add(raw.handle as number);
      result.push({ nodeId: raw.nodeId, handle: raw.handle as number });
    }
    return result;
  };
  const bodyHandles = handleRecords(physics.bodyHandles);
  const colliderHandles = handleRecords(physics.colliderHandles);
  const jointHandles = physics.jointHandles === undefined ? undefined : handleRecords(physics.jointHandles);
  const terrainColliderHandles =
    physics.terrainColliderHandles === undefined
      ? undefined
      : Array.isArray(physics.terrainColliderHandles) &&
          physics.terrainColliderHandles.length <= MAX_PHYSICS_ENTRIES
        ? physics.terrainColliderHandles.map((entry) => {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
            const raw = entry as Record<string, unknown>;
            const handleIndex = rapierHandleIndex(raw.handle);
            if (
              Object.keys(raw).some((key) => !['key', 'hash', 'handle'].includes(key)) ||
              typeof raw.key !== 'string' ||
              !/^[sv]:-?\d+,-?\d+,-?\d+$/.test(raw.key) ||
              typeof raw.hash !== 'string' ||
              !/^[a-f0-9]{16}$/.test(raw.hash) ||
              handleIndex === null ||
              handleIndex > MAX_PHYSICS_ENTRIES
            )
              return null;
            return { key: raw.key, hash: raw.hash, handle: raw.handle as number };
          })
        : null;
  const terrainBodyHandleIndex =
    physics.terrainBodyHandle === undefined ? undefined : rapierHandleIndex(physics.terrainBodyHandle);
  const terrainHandlesValid =
    terrainBodyHandleIndex === undefined
      ? physics.terrainColliderHandles === undefined
      : terrainBodyHandleIndex !== null &&
        terrainColliderHandles !== null &&
        terrainColliderHandles !== undefined &&
        terrainColliderHandles.every(Boolean) &&
        new Set(terrainColliderHandles.map((entry) => entry!.key)).size === terrainColliderHandles.length &&
        new Set(terrainColliderHandles.map((entry) => entry!.handle)).size ===
          terrainColliderHandles.length &&
        !bodyHandles?.some((entry) => entry.handle === physics.terrainBodyHandle) &&
        !colliderHandles?.some((entry) =>
          terrainColliderHandles.some((terrainEntry) => terrainEntry?.handle === entry.handle),
        );
  if (
    Object.keys(physics).some(
      (key) =>
        ![
          'format',
          'rapierVersion',
          'compatibilityKey',
          'world',
          'bodyHandles',
          'colliderHandles',
          'jointHandles',
          'terrainBodyHandle',
          'terrainColliderHandles',
          'worldBodyCount',
          'worldColliderCount',
        ].includes(key),
    ) ||
    physics.format !== 1 ||
    typeof physics.rapierVersion !== 'string' ||
    !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(physics.rapierVersion) ||
    typeof physics.compatibilityKey !== 'string' ||
    physics.compatibilityKey.length < 1 ||
    physics.compatibilityKey.length > 16_384 ||
    typeof physics.world !== 'string' ||
    physics.world.length < 4 ||
    physics.world.length > MAX_GAME_PROGRESS_BYTES ||
    physics.world.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(physics.world) ||
    !bodyHandles ||
    !colliderHandles ||
    (physics.jointHandles !== undefined && !jointHandles) ||
    !terrainHandlesValid ||
    !Number.isSafeInteger(physics.worldBodyCount) ||
    (physics.worldBodyCount as number) < 0 ||
    (physics.worldBodyCount as number) > MAX_PHYSICS_ENTRIES ||
    (physics.worldBodyCount as number) < bodyHandles.length ||
    !Number.isSafeInteger(physics.worldColliderCount) ||
    (physics.worldColliderCount as number) < 0 ||
    (physics.worldColliderCount as number) > MAX_PHYSICS_ENTRIES ||
    (physics.worldColliderCount as number) < colliderHandles.length ||
    (terrainBodyHandleIndex !== undefined &&
      (terrainBodyHandleIndex === null || terrainBodyHandleIndex >= (physics.worldBodyCount as number))) ||
    (terrainColliderHandles !== undefined &&
      (terrainColliderHandles === null ||
        terrainColliderHandles.some(
          (entry) => !entry || rapierHandleIndex(entry.handle)! >= (physics.worldColliderCount as number),
        ))) ||
    bodyHandles.some(({ handle }) => rapierHandleIndex(handle)! >= (physics.worldBodyCount as number)) ||
    colliderHandles.some(({ handle }) => rapierHandleIndex(handle)! >= (physics.worldColliderCount as number))
  )
    return null;
  return {
    format: 1,
    rapierVersion: physics.rapierVersion,
    compatibilityKey: physics.compatibilityKey,
    world: physics.world,
    bodyHandles,
    colliderHandles,
    ...(jointHandles && { jointHandles }),
    ...(terrainBodyHandleIndex !== undefined && { terrainBodyHandle: physics.terrainBodyHandle as number }),
    ...(terrainColliderHandles && {
      terrainColliderHandles: terrainColliderHandles as NonNullable<
        GameProgressPhysics['terrainColliderHandles']
      >,
    }),
    worldBodyCount: physics.worldBodyCount as number,
    worldColliderCount: physics.worldColliderCount as number,
  };
}

function parseBehavior(value: unknown): GameProgressBehavior | null | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const behavior = value as Record<string, unknown>;
  if (
    Object.keys(behavior).some(
      (key) => !['patrolTargets', 'animations', 'cooldowns', 'constructionPaint'].includes(key),
    ) ||
    !record(behavior.patrolTargets) ||
    !record(behavior.animations) ||
    (Object.hasOwn(behavior, 'constructionPaint') &&
      (typeof behavior.constructionPaint !== 'string' || !idPattern.test(behavior.constructionPaint)))
  )
    return null;

  const patrolTargets: GameProgressBehavior['patrolTargets'] = {};
  for (const [id, target] of Object.entries(behavior.patrolTargets)) {
    if (!Number.isSafeInteger(target) || (target as number) < 0 || (target as number) > 9999) return null;
    patrolTargets[id] = target as number;
  }

  const animations: GameProgressBehavior['animations'] = {};
  for (const [id, value] of Object.entries(behavior.animations)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const animation = value as Record<string, unknown>;
    if (
      Object.keys(animation).some((key) => key !== 'clip' && key !== 'time') ||
      typeof animation.clip !== 'string' ||
      animation.clip.length > 64 ||
      animation.clip !== animation.clip.trim() ||
      !idPattern.test(animation.clip) ||
      !finite(animation.time, 1_000_000_000_000) ||
      animation.time < 0
    )
      return null;
    animations[id] = { clip: animation.clip, time: animation.time };
  }

  if (!behavior.cooldowns || typeof behavior.cooldowns !== 'object' || Array.isArray(behavior.cooldowns))
    return null;
  const cooldowns = behavior.cooldowns as Record<string, unknown>;
  if (
    Object.keys(cooldowns).some((key) => key !== 'attack' && key !== 'damage') ||
    !finite(cooldowns.attack, 10_000) ||
    cooldowns.attack < 0 ||
    !finite(cooldowns.damage, 10_000) ||
    cooldowns.damage < 0
  )
    return null;

  return {
    patrolTargets,
    animations,
    cooldowns: { attack: cooldowns.attack, damage: cooldowns.damage },
    ...(behavior.constructionPaint !== undefined && {
      constructionPaint: behavior.constructionPaint as string,
    }),
  };
}

/** Reject unknown versions, mismatched IDs, malformed fields and oversized serialized data. */
export function parseGameProgress(
  serialized: string,
  projectId: string,
  sceneId: string,
): GameProgressSnapshot | null {
  if (serializedBytes(serialized) > MAX_GAME_PROGRESS_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    Object.keys(raw).some(
      (key) =>
        ![
          'version',
          'projectId',
          'sceneId',
          'variables',
          'inventory',
          'health',
          'nodes',
          'spawnedPrefabs',
          'terrain',
          'motion',
          'physics',
          'behavior',
          'execution',
          'status',
        ].includes(key),
    ) ||
    raw.version !== GAME_PROGRESS_VERSION ||
    raw.projectId !== projectId ||
    raw.sceneId !== sceneId ||
    typeof projectId !== 'string' ||
    typeof sceneId !== 'string' ||
    !idPattern.test(projectId) ||
    !idPattern.test(sceneId) ||
    !record(raw.variables) ||
    !record(raw.health) ||
    !record(raw.nodes) ||
    (raw.spawnedPrefabs !== undefined && !Array.isArray(raw.spawnedPrefabs)) ||
    !['playing', 'won', 'lost'].includes(String(raw.status)) ||
    !Array.isArray(raw.inventory) ||
    raw.inventory.length > 128
  )
    return null;
  const terrain = parseTerrainProgress(raw.terrain);
  if (terrain === null) return null;
  const motion = parseMotion(raw.motion);
  if (motion === null) return null;
  const physics = parsePhysics(raw.physics);
  if (physics === null) return null;
  const behavior = parseBehavior(raw.behavior);
  if (behavior === null) return null;
  const execution = parseExecution(raw.execution);
  if (execution === null) return null;

  const variables: Record<string, number> = {};
  for (const [key, entry] of Object.entries(raw.variables)) {
    if (!finite(entry, 1_000_000_000_000)) return null;
    variables[key] = entry;
  }
  const health: Record<string, number> = {};
  for (const [key, entry] of Object.entries(raw.health)) {
    if (!finite(entry, 1_000_000_000)) return null;
    health[key] = entry;
  }
  const inventory: GameProgressSnapshot['inventory'] = [];
  for (const entry of raw.inventory) {
    const stack = entry as Record<string, unknown>;
    if (
      !entry ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      Object.keys(stack).some((key) => key !== 'itemId' && key !== 'quantity') ||
      typeof stack.itemId !== 'string' ||
      !idPattern.test(stack.itemId) ||
      !Number.isSafeInteger(stack.quantity) ||
      (stack.quantity as number) < 1 ||
      (stack.quantity as number) > 9999
    )
      return null;
    inventory.push({
      itemId: stack.itemId as string,
      quantity: stack.quantity as number,
    });
  }
  const nodes: Record<string, GameProgressNode> = {};
  for (const [id, state] of Object.entries(raw.nodes)) {
    if (!state || typeof state !== 'object' || Array.isArray(state)) return null;
    const entry = state as Record<string, unknown>;
    if (Object.keys(entry).some((key) => !['transform', 'enabled', 'attachments'].includes(key))) return null;
    const node: GameProgressNode = {};
    if (entry.enabled !== undefined) {
      if (typeof entry.enabled !== 'boolean') return null;
      node.enabled = entry.enabled;
    }
    if (entry.transform !== undefined) {
      if (!entry.transform || typeof entry.transform !== 'object' || Array.isArray(entry.transform))
        return null;
      const transform = entry.transform as Record<string, unknown>;
      if (
        Object.keys(transform).some((key) => !['position', 'rotation', 'scale'].includes(key)) ||
        (transform.position !== undefined && !vector(transform.position, 100_000)) ||
        (transform.rotation !== undefined && !vector(transform.rotation, 100_000)) ||
        (transform.scale !== undefined &&
          (!vector(transform.scale, 1000) || transform.scale.some((value) => value <= 0)))
      )
        return null;
      node.transform = {
        ...(transform.position ? { position: [...transform.position] as [number, number, number] } : {}),
        ...(transform.rotation ? { rotation: [...transform.rotation] as [number, number, number] } : {}),
        ...(transform.scale ? { scale: [...transform.scale] as [number, number, number] } : {}),
      };
      if (!Object.keys(node.transform).length) return null;
    }
    if (entry.attachments !== undefined) {
      if (!Array.isArray(entry.attachments) || entry.attachments.length > 16) return null;
      const slots = new Set<string>();
      node.attachments = [];
      for (const value of entry.attachments) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        const attachment = value as Record<string, unknown>;
        if (
          Object.keys(attachment).some(
            (key) => !['assetId', 'socket', 'slot', 'transform', 'hiddenBones'].includes(key),
          ) ||
          typeof attachment.assetId !== 'string' ||
          !idPattern.test(attachment.assetId) ||
          typeof attachment.socket !== 'string' ||
          !idPattern.test(attachment.socket) ||
          typeof attachment.slot !== 'string' ||
          !idPattern.test(attachment.slot) ||
          slots.has(attachment.slot) ||
          !attachment.transform ||
          typeof attachment.transform !== 'object' ||
          Array.isArray(attachment.transform)
        )
          return null;
        const transform = attachment.transform as Record<string, unknown>;
        if (
          Object.keys(transform).some((key) => !['position', 'rotation', 'scale'].includes(key)) ||
          !vector(transform.position, 100_000) ||
          !vector(transform.rotation, 100_000) ||
          !vector(transform.scale, 1000) ||
          transform.scale.some((component) => component <= 0) ||
          (attachment.hiddenBones !== undefined &&
            (!Array.isArray(attachment.hiddenBones) ||
              attachment.hiddenBones.length > 128 ||
              attachment.hiddenBones.some((joint) => typeof joint !== 'string' || !idPattern.test(joint))))
        )
          return null;
        slots.add(attachment.slot);
        node.attachments.push({
          assetId: attachment.assetId,
          socket: attachment.socket,
          slot: attachment.slot,
          transform: {
            position: [...transform.position] as [number, number, number],
            rotation: [...transform.rotation] as [number, number, number],
            scale: [...transform.scale] as [number, number, number],
          },
          hiddenBones: [...((attachment.hiddenBones as string[] | undefined) ?? [])],
        });
      }
    }
    if (!node.transform && node.enabled === undefined && node.attachments === undefined) return null;
    nodes[id] = node;
  }

  const spawnedPrefabs: GameProgressSpawn[] = [];
  const spawnedIds = new Set<string>();
  let spawnedNodeCount = 0;
  for (const value of (raw.spawnedPrefabs as unknown[] | undefined) ?? []) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const entry = value as Record<string, unknown>;
    if (
      Object.keys(entry).some(
        (key) =>
          ![
            'prefabId',
            'signature',
            'instanceId',
            'nodeIds',
            'rootPosition',
            'rootRotation',
            'rootScale',
          ].includes(key),
      ) ||
      typeof entry.prefabId !== 'string' ||
      !idPattern.test(entry.prefabId) ||
      typeof entry.signature !== 'string' ||
      !/^[a-f0-9]{16}$/.test(entry.signature) ||
      typeof entry.instanceId !== 'string' ||
      !idPattern.test(entry.instanceId) ||
      spawnedIds.has(entry.instanceId) ||
      !Array.isArray(entry.nodeIds) ||
      entry.nodeIds.length < 1 ||
      entry.nodeIds.length > 5000 ||
      !vector(entry.rootPosition, 100_000) ||
      (entry.rootRotation !== undefined && !vector(entry.rootRotation, 100_000)) ||
      (entry.rootScale !== undefined &&
        (!Array.isArray(entry.rootScale) ||
          entry.rootScale.length !== 3 ||
          entry.rootScale.some(
            (value) => typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1000,
          )))
    )
      return null;
    const nodeIds = entry.nodeIds as unknown[];
    if (
      nodeIds.some((id) => typeof id !== 'string' || !idPattern.test(id) || spawnedIds.has(id)) ||
      spawnedNodeCount + nodeIds.length > MAX_PROGRESS_ENTRIES
    )
      return null;
    spawnedIds.add(entry.instanceId);
    for (const id of nodeIds) spawnedIds.add(id as string);
    spawnedNodeCount += nodeIds.length;
    spawnedPrefabs.push({
      prefabId: entry.prefabId,
      signature: entry.signature,
      instanceId: entry.instanceId,
      nodeIds: [...nodeIds] as string[],
      rootPosition: [...entry.rootPosition] as [number, number, number],
      ...(entry.rootRotation !== undefined && {
        rootRotation: [...entry.rootRotation] as [number, number, number],
      }),
      ...(entry.rootScale !== undefined && { rootScale: [...entry.rootScale] as [number, number, number] }),
    });
    if (spawnedPrefabs.length > 1000) return null;
  }

  return {
    version: GAME_PROGRESS_VERSION,
    projectId,
    sceneId,
    variables,
    inventory,
    health,
    nodes,
    ...(spawnedPrefabs.length && { spawnedPrefabs }),
    ...(terrain && { terrain }),
    ...(motion && { motion }),
    ...(physics && { physics }),
    ...(behavior && { behavior }),
    ...(execution && { execution }),
    status: raw.status as GameProgressSnapshot['status'],
  };
}

export function serializeGameProgress(snapshot: GameProgressSnapshot): string | null {
  let serialized: string;
  try {
    serialized = JSON.stringify(snapshot);
  } catch {
    return null;
  }
  return parseGameProgress(serialized, snapshot.projectId, snapshot.sceneId) ? serialized : null;
}

/** Safe wrapper around browser storage; accessors may throw in private or restricted contexts. */
export class GameProgressStore {
  readonly key: string;
  private readonly projectId: string;
  private readonly sceneId: string;
  constructor(
    projectId: string,
    sceneId: string,
    private readonly getStorage: () => ProgressStorageLike | null = getBrowserProgressStorage,
  ) {
    this.projectId = projectId;
    this.sceneId = sceneId;
    this.key = gameProgressStorageKey(projectId, sceneId);
  }
  get available() {
    return progressStorageAvailable(this.getStorage);
  }
  load(): ProgressLoadResult {
    return loadProgressFromStorage(this.key, this.getStorage, (serialized) =>
      parseGameProgress(serialized, this.projectId, this.sceneId),
    );
  }
  save(snapshot: GameProgressSnapshot): ProgressSaveResult {
    let serialized: string;
    try {
      serialized = JSON.stringify(snapshot);
    } catch {
      return 'invalid';
    }
    if (serializedBytes(serialized) > MAX_GAME_PROGRESS_BYTES) return 'too-large';
    if (!parseGameProgress(serialized, this.projectId, this.sceneId)) return 'invalid';
    try {
      const storage = this.getStorage();
      if (!storage) return 'unavailable';
      storage.setItem(this.key, serialized);
      return 'saved';
    } catch {
      return 'unavailable';
    }
  }
  clear(): boolean {
    return clearProgressStorage(this.key, this.getStorage);
  }
}
