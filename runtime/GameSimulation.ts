import { Box3, Euler, Matrix4, Quaternion, Ray, Vector3 } from 'three';
import { createTerrainSurfaceSampler } from '../services/terrainNoise';
import {
  createWorldCellSampler,
  worldEditSchema,
  type WorldCell,
  type WorldDocument,
  type WorldEdit,
} from '../services/worldDocument';
import { SpatialIndex } from './SpatialIndex';
import { compileGameFormula, type GameFormula } from '../services/gameFormula';
import {
  findVoxelPath,
  findGridPath,
  segmentHitsObstacle,
  type NavigationObstacle,
  type NavigationPoint,
  type NavigationVoxelPoint,
} from './navigation';
import type {
  Asset,
  Action,
  CraftingRecipe,
  Component,
  GameScene,
  ItemDefinition,
  ProjectDocument,
  Prefab,
  Rule,
  RuleCondition,
  SceneNode,
} from '../services/projectDocument';
import { COLLISION_OTHER_TARGET, identityTransform, idSchema } from '../services/projectDocument';
import type { PhysicsQuery } from '../services/viewportProtocol';
import {
  addInventoryItem,
  changeInventory,
  craftInventory,
  removeInventoryItem,
  reorderInventoryStacks,
  sortInventoryStacks,
  type InventoryStack,
} from './Inventory';
import { prepareConstruction } from './construction';
import { MAX_CAMPAIGN_VARIABLES } from './campaignProgress';
import {
  GAME_PROGRESS_VERSION,
  MAX_GAME_WORLD_EDITS,
  parseGameProgress,
  type BodyMotion,
  type GameProgressPhysics,
  type GameProgressMotion,
  type GameProgressSnapshot,
  type GameProgressSpawn,
} from './gameProgress';
import type { PhysicsPose, PhysicsQueryResult, RapierPhysics, RapierPhysicsSnapshot } from './RapierPhysics';
import { instantiatePrefabNodes, prefabSignature } from '../services/prefabAuthoring';
import {
  multiplayerGameStateSchema,
  type MultiplayerPlayerSnapshot,
  type MultiplayerGameState,
} from '../services/multiplayerProtocol';

declare const __VOXSHOP_WITH_RAPIER__: boolean | undefined;

export type GameInput = {
  togglePause?: boolean;
  moveX?: number;
  moveZ?: number;
  sprint?: boolean;
  jump?: boolean;
  interact?: boolean;
  attack?: boolean;
  useItem?: string;
  placeCell?: boolean;
  removeCell?: boolean;
  constructionPaint?: string;
  uiEventId?: string;
  inventoryMove?: { fromIndex: number; toIndex: number };
  inventorySort?: boolean;
  terrainEdit?: WorldEdit;
};
export type RuntimeEvent = { frame: number; type: string; nodeId?: string; data?: unknown };
export const FIXED_DELTA = 1 / 60;
const ATTACK_COOLDOWN_SECONDS = 0.35;
const DEFAULT_ATTACK_DAMAGE = 25;
const DEFAULT_ATTACK_RANGE = 3;
const DAMAGE_COOLDOWN_SECONDS = 0.8;
const MAX_RUNTIME_SPAWNED_NODES = 5000;
const MAX_RUNTIME_SPAWNED_INSTANCES = 1000;
const MAX_INTERACTION_QUERY_CELLS = 4096;
const ENEMY_NAV_CELL_SIZE = 0.5;
const ENEMY_NAV_PADDING_CELLS = 10;

function numericOwnValue(record: Record<string, number>, id: string) {
  return Object.hasOwn(record, id) ? (record[id] ?? 0) : 0;
}

function encodePhysicsWorld(world: Uint8Array) {
  let binary = '';
  for (let offset = 0; offset < world.length; offset += 0x8000)
    binary += String.fromCharCode(...world.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

function decodePhysicsSnapshot(snapshot: GameProgressPhysics): RapierPhysicsSnapshot | null {
  try {
    const binary = atob(snapshot.world),
      world = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) world[index] = binary.charCodeAt(index);
    return { ...snapshot, world };
  } catch {
    return null;
  }
}

function encodePhysicsSnapshot(snapshot: RapierPhysicsSnapshot): GameProgressPhysics | null {
  try {
    return { ...snapshot, world: encodePhysicsWorld(snapshot.world) };
  } catch {
    return null;
  }
}

export function terrainWorldSignature(world: WorldDocument) {
  const descriptor = JSON.stringify({
    id: world.id,
    seed: world.seed,
    chunkSize: world.chunkSize,
    voxelSize: world.voxelSize,
    generator: world.generator,
    edits: world.edits,
  });
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < descriptor.length; index++) {
    hash ^= BigInt(descriptor.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}

function terrainEditKey({ x, y, z }: Pick<WorldEdit, 'x' | 'y' | 'z'>) {
  return `${x},${y},${z}`;
}

function sameWorldCell(a: WorldCell | null | undefined, b: WorldCell | null | undefined) {
  return a === b || (!!a && !!b && a.color === b.color && a.materialType === b.materialType);
}

function withinTerrainBounds(world: WorldDocument, { x, y, z }: Pick<WorldEdit, 'x' | 'y' | 'z'>) {
  const [originX, originZ] = world.generator.origin,
    [width, depth] = world.generator.size;
  return (
    x >= originX &&
    x < originX + width &&
    z >= originZ &&
    z < originZ + depth &&
    y >= world.generator.minY &&
    y <= world.generator.maxY
  );
}

type TerrainHorizontalBounds = { minX: number; maxX: number; minZ: number; maxZ: number };

function terrainHorizontalBounds(world: WorldDocument): TerrainHorizontalBounds {
  const [originX, originZ] = world.generator.origin,
    [width, depth] = world.generator.size,
    size = world.voxelSize;
  return {
    minX: (originX - 0.5) * size,
    maxX: (originX + width - 0.5) * size,
    minZ: (originZ - 0.5) * size,
    maxZ: (originZ + depth - 0.5) * size,
  };
}

export class GameSimulation {
  readonly scene: GameScene;
  readonly projectId: string;
  readonly projectRevision: number;
  readonly assets: Map<string, Asset>;
  readonly nodes: Map<string, SceneNode>;
  readonly ready: Promise<void>;
  readonly variables: Record<string, number>;
  readonly campaignVariables: Record<string, number>;
  readonly items: Map<string, ItemDefinition>;
  readonly recipes: Map<string, CraftingRecipe>;
  inventory: InventoryStack[] = [];
  readonly health: Record<string, number> = {};
  readonly events: RuntimeEvent[] = [];
  readonly errors: string[] = [];
  readonly velocities = new Map<string, number>();
  readonly moving = new Set<string>();
  private sprinting = new Set<string>();
  frame = 0;
  status: 'playing' | 'won' | 'lost' | 'stopped' = 'playing';
  paused = false;
  message = '';
  progressRestored = false;
  private fired = new Set<string>();
  private prefabs = new Map<string, Prefab>();
  private spawnedPrefabs: GameProgressSpawn[] = [];
  private nextSpawnId = 1;
  private dispatchDepth = 0;
  private pendingSpawnStarts: SceneNode[] = [];
  private drainingSpawnStarts = false;
  private pendingSignals: { eventId: string; sourceNodeId: string }[] = [];
  private drainingSignals = false;
  private signalListeners = new Map<string, SceneNode[]>();
  private runtimeSpawnNodeCount = 0;
  private runtimeSpawnWarningIssued = false;
  private timers = new Map<string, number>();
  private patrolTargets = new Map<string, number>();
  private actionBudget = 4096;
  private attackCooldown = 0;
  private damageCooldown = 0;
  private multiplayerActors = new Map<string, string>();
  private multiplayerPlayerByNode = new Map<string, string>();
  private multiplayerInventories = new Map<string, InventoryStack[]>();
  private multiplayerInputs = new Map<string, GameInput>();
  private multiplayerOneShots = new Map<string, GameInput[]>();
  private multiplayerPrevious = new Map<string, GameInput>();
  private multiplayerTouching = new Map<string, Set<string>>();
  private multiplayerAttackCooldowns = new Map<string, number>();
  private multiplayerDamageCooldowns = new Map<string, number>();
  private multiplayerConnectedPlayers = new Set<string>();
  private multiplayerRuntimeNodeIds = new Set<string>();
  private readonly authoredNodeIds = new Set<string>();
  selectedMultiplayerPlayerNodeId: string | null = null;
  private touchingNodeIds = new Set<string>();
  private simulatedSeconds = 0;
  private readonly numericFormulas = new WeakMap<object, GameFormula>();
  private previous: GameInput = {};
  private animationTimes = new Map<string, { clip: string; time: number }>();
  private constructionPaintId: string | null = null;
  private multiplayerConstructionPaint = new Map<string, string>();
  private localBounds = new Map<string, Box3>();
  private assetBounds = new Map<string, Box3>();
  private solids = new SpatialIndex();
  private readonly playerSupports = new Map<string, { nodeId: string; revision: number }>();
  private navigationRevision = 0;
  private navigationGateVariables = new Set<string>();
  private enemyNavigationRoutes = new Map<
    string,
    {
      targetX: number;
      targetZ: number;
      revision: number;
      clearance: number;
      terrainRise: number | null;
      path: NavigationPoint[] | null;
      waypoint: number;
    }
  >();
  private enemyVoxelNavigationRoutes = new Map<
    string,
    {
      targetX: number;
      targetY: number;
      targetZ: number;
      revision: number;
      cellSize: number;
      path: NavigationVoxelPoint[] | null;
      waypoint: number;
    }
  >();
  private children = new Map<string, SceneNode[]>();
  private nodeOrder = new Map<string, number>();
  private initialNodeState = new Map<
    string,
    { transform: SceneNode['transform']; enabled: boolean; attachments: SceneNode['attachments'] }
  >();
  private ruleNodes: SceneNode[];
  private patrolNodes: SceneNode[];
  private rigNodes: SceneNode[];
  private contactNodes: SceneNode[];
  private enemyNodes: SceneNode[];
  private rigidBodyNodes: SceneNode[];
  private interactionNodeIds = new Set<string>();
  private interactables = new SpatialIndex(32);
  private rigidBodyVelocities = new Map<string, Vector3>();
  private coyoteTimes = new Map<string, number>();
  private jumpBuffers = new Map<string, number>();
  private pendingBodyMotion = new Map<string, BodyMotion>();
  private pendingPhysicsSnapshot: GameProgressPhysics | null = null;
  private physics: RapierPhysics | null = null;
  private physicsLoading = false;
  private physicsQueryInitialization: Promise<void> | null = null;
  private disposed = false;
  private pendingSceneTransition: string | null = null;
  private pendingPhysicsSteps: { input: GameInput; deltaSeconds: number }[] = [];
  private terrainWorld: WorldDocument | null = null;
  private terrainSourceWorld: WorldDocument | null = null;
  private terrainBounds: TerrainHorizontalBounds | null = null;
  private terrainVoxelCell:
    ((position: { x: number; y: number; z: number }) => WorldCell | undefined) | null = null;
  private terrainCell: ((position: { x: number; y: number; z: number }) => WorldCell | undefined) | null =
    null;
  private terrainSurfaceCell: ((x: number, z: number) => number) | null = null;
  private terrainEdits = new Map<string, Map<number, WorldCell | null>>();
  private highestTerrainEdits = new Map<string, number>();
  private terrainColumns = new Map<string, number | null>();
  private terrainBaseEdits = new Map<string, WorldEdit>();
  private terrainCurrentEdits = new Map<string, WorldEdit>();
  private terrainRuntimeEdits = new Map<string, WorldEdit>();
  private terrainRuntimeCells = new Map<string, WorldCell | null>();
  private terrainTouchedCells = new Set<string>();
  private blockedPickups = new Set<string>();
  private readonly inventorySlotLimit: number;
  constructor(
    project: ProjectDocument,
    sceneId = project.activeSceneId,
    progress?: unknown,
    private readonly onEvent?: (event: RuntimeEvent) => void,
    campaignVariables?: Record<string, number>,
    deferStartRules = false,
  ) {
    const scene = project.scenes.find((s) => s.id === sceneId);
    if (!scene) throw new Error('Scene not found.');
    this.projectId = project.id;
    this.projectRevision = project.revision;
    this.scene = structuredClone(scene);
    for (const node of this.scene.nodes) this.authoredNodeIds.add(node.id);
    this.prefabs = new Map(project.prefabs.map((prefab) => [prefab.id, prefab]));
    let checkpoint: GameProgressSnapshot | null = null;
    if (progress !== undefined) {
      try {
        const serialized = JSON.stringify(progress);
        if (typeof serialized === 'string') checkpoint = parseGameProgress(serialized, project.id, scene.id);
      } catch {
        checkpoint = null;
      }
    }
    const restoredSpawns: { nodes: SceneNode[]; record: GameProgressSpawn }[] = [];
    const restoredIds = new Set(this.scene.nodes.map((node) => node.id));
    let spawnRecordsValid = true;
    for (const record of checkpoint?.spawnedPrefabs ?? []) {
      const prefab = this.prefabs.get(record.prefabId);
      if (
        !prefab ||
        record.signature !== prefabSignature(prefab) ||
        record.nodeIds.length !== prefab.nodes.length ||
        record.nodeIds.some((id) => restoredIds.has(id) || id === record.instanceId) ||
        restoredIds.has(record.instanceId)
      ) {
        spawnRecordsValid = false;
        break;
      }
      const nodes = instantiatePrefabNodes(prefab, record.nodeIds, {
        position: record.rootPosition,
        ...(record.rootRotation && { rotation: record.rootRotation }),
        ...(record.rootScale && { scale: record.rootScale }),
        rootParentId: null,
      });
      for (const node of nodes) restoredIds.add(node.id);
      restoredIds.add(record.instanceId);
      restoredSpawns.push({ nodes, record: structuredClone(record) });
    }
    if (spawnRecordsValid)
      for (const { nodes, record } of restoredSpawns) {
        this.scene.nodes.push(...nodes);
        this.spawnedPrefabs.push(record);
        this.runtimeSpawnNodeCount += nodes.length;
      }
    this.items = new Map(this.scene.items.map((item) => [item.id, item]));
    this.recipes = new Map(this.scene.recipes.map((recipe) => [recipe.id, recipe]));
    this.assets = new Map(project.assets.map((a) => [a.id, a]));
    this.nodes = new Map(this.scene.nodes.map((n) => [n.id, n]));
    for (const node of this.nodes.values())
      if (!this.authoredNodeIds.has(node.id)) this.multiplayerRuntimeNodeIds.add(node.id);
    for (const node of this.scene.nodes) {
      const gate = this.component(node, 'gate');
      if (gate) this.navigationGateVariables.add(gate.variable);
    }
    for (const node of this.scene.nodes)
      this.initialNodeState.set(node.id, {
        transform: structuredClone(node.transform),
        enabled: node.enabled,
        attachments: structuredClone(node.attachments),
      });
    const player = [...this.nodes.values()].find((node) => this.component(node, 'player'));
    this.inventorySlotLimit = (player && this.component(player, 'inventory')?.slots) ?? 24;
    this.terrainSourceWorld = this.scene.worldId
      ? (project.worlds.find((world) => world.id === this.scene.worldId) ?? null)
      : null;
    this.terrainWorld = this.terrainSourceWorld ? structuredClone(this.terrainSourceWorld) : null;
    if (this.terrainWorld) {
      this.terrainBounds = terrainHorizontalBounds(this.terrainWorld);
      this.terrainSurfaceCell = createTerrainSurfaceSampler(this.terrainWorld);
      const generatedCell = createWorldCellSampler(this.terrainSourceWorld!);
      this.terrainCell = (position) => {
        const key = terrainEditKey(position);
        return this.terrainRuntimeCells.has(key)
          ? (this.terrainRuntimeCells.get(key) ?? undefined)
          : generatedCell(position);
      };
      // Construction can create holes/overhangs in either generator mode; collide with actual cells.
      if (
        this.terrainWorld.generator.mode === 'voxel3d' ||
        scene.nodes.some((node) => node.components.some((component) => component.type === 'construction'))
      )
        this.terrainVoxelCell = this.terrainCell;
      for (const edit of this.terrainWorld.edits) {
        const key3d = terrainEditKey(edit);
        this.terrainBaseEdits.set(key3d, edit);
      }
      this.restoreTerrainProgress([]);
    }
    this.ruleNodes = this.scene.nodes.filter((n) => this.component(n, 'rules'));
    for (const node of this.ruleNodes) this.indexSignalRules(node);
    this.patrolNodes = this.scene.nodes.filter((n) => this.component(n, 'patrol'));
    this.rigNodes = this.scene.nodes.filter((n) => n.assetId && this.assets.get(n.assetId)?.rig);
    this.enemyNodes = this.scene.nodes.filter((n) => this.component(n, 'enemy'));
    this.rigidBodyNodes = this.scene.nodes.filter((n) => this.component(n, 'rigid-body'));
    // Explicit interactables are preferred. Legacy scenes that only have an interact rule
    // remain usable with the old default three-metre range.
    this.interactionNodeIds = new Set(
      this.scene.nodes
        .filter(
          (n) =>
            this.component(n, 'interactable') ||
            this.component(n, 'rules')?.rules.some((rule) => rule.event === 'interact'),
        )
        .map((n) => n.id),
    );
    this.contactNodes = this.scene.nodes.filter(
      (n) =>
        this.component(n, 'enemy') ||
        this.component(n, 'collectible') ||
        this.component(n, 'rules')?.rules.some((r) => r.event === 'touch' || r.event === 'untouch'),
    );
    this.scene.nodes.forEach((n, i) => {
      this.nodeOrder.set(n.id, i);
      if (n.parentId) {
        if (!this.children.has(n.parentId)) this.children.set(n.parentId, []);
        this.children.get(n.parentId)!.push(n);
      }
      if (this.isSolidCollider(n)) this.solids.set(n.id, this.bounds(n));
      if (this.interactionNodeIds.has(n.id)) this.interactables.set(n.id, this.bounds(n));
    });
    this.variables = { ...scene.variables };
    this.campaignVariables = campaignVariables ?? {};
    for (const n of this.nodes.values()) {
      const hp = this.component(n, 'health');
      if (hp) this.health[n.id] = hp.maximum;
    }
    const checkpointSpawnCount = this.spawnedPrefabs.length;
    if (progress !== undefined) this.progressRestored = spawnRecordsValid && this.restoreProgress(progress);
    if (!this.progressRestored && checkpointSpawnCount) this.discardCheckpointSpawns();
    if (!this.progressRestored && !deferStartRules)
      for (const n of this.scene.nodes.slice(0, scene.nodes.length)) {
        this.dispatch(n, 'start');
        if (this.pendingSceneTransition) break;
      }
    const spawnablePhysics = project.prefabs.some((prefab) =>
      prefab.nodes.some((node) => node.components.some((component) => component.type === 'rigid-body')),
    );
    const needsCharacterController = this.scene.nodes.some(
      (node) =>
        this.component(node, 'player') &&
        !!this.component(node, 'collider')?.shape &&
        this.isSolidCollider(node),
    );
    this.ready =
      this.rigidBodyNodes.length || spawnablePhysics || needsCharacterController
        ? this.initializePhysics()
        : Promise.resolve();
  }
  get terrainWorldDocument() {
    return this.terrainWorld;
  }
  getMultiplayerPlayerNodeId(playerId: string) {
    return this.multiplayerActors.get(playerId) ?? null;
  }
  multiplayerPlayerIds() {
    return [...this.multiplayerActors.keys()];
  }
  addMultiplayerPlayer(playerId: string) {
    if (!idSchema.safeParse(playerId).success) throw new Error('Invalid multiplayer player ID.');
    const existing = this.multiplayerActors.get(playerId);
    if (existing) {
      this.setMultiplayerPlayerConnected(playerId, true);
      return existing;
    }
    const template = [...this.nodes.values()].find(
      (node) => this.authoredNodeIds.has(node.id) && this.component(node, 'player'),
    );
    if (!template) throw new Error('A multiplayer room requires an authored player node.');
    const suffix = playerId.length <= 61 ? playerId : this.hashMultiplayerId(playerId),
      nodeId = `mp-${suffix}`;
    if (this.nodes.has(nodeId)) throw new Error('Multiplayer actor ID collides with a scene node.');
    const node = structuredClone(template);
    node.id = nodeId;
    node.name = `${template.name} ${playerId}`.slice(0, 120);
    node.parentId = null;
    delete node.prefabLink;
    node.enabled = true;
    const spawnOffset = this.multiplayerActors.size * 1.5;
    node.transform.position[0] += spawnOffset;
    template.enabled = false;
    this.refreshSolids(template);
    this.multiplayerActors.set(playerId, nodeId);
    this.multiplayerPlayerByNode.set(nodeId, playerId);
    this.multiplayerConnectedPlayers.add(playerId);
    this.multiplayerInventories.set(
      playerId,
      this.inventory.map((stack) => ({ ...stack })),
    );
    this.multiplayerPrevious.set(playerId, {});
    this.multiplayerInputs.set(playerId, {});
    this.multiplayerTouching.set(playerId, new Set());
    this.multiplayerAttackCooldowns.set(playerId, 0);
    this.multiplayerDamageCooldowns.set(playerId, 0);
    this.multiplayerRuntimeNodeIds.add(nodeId);
    this.installRuntimeNode(node);
    const previousInventory = this.inventory;
    this.inventory = this.multiplayerInventories.get(playerId) ?? [];
    this.dispatch(node, 'start');
    this.multiplayerInventories.set(
      playerId,
      this.inventory.map((stack) => ({ ...stack })),
    );
    this.inventory = previousInventory;
    this.selectedMultiplayerPlayerNodeId ??= nodeId;
    return nodeId;
  }
  private hashMultiplayerId(value: string) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index++) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return hash.toString(36);
  }
  private installRuntimeNode(node: SceneNode) {
    if (this.nodes.has(node.id)) return;
    this.nodes.set(node.id, node);
    this.scene.nodes.push(node);
    this.nodeOrder.set(node.id, this.scene.nodes.length - 1);
    this.initialNodeState.set(node.id, {
      transform: structuredClone(node.transform),
      enabled: node.enabled,
      attachments: structuredClone(node.attachments),
    });
    const health = this.component(node, 'health');
    if (health) this.health[node.id] = health.maximum;
    if (this.isSolidCollider(node)) this.solids.set(node.id, this.bounds(node));
    if (
      this.component(node, 'interactable') ||
      this.component(node, 'rules')?.rules.some((rule) => rule.event === 'interact')
    ) {
      this.interactionNodeIds.add(node.id);
      this.interactables.set(node.id, this.bounds(node));
    }
    const rules = this.component(node, 'rules');
    if (rules) {
      this.ruleNodes.push(node);
      this.indexSignalRules(node);
    }
    if (node.assetId && this.assets.get(node.assetId)?.rig) this.rigNodes.push(node);
    if (
      this.component(node, 'enemy') ||
      this.component(node, 'collectible') ||
      rules?.rules.some((rule) => rule.event === 'touch' || rule.event === 'untouch')
    )
      this.contactNodes.push(node);
    if (node.parentId) {
      const children = this.children.get(node.parentId) ?? [];
      children.push(node);
      this.children.set(node.parentId, children);
    }
    this.refreshSolids(node);
  }
  setMultiplayerPlayerConnected(playerId: string, connected: boolean) {
    const nodeId = this.multiplayerActors.get(playerId),
      node = nodeId && this.nodes.get(nodeId);
    if (!node) return;
    if (connected) this.multiplayerConnectedPlayers.add(playerId);
    else this.multiplayerConnectedPlayers.delete(playerId);
    node.enabled = connected && (this.health[nodeId!] ?? 1) > 0;
    if (!connected) {
      this.multiplayerInputs.set(playerId, {});
      this.multiplayerPrevious.set(playerId, {});
      this.multiplayerOneShots.delete(playerId);
    }
    this.refreshSolids(node);
  }
  removeMultiplayerPlayer(playerId: string) {
    const nodeId = this.multiplayerActors.get(playerId);
    if (!nodeId) return false;
    this.multiplayerActors.delete(playerId);
    this.multiplayerPlayerByNode.delete(nodeId);
    this.multiplayerInventories.delete(playerId);
    this.multiplayerInputs.delete(playerId);
    this.multiplayerOneShots.delete(playerId);
    this.multiplayerConstructionPaint.delete(playerId);
    this.multiplayerPrevious.delete(playerId);
    this.multiplayerTouching.delete(playerId);
    this.multiplayerAttackCooldowns.delete(playerId);
    this.multiplayerDamageCooldowns.delete(playerId);
    this.multiplayerConnectedPlayers.delete(playerId);
    this.multiplayerRuntimeNodeIds.delete(nodeId);
    this.removeRuntimeNode(nodeId);
    if (this.selectedMultiplayerPlayerNodeId === nodeId)
      this.selectedMultiplayerPlayerNodeId = this.multiplayerActors.values().next().value ?? null;
    if (!this.multiplayerActors.size) {
      const template = [...this.nodes.values()].find(
        (node) => this.authoredNodeIds.has(node.id) && this.component(node, 'player'),
      );
      const initial = template && this.initialNodeState.get(template.id);
      if (template && initial) {
        template.enabled = initial.enabled;
        this.refreshSolids(template);
      }
    }
    return true;
  }
  private removeRuntimeNode(nodeId: string) {
    const node = this.nodes.get(nodeId);
    if (!node || this.authoredNodeIds.has(nodeId)) return;
    this.unindexSignalRules(node);
    this.nodes.delete(nodeId);
    this.scene.nodes = this.scene.nodes.filter((candidate) => candidate.id !== nodeId);
    this.ruleNodes = this.ruleNodes.filter((candidate) => candidate.id !== nodeId);
    this.patrolNodes = this.patrolNodes.filter((candidate) => candidate.id !== nodeId);
    this.rigNodes = this.rigNodes.filter((candidate) => candidate.id !== nodeId);
    this.enemyNodes = this.enemyNodes.filter((candidate) => candidate.id !== nodeId);
    this.rigidBodyNodes = this.rigidBodyNodes.filter((candidate) => candidate.id !== nodeId);
    this.contactNodes = this.contactNodes.filter((candidate) => candidate.id !== nodeId);
    this.solids.delete(nodeId);
    this.interactables.delete(nodeId);
    this.children.delete(nodeId);
    for (const children of this.children.values()) {
      const index = children.findIndex((candidate) => candidate.id === nodeId);
      if (index >= 0) children.splice(index, 1);
    }
    this.initialNodeState.delete(nodeId);
    delete this.health[nodeId];
    this.velocities.delete(nodeId);
    this.animationTimes.delete(nodeId);
    this.refreshNodeOrder();
  }
  private refreshNodeOrder() {
    this.nodeOrder.clear();
    this.scene.nodes.forEach((node, index) => this.nodeOrder.set(node.id, index));
  }
  stepMultiplayer(
    inputs: readonly { playerId: string; sequence: number; input: GameInput }[],
    deltaSeconds = FIXED_DELTA,
  ) {
    for (const intent of inputs) {
      if (!this.multiplayerActors.has(intent.playerId)) continue;
      // The accepted room queue is arrival ordered. The last state for a player in this tick wins.
      const { uiEventId, constructionPaint, inventoryMove, inventorySort, terrainEdit, ...heldInput } =
        intent.input;
      this.multiplayerInputs.set(intent.playerId, heldInput);
      if (uiEventId || constructionPaint || inventoryMove || inventorySort || terrainEdit) {
        const pending = this.multiplayerOneShots.get(intent.playerId) ?? [];
        pending.push({ uiEventId, constructionPaint, inventoryMove, inventorySort, terrainEdit });
        this.multiplayerOneShots.set(intent.playerId, pending);
      }
    }
    this.step({}, deltaSeconds, new Map(this.multiplayerInputs));
  }
  captureMultiplayerState(
    playerIds = [...this.multiplayerActors.keys()],
    connectedPlayerIds = playerIds,
  ): MultiplayerGameState {
    const nodes = [...this.nodes.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((node) => {
        const animation = this.animationTimes.get(node.id),
          health = this.health[node.id],
          maximum = this.component(node, 'health')?.maximum;
        return {
          nodeId: node.id,
          ...(this.multiplayerPlayerByNode.has(node.id)
            ? { playerId: this.multiplayerPlayerByNode.get(node.id)! }
            : {}),
          transform: structuredClone(node.transform),
          enabled: node.enabled,
          attachments: structuredClone(node.attachments),
          ...(health !== undefined && maximum !== undefined ? { health, maxHealth: maximum } : {}),
          ...(animation ? { animation: { ...animation } } : {}),
          ...(this.multiplayerRuntimeNodeIds.has(node.id) ? { runtimeNode: structuredClone(node) } : {}),
        };
      });
    const connected = new Set(connectedPlayerIds);
    const players = playerIds
      .map((playerId) => {
        const nodeId = this.multiplayerActors.get(playerId);
        if (!nodeId) return null;
        const node = this.nodes.get(nodeId),
          maximum = node ? (this.component(node, 'health')?.maximum ?? 100) : undefined;
        if (!node || maximum === undefined) return null;
        return {
          playerId,
          nodeId,
          connected: connected.has(playerId),
          health: this.health[nodeId] ?? maximum,
          maxHealth: maximum,
          inventory: (this.multiplayerInventories.get(playerId) ?? []).map((stack) => ({ ...stack })),
          attackCooldown: this.multiplayerAttackCooldowns.get(playerId) ?? 0,
          damageCooldown: this.multiplayerDamageCooldowns.get(playerId) ?? 0,
          ...(this.multiplayerConstructionPaint.has(playerId)
            ? { constructionPaint: this.multiplayerConstructionPaint.get(playerId)! }
            : {}),
        };
      })
      .filter((player): player is NonNullable<typeof player> => player !== null)
      .sort((a, b) => a.playerId.localeCompare(b.playerId));
    const objectives = players.flatMap((player) => {
      const previousInventory = this.inventory;
      this.inventory = this.multiplayerInventories.get(player.playerId) ?? [];
      const current = this.inspect().objectives.map((objective) => ({
        playerId: player.playerId,
        id: objective.id,
        current: objective.current,
        available: objective.available,
        completed: objective.completed,
      }));
      this.inventory = previousInventory;
      return current;
    });
    const events = this.events.map((event) => {
      const data = event.data;
      let safeData: string | Record<string, string | number | boolean | null> | undefined;
      if (typeof data === 'string') safeData = data.slice(0, 4096);
      else if (data && typeof data === 'object' && !Array.isArray(data)) {
        safeData = Object.fromEntries(
          Object.entries(data as Record<string, unknown>)
            .filter(
              ([, value]) =>
                value === null ||
                typeof value === 'string' ||
                typeof value === 'number' ||
                typeof value === 'boolean',
            )
            .slice(0, 32)
            .map(([key, value]) => [
              key.slice(0, 64),
              typeof value === 'string' ? value.slice(0, 1024) : value,
            ]),
        ) as Record<string, string | number | boolean | null>;
      }
      return {
        frame: event.frame,
        type: event.type.slice(0, 64),
        ...(event.nodeId ? { nodeId: event.nodeId } : {}),
        ...(safeData === undefined ? {} : { data: safeData }),
      };
    });
    return multiplayerGameStateSchema.parse({
      version: 1,
      projectId: this.projectId,
      revision: this.projectRevision,
      sceneId: this.scene.id,
      frame: Math.max(0, this.frame),
      seconds: this.simulatedSeconds,
      status: this.status,
      paused: this.paused,
      message: this.message.slice(0, 4096),
      variables: { ...this.variables },
      campaignVariables: { ...this.campaignVariables },
      terrainEdits: this.terrainProgressEdits,
      firedRules: [...this.fired],
      tickDeadlines: Object.fromEntries(this.timers),
      nodes,
      players,
      objectives,
      events,
    });
  }
  captureMultiplayerPlayerSnapshots(
    activePlayerIds = [...this.multiplayerActors.keys()],
  ): MultiplayerPlayerSnapshot[] {
    return activePlayerIds
      .map((playerId) => {
        const nodeId = this.multiplayerActors.get(playerId);
        if (!nodeId) return null;
        const node = this.nodes.get(nodeId),
          maximum = node ? (this.component(node, 'health')?.maximum ?? 100) : undefined;
        if (!node || maximum === undefined) return null;
        const position = this.worldPosition(node);
        return {
          playerId,
          position: position.toArray() as [number, number, number],
          rotation: [...node.transform.rotation] as [number, number, number],
          velocity: [0, this.velocities.get(node.id) ?? 0, 0] as [number, number, number],
          health: this.health[node.id] ?? maximum,
          maxHealth: maximum,
        };
      })
      .filter((player): player is NonNullable<typeof player> => player !== null)
      .sort((a, b) => a.playerId.localeCompare(b.playerId));
  }
  restoreMultiplayerPlayerState(
    playerId: string,
    state: Pick<
      MultiplayerGameState['players'][number],
      'inventory' | 'health' | 'constructionPaint' | 'attackCooldown' | 'damageCooldown'
    >,
  ) {
    const nodeId = this.multiplayerActors.get(playerId),
      node = nodeId && this.nodes.get(nodeId);
    if (!node || state.inventory.length > this.inventorySlotLimit) return false;
    if (
      state.inventory.some((stack) => {
        const item = this.items.get(stack.itemId);
        return !item || stack.quantity < 1 || stack.quantity > item.maxStack;
      })
    )
      return false;
    if (state.constructionPaint && !this.selectConstructionPaint(state.constructionPaint, playerId))
      return false;
    this.multiplayerInventories.set(
      playerId,
      state.inventory.map((stack) => ({ ...stack })),
    );
    const maximum = this.component(node, 'health')?.maximum ?? 100;
    this.health[node.id] = Math.min(maximum, Math.max(0, state.health));
    this.multiplayerAttackCooldowns.set(playerId, state.attackCooldown);
    this.multiplayerDamageCooldowns.set(playerId, state.damageCooldown);
    node.enabled = this.multiplayerConnectedPlayers.has(playerId) && this.health[node.id] > 0;
    this.refreshSolids(node);
    return true;
  }
  applyMultiplayerState(state: MultiplayerGameState, localPlayerId?: string) {
    const parsed = multiplayerGameStateSchema.safeParse(state);
    if (
      !parsed.success ||
      state.projectId !== this.projectId ||
      state.revision !== this.projectRevision ||
      state.sceneId !== this.scene.id
    )
      return false;
    const stateNodes = new Map(state.nodes.map((node) => [node.nodeId, node]));
    const ruleFor = (key: string) => {
      const separator = key.lastIndexOf(':'),
        nodeId = key.slice(0, separator),
        ruleIndex = Number(key.slice(separator + 1)),
        node = stateNodes.get(nodeId)?.runtimeNode ?? this.nodes.get(nodeId),
        rules = node && this.component(node, 'rules')?.rules;
      return separator > 0 && Number.isInteger(ruleIndex) && ruleIndex >= 0 ? rules?.[ruleIndex] : undefined;
    };
    if (
      state.firedRules.some((key) => !ruleFor(key)?.once) ||
      Object.entries(state.tickDeadlines).some(([key, deadline]) => {
        const rule = ruleFor(key);
        return !rule || rule.event !== 'tick' || deadline > state.seconds + rule.interval + 1e-6;
      })
    )
      return false;
    const incomingRuntimeIds = new Set(
      state.nodes.filter((node) => node.runtimeNode).map((node) => node.nodeId),
    );
    for (const nodeId of this.multiplayerRuntimeNodeIds)
      if (!incomingRuntimeIds.has(nodeId)) this.removeRuntimeNode(nodeId);
    this.multiplayerRuntimeNodeIds = incomingRuntimeIds;
    this.multiplayerActors.clear();
    this.multiplayerPlayerByNode.clear();
    for (const nodeState of state.nodes) {
      if (nodeState.runtimeNode && !this.nodes.has(nodeState.nodeId)) {
        const runtimeNode = structuredClone(nodeState.runtimeNode);
        this.installRuntimeNode(runtimeNode);
      }
      const node = this.nodes.get(nodeState.nodeId);
      if (!node) continue;
      node.transform = structuredClone(nodeState.transform);
      node.enabled = nodeState.enabled;
      node.attachments = structuredClone(nodeState.attachments);
      if (nodeState.health !== undefined) this.health[node.id] = nodeState.health;
      if (nodeState.playerId) {
        this.multiplayerActors.set(nodeState.playerId, node.id);
        this.multiplayerPlayerByNode.set(node.id, nodeState.playerId);
      }
      this.refreshSolids(node);
      if (this.interactionNodeIds.has(node.id)) this.interactables.set(node.id, this.bounds(node));
    }
    this.animationTimes.clear();
    for (const node of state.nodes)
      if (node.animation) this.animationTimes.set(node.nodeId, { ...node.animation });
    this.multiplayerInventories.clear();
    this.multiplayerInputs.clear();
    this.multiplayerPrevious.clear();
    this.multiplayerTouching.clear();
    this.multiplayerAttackCooldowns.clear();
    this.multiplayerDamageCooldowns.clear();
    this.multiplayerConnectedPlayers.clear();
    this.multiplayerOneShots.clear();
    this.multiplayerConstructionPaint.clear();
    for (const player of state.players) {
      this.multiplayerInventories.set(
        player.playerId,
        player.inventory.map((stack) => ({ ...stack })),
      );
      this.multiplayerPrevious.set(player.playerId, {});
      this.multiplayerInputs.set(player.playerId, {});
      this.multiplayerTouching.set(player.playerId, new Set());
      this.multiplayerAttackCooldowns.set(player.playerId, player.attackCooldown);
      this.multiplayerDamageCooldowns.set(player.playerId, player.damageCooldown);
      if (player.connected) this.multiplayerConnectedPlayers.add(player.playerId);
      if (player.constructionPaint)
        this.multiplayerConstructionPaint.set(player.playerId, player.constructionPaint);
    }
    for (const key of Object.keys(this.variables)) delete this.variables[key];
    Object.assign(this.variables, state.variables);
    for (const key of Object.keys(this.campaignVariables)) delete this.campaignVariables[key];
    Object.assign(this.campaignVariables, state.campaignVariables);
    this.restoreTerrainProgress(structuredClone(state.terrainEdits));
    if (this.terrainWorld) this.physics?.updateTerrain(this.terrainWorld);
    this.status = state.status;
    this.paused = state.paused;
    this.message = state.message;
    this.frame = state.frame;
    this.simulatedSeconds = state.seconds;
    this.fired = new Set(state.firedRules);
    this.timers = new Map(Object.entries(state.tickDeadlines));
    this.events.splice(0, this.events.length, ...state.events.map((event) => ({ ...event })));
    const localPlayer = state.players.find((player) => player.playerId === localPlayerId);
    this.selectedMultiplayerPlayerNodeId = localPlayer?.nodeId ?? null;
    if (localPlayer) this.inventory = localPlayer.inventory.map((stack) => ({ ...stack }));
    return true;
  }
  takeSceneTransition() {
    const sceneId = this.pendingSceneTransition;
    this.pendingSceneTransition = null;
    return sceneId;
  }
  campaignState() {
    const player = [...this.nodes.values()].find((node) => this.component(node, 'player'));
    return {
      inventory: this.inventory.map((stack) => ({ ...stack })),
      health: player ? this.health[player.id] : undefined,
    };
  }
  applyCampaignState(state: ReturnType<GameSimulation['campaignState']>) {
    if (
      state.inventory.length > this.inventorySlotLimit ||
      state.inventory.some((stack) => {
        const item = this.items.get(stack.itemId);
        return !item || stack.quantity < 1 || stack.quantity > item.maxStack;
      })
    )
      return false;
    this.inventory = state.inventory.map((stack) => ({ ...stack }));
    const player = [...this.nodes.values()].find((node) => this.component(node, 'player')),
      maximum = player && this.component(player, 'health')?.maximum;
    if (player && maximum !== undefined && state.health !== undefined)
      this.health[player.id] = Math.min(maximum, Math.max(0, state.health));
    return true;
  }
  moveInventoryStack(fromIndex: number, toIndex: number) {
    if (this.status !== 'playing') return false;
    const next = reorderInventoryStacks(this.inventory, fromIndex, toIndex);
    if (!next) return false;
    this.inventory = next;
    return true;
  }
  sortInventoryByName() {
    if (this.status !== 'playing') return false;
    const next = sortInventoryStacks(this.inventory, this.items);
    if (!next) return false;
    this.inventory = next;
    return true;
  }
  get terrainProgressEdits() {
    return structuredClone(
      [...this.terrainRuntimeEdits.values()].sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x),
    );
  }
  constructionState(playerId?: string) {
    const player = playerId
        ? this.nodes.get(this.multiplayerActors.get(playerId) ?? '')
        : [...this.nodes.values()].find((node) => this.component(node, 'player')),
      construction = player && this.component(player, 'construction'),
      palette = construction?.palette;
    if (!this.terrainWorld || !construction || !palette?.length) return null;
    return {
      palette: structuredClone(palette),
      selectedId:
        (playerId ? this.multiplayerConstructionPaint.get(playerId) : this.constructionPaintId) ??
        palette[0].id,
      enabled: this.status === 'playing' && this.enabled(player!) && construction.place,
    };
  }
  selectConstructionPaint(id: string, playerId?: string) {
    if (this.status !== 'playing') return false;
    const state = this.constructionState(playerId);
    if (!state?.enabled || !state.palette.some((paint) => paint.id === id)) {
      this.message = 'Choose an available construction paint while building is enabled.';
      return false;
    }
    if (playerId) this.multiplayerConstructionPaint.set(playerId, id);
    else this.constructionPaintId = id;
    return true;
  }
  /** One-cell Play input. Empty cells cannot be removed, occupied cells cannot be overwritten. */
  editTerrain(input: unknown, playerId?: string): WorldDocument | null {
    const edit = worldEditSchema.parse(input),
      world = this.terrainWorld;
    if (this.status !== 'playing') return null;
    if (!world || !withinTerrainBounds(world, edit)) {
      this.message = 'Aim at an editable cell within the active terrain world.';
      return null;
    }
    const key = terrainEditKey(edit),
      cell = this.terrainCell?.({ x: edit.x, y: edit.y, z: edit.z });
    if ((edit.value === null && !cell) || (edit.value !== null && cell)) {
      this.message =
        edit.value === null ? 'That terrain cell is already empty.' : 'That terrain cell is occupied.';
      return null;
    }
    const current = this.terrainCurrentEdits.get(key);
    if (current && sameWorldCell(current.value, edit.value)) return null;
    if (!this.terrainTouchedCells.has(key) && this.terrainTouchedCells.size >= MAX_GAME_WORLD_EDITS)
      throw new Error(`A Play session may change at most ${MAX_GAME_WORLD_EDITS} unique terrain cells.`);
    if (!current && this.terrainCurrentEdits.size >= 250_000)
      throw new Error('The world already has the maximum number of sparse terrain edits.');
    const player = playerId
        ? this.nodes.get(this.multiplayerActors.get(playerId) ?? '')
        : [...this.nodes.values()].find((node) => this.component(node, 'player')),
      construction = player && this.component(player, 'construction');
    let inventory = this.inventory;
    if (construction) {
      if (!this.enabled(player!)) {
        this.message = 'Construction is unavailable while the player is disabled.';
        return null;
      }
      const cellBounds = this.terrainVoxelBox(edit.x, edit.y, edit.z);
      const plan = prepareConstruction({
        settings: construction,
        placing: edit.value !== null,
        cellBounds,
        actorBounds: this.bounds(player!),
        solidBounds: edit.value
          ? this.nearbySolids(cellBounds)
              .filter(
                (node) =>
                  node.id !== player!.id && this.enabled(node) && !this.component(node, 'collider')?.sensor,
              )
              .map((node) => this.bounds(node))
          : [],
        inventory,
        items: this.items,
        slots: this.inventorySlotLimit,
      });
      if (!plan.allowed) {
        this.message = plan.message;
        this.emit('construction-failed', player!.id, {
          reason: plan.reason,
          x: edit.x,
          y: edit.y,
          z: edit.z,
        });
        return null;
      }
      inventory = plan.inventory;
    }
    const updated = this.storeTerrainEdit(edit, true);
    this.physics?.updateTerrain(updated, edit);
    this.inventory = inventory;
    return updated;
  }
  /** Undefined means no world/outside bounds; null means an empty cell in the active world. */
  inspectTerrainCell(position: { x: number; y: number; z: number }): WorldCell | null | undefined {
    if (!this.terrainWorld || !withinTerrainBounds(this.terrainWorld, position)) return undefined;
    const cell = this.terrainCell?.(position);
    return cell ? { ...cell } : null;
  }
  private storeTerrainEdit(edit: WorldEdit, countAsRuntimeInput: boolean, announce = true) {
    const key = terrainEditKey(edit),
      current = this.terrainWorld!;
    if (countAsRuntimeInput) this.terrainTouchedCells.add(key);
    this.terrainCurrentEdits.set(key, edit);
    const columnKey = `${edit.x},${edit.z}`;
    let column = this.terrainEdits.get(columnKey);
    if (!column) this.terrainEdits.set(columnKey, (column = new Map()));
    column.set(edit.y, edit.value);
    let highest = -Infinity;
    for (const [y, value] of column) if (value && y > highest) highest = y;
    if (Number.isFinite(highest)) this.highestTerrainEdits.set(columnKey, highest);
    else this.highestTerrainEdits.delete(columnKey);

    const base = this.terrainBaseEdits.get(key);
    if (base && sameWorldCell(base.value, edit.value)) {
      this.terrainRuntimeEdits.delete(key);
      this.terrainRuntimeCells.delete(key);
    } else {
      this.terrainRuntimeEdits.set(key, edit);
      this.terrainRuntimeCells.set(key, edit.value);
    }
    this.terrainColumns.clear();
    this.invalidateNavigation();
    this.terrainWorld = {
      ...current,
      edits: [...this.terrainCurrentEdits.values()].sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x),
    };
    if (announce) {
      this.message = edit.value ? 'Terrain cell placed.' : 'Terrain cell removed.';
      this.emit(edit.value ? 'terrain-cell-placed' : 'terrain-cell-removed', 'world', {
        x: edit.x,
        y: edit.y,
        z: edit.z,
      });
    }
    return this.terrainWorld;
  }
  private restoreTerrainProgress(edits: WorldEdit[]) {
    if (!this.terrainWorld) return;
    this.terrainCurrentEdits = new Map(this.terrainBaseEdits);
    this.terrainRuntimeEdits.clear();
    this.terrainRuntimeCells.clear();
    this.terrainTouchedCells = new Set(edits.map(terrainEditKey));
    this.terrainEdits.clear();
    this.highestTerrainEdits.clear();
    this.terrainColumns.clear();
    this.invalidateNavigation();
    for (const edit of edits) {
      const key = terrainEditKey(edit),
        base = this.terrainBaseEdits.get(key);
      this.terrainCurrentEdits.set(key, edit);
      if (!base || !sameWorldCell(base.value, edit.value)) {
        this.terrainRuntimeEdits.set(key, edit);
        this.terrainRuntimeCells.set(key, edit.value);
      }
    }
    for (const edit of this.terrainCurrentEdits.values()) {
      const key = `${edit.x},${edit.z}`;
      let column = this.terrainEdits.get(key);
      if (!column) this.terrainEdits.set(key, (column = new Map()));
      column.set(edit.y, edit.value);
      if (edit.value && edit.y > (this.highestTerrainEdits.get(key) ?? -Infinity))
        this.highestTerrainEdits.set(key, edit.y);
    }
    // Restore is a batch: merge and sort once, rather than rebuilding the world for every saved cell.
    this.terrainWorld = {
      ...this.terrainWorld,
      edits: [...this.terrainCurrentEdits.values()].sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x),
    };
  }
  progressSnapshot(): GameProgressSnapshot | null {
    if (this.status === 'stopped') return null;
    const capturedPhysics = this.physics?.captureSnapshot();
    const physics =
      (capturedPhysics && encodePhysicsSnapshot(capturedPhysics)) ?? this.pendingPhysicsSnapshot ?? undefined;
    const nodes: GameProgressSnapshot['nodes'] = {};
    for (const node of this.nodes.values()) {
      const initial = this.initialNodeState.get(node.id)!;
      const transform: NonNullable<GameProgressSnapshot['nodes'][string]['transform']> = {};
      for (const key of ['position', 'rotation', 'scale'] as const) {
        const current = node.transform[key],
          authored = initial.transform[key];
        if (current.some((value, index) => value !== authored[index]))
          transform[key] = [...current] as [number, number, number];
      }
      const state: GameProgressSnapshot['nodes'][string] = {};
      if (Object.keys(transform).length) state.transform = transform;
      if (node.enabled !== initial.enabled) state.enabled = node.enabled;
      if (JSON.stringify(node.attachments) !== JSON.stringify(initial.attachments))
        state.attachments = structuredClone(node.attachments);
      if (state.transform || state.enabled !== undefined || state.attachments) nodes[node.id] = state;
    }
    const motion: GameProgressMotion = { actors: Object.fromEntries(this.velocities), bodies: {} };
    for (const node of this.rigidBodyNodes) {
      const body = this.component(node, 'rigid-body')!;
      motion.bodies[node.id] = this.physics?.captureMotion(node.id) ??
        structuredClone(this.pendingBodyMotion.get(node.id)) ?? {
          linearVelocity: (this.rigidBodyVelocities.get(node.id)?.toArray() ?? [...body.velocity]) as [
            number,
            number,
            number,
          ],
          angularVelocity: this.physicsLoading
            ? ([...(body.angularVelocity ?? [0, 0, 0])] as [number, number, number])
            : [0, 0, 0],
          sleeping: false,
        };
    }
    return {
      version: GAME_PROGRESS_VERSION,
      projectId: this.projectId,
      sceneId: this.scene.id,
      variables: { ...this.variables },
      inventory: this.inventory.map((stack) => ({ ...stack })),
      health: { ...this.health },
      nodes,
      ...(this.spawnedPrefabs.length && {
        spawnedPrefabs: this.spawnedPrefabs.map((entry) => structuredClone(entry)),
      }),
      ...((Object.keys(motion.actors).length || this.rigidBodyNodes.length) && { motion }),
      ...(physics && { physics }),
      ...((this.constructionPaintId ||
        this.patrolTargets.size ||
        this.animationTimes.size ||
        this.attackCooldown ||
        this.damageCooldown) && {
        behavior: {
          ...(this.constructionPaintId && { constructionPaint: this.constructionPaintId }),
          patrolTargets: Object.fromEntries(this.patrolTargets),
          animations: Object.fromEntries([...this.animationTimes].map(([id, state]) => [id, { ...state }])),
          cooldowns: { attack: this.attackCooldown, damage: this.damageCooldown },
        },
      }),
      execution: {
        frame: this.frame,
        seconds: this.simulatedSeconds,
        firedRules: [...this.fired],
        tickDeadlines: Object.fromEntries(this.timers),
      },
      ...(this.terrainSourceWorld &&
        this.terrainRuntimeEdits.size > 0 && {
          terrain: {
            worldId: this.terrainSourceWorld.id,
            signature: terrainWorldSignature(this.terrainSourceWorld),
            edits: this.terrainProgressEdits,
          },
        }),
      status: this.status,
    };
  }
  restoreProgress(value: unknown): boolean {
    let serialized: string;
    try {
      serialized = JSON.stringify(value);
    } catch {
      return false;
    }
    if (typeof serialized !== 'string') return false;
    const snapshot = parseGameProgress(serialized, this.projectId, this.scene.id);
    if (!snapshot) return false;

    const healthIds = Object.keys(this.health).sort(),
      savedHealthIds = Object.keys(snapshot.health).sort(),
      authoredVariableIds = Object.keys(this.scene.variables);
    const addedTerrainEdits =
      snapshot.terrain?.edits.filter((edit) => !this.terrainBaseEdits.has(terrainEditKey(edit))).length ?? 0;
    if (
      healthIds.length !== savedHealthIds.length ||
      healthIds.some((id, index) => id !== savedHealthIds[index]) ||
      authoredVariableIds.some((id) => !Object.hasOwn(snapshot.variables, id)) ||
      snapshot.inventory.length > this.inventorySlotLimit ||
      (snapshot.physics !== undefined && !this.rigidBodyNodes.length) ||
      (snapshot.terrain !== undefined &&
        (!this.terrainSourceWorld ||
          snapshot.terrain.worldId !== this.terrainSourceWorld.id ||
          snapshot.terrain.signature !== terrainWorldSignature(this.terrainSourceWorld) ||
          snapshot.terrain.edits.some((edit) => !withinTerrainBounds(this.terrainSourceWorld!, edit)) ||
          this.terrainBaseEdits.size + addedTerrainEdits > 250_000))
    )
      return false;
    for (const stack of snapshot.inventory) {
      const item = this.items.get(stack.itemId);
      if (!item || stack.quantity > item.maxStack) return false;
    }
    for (const [id, amount] of Object.entries(snapshot.health)) {
      const node = this.nodes.get(id),
        component = node && this.component(node, 'health');
      if (!component || amount < 0 || amount > component.maximum) return false;
    }
    for (const [id, state] of Object.entries(snapshot.nodes)) {
      const node = this.nodes.get(id);
      if (!node) return false;
      if (
        state.transform?.position?.some((value) => Math.abs(value) > 1_000_000_000) ||
        state.transform?.rotation?.some((value) => Math.abs(value) > 1_000_000) ||
        state.transform?.scale?.some((value) => Math.abs(value) > 1_000_000)
      )
        return false;
      if (state.attachments) {
        const body = node.assetId ? this.assets.get(node.assetId) : undefined,
          jointNames = new Set(body?.rig?.joints.map((joint) => joint.name) ?? []),
          slots = new Set<string>();
        if (!body?.rig) return false;
        for (const attachment of state.attachments) {
          const gear = this.assets.get(attachment.assetId),
            fit = gear?.equipment;
          if (
            !gear ||
            !body.rig.sockets.some((socket) => socket.name === attachment.socket) ||
            attachment.hiddenBones?.some((joint) => !jointNames.has(joint)) ||
            slots.has(attachment.slot) ||
            (fit &&
              (fit.bodyAssetId !== body.id ||
                fit.profile !== body.rig.profile ||
                fit.socket !== attachment.socket ||
                fit.kind !== attachment.slot))
          )
            return false;
          slots.add(attachment.slot);
        }
      }
    }
    if (snapshot.motion) {
      for (const id of Object.keys(snapshot.motion.actors)) {
        const node = this.nodes.get(id);
        if (
          !node ||
          !(this.component(node, 'player') || this.component(node, 'enemy') || this.component(node, 'patrol'))
        )
          return false;
      }
      for (const [id, motion] of Object.entries(snapshot.motion.bodies)) {
        const node = this.nodes.get(id),
          body = node && this.component(node, 'rigid-body');
        if (
          !body ||
          (motion.sleeping && ((body.bodyType ?? 'dynamic') !== 'dynamic' || body.canSleep === false))
        )
          return false;
      }
    }
    if (snapshot.behavior) {
      const player = [...this.nodes.values()].find((node) => this.component(node, 'player'));
      const maximumAttackCooldown =
        (player && this.component(player, 'combat')?.cooldown) ?? ATTACK_COOLDOWN_SECONDS;
      if (
        snapshot.behavior.constructionPaint &&
        !this.constructionState()?.palette.some((paint) => paint.id === snapshot.behavior!.constructionPaint)
      )
        return false;
      if (
        snapshot.behavior.cooldowns.attack > maximumAttackCooldown ||
        snapshot.behavior.cooldowns.damage > DAMAGE_COOLDOWN_SECONDS
      )
        return false;
      for (const [id, target] of Object.entries(snapshot.behavior.patrolTargets)) {
        const node = this.nodes.get(id),
          patrol = node && this.component(node, 'patrol');
        if (!patrol || target >= patrol.points.length) return false;
      }
      for (const [id, state] of Object.entries(snapshot.behavior.animations)) {
        const node = this.nodes.get(id),
          clip =
            node?.assetId &&
            this.assets.get(node.assetId)?.rig?.clips.find((clip) => clip.name === state.clip);
        if (!node || !clip || (!clip.loop && state.time > clip.duration)) return false;
        const settings = this.component(node, 'animation');
        if (
          ![settings?.idle ?? 'idle', settings?.moving ?? 'walk'].some(
            (name) => name.toLowerCase() === clip.name.toLowerCase(),
          )
        )
          return false;
      }
    }
    if (snapshot.execution) {
      const ruleAt = (key: string) => {
        const [id, index] = key.split(':');
        const node = this.nodes.get(id);
        return node && this.component(node, 'rules')?.rules[Number(index)];
      };
      if (
        snapshot.execution.firedRules.some((key) => !ruleAt(key)?.once) ||
        Object.entries(snapshot.execution.tickDeadlines).some(([key, deadline]) => {
          const rule = ruleAt(key);
          return (
            !rule || rule.event !== 'tick' || deadline > snapshot.execution!.seconds + rule.interval + 1e-6
          );
        })
      )
        return false;
    }

    for (const key of Object.keys(this.variables)) delete this.variables[key];
    Object.assign(this.variables, snapshot.variables);
    this.inventory = snapshot.inventory.map((stack) => ({ ...stack }));
    Object.assign(this.health, snapshot.health);
    this.pendingSceneTransition = null;
    this.pendingPhysicsSteps = [];
    this.frame = snapshot.execution?.frame ?? 0;
    this.simulatedSeconds = snapshot.execution?.seconds ?? 0;
    this.fired = new Set(snapshot.execution?.firedRules ?? []);
    this.timers = new Map(Object.entries(snapshot.execution?.tickDeadlines ?? {}));
    this.status = snapshot.status;
    this.previous = {};
    this.constructionPaintId = snapshot.behavior?.constructionPaint ?? null;
    this.patrolTargets = new Map(Object.entries(snapshot.behavior?.patrolTargets ?? {}));
    this.animationTimes = new Map(Object.entries(snapshot.behavior?.animations ?? {}));
    this.attackCooldown = snapshot.behavior?.cooldowns.attack ?? 0;
    this.damageCooldown = snapshot.behavior?.cooldowns.damage ?? 0;
    this.velocities.clear();
    for (const [id, velocity] of Object.entries(snapshot.motion?.actors ?? {}))
      this.velocities.set(id, velocity);
    this.pendingBodyMotion.clear();
    this.pendingPhysicsSnapshot = snapshot.physics ?? null;
    this.rigidBodyVelocities.clear();
    for (const node of this.rigidBodyNodes) {
      const body = this.component(node, 'rigid-body')!,
        motion = snapshot.motion?.bodies[node.id] ?? {
          linearVelocity: [...body.velocity] as [number, number, number],
          angularVelocity: [...(body.angularVelocity ?? [0, 0, 0])] as [number, number, number],
          sleeping: false,
        };
      this.pendingBodyMotion.set(node.id, motion);
      this.rigidBodyVelocities.set(node.id, new Vector3(...motion.linearVelocity));
    }
    this.restoreTerrainProgress(snapshot.terrain?.edits ?? []);
    for (const node of this.nodes.values()) {
      const initial = this.initialNodeState.get(node.id)!,
        state = snapshot.nodes[node.id];
      node.enabled = state?.enabled ?? initial.enabled;
      node.transform = { ...structuredClone(initial.transform), ...state?.transform };
      node.attachments = structuredClone(state?.attachments ?? initial.attachments);
      this.refreshSolids(node);
    }
    if (this.physics) {
      for (const node of this.nodes.values()) {
        if (!this.component(node, 'rigid-body') && !this.component(node, 'collider')) continue;
        const position = new Vector3(),
          rotation = new Quaternion();
        this.worldMatrix(node).decompose(position, rotation, new Vector3());
        this.physics.setBodyPose(node.id, position, rotation);
      }
      if (this.terrainWorld) this.physics.updateTerrain(this.terrainWorld);
      if (!this.restorePhysicsSnapshot(this.physics)) this.restoreBodyMotion(this.physics);
    }
    return true;
  }
  private restoreBodyMotion(physics: RapierPhysics) {
    for (const [id, motion] of this.pendingBodyMotion) physics.restoreMotion(id, motion);
    this.pendingBodyMotion.clear();
  }
  private restorePhysicsSnapshot(physics: RapierPhysics) {
    const snapshot = this.pendingPhysicsSnapshot;
    if (!snapshot) return false;
    const decoded = decodePhysicsSnapshot(snapshot);
    if (decoded && physics.restoreSnapshot(decoded)) {
      this.pendingPhysicsSnapshot = null;
      this.pendingBodyMotion.clear();
      return true;
    }
    this.pendingPhysicsSnapshot = null;
    this.errors.push(
      'Saved Rapier solver state did not match this scene; restored body transforms and motion instead.',
    );
    return false;
  }
  private async initializePhysics() {
    if (typeof __VOXSHOP_WITH_RAPIER__ === 'undefined' || __VOXSHOP_WITH_RAPIER__) {
      this.physicsLoading = true;
      try {
        const { RapierPhysics } = await import('./RapierPhysics');
        if (this.disposed) return;
        const terrain = this.terrainWorld
          ? {
              world: this.terrainWorld,
              cellAt: (position: { x: number; y: number; z: number }) => this.terrainCell?.(position),
              surfaceAt: (x: number, z: number) => {
                const size = this.terrainWorld!.voxelSize;
                return this.terrainSurface(x * size, z * size);
              },
              smoothSurface:
                !this.terrainVoxelCell &&
                this.terrainWorld.generator.mode !== 'voxel3d' &&
                this.terrainWorld.edits.length === 0,
            }
          : undefined;
        const physics = await RapierPhysics.create(
          this.scene,
          (node) => this.worldMatrix(node),
          !!this.terrainWorld,
          [...this.prefabs.values()].some((prefab) =>
            prefab.nodes.some(
              (node) =>
                this.component(node, 'collider') &&
                this.component(node, 'rules')?.rules.some(
                  (rule) => rule.event === 'collision' || rule.event === 'separation',
                ),
            ),
          ),
          terrain,
        );
        if (this.disposed) physics.dispose();
        else {
          if (this.terrainWorld && terrain?.world !== this.terrainWorld)
            physics.updateTerrain(this.terrainWorld);
          if (!this.restorePhysicsSnapshot(physics)) this.restoreBodyMotion(physics);
          this.physics = physics;
        }
      } catch (error) {
        this.errors.push(
          `Rapier physics initialization failed; legacy rigid-body collision is active: ${(error as Error).message}`,
        );
      } finally {
        this.physicsLoading = false;
        this.pendingBodyMotion.clear();
        const pending = this.pendingPhysicsSteps;
        this.pendingPhysicsSteps = [];
        if (!this.disposed)
          for (const step of pending) {
            this.step(step.input, step.deltaSeconds);
            if (this.pendingSceneTransition) break;
          }
      }
    } else {
      this.pendingBodyMotion.clear();
      if (this.pendingPhysicsSnapshot) {
        this.pendingPhysicsSnapshot = null;
        this.errors.push(
          'This runtime does not include Rapier; restored body transforms and motion instead.',
        );
      }
    }
  }
  component<T extends Component['type']>(
    node: SceneNode,
    type: T,
  ): Extract<Component, { type: T }> | undefined {
    return node.components.find((c) => c.type === type) as any;
  }
  async queryPhysics(query: PhysicsQuery): Promise<PhysicsQueryResult> {
    await this.ready;
    if (
      !this.physics &&
      !this.physicsLoading &&
      (typeof __VOXSHOP_WITH_RAPIER__ === 'undefined' || __VOXSHOP_WITH_RAPIER__)
    ) {
      this.physicsQueryInitialization ??= this.initializePhysics().finally(() => {
        this.physicsQueryInitialization = null;
      });
      await this.physicsQueryInitialization;
    }
    return (
      this.physics?.query(query) ?? {
        available: false,
        shape: query.shape,
        reason: this.physicsLoading
          ? 'Physics initialization is still in progress.'
          : 'This runtime does not include an active Rapier physics scene.',
      }
    );
  }
  private isSolidCollider(node: SceneNode) {
    const collider = this.component(node, 'collider');
    return !!collider && collider.solid && !collider.sensor;
  }
  private craft(recipeId: string, batches: number, nodeId?: string) {
    const recipe = this.recipes.get(recipeId);
    if (!recipe) {
      this.message = `Recipe ${recipeId} is unavailable.`;
      this.emit('craft-failed', nodeId, { recipeId, reason: 'missing-recipe' });
      return false;
    }
    const result = craftInventory(this.inventory, recipe, this.items, batches, this.inventorySlotLimit);
    if (result.status !== 'crafted') {
      this.message =
        result.status === 'missing-items'
          ? `Not enough ingredients for ${recipe.name}.`
          : result.status === 'inventory-full'
            ? `Inventory full; make room before crafting ${recipe.name}.`
            : `A required item for ${recipe.name} is unavailable.`;
      this.emit('craft-failed', nodeId, { recipeId, reason: result.status });
      return false;
    }
    this.inventory = result.inventory;
    this.message = `${recipe.name} crafted.`;
    this.emit('crafted', nodeId, { recipeId, batches });
    return true;
  }
  private changeInventory(change: Extract<Action, { type: 'inventory' }>, nodeId: string) {
    const result = changeInventory(this.inventory, change, this.items, this.inventorySlotLimit);
    if (result.status !== 'changed') {
      const firstRemoved = change.remove.find((entry) => {
        const item = this.items.get(entry.itemId);
        return (
          item &&
          this.inventory.reduce(
            (total, stack) => total + (stack.itemId === entry.itemId ? stack.quantity : 0),
            0,
          ) < entry.quantity
        );
      });
      this.message =
        result.status === 'missing-items' && firstRemoved
          ? `Not enough ${this.items.get(firstRemoved.itemId)!.name} to complete this inventory change.`
          : result.status === 'inventory-full'
            ? 'Inventory full; make room before receiving these items.'
            : result.status === 'missing-item'
              ? 'An item in this inventory change is unavailable.'
              : 'This inventory change could not be applied.';
      this.emit('inventory-failed', nodeId, {
        reason: result.status,
        remove: change.remove.map((entry) => ({ ...entry })),
        add: change.add.map((entry) => ({ ...entry })),
      });
      return false;
    }
    this.inventory = result.inventory;
    const describe = (entries: typeof change.remove, prefix: string) =>
      entries.map(({ itemId, quantity }) => {
        const name = this.items.get(itemId)?.name ?? itemId;
        return `${prefix}${quantity} ${name}`;
      });
    const changes = [...describe(change.remove, '-'), ...describe(change.add, '+')];
    this.message = `Inventory updated: ${changes.join(', ')}.`;
    this.emit('inventory-changed', nodeId, {
      remove: change.remove.map((entry) => ({ ...entry })),
      add: change.add.map((entry) => ({ ...entry })),
    });
    return true;
  }
  enabled(node: SceneNode): boolean {
    if (!node.enabled) return false;
    const gate = this.component(node, 'gate');
    if (gate && (this.variables[gate.variable] ?? 0) >= gate.required) return false;
    return node.parentId ? this.enabled(this.nodes.get(node.parentId)!) : true;
  }
  worldMatrix(node: SceneNode): Matrix4 {
    const t = node.transform;
    const matrix = new Matrix4().compose(
      new Vector3(...t.position),
      new Quaternion().setFromEuler(new Euler(...t.rotation)),
      new Vector3(...t.scale),
    );
    return node.parentId ? this.worldMatrix(this.nodes.get(node.parentId)!).multiply(matrix) : matrix;
  }
  worldPosition(node: SceneNode): Vector3 {
    return new Vector3().setFromMatrixPosition(this.worldMatrix(node));
  }
  private setWorldPosition(node: SceneNode, position: Vector3) {
    if (node.parentId) position.applyMatrix4(this.worldMatrix(this.nodes.get(node.parentId)!).invert());
    node.transform.position = position.toArray() as [number, number, number];
    this.refreshSolids(node);
  }
  private setWorldTransform(node: SceneNode, position: Vector3, rotation: Quaternion) {
    let localPosition = position.clone(),
      localRotation = rotation.clone();
    if (node.parentId) {
      const parentMatrix = this.worldMatrix(this.nodes.get(node.parentId)!),
        parentPosition = new Vector3(),
        parentRotation = new Quaternion(),
        parentScale = new Vector3();
      parentMatrix.decompose(parentPosition, parentRotation, parentScale);
      localPosition.applyMatrix4(parentMatrix.clone().invert());
      localRotation = parentRotation.invert().multiply(localRotation).normalize();
    }
    node.transform.position = localPosition.toArray() as [number, number, number];
    const euler = new Euler().setFromQuaternion(localRotation);
    node.transform.rotation = [euler.x, euler.y, euler.z];
    this.refreshSolids(node);
  }
  private discardCheckpointSpawns() {
    for (const { nodeIds } of this.spawnedPrefabs)
      for (const id of nodeIds) {
        const node = this.nodes.get(id);
        if (node?.parentId) {
          const siblings = this.children.get(node.parentId);
          if (siblings)
            this.children.set(
              node.parentId,
              siblings.filter((child) => child.id !== id),
            );
        }
        this.children.delete(id);
        this.nodes.delete(id);
        this.initialNodeState.delete(id);
        this.nodeOrder.delete(id);
        this.interactionNodeIds.delete(id);
        this.solids.delete(id);
        this.interactables.delete(id);
        this.localBounds.delete(id);
        this.assetBounds.delete(id);
        this.rigidBodyVelocities.delete(id);
        this.pendingBodyMotion.delete(id);
        delete this.health[id];
      }
    const ids = new Set(this.spawnedPrefabs.flatMap((entry) => entry.nodeIds));
    this.scene.nodes = this.scene.nodes.filter((node) => !ids.has(node.id));
    for (const node of this.ruleNodes) if (ids.has(node.id)) this.unindexSignalRules(node);
    this.ruleNodes = this.ruleNodes.filter((node) => !ids.has(node.id));
    this.patrolNodes = this.patrolNodes.filter((node) => !ids.has(node.id));
    this.rigNodes = this.rigNodes.filter((node) => !ids.has(node.id));
    this.contactNodes = this.contactNodes.filter((node) => !ids.has(node.id));
    this.enemyNodes = this.enemyNodes.filter((node) => !ids.has(node.id));
    this.rigidBodyNodes = this.rigidBodyNodes.filter((node) => !ids.has(node.id));
    this.spawnedPrefabs = [];
    this.runtimeSpawnNodeCount = 0;
  }
  private spawnPrefab(action: Extract<Action, { type: 'spawn' }>, source: SceneNode) {
    const prefab = this.prefabs.get(action.prefabId);
    if (!prefab || prefab.nodes.some((node) => this.component(node, 'player'))) return false;
    if (
      this.spawnedPrefabs.length >= MAX_RUNTIME_SPAWNED_INSTANCES ||
      this.runtimeSpawnNodeCount + prefab.nodes.length > MAX_RUNTIME_SPAWNED_NODES
    ) {
      if (!this.runtimeSpawnWarningIssued) {
        this.runtimeSpawnWarningIssued = true;
        this.errors.push('Runtime prefab spawning reached its 5,000-node or 1,000-instance safety limit.');
      }
      this.emit('spawn-limit', source.id, { prefabId: prefab.id });
      return false;
    }
    const position = action.position
      ? new Vector3(...action.position)
      : this.worldPosition(source).add(new Vector3(...(action.offset ?? [0, 0, 0])));
    let instanceId: string;
    let nodeIds: string[];
    do {
      instanceId = `rt${this.nextSpawnId++}`;
      nodeIds = prefab.nodes.map((_, index) => `${instanceId}n${index}`);
    } while (
      this.nodes.has(instanceId) ||
      nodeIds.some((id) => this.nodes.has(id)) ||
      this.spawnedPrefabs.some((entry) => entry.instanceId === instanceId)
    );
    const rootPosition = position.toArray() as [number, number, number];
    let nodes: SceneNode[];
    try {
      nodes = instantiatePrefabNodes(prefab, nodeIds, {
        position: rootPosition,
        ...(action.rotation && { rotation: action.rotation }),
        ...(action.scale && { scale: action.scale }),
        rootParentId: null,
      });
    } catch {
      return false;
    }
    const root = nodes[prefab.nodes.findIndex((node) => node.id === prefab.rootId)];
    const record: GameProgressSpawn = {
      prefabId: prefab.id,
      signature: prefabSignature(prefab),
      instanceId,
      nodeIds,
      rootPosition,
      rootRotation: [...root.transform.rotation],
      rootScale: [...root.transform.scale],
    };
    this.spawnedPrefabs.push(record);
    this.runtimeSpawnNodeCount += nodes.length;
    for (const node of nodes) {
      this.multiplayerRuntimeNodeIds.add(node.id);
      const index = this.scene.nodes.length;
      this.scene.nodes.push(node);
      this.nodes.set(node.id, node);
      this.initialNodeState.set(node.id, {
        transform: structuredClone(node.transform),
        enabled: node.enabled,
        attachments: structuredClone(node.attachments),
      });
      this.nodeOrder.set(node.id, index);
    }
    for (const node of nodes) {
      const health = this.component(node, 'health');
      if (health) this.health[node.id] = health.maximum;
      const gate = this.component(node, 'gate');
      if (gate) this.navigationGateVariables.add(gate.variable);
      if (node.parentId) {
        const children = this.children.get(node.parentId) ?? [];
        children.push(node);
        this.children.set(node.parentId, children);
      }
      const rules = this.component(node, 'rules');
      if (rules) {
        this.ruleNodes.push(node);
        this.indexSignalRules(node);
      }
      if (this.component(node, 'patrol')) this.patrolNodes.push(node);
      if (node.assetId && this.assets.get(node.assetId)?.rig) this.rigNodes.push(node);
      if (this.component(node, 'enemy')) this.enemyNodes.push(node);
      const collider = this.component(node, 'collider');
      if (
        this.component(node, 'enemy') ||
        this.component(node, 'collectible') ||
        rules?.rules.some((rule) => rule.event === 'touch' || rule.event === 'untouch')
      )
        this.contactNodes.push(node);
      if (this.component(node, 'interactable') || rules?.rules.some((rule) => rule.event === 'interact')) {
        this.interactionNodeIds.add(node.id);
        this.interactables.set(node.id, this.bounds(node));
      }
      if (this.isSolidCollider(node)) this.solids.set(node.id, this.bounds(node));
      if (this.component(node, 'rigid-body')) {
        this.rigidBodyNodes.push(node);
        const body = this.component(node, 'rigid-body')!;
        const motion: BodyMotion = {
          linearVelocity: [...body.velocity] as [number, number, number],
          angularVelocity: [...(body.angularVelocity ?? [0, 0, 0])] as [number, number, number],
          sleeping: false,
        };
        this.pendingBodyMotion.set(node.id, motion);
        this.rigidBodyVelocities.set(node.id, new Vector3(...motion.linearVelocity));
      }
      if (
        this.physics &&
        (this.component(node, 'rigid-body') || (collider && (collider.solid || collider.sensor)))
      )
        this.physics.addNode(node);
      if (this.isSolidCollider(node)) this.invalidateNavigation();
      this.pendingSpawnStarts.push(node);
    }
    this.emit('spawned', source.id, { prefabId: prefab.id, instanceId, nodeIds });
    return true;
  }
  private refreshSolids(node: SceneNode) {
    if (this.isSolidCollider(node)) {
      this.solids.set(node.id, this.bounds(node));
      if (!this.component(node, 'player') && !this.component(node, 'enemy')) this.navigationRevision++;
    }
    if (this.interactionNodeIds.has(node.id)) this.interactables.set(node.id, this.bounds(node));
    for (const child of this.children.get(node.id) ?? []) this.refreshSolids(child);
  }
  private nearbySolids(box: Box3) {
    return [...this.solids.query(box)]
      .sort((a, b) => this.nodeOrder.get(a)! - this.nodeOrder.get(b)!)
      .map((id) => this.nodes.get(id)!);
  }
  private findPlayerSupport(node: SceneNode) {
    const box = this.bounds(node),
      epsilon = 0.03;
    let support: SceneNode | null = null,
      nearestGap = Infinity;
    for (const other of this.nearbySolids(box.clone().expandByScalar(epsilon))) {
      if (
        other.id === node.id ||
        !this.enabled(other) ||
        !this.isSolidCollider(other) ||
        this.component(other, 'player') ||
        this.component(other, 'enemy')
      )
        continue;
      const solid = this.bounds(other),
        gap = box.min.y - solid.max.y;
      if (
        gap < -epsilon ||
        gap > epsilon ||
        box.max.x <= solid.min.x + epsilon ||
        box.min.x >= solid.max.x - epsilon ||
        box.max.z <= solid.min.z + epsilon ||
        box.min.z >= solid.max.z - epsilon
      )
        continue;
      if (Math.abs(gap) < nearestGap) {
        support = other;
        nearestGap = Math.abs(gap);
      }
    }
    return support;
  }
  private rememberPlayerSupport(node: SceneNode, grounded: boolean) {
    if (!grounded) {
      this.playerSupports.delete(node.id);
      return;
    }
    const support = this.findPlayerSupport(node);
    if (!support) {
      this.playerSupports.delete(node.id);
      return;
    }
    const previous = this.playerSupports.get(node.id);
    if (previous?.nodeId === support.id) return;
    this.playerSupports.set(node.id, {
      nodeId: support.id,
      revision: this.physics?.platformMotionRevision(support.id) ?? 0,
    });
  }
  private solidCollisionFace(
    node: SceneNode,
    current: Box3,
    next: Box3,
    axis: 'x' | 'y' | 'z',
    ignoredNodeId?: string,
  ) {
    const positive = next.min[axis] >= current.min[axis] - 1e-8,
      epsilon = 1e-5,
      swept = current.clone().union(next);
    let face = positive ? Infinity : -Infinity;
    for (const other of this.nearbySolids(swept)) {
      if (
        other.id === node.id ||
        other.id === ignoredNodeId ||
        !this.enabled(other) ||
        !this.isSolidCollider(other) ||
        this.component(other, 'player') ||
        this.component(other, 'enemy')
      )
        continue;
      const solid = this.bounds(other),
        overlapsOtherAxes =
          (axis === 'x'
            ? current.max.y > solid.min.y + epsilon && current.min.y < solid.max.y - epsilon
            : current.max.x > solid.min.x + epsilon && current.min.x < solid.max.x - epsilon) &&
          (axis === 'z'
            ? current.max.y > solid.min.y + epsilon && current.min.y < solid.max.y - epsilon
            : current.max.z > solid.min.z + epsilon && current.min.z < solid.max.z - epsilon);
      if (!overlapsOtherAxes) continue;

      const overlapsCurrent =
          current.max[axis] > solid.min[axis] + epsilon && current.min[axis] < solid.max[axis] - epsilon,
        overlapsNext =
          next.max[axis] > solid.min[axis] + epsilon && next.min[axis] < solid.max[axis] - epsilon;
      if (overlapsCurrent) {
        if (overlapsNext) face = positive ? Math.min(face, solid.min[axis]) : Math.max(face, solid.max[axis]);
      } else if (
        positive &&
        current.max[axis] <= solid.min[axis] + epsilon &&
        next.max[axis] > solid.min[axis] + epsilon
      )
        face = Math.min(face, solid.min[axis]);
      else if (
        !positive &&
        current.min[axis] >= solid.max[axis] - epsilon &&
        next.min[axis] < solid.max[axis] - epsilon
      )
        face = Math.max(face, solid.max[axis]);
    }
    return Number.isFinite(face) ? face : null;
  }
  private invalidateNavigation() {
    this.navigationRevision++;
  }
  private terrainSegmentTraversable(start: NavigationPoint, end: NavigationPoint, maximumRise: number) {
    const world = this.terrainWorld;
    if (!world) return true;
    const distance = Math.hypot(end.x - start.x, end.z - start.z),
      sampleSpacing = Math.max(world.voxelSize, ENEMY_NAV_CELL_SIZE),
      steps = Math.max(1, Math.ceil(distance / sampleSpacing));
    let previous = this.terrainSurface(start.x, start.z);
    if (previous === null) return false;
    for (let step = 1; step <= steps; step++) {
      const progress = step / steps,
        current = this.terrainSurface(
          start.x + (end.x - start.x) * progress,
          start.z + (end.z - start.z) * progress,
        );
      if (current === null || (current - previous) * world.voxelSize > maximumRise + 1e-6) return false;
      previous = current;
    }
    return true;
  }
  private enemyChaseDirection(enemy: SceneNode, player: SceneNode, towardPlayer: Vector3) {
    if (this.terrainWorld?.generator.mode === 'voxel3d')
      return this.enemyVoxelChaseDirection(enemy, player, towardPlayer);
    const position = this.worldPosition(enemy),
      playerPosition = this.worldPosition(player),
      distance = towardPlayer.length();
    if (distance < 1e-8) return null;
    const targetX = Math.round(playerPosition.x / ENEMY_NAV_CELL_SIZE),
      targetZ = Math.round(playerPosition.z / ENEMY_NAV_CELL_SIZE),
      actorBounds = this.bounds(enemy),
      clearance = this.enemyNavigationClearance(enemy),
      terrainRise = this.terrainWorld
        ? Math.min(this.terrainWorld.voxelSize, (actorBounds.max.y - actorBounds.min.y) * 0.5)
        : null,
      traversable =
        terrainRise === null
          ? undefined
          : (from: NavigationPoint, to: NavigationPoint) =>
              this.terrainSegmentTraversable(from, to, terrainRise),
      cached = this.enemyNavigationRoutes.get(enemy.id);
    if (
      cached &&
      cached.targetX === targetX &&
      cached.targetZ === targetZ &&
      cached.revision === this.navigationRevision &&
      Math.abs(cached.clearance - clearance) < 1e-8 &&
      cached.terrainRise === terrainRise
    ) {
      if (!cached.path) return null;
      while (
        cached.waypoint < cached.path.length &&
        Math.hypot(cached.path[cached.waypoint].x - position.x, cached.path[cached.waypoint].z - position.z) <
          0.08
      )
        cached.waypoint++;
      if (cached.waypoint < cached.path.length) {
        const point = cached.path[cached.waypoint];
        return new Vector3(point.x - position.x, 0, point.z - position.z).normalize();
      }
      this.enemyNavigationRoutes.delete(enemy.id);
    } else this.enemyNavigationRoutes.delete(enemy.id);

    const lookahead = Math.min(6, distance),
      goal = position.clone().addScaledVector(towardPlayer, lookahead / distance),
      padding = ENEMY_NAV_CELL_SIZE * ENEMY_NAV_PADDING_CELLS,
      search = new Box3(
        new Vector3(
          Math.min(position.x, goal.x) - padding,
          actorBounds.min.y,
          Math.min(position.z, goal.z) - padding,
        ),
        new Vector3(
          Math.max(position.x, goal.x) + padding,
          actorBounds.max.y,
          Math.max(position.z, goal.z) + padding,
        ),
      ),
      obstacles: NavigationObstacle[] = [];
    for (const other of this.nearbySolids(search)) {
      if (
        other.id === enemy.id ||
        other.id === player.id ||
        this.component(other, 'player') ||
        this.component(other, 'enemy') ||
        !this.enabled(other) ||
        !this.isSolidCollider(other)
      )
        continue;
      const bounds = this.bounds(other);
      if (bounds.max.y <= actorBounds.min.y + 1e-5 || bounds.min.y >= actorBounds.max.y - 1e-5) continue;
      obstacles.push({ minX: bounds.min.x, maxX: bounds.max.x, minZ: bounds.min.z, maxZ: bounds.max.z });
    }
    if (
      !obstacles.some((obstacle) => segmentHitsObstacle(position, goal, obstacle, clearance)) &&
      (!traversable || traversable(position, goal))
    )
      return towardPlayer.normalize();

    const result = findGridPath(position, goal, obstacles, {
      cellSize: ENEMY_NAV_CELL_SIZE,
      clearance,
      paddingCells: ENEMY_NAV_PADDING_CELLS,
      traversable,
    });
    const route = {
      targetX,
      targetZ,
      revision: this.navigationRevision,
      clearance,
      terrainRise,
      path: result.path && result.path.length > 1 ? result.path : null,
      waypoint: 1,
    };
    this.enemyNavigationRoutes.set(enemy.id, route);
    if (!route.path) return null;
    let waypoint = route.waypoint;
    while (
      waypoint < route.path.length &&
      Math.hypot(route.path[waypoint].x - position.x, route.path[waypoint].z - position.z) < 0.08
    )
      waypoint++;
    route.waypoint = waypoint;
    if (waypoint >= route.path.length) {
      this.enemyNavigationRoutes.delete(enemy.id);
      return towardPlayer.normalize();
    }
    const point = route.path[waypoint];
    return new Vector3(point.x - position.x, 0, point.z - position.z).normalize();
  }
  private enemyNavigationClearance(enemy: SceneNode) {
    // The route follows a turning actor, so its current world AABB changes with yaw. Use a
    // yaw-independent envelope from local bounds and the largest scale along its hierarchy.
    this.bounds(enemy);
    const localBounds = this.localBounds.get(enemy.id)!;
    let planarScale = 1,
      spatialScale = 1,
      tilted = false;
    for (let ancestor: SceneNode | undefined = enemy; ancestor;) {
      const [scaleX, scaleY, scaleZ] = ancestor.transform.scale.map(Math.abs);
      planarScale *= Math.max(scaleX, scaleZ);
      spatialScale *= Math.max(scaleX, scaleY, scaleZ);
      tilted ||=
        Math.abs(ancestor.transform.rotation[0]) > 1e-6 || Math.abs(ancestor.transform.rotation[2]) > 1e-6;
      ancestor = ancestor.parentId ? this.nodes.get(ancestor.parentId) : undefined;
    }
    const halfX = Math.max(Math.abs(localBounds.min.x), Math.abs(localBounds.max.x)),
      halfY = Math.max(Math.abs(localBounds.min.y), Math.abs(localBounds.max.y)),
      halfZ = Math.max(Math.abs(localBounds.min.z), Math.abs(localBounds.max.z)),
      radius = tilted
        ? Math.hypot(halfX, halfY, halfZ) * spatialScale
        : Math.hypot(halfX, halfZ) * planarScale;
    return radius + 0.05;
  }
  private enemyVoxelChaseDirection(enemy: SceneNode, player: SceneNode, towardPlayer: Vector3) {
    const world = this.terrainWorld!,
      position = this.worldPosition(enemy),
      playerPosition = this.worldPosition(player),
      distance = towardPlayer.length();
    if (distance < 1e-8) return null;
    const cellSize = Math.max(ENEMY_NAV_CELL_SIZE, world.voxelSize),
      targetX = Math.round(playerPosition.x / cellSize),
      targetY = Math.round(playerPosition.y / cellSize),
      targetZ = Math.round(playerPosition.z / cellSize),
      actorBounds = this.bounds(enemy),
      canOccupy = (point: NavigationVoxelPoint) =>
        this.terrainVoxelPositionClear(position, actorBounds, point),
      canTravel = (from: NavigationVoxelPoint, to: NavigationVoxelPoint) =>
        this.terrainVoxelSegmentClear(position, actorBounds, from, to),
      cached = this.enemyVoxelNavigationRoutes.get(enemy.id);
    if (
      cached &&
      cached.targetX === targetX &&
      cached.targetY === targetY &&
      cached.targetZ === targetZ &&
      cached.revision === this.navigationRevision &&
      cached.cellSize === cellSize
    ) {
      if (!cached.path) return null;
      while (
        cached.waypoint < cached.path.length &&
        Math.hypot(
          cached.path[cached.waypoint].x - position.x,
          cached.path[cached.waypoint].y - position.y,
          cached.path[cached.waypoint].z - position.z,
        ) < 0.08
      )
        cached.waypoint++;
      if (cached.waypoint < cached.path.length) {
        const point = cached.path[cached.waypoint];
        return new Vector3(point.x - position.x, point.y - position.y, point.z - position.z).normalize();
      }
      this.enemyVoxelNavigationRoutes.delete(enemy.id);
    } else this.enemyVoxelNavigationRoutes.delete(enemy.id);

    const goal = position.clone().addScaledVector(towardPlayer, Math.min(6, distance) / distance),
      startPoint = { x: position.x, y: position.y, z: position.z },
      goalPoint = { x: goal.x, y: goal.y, z: goal.z };
    if (canTravel(startPoint, goalPoint)) return towardPlayer.normalize();

    const result = findVoxelPath(startPoint, goalPoint, {
      cellSize,
      paddingCells: 8,
      traversable: canOccupy,
      segmentTraversable: canTravel,
    });
    const route = {
      targetX,
      targetY,
      targetZ,
      revision: this.navigationRevision,
      cellSize,
      path: result.path && result.path.length > 1 ? result.path : null,
      waypoint: 1,
    };
    this.enemyVoxelNavigationRoutes.set(enemy.id, route);
    if (!route.path) return null;
    let waypoint = route.waypoint;
    while (
      waypoint < route.path.length &&
      Math.hypot(
        route.path[waypoint].x - position.x,
        route.path[waypoint].y - position.y,
        route.path[waypoint].z - position.z,
      ) < 0.08
    )
      waypoint++;
    route.waypoint = waypoint;
    if (waypoint >= route.path.length) {
      this.enemyVoxelNavigationRoutes.delete(enemy.id);
      return towardPlayer.normalize();
    }
    const point = route.path[waypoint];
    return new Vector3(point.x - position.x, point.y - position.y, point.z - position.z).normalize();
  }
  private horizontalBounds(axis: 'x' | 'z'): [number, number] {
    if (!this.terrainBounds) return [-this.scene.bounds, this.scene.bounds];
    return axis === 'x'
      ? [this.terrainBounds.minX, this.terrainBounds.maxX]
      : [this.terrainBounds.minZ, this.terrainBounds.maxZ];
  }
  private isGrounded(node: SceneNode) {
    const box = this.bounds(node);
    const characterGrounded = this.physics?.characterGrounded(node.id);
    if (characterGrounded !== null && characterGrounded !== undefined) return characterGrounded;
    return this.terrainWorld
      ? this.terrainGrounded(node) || this.grounded(node)
      : box.min.y <= 0.02 || this.grounded(node);
  }
  private playerStepPosition(node: SceneNode, currentBox: Box3, targetBox: Box3, maxStepHeight: number) {
    const epsilon = 1e-5,
      tops = new Set<number>(),
      addTop = (height: number) => {
        const rise = height - currentBox.min.y;
        if (rise > epsilon && rise <= maxStepHeight + epsilon) tops.add(height);
      };

    if (this.terrainVoxelCell) {
      const range = this.terrainVoxelRange(targetBox),
        count =
          Math.max(0, range.maxX - range.minX + 1) *
          Math.max(0, range.maxY - range.minY + 1) *
          Math.max(0, range.maxZ - range.minZ + 1);
      if (count > 4096) return null;
      for (let z = range.minZ; z <= range.maxZ; z++)
        for (let y = range.minY; y <= range.maxY; y++)
          for (let x = range.minX; x <= range.maxX; x++) {
            if (!this.terrainVoxelCell({ x, y, z })) continue;
            const solid = this.terrainVoxelBox(x, y, z);
            if (
              targetBox.max.x > solid.min.x + epsilon &&
              targetBox.min.x < solid.max.x - epsilon &&
              targetBox.max.y > solid.min.y + epsilon &&
              targetBox.min.y < solid.max.y - epsilon &&
              targetBox.max.z > solid.min.z + epsilon &&
              targetBox.min.z < solid.max.z - epsilon
            )
              addTop(solid.max.y);
          }
    } else if (this.terrainWorld) {
      const height = this.terrainHeightUnder(targetBox);
      if (height !== null) addTop(height);
    }

    for (const other of this.nearbySolids(targetBox)) {
      if (
        other.id === node.id ||
        !this.enabled(other) ||
        !this.isSolidCollider(other) ||
        this.component(other, 'player') ||
        this.component(other, 'enemy')
      )
        continue;
      const solid = this.bounds(other);
      if (
        targetBox.max.x > solid.min.x + epsilon &&
        targetBox.min.x < solid.max.x - epsilon &&
        targetBox.max.y > solid.min.y + epsilon &&
        targetBox.min.y < solid.max.y - epsilon &&
        targetBox.max.z > solid.min.z + epsilon &&
        targetBox.min.z < solid.max.z - epsilon
      )
        addTop(solid.max.y);
    }

    const shiftX = targetBox.min.x - currentBox.min.x,
      shiftZ = targetBox.min.z - currentBox.min.z;
    for (const top of [...tops].sort((a, b) => a - b)) {
      const lift = top - currentBox.min.y,
        candidate = currentBox.clone().translate(new Vector3(shiftX, lift, shiftZ));
      if (
        (['x', 'z'] as const).some((axis) => {
          const [minimum, maximum] = this.horizontalBounds(axis);
          return candidate.min[axis] < minimum - epsilon || candidate.max[axis] > maximum + epsilon;
        })
      )
        continue;
      if (this.terrainVoxelCell && !this.terrainVoxelBoxClear(candidate)) continue;
      if (this.terrainWorld && !this.terrainVoxelCell) {
        const height = this.terrainHeightUnder(candidate);
        if (height !== null && candidate.min.y < height - epsilon) continue;
      }
      const blocked = this.nearbySolids(candidate).some((other) => {
        if (
          other.id === node.id ||
          !this.enabled(other) ||
          !this.isSolidCollider(other) ||
          this.component(other, 'player') ||
          this.component(other, 'enemy')
        )
          return false;
        const solid = this.bounds(other);
        return (
          candidate.max.x > solid.min.x + epsilon &&
          candidate.min.x < solid.max.x - epsilon &&
          candidate.max.y > solid.min.y + epsilon &&
          candidate.min.y < solid.max.y - epsilon &&
          candidate.max.z > solid.min.z + epsilon &&
          candidate.min.z < solid.max.z - epsilon
        );
      });
      if (!blocked) return this.worldPosition(node).add(new Vector3(0, lift, 0));
    }
    return null;
  }
  private interactionLineOfSight(player: SceneNode, target: SceneNode) {
    const from = this.bounds(player).getCenter(new Vector3());
    const to = this.bounds(target).getCenter(new Vector3());
    const delta = to.clone().sub(from);
    const distance = delta.length();
    if (distance < 1e-6) return true;
    const ray = new Ray(from, delta.multiplyScalar(1 / distance));
    const corridor = new Box3().setFromPoints([from, to]).expandByScalar(1e-5);
    for (const id of this.solids.query(corridor)) {
      if (id === player.id || id === target.id) continue;
      const blocker = this.nodes.get(id);
      if (
        !blocker ||
        !this.enabled(blocker) ||
        !this.isSolidCollider(blocker) ||
        this.component(blocker, 'player')
      )
        continue;
      const hit = ray.intersectBox(this.bounds(blocker), new Vector3());
      if (hit && from.distanceTo(hit) < distance - 1e-5) return false;
    }
    return this.terrainLineOfSight(from, to);
  }

  private terrainLineOfSight(from: Vector3, to: Vector3) {
    const world = this.terrainWorld;
    if (!world) return true;
    const size = world.voxelSize;
    const delta = to.clone().sub(from);
    let x = Math.floor(from.x / size + 0.5),
      y = Math.floor(from.y / size + 0.5),
      z = Math.floor(from.z / size + 0.5);
    const endX = Math.floor(to.x / size + 0.5),
      endY = Math.floor(to.y / size + 0.5),
      endZ = Math.floor(to.z / size + 0.5);
    const stepX = Math.sign(delta.x),
      stepY = Math.sign(delta.y),
      stepZ = Math.sign(delta.z);
    const tDeltaX = stepX ? size / Math.abs(delta.x) : Infinity,
      tDeltaY = stepY ? size / Math.abs(delta.y) : Infinity,
      tDeltaZ = stepZ ? size / Math.abs(delta.z) : Infinity;
    let tMaxX = stepX ? ((x + (stepX > 0 ? 0.5 : -0.5)) * size - from.x) / delta.x : Infinity,
      tMaxY = stepY ? ((y + (stepY > 0 ? 0.5 : -0.5)) * size - from.y) / delta.y : Infinity,
      tMaxZ = stepZ ? ((z + (stepZ > 0 ? 0.5 : -0.5)) * size - from.z) / delta.z : Infinity;
    const occupied = (cellX: number, cellY: number, cellZ: number) =>
      this.terrainVoxelCell
        ? Boolean(this.terrainVoxelCell({ x: cellX, y: cellY, z: cellZ }))
        : (this.terrainSurface(cellX * size, cellZ * size) ?? -Infinity) >= cellY;
    let visited = 0;
    while (x !== endX || y !== endY || z !== endZ) {
      if (++visited > MAX_INTERACTION_QUERY_CELLS) return false;
      const next = Math.min(tMaxX, tMaxY, tMaxZ);
      if (next > 1 || !Number.isFinite(next)) return true;
      if (tMaxX <= next + 1e-10) {
        x += stepX;
        tMaxX += tDeltaX;
      }
      if (tMaxY <= next + 1e-10) {
        y += stepY;
        tMaxY += tDeltaY;
      }
      if (tMaxZ <= next + 1e-10) {
        z += stepZ;
        tMaxZ += tDeltaZ;
      }
      if (x === endX && y === endY && z === endZ) return true;
      if (occupied(x, y, z)) return false;
    }
    return true;
  }

  private findInteractionTarget(player: SceneNode) {
    const position = this.worldPosition(player);
    // Ranges are capped at 100m in the document schema, so the broad phase remains bounded.
    const search = new Box3(position.clone().addScalar(-100), position.clone().addScalar(100));
    let nearest: { nodeId: string; prompt: string; distanceMeters: number } | null = null;
    const candidates = [...this.interactables.query(search)].sort(
      (a, b) => this.nodeOrder.get(a)! - this.nodeOrder.get(b)!,
    );
    for (const id of candidates) {
      const node = this.nodes.get(id);
      if (!node || node.id === player.id || !this.enabled(node)) continue;
      const explicit = this.component(node, 'interactable');
      const rules = this.component(node, 'rules');
      if (!explicit && !rules?.rules.some((rule) => rule.event === 'interact')) continue;
      const distanceMeters = this.bounds(node).distanceToPoint(position);
      const range = explicit?.range ?? 3;
      if (distanceMeters > range) continue;
      if (explicit?.requiresLineOfSight && !this.interactionLineOfSight(player, node)) continue;
      if (!nearest || distanceMeters < nearest.distanceMeters - 1e-8)
        nearest = { nodeId: node.id, prompt: explicit?.prompt ?? 'Interact', distanceMeters };
    }
    return nearest;
  }
  private terrainSurface(x: number, z: number): number | null {
    const world = this.terrainWorld;
    if (!world || !this.terrainSurfaceCell) return null;
    const cellX = Math.floor(x / world.voxelSize + 0.5);
    const cellZ = Math.floor(z / world.voxelSize + 0.5);
    const key = `${cellX},${cellZ}`;
    if (this.terrainColumns.has(key)) return this.terrainColumns.get(key)!;

    const { generator } = world;
    const [originX, originZ] = generator.origin;
    const [width, depth] = generator.size;
    let surface: number | null = null;
    if (cellX >= originX && cellX < originX + width && cellZ >= originZ && cellZ < originZ + depth) {
      surface = this.terrainSurfaceCell(cellX, cellZ);
      const edits = this.terrainEdits.get(key);
      while (surface >= generator.minY && edits?.get(surface) === null) surface--;
      if (surface < generator.minY) surface = null;
    }

    const placed = this.highestTerrainEdits.get(key);
    if (placed !== undefined && (surface === null || placed > surface)) surface = placed;
    this.terrainColumns.set(key, surface);
    return surface;
  }
  private terrainHeightUnder(box: Box3): number | null {
    const world = this.terrainWorld;
    if (!world) return null;
    const size = world.voxelSize;
    const [originX, originZ] = world.generator.origin;
    const [worldWidth, worldDepth] = world.generator.size;
    const minX = Math.max(originX, Math.ceil(box.min.x / size - 0.5));
    const maxX = Math.min(originX + worldWidth - 1, Math.floor(box.max.x / size + 0.5));
    const minZ = Math.max(originZ, Math.ceil(box.min.z / size - 0.5));
    const maxZ = Math.min(originZ + worldDepth - 1, Math.floor(box.max.z / size + 0.5));
    let highest: number | null = null;
    const width = Math.max(0, maxX - minX + 1);
    const depth = Math.max(0, maxZ - minZ + 1);
    if (width * depth <= 4096) {
      for (let z = minZ; z <= maxZ; z++)
        for (let x = minX; x <= maxX; x++) {
          const surface = this.terrainSurface(x * size, z * size);
          if (surface !== null && (highest === null || surface > highest)) highest = surface;
        }
    } else {
      for (const x of [box.min.x, (box.min.x + box.max.x) / 2, box.max.x])
        for (const z of [box.min.z, (box.min.z + box.max.z) / 2, box.max.z]) {
          const surface = this.terrainSurface(x, z);
          if (surface !== null && (highest === null || surface > highest)) highest = surface;
        }
    }
    return highest === null ? null : (highest + 0.5) * size;
  }
  private terrainVoxelRange(box: Box3) {
    const size = this.terrainWorld!.voxelSize;
    return {
      minX: Math.ceil(box.min.x / size - 0.5),
      maxX: Math.floor(box.max.x / size + 0.5),
      minY: Math.ceil(box.min.y / size - 0.5),
      maxY: Math.floor(box.max.y / size + 0.5),
      minZ: Math.ceil(box.min.z / size - 0.5),
      maxZ: Math.floor(box.max.z / size + 0.5),
    };
  }
  private terrainVoxelBoxClear(box: Box3) {
    const world = this.terrainWorld;
    if (!world || !this.terrainVoxelCell || !this.terrainBounds) return false;
    const size = world.voxelSize,
      verticalMin = (world.generator.minY - 0.5) * size,
      verticalMax = (world.generator.maxY + 0.5) * size;
    if (
      box.min.x < this.terrainBounds.minX - 1e-5 ||
      box.max.x > this.terrainBounds.maxX + 1e-5 ||
      box.min.z < this.terrainBounds.minZ - 1e-5 ||
      box.max.z > this.terrainBounds.maxZ + 1e-5 ||
      box.min.y < verticalMin - 1e-5 ||
      box.max.y > verticalMax + 1e-5
    )
      return false;
    const range = this.terrainVoxelRange(box),
      count =
        Math.max(0, range.maxX - range.minX + 1) *
        Math.max(0, range.maxY - range.minY + 1) *
        Math.max(0, range.maxZ - range.minZ + 1);
    if (count > 4096) return false;
    for (let z = range.minZ; z <= range.maxZ; z++)
      for (let y = range.minY; y <= range.maxY; y++)
        for (let x = range.minX; x <= range.maxX; x++) {
          if (!this.terrainVoxelCell({ x, y, z })) continue;
          const solid = this.terrainVoxelBox(x, y, z);
          if (
            box.max.x > solid.min.x + 1e-5 &&
            box.min.x < solid.max.x - 1e-5 &&
            box.max.y > solid.min.y + 1e-5 &&
            box.min.y < solid.max.y - 1e-5 &&
            box.max.z > solid.min.z + 1e-5 &&
            box.min.z < solid.max.z - 1e-5
          )
            return false;
        }
    return true;
  }
  private terrainVoxelPositionClear(origin: Vector3, actorBounds: Box3, position: NavigationVoxelPoint) {
    const box = actorBounds.clone().translate(new Vector3(position.x, position.y, position.z).sub(origin));
    return this.terrainVoxelBoxClear(box);
  }
  private terrainVoxelSegmentClear(
    origin: Vector3,
    actorBounds: Box3,
    start: NavigationVoxelPoint,
    end: NavigationVoxelPoint,
  ) {
    const world = this.terrainWorld;
    if (!world) return false;
    const distance = Math.hypot(end.x - start.x, end.y - start.y, end.z - start.z),
      spacing = Math.min(0.25, world.voxelSize / 2),
      steps = Math.max(1, Math.ceil(distance / spacing));
    for (let step = 1; step <= steps; step++) {
      const progress = step / steps;
      if (
        !this.terrainVoxelPositionClear(origin, actorBounds, {
          x: start.x + (end.x - start.x) * progress,
          y: start.y + (end.y - start.y) * progress,
          z: start.z + (end.z - start.z) * progress,
        })
      )
        return false;
    }
    return true;
  }
  private terrainVoxelBox(x: number, y: number, z: number) {
    const size = this.terrainWorld!.voxelSize;
    const center = new Vector3(x * size, y * size, z * size);
    const half = size / 2;
    return new Box3(center.clone().addScalar(-half), center.clone().addScalar(half));
  }
  private terrainVoxelCollisionFace(current: Box3, next: Box3, axis: 'x' | 'y' | 'z'): number | null {
    if (!this.terrainVoxelCell || !this.terrainWorld) return null;
    const positive = next.min[axis] >= current.min[axis] - 1e-8;
    const probe = current.clone();
    probe.min[axis] = positive ? current.max[axis] : next.min[axis];
    probe.max[axis] = positive ? next.max[axis] : current.min[axis];
    const range = this.terrainVoxelRange(probe);
    const count =
      Math.max(0, range.maxX - range.minX + 1) *
      Math.max(0, range.maxY - range.minY + 1) *
      Math.max(0, range.maxZ - range.minZ + 1);
    // Keep every collision query proportional to the moving collider's footprint.
    // Oversized colliders conservatively stay put instead of scanning an unbounded world volume.
    if (count > 4096) return current[positive ? 'max' : 'min'][axis];
    const epsilon = 1e-5;
    let face = positive ? Infinity : -Infinity;
    for (let z = range.minZ; z <= range.maxZ; z++)
      for (let y = range.minY; y <= range.maxY; y++)
        for (let x = range.minX; x <= range.maxX; x++) {
          if (!this.terrainVoxelCell!({ x, y, z })) continue;
          const solid = this.terrainVoxelBox(x, y, z);
          const overlapsOtherAxes =
            (axis === 'x'
              ? current.max.y > solid.min.y + epsilon && current.min.y < solid.max.y - epsilon
              : current.max.x > solid.min.x + epsilon && current.min.x < solid.max.x - epsilon) &&
            (axis === 'z'
              ? current.max.y > solid.min.y + epsilon && current.min.y < solid.max.y - epsilon
              : current.max.z > solid.min.z + epsilon && current.min.z < solid.max.z - epsilon);
          if (!overlapsOtherAxes) continue;
          if (
            positive &&
            current.max[axis] <= solid.min[axis] + epsilon &&
            next.max[axis] > solid.min[axis] + epsilon
          )
            face = Math.min(face, solid.min[axis]);
          if (
            !positive &&
            current.min[axis] >= solid.max[axis] - epsilon &&
            next.min[axis] < solid.max[axis] - epsilon
          )
            face = Math.max(face, solid.max[axis]);
        }
    return Number.isFinite(face) ? face : null;
  }
  private terrainVoxelGrounded(box: Box3): boolean {
    if (!this.terrainVoxelCell || !this.terrainWorld) return false;
    const probe = box.clone();
    probe.min.y -= 0.03;
    const range = this.terrainVoxelRange(probe);
    const count =
      Math.max(0, range.maxX - range.minX + 1) *
      Math.max(0, range.maxY - range.minY + 1) *
      Math.max(0, range.maxZ - range.minZ + 1);
    if (count > 4096) return false;
    for (let z = range.minZ; z <= range.maxZ; z++)
      for (let y = range.minY; y <= range.maxY; y++)
        for (let x = range.minX; x <= range.maxX; x++) {
          if (!this.terrainVoxelCell({ x, y, z })) continue;
          const solid = this.terrainVoxelBox(x, y, z);
          if (
            Math.abs(box.min.y - solid.max.y) <= 0.03 &&
            box.max.x > solid.min.x + 1e-5 &&
            box.min.x < solid.max.x - 1e-5 &&
            box.max.z > solid.min.z + 1e-5 &&
            box.min.z < solid.max.z - 1e-5
          )
            return true;
        }
    return false;
  }
  bounds(node: SceneNode): Box3 {
    const cached = this.localBounds.get(node.id);
    if (cached) return cached.clone().applyMatrix4(this.worldMatrix(node));
    const collider = this.component(node, 'collider');
    let min: Vector3, max: Vector3;
    if (collider) {
      const c = new Vector3(...collider.offset),
        half = new Vector3(...collider.size).multiplyScalar(0.5);
      min = c.clone().sub(half);
      max = c.clone().add(half);
    } else {
      const a = node.assetId && this.assets.get(node.assetId);
      min = new Vector3(Infinity, Infinity, Infinity);
      max = new Vector3(-Infinity, -Infinity, -Infinity);
      const cachedAsset = a && this.assetBounds.get(a.id);
      if (cachedAsset) {
        min.copy(cachedAsset.min);
        max.copy(cachedAsset.max);
      } else if (a && a.model.voxels.length) {
        for (const v of a.model.voxels) {
          min.min(new Vector3(v.x - 0.5, v.y - 0.5, v.z - 0.5));
          max.max(new Vector3(v.x + 0.5, v.y + 0.5, v.z + 0.5));
        }
        min.sub(new Vector3(...a.pivot)).multiplyScalar(a.voxelSize);
        max.sub(new Vector3(...a.pivot)).multiplyScalar(a.voxelSize);
        this.assetBounds.set(a.id, new Box3(min.clone(), max.clone()));
      } else {
        min.set(-0.5, -0.5, -0.5);
        max.set(0.5, 0.5, 0.5);
      }
    }
    const local = new Box3(min, max);
    this.localBounds.set(node.id, local);
    return local.clone().applyMatrix4(this.worldMatrix(node));
  }
  emit(type: string, nodeId?: string, data?: unknown) {
    const event = { frame: this.frame, type, nodeId, data };
    this.events.push(event);
    if (this.events.length > 200) this.events.shift();
    this.onEvent?.(event);
  }
  private dispatch(
    node: SceneNode,
    event: Rule['event'],
    marker?: string,
    otherNode?: SceneNode,
    eventId?: string,
  ) {
    this.dispatchDepth++;
    try {
      this.dispatchRules(node, event, marker, otherNode, eventId);
    } finally {
      this.dispatchDepth--;
      if (!this.dispatchDepth) {
        this.flushSpawnStarts();
        this.flushSignals();
      }
    }
  }
  private indexSignalRules(node: SceneNode) {
    const eventIds = new Set<string>();
    for (const rule of this.component(node, 'rules')?.rules ?? [])
      if (rule.event === 'signal' && rule.eventId) eventIds.add(rule.eventId);
    for (const eventId of eventIds) {
      const listeners = this.signalListeners.get(eventId) ?? [];
      listeners.push(node);
      this.signalListeners.set(eventId, listeners);
    }
  }
  private unindexSignalRules(node: SceneNode) {
    const eventIds = new Set<string>();
    for (const rule of this.component(node, 'rules')?.rules ?? [])
      if (rule.event === 'signal' && rule.eventId) eventIds.add(rule.eventId);
    for (const eventId of eventIds) {
      const listeners = this.signalListeners.get(eventId);
      if (!listeners) continue;
      const index = listeners.indexOf(node);
      if (index >= 0) listeners.splice(index, 1);
      if (!listeners.length) this.signalListeners.delete(eventId);
    }
  }
  private flushSignals() {
    if (this.drainingSignals) return;
    if (this.pendingSceneTransition) {
      this.pendingSignals.length = 0;
      return;
    }
    this.drainingSignals = true;
    let cursor = 0;
    try {
      while (cursor < this.pendingSignals.length && !this.pendingSceneTransition) {
        const signal = this.pendingSignals[cursor++];
        this.emit('signal', signal.sourceNodeId, { eventId: signal.eventId });
        for (const node of this.signalListeners.get(signal.eventId)?.slice() ?? []) {
          if (!node.enabled || this.nodes.get(node.id) !== node) continue;
          this.dispatch(node, 'signal', undefined, undefined, signal.eventId);
          if (this.pendingSceneTransition) break;
        }
      }
    } finally {
      this.pendingSignals.length = 0;
      this.drainingSignals = false;
    }
  }
  private dispatchRules(
    node: SceneNode,
    event: Rule['event'],
    marker?: string,
    otherNode?: SceneNode,
    eventId?: string,
  ) {
    const c = this.component(node, 'rules');
    if (!c) return;
    for (let i = 0; i < c.rules.length; i++) {
      const rule = c.rules[i],
        key = `${node.id}:${i}`;
      if (
        rule.event !== event ||
        (rule.marker && rule.marker !== marker) ||
        rule.eventId !== eventId ||
        (rule.once && this.fired.has(key))
      )
        continue;
      if (event === 'tick' && this.simulatedSeconds + 1e-9 < (this.timers.get(key) ?? 0)) continue;
      if (
        (rule.condition && !this.conditionPasses(rule.condition)) ||
        (rule.conditionGroup &&
          (rule.conditionGroup.mode === 'all'
            ? !rule.conditionGroup.conditions.every((condition) => this.conditionPasses(condition))
            : !rule.conditionGroup.conditions.some((condition) => this.conditionPasses(condition))))
      )
        continue;
      if (rule.once) this.fired.add(key);
      if (event === 'tick') this.timers.set(key, this.simulatedSeconds + rule.interval);
      let actionFailed = false;
      for (const action of rule.actions) {
        if (--this.actionBudget < 0)
          throw new Error('Gameplay exceeded 4096 actions in a single simulation step.');
        const target =
          'target' in action && action.target === COLLISION_OTHER_TARGET
            ? otherNode
            : 'target' in action && action.target
              ? this.nodes.get(action.target)
              : node;
        switch (action.type) {
          case 'set':
          case 'add': {
            let value = action.value;
            if (action.formula !== undefined) {
              try {
                let formula = this.numericFormulas.get(action);
                if (!formula) {
                  formula = compileGameFormula(action.formula);
                  this.numericFormulas.set(action, formula);
                }
                value = formula({
                  variable: (scope, id) =>
                    numericOwnValue(scope === 'campaign' ? this.campaignVariables : this.variables, id),
                  item: (id) =>
                    this.inventory.reduce(
                      (total, stack) => total + (stack.itemId === id ? stack.quantity : 0),
                      0,
                    ),
                  health: (id) => numericOwnValue(this.health, id),
                  time: this.simulatedSeconds,
                  frame: this.frame,
                });
              } catch (error) {
                this.message = `Could not calculate ${action.variable}: ${(error as Error).message}`;
                this.emit('message', node.id, this.message);
                actionFailed = true;
                break;
              }
            }
            const variables = action.scope === 'campaign' ? this.campaignVariables : this.variables;
            const next = action.type === 'add' ? numericOwnValue(variables, action.variable) + value : value;
            if (!Number.isFinite(next)) {
              this.message = `Could not calculate ${action.variable}: result must be finite.`;
              this.emit('message', node.id, this.message);
              actionFailed = true;
              break;
            }
            this.writeVariable(action.variable, next, action.scope);
            if (action.scope !== 'campaign' && this.navigationGateVariables.has(action.variable))
              this.invalidateNavigation();
            break;
          }
          case 'destroy':
            if (target) this.destroy(target);
            break;
          case 'enable':
            if (target) {
              target.enabled = action.value;
              this.invalidateNavigation();
            }
            break;
          case 'emit':
            this.pendingSignals.push({ eventId: action.eventId, sourceNodeId: node.id });
            break;
          case 'message':
            this.message = action.text;
            this.emit('message', node.id, action.text);
            break;
          case 'sound':
            this.emit('sound', node.id, action);
            break;
          case 'audio':
            this.emit('audio', node.id, action);
            break;
          case 'win':
            this.status = 'won';
            this.emit('won', node.id);
            break;
          case 'lose':
            this.status = 'lost';
            this.emit('lost', node.id);
            break;
          case 'damage':
            if (target) this.damage(target, action.amount);
            break;
          case 'heal':
            if (target) this.heal(target, action.amount);
            break;
          case 'teleport':
            if (target) this.setWorldPosition(target, new Vector3(...action.position));
            break;
          case 'craft':
            actionFailed = !this.craft(action.recipeId, action.batches, node.id);
            break;
          case 'inventory':
            actionFailed = !this.changeInventory(action, node.id);
            break;
          case 'transition':
            this.pendingSceneTransition = action.sceneId;
            this.emit('scene-transition', node.id, { sceneId: action.sceneId });
            break;
          case 'spawn':
            actionFailed = !this.spawnPrefab(action, node);
            break;
        }
        if (actionFailed) break;
        if (this.pendingSceneTransition) return;
      }
      if (actionFailed && rule.once) this.fired.delete(key);
    }
  }
  private flushSpawnStarts() {
    if (this.drainingSpawnStarts || this.pendingSceneTransition) return;
    this.drainingSpawnStarts = true;
    let processed = 0;
    try {
      while (this.pendingSpawnStarts.length && !this.pendingSceneTransition) {
        if (++processed > MAX_RUNTIME_SPAWNED_NODES) {
          this.pendingSpawnStarts.length = 0;
          this.errors.push('Runtime prefab start rules exceeded their per-dispatch safety limit.');
          break;
        }
        this.dispatch(this.pendingSpawnStarts.shift()!, 'start');
      }
    } finally {
      this.drainingSpawnStarts = false;
    }
  }
  private destroy(node: SceneNode) {
    if (!node.enabled) return;
    node.enabled = false;
    this.invalidateNavigation();
    this.enemyNavigationRoutes.delete(node.id);
    this.enemyVoxelNavigationRoutes.delete(node.id);
    this.emit('destroyed', node.id);
    if (this.component(node, 'enemy')) this.variables.kills = (this.variables.kills ?? 0) + 1;
    this.dispatch(node, 'destroyed');
  }
  private damage(node: SceneNode, amount: number) {
    if (this.health[node.id] === undefined || !this.enabled(node)) return;
    this.health[node.id] = Math.max(0, this.health[node.id] - amount);
    this.emit('damage', node.id, { amount, remaining: this.health[node.id] });
    if (!this.health[node.id]) {
      this.destroy(node);
      if (this.component(node, 'player')) {
        const playerId = this.multiplayerPlayerByNode.get(node.id),
          roomPlayers = [...this.multiplayerConnectedPlayers],
          livingRoomPlayer = roomPlayers.some((connectedId) => {
            const actorId = this.multiplayerActors.get(connectedId),
              actor = actorId && this.nodes.get(actorId);
            return !!actor && actor.enabled && (this.health[actor.id] ?? 0) > 0;
          });
        if (!playerId || (roomPlayers.length > 0 && !livingRoomPlayer)) {
          this.status = 'lost';
          this.emit('lost', node.id);
        }
      }
    }
  }
  private heal(node: SceneNode, amount: number) {
    const maximum = this.component(node, 'health')?.maximum;
    if (maximum === undefined || this.health[node.id] === undefined || !this.enabled(node)) return;
    this.health[node.id] = Math.min(maximum, this.health[node.id] + amount);
    this.emit('healed', node.id, { amount, remaining: this.health[node.id] });
  }
  private useItem(player: SceneNode, itemId: string) {
    const item = this.items.get(itemId),
      effect = item?.use;
    if (!item || !effect) {
      this.message = 'That inventory item cannot be used.';
      return;
    }
    if (effect.type === 'equip') {
      const gear = this.assets.get(effect.assetId),
        fit = gear?.equipment,
        body = player.assetId ? this.assets.get(player.assetId) : undefined;
      if (
        !gear ||
        !fit ||
        !body?.rig ||
        fit.bodyAssetId !== body.id ||
        fit.profile !== body.rig.profile ||
        !body.rig.sockets.some((socket) => socket.name === fit.socket)
      ) {
        this.message = 'That equipment is not compatible with this player.';
        return;
      }
      if (!this.inventory.some((stack) => stack.itemId === itemId && stack.quantity > 0)) {
        this.message = `You do not have ${item.name}.`;
        return;
      }
      const occupiesSlot = (attachment: SceneNode['attachments'][number]) =>
          attachment.slot === fit.kind || this.assets.get(attachment.assetId)?.equipment?.kind === fit.kind,
        wasEquipped = player.attachments.some(
          (attachment) => occupiesSlot(attachment) && attachment.assetId === gear.id,
        );
      player.attachments = player.attachments.filter((attachment) => !occupiesSlot(attachment));
      if (!wasEquipped)
        player.attachments.push({
          assetId: gear.id,
          socket: fit.socket,
          slot: fit.kind,
          transform: identityTransform(),
          hiddenBones: [...fit.hiddenBones],
        });
      this.message = wasEquipped ? `Unequipped ${gear.name}.` : `Equipped ${gear.name}.`;
      this.emit('equipment-changed', player.id, {
        itemId,
        assetId: gear.id,
        slot: fit.kind,
        equipped: !wasEquipped,
      });
      this.emit('item-used', player.id, {
        itemId,
        effect: 'equip',
        assetId: gear.id,
        slot: fit.kind,
        equipped: !wasEquipped,
      });
      return;
    }
    const maximum = this.component(player, 'health')?.maximum,
      current = this.health[player.id];
    if (maximum === undefined || current === undefined) {
      this.message = 'This player has no health system.';
      return;
    }
    const restored = Math.min(maximum, current + effect.amount) - current;
    if (restored <= 0) {
      this.message = 'Health is already full.';
      return;
    }
    const inventory = removeInventoryItem(this.inventory, itemId, 1);
    if (!inventory) {
      this.message = `You do not have ${item.name}.`;
      return;
    }
    this.inventory = inventory;
    this.heal(player, restored);
    this.message = `Used ${item.name}. Restored ${restored} health.`;
    this.emit('item-used', player.id, { itemId, effect: 'heal', amount: restored });
  }
  private stopStepAfterTransition(input: GameInput) {
    if (!this.pendingSceneTransition) return false;
    this.previous = { ...input };
    this.currentInteractionTarget = null;
    return true;
  }
  private move(node: SceneNode, delta: Vector3): boolean {
    const player = this.component(node, 'player'),
      collider = this.component(node, 'collider'),
      stepHeight = player?.stepHeight ?? 0,
      groundedBeforeMove =
        !!player && (this.isGrounded(node) || (!collider?.shape && this.playerSupports.has(node.id))),
      canStepUp =
        !!player && stepHeight > 0 && (this.velocities.get(node.id) ?? 0) <= 0 && groundedBeforeMove;
    let movementDelta = delta.clone(),
      carriedSupportNodeId: string | null = null,
      ignoredCarriedSupportNodeId: string | null = null,
      carriedSupportDelta = new Vector3();
    if (player && !collider?.shape && groundedBeforeMove && delta.y <= 1e-5) {
      const support = this.playerSupports.get(node.id),
        displacement =
          support &&
          this.physics?.platformMotionSince(support.nodeId, support.revision, this.worldPosition(node));
      if (support && displacement) {
        carriedSupportDelta.copy(displacement.delta);
        movementDelta.add(displacement.delta);
        if (delta.y <= 1e-5) movementDelta.y = displacement.delta.y;
        support.revision = displacement.revision;
        carriedSupportNodeId = support.nodeId;
        if (Math.abs(displacement.delta.y) > 1e-5 || displacement.rotated)
          ignoredCarriedSupportNodeId = support.nodeId;
      }
    }
    const steps = Math.max(1, Math.ceil(movementDelta.length() / 0.2)),
      step = movementDelta.divideScalar(steps);
    if (player && collider?.solid && !collider.sensor && this.physics) {
      this.playerSupports.delete(node.id);
      const current = this.worldPosition(node),
        currentBounds = this.bounds(node),
        movement = this.physics.moveCharacter(
          node.id,
          delta,
          canStepUp ? stepHeight : 0,
          player.maxSlopeAngle ?? 45,
          groundedBeforeMove,
        );
      if (movement) {
        const target = current.clone().add(movement.movement);
        for (const axis of ['x', 'z'] as const) {
          const [minimum, maximum] = this.horizontalBounds(axis),
            minOffset = currentBounds.min[axis] - current[axis],
            maxOffset = currentBounds.max[axis] - current[axis];
          target[axis] = Math.max(minimum - minOffset, Math.min(maximum - maxOffset, target[axis]));
        }
        this.setWorldPosition(node, target);
        if (
          Math.abs(movement.movement.y - delta.y) > 1e-5 &&
          (delta.y > 0 || (delta.y < 0 && movement.grounded))
        )
          this.velocities.set(node.id, 0);
        return movement.grounded;
      }
    }
    let grounded = false;
    for (let n = 0; n < steps; n++)
      for (const axis of ['x', 'z', 'y'] as const) {
        if (!step[axis]) continue;
        const position = this.worldPosition(node);
        const currentBox = this.bounds(node);
        position[axis] += step[axis];
        this.setWorldPosition(node, position);
        let box = this.bounds(node);
        const offset = new Vector3();
        let blockedBySolid = false;
        const applyCorrection = (amount: number) => {
          offset[axis] = step[axis] > 0 ? Math.min(offset[axis], amount) : Math.max(offset[axis], amount);
        };
        if (this.terrainVoxelCell) {
          const face = this.terrainVoxelCollisionFace(currentBox, box, axis);
          if (face !== null) {
            blockedBySolid = true;
            offset[axis] = face - (step[axis] > 0 ? box.max[axis] : box.min[axis]);
            if (axis === 'y') {
              if (step.y < 0) grounded = true;
              this.velocities.set(node.id, 0);
            }
          }
        } else if (axis === 'y') {
          const terrainHeight = this.terrainHeightUnder(box);
          if (terrainHeight !== null && box.min.y < terrainHeight) {
            offset.y = terrainHeight - box.min.y;
            grounded = true;
            this.velocities.set(node.id, 0);
          } else if (!this.terrainWorld && box.min.y < 0) {
            offset.y = -box.min.y;
            grounded = true;
            this.velocities.set(node.id, 0);
          }
        }
        if (axis !== 'y') {
          const [minimum, maximum] = this.horizontalBounds(axis);
          if (box.min[axis] < minimum) {
            const correction = minimum - box.min[axis];
            if (this.terrainVoxelCell) applyCorrection(correction);
            else offset[axis] = correction;
          }
          if (box.max[axis] > maximum) {
            const correction = maximum - box.max[axis];
            if (this.terrainVoxelCell) applyCorrection(correction);
            else offset[axis] = correction;
          }
        }
        const solidFace = this.solidCollisionFace(
          node,
          currentBox,
          box,
          axis,
          Math.abs(carriedSupportDelta[axis]) > 1e-5 ? (ignoredCarriedSupportNodeId ?? undefined) : undefined,
        );
        if (solidFace !== null) {
          blockedBySolid = true;
          const adjustment = solidFace - box[step[axis] > 0 ? 'max' : 'min'][axis];
          applyCorrection(adjustment);
          if (axis === 'y') {
            if (step.y < 0) grounded = true;
            this.velocities.set(node.id, 0);
          }
        }
        if (axis !== 'y' && blockedBySolid && canStepUp) {
          const steppedPosition = this.playerStepPosition(node, currentBox, box, stepHeight);
          if (steppedPosition) {
            this.setWorldPosition(node, steppedPosition);
            continue;
          }
        }
        this.setWorldPosition(node, this.worldPosition(node).add(offset));
      }
    if (player && carriedSupportNodeId && this.findPlayerSupport(node)?.id === carriedSupportNodeId)
      grounded = true;
    if (player) this.rememberPlayerSupport(node, grounded);
    return grounded;
  }
  private simulateRigidBody(
    node: SceneNode,
    body: Extract<Component, { type: 'rigid-body' }>,
    deltaSeconds: number,
  ) {
    const velocity = this.rigidBodyVelocities.get(node.id) ?? new Vector3(...body.velocity);
    velocity.y -= body.gravity * deltaSeconds;
    velocity.multiplyScalar(Math.exp(-body.linearDamping * deltaSeconds)).clampLength(0, 100);
    const steps = Math.max(1, Math.ceil((velocity.length() * deltaSeconds) / 0.2));
    const substep = deltaSeconds / steps;
    for (let i = 0; i < steps; i++)
      for (const axis of ['x', 'z', 'y'] as const) {
        const amount = velocity[axis] * substep;
        if (Math.abs(amount) < 1e-8) continue;
        const current = this.bounds(node),
          position = this.worldPosition(node);
        position[axis] += amount;
        this.setWorldPosition(node, position);
        const box = this.bounds(node),
          positive = amount > 0;
        let face = positive ? Infinity : -Infinity;
        if (this.terrainVoxelCell) {
          const voxelFace = this.terrainVoxelCollisionFace(current, box, axis);
          if (voxelFace !== null) face = positive ? Math.min(face, voxelFace) : Math.max(face, voxelFace);
        } else if (axis === 'y' && !positive) {
          const terrainHeight = this.terrainHeightUnder(box);
          if (terrainHeight !== null && box.min.y < terrainHeight) face = Math.max(face, terrainHeight);
          else if (!this.terrainWorld && box.min.y < 0) face = Math.max(face, 0);
        }
        if (axis !== 'y') {
          const [minimum, maximum] = this.horizontalBounds(axis);
          if (positive && box.max[axis] > maximum) face = Math.min(face, maximum);
          if (!positive && box.min[axis] < minimum) face = Math.max(face, minimum);
        }
        const overlapsOtherAxes = (other: Box3) =>
          (axis === 'x'
            ? box.max.y > other.min.y + 1e-5 && box.min.y < other.max.y - 1e-5
            : axis === 'y'
              ? box.max.x > other.min.x + 1e-5 && box.min.x < other.max.x - 1e-5
              : box.max.x > other.min.x + 1e-5 && box.min.x < other.max.x - 1e-5) &&
          (axis === 'z'
            ? box.max.y > other.min.y + 1e-5 && box.min.y < other.max.y - 1e-5
            : axis === 'y'
              ? box.max.z > other.min.z + 1e-5 && box.min.z < other.max.z - 1e-5
              : box.max.z > other.min.z + 1e-5 && box.min.z < other.max.z - 1e-5);
        for (const other of this.nearbySolids(box)) {
          if (
            other.id === node.id ||
            !this.enabled(other) ||
            !this.isSolidCollider(other) ||
            this.component(other, 'player') ||
            this.component(other, 'enemy')
          )
            continue;
          const solid = this.bounds(other);
          if (!overlapsOtherAxes(solid)) continue;
          if (positive && current.max[axis] <= solid.min[axis] + 1e-5 && box.max[axis] > solid.min[axis])
            face = Math.min(face, solid.min[axis]);
          if (!positive && current.min[axis] >= solid.max[axis] - 1e-5 && box.min[axis] < solid.max[axis])
            face = Math.max(face, solid.max[axis]);
        }
        const crossed = positive ? box.max[axis] > face + 1e-5 : box.min[axis] < face - 1e-5;
        if (!Number.isFinite(face) || !crossed) continue;
        position.copy(this.worldPosition(node));
        position[axis] += positive ? face - box.max[axis] : face - box.min[axis];
        this.setWorldPosition(node, position);
        velocity[axis] = Math.abs(velocity[axis]) < 0.35 ? 0 : -velocity[axis] * body.restitution;
      }
    this.rigidBodyVelocities.set(node.id, velocity);
  }
  private updateRigidBodyPoses(poses: Map<string, PhysicsPose>) {
    if (!this.physics) return;
    for (const [id, pose] of poses) {
      const node = this.nodes.get(id),
        body = node && this.component(node, 'rigid-body');
      if (!node || !body) continue;
      let velocity = this.physics.linearVelocity(id);
      if (this.terrainVoxelCell) {
        const displacement = pose.position.clone().sub(pose.previousPosition),
          steps = Math.max(1, Math.ceil(displacement.length() / 0.2));
        this.setWorldTransform(node, pose.previousPosition, pose.rotation);
        for (let substep = 0; substep < steps; substep++)
          for (const axis of ['x', 'z', 'y'] as const) {
            const amount = displacement[axis] / steps;
            if (Math.abs(amount) < 1e-8) continue;
            const current = this.bounds(node),
              nextPosition = this.worldPosition(node);
            nextPosition[axis] += amount;
            this.setWorldPosition(node, nextPosition);
            const next = this.bounds(node),
              face = this.terrainVoxelCollisionFace(current, next, axis),
              positive = amount > 0;
            if (face === null || !(positive ? next.max[axis] > face + 1e-5 : next.min[axis] < face - 1e-5))
              continue;
            const corrected = this.worldPosition(node);
            corrected[axis] += positive ? face - next.max[axis] : face - next.min[axis];
            this.setWorldPosition(node, corrected);
            velocity[axis] = Math.abs(velocity[axis]) < 0.35 ? 0 : -velocity[axis] * body.restitution;
          }
        const corrected = this.worldPosition(node);
        this.physics.setBodyPose(id, corrected, pose.rotation);
        this.physics.setLinearVelocity(id, velocity);
      } else {
        this.setWorldTransform(node, pose.position, pose.rotation);
        const box = this.bounds(node),
          terrainHeight = this.terrainHeightUnder(box);
        if (terrainHeight !== null && box.min.y < terrainHeight) {
          const corrected = this.worldPosition(node);
          corrected.y += terrainHeight - box.min.y;
          this.setWorldPosition(node, corrected);
          if (velocity.y < 0) velocity.y = Math.abs(velocity.y) < 0.35 ? 0 : -velocity.y * body.restitution;
          this.physics.setBodyPose(id, corrected, pose.rotation);
          this.physics.setLinearVelocity(id, velocity);
        }
      }
      this.rigidBodyVelocities.set(id, velocity);
    }
  }
  private startActionAnimation(node: SceneNode, action: 'jumping' | 'attacking') {
    const requested = this.component(node, 'animation')?.[action];
    const rig = node.assetId ? this.assets.get(node.assetId)?.rig : undefined;
    const clip =
      requested && rig?.clips.find((entry) => entry.name.toLowerCase() === requested.toLowerCase());
    if (clip) this.animationTimes.set(node.id, { clip: clip.name, time: 0 });
  }

  step(input: GameInput = {}, deltaSeconds = FIXED_DELTA, playerInputs?: ReadonlyMap<string, GameInput>) {
    if (this.status !== 'playing') return;
    if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0 || deltaSeconds > 0.1)
      throw new Error('Simulation steps must be greater than 0 and at most 0.1 seconds.');
    if (input.togglePause) {
      this.setPaused(!this.paused);
      return;
    }
    if (this.paused) {
      if (input.uiEventId !== undefined) {
        this.actionBudget = 4096;
        try {
          this.dispatchUiEvent(input.uiEventId, input);
        } catch (error) {
          const message = (error as Error).message;
          this.errors.push(message);
          this.status = 'stopped';
          this.paused = false;
          this.currentInteractionTarget = null;
          this.emit('error', undefined, message);
        }
      }
      return;
    }
    if (this.physicsLoading) {
      if (this.pendingPhysicsSteps.length >= 18000) {
        this.status = 'stopped';
        this.errors.push('Simulation exceeded 18,000 queued steps while physics initialized.');
        return;
      }
      this.pendingPhysicsSteps.push({ input: { ...input, togglePause: undefined }, deltaSeconds });
      return;
    }
    if (input.constructionPaint !== undefined && !this.selectConstructionPaint(input.constructionPaint))
      return;
    this.simulatedSeconds += deltaSeconds;
    this.actionBudget = 4096;
    this.frame++;
    this.moving.clear();
    this.sprinting.clear();
    this.attackCooldown = Math.max(0, this.attackCooldown - deltaSeconds);
    this.damageCooldown = Math.max(0, this.damageCooldown - deltaSeconds);
    for (const [playerId, cooldown] of this.multiplayerAttackCooldowns)
      this.multiplayerAttackCooldowns.set(playerId, Math.max(0, cooldown - deltaSeconds));
    for (const [playerId, cooldown] of this.multiplayerDamageCooldowns)
      this.multiplayerDamageCooldowns.set(playerId, Math.max(0, cooldown - deltaSeconds));
    try {
      const players = [...this.nodes.values()].filter(
          (node) => this.component(node, 'player') && this.enabled(node),
        ),
        primaryPlayer = players[0];
      for (const node of this.nodes.values()) {
        if (!this.component(node, 'player') || this.enabled(node)) continue;
        const roomPlayerId = this.multiplayerPlayerByNode.get(node.id);
        if (roomPlayerId) this.multiplayerTouching.set(roomPlayerId, new Set());
        else this.touchingNodeIds.clear();
      }
      if (input.uiEventId !== undefined && this.dispatchUiEvent(input.uiEventId, input)) return;
      for (const node of this.ruleNodes.slice()) {
        if (this.enabled(node)) this.dispatch(node, 'tick');
        if (this.stopStepAfterTransition(input)) return;
      }
      if (players.length && this.physics)
        for (const id of this.physics.syncAuthoredTransforms()) {
          const changed = this.nodes.get(id);
          if (changed) this.refreshSolids(changed);
        }
      for (const player of players) {
        const roomPlayerId = this.multiplayerPlayerByNode.get(player.id),
          playerInput = roomPlayerId ? (playerInputs?.get(roomPlayerId) ?? {}) : input,
          previousInput = roomPlayerId ? (this.multiplayerPrevious.get(roomPlayerId) ?? {}) : this.previous,
          previousInventory = this.inventory,
          touchingNodeIds = new Set<string>();
        if (roomPlayerId) this.inventory = this.multiplayerInventories.get(roomPlayerId) ?? [];
        const c = this.component(player, 'player')!,
          direction = new Vector3(playerInput.moveX ?? 0, 0, playerInput.moveZ ?? 0);
        if (roomPlayerId) {
          const oneShots = this.multiplayerOneShots.get(roomPlayerId) ?? [];
          this.multiplayerOneShots.delete(roomPlayerId);
          for (const oneShot of oneShots) {
            if (oneShot.uiEventId && this.dispatchUiEvent(oneShot.uiEventId, oneShot)) return;
            if (oneShot.constructionPaint)
              this.selectConstructionPaint(oneShot.constructionPaint, roomPlayerId);
            if (oneShot.inventoryMove)
              this.moveInventoryStack(oneShot.inventoryMove.fromIndex, oneShot.inventoryMove.toIndex);
            if (oneShot.inventorySort) this.sortInventoryByName();
            if (oneShot.terrainEdit) this.editTerrain(oneShot.terrainEdit, roomPlayerId);
          }
        }
        if (!Number.isFinite(direction.lengthSq())) throw new Error('Input axes must be finite.');
        if (playerInput.useItem && playerInput.useItem !== previousInput.useItem)
          this.useItem(player, playerInput.useItem);
        if (direction.length() > 1) direction.normalize();
        if (direction.lengthSq() > 0.0001) {
          this.moving.add(player.id);
          if (playerInput.sprint) this.sprinting.add(player.id);
          const rotation = new Quaternion().setFromEuler(
            new Euler(0, Math.atan2(-direction.x, -direction.z), 0),
          );
          this.setWorldTransform(player, this.worldPosition(player), rotation);
        }
        let vy = this.velocities.get(player.id) ?? 0;
        const ground = this.isGrounded(player);
        const jumpPressed = !!playerInput.jump && !previousInput.jump,
          coyoteTime = this.coyoteTimes.get(player.id) ?? 0,
          jumpBuffer = this.jumpBuffers.get(player.id) ?? 0;
        const coyoteWindow = c.coyoteTime ?? 0,
          jumpBufferWindow = c.jumpBuffer ?? 0,
          gravity = c.gravity ?? 18,
          terminalVelocity = c.terminalVelocity ?? 50,
          jumpAvailable = ground || coyoteTime > 0,
          bufferedJumpAvailable = jumpPressed || jumpBuffer > 0;
        let nextCoyoteTime = ground ? coyoteWindow : Math.max(0, coyoteTime - deltaSeconds),
          nextJumpBuffer = jumpPressed ? jumpBufferWindow : Math.max(0, jumpBuffer - deltaSeconds);
        if (bufferedJumpAvailable && jumpAvailable) {
          vy = c.jump;
          nextCoyoteTime = 0;
          nextJumpBuffer = 0;
          this.startActionAnimation(player, 'jumping');
        }
        this.coyoteTimes.set(player.id, nextCoyoteTime);
        this.jumpBuffers.set(player.id, nextJumpBuffer);
        vy = Math.max(-terminalVelocity, vy - gravity * deltaSeconds);
        this.velocities.set(player.id, vy);
        const speed = c.speed * (this.sprinting.has(player.id) ? (c.sprintMultiplier ?? 1.6) : 1);
        this.move(player, direction.multiplyScalar(speed * deltaSeconds).setY(vy * deltaSeconds));
        const interactionTarget = this.findInteractionTarget(player);
        if (playerInput.interact && !previousInput.interact && interactionTarget) {
          const target = this.nodes.get(interactionTarget.nodeId)!;
          this.emit('interact', target.id, { prompt: interactionTarget.prompt });
          this.dispatch(target, 'interact');
          if (this.stopStepAfterTransition(playerInput)) return;
        }
        const attackCooldown = roomPlayerId
          ? (this.multiplayerAttackCooldowns.get(roomPlayerId) ?? 0)
          : this.attackCooldown;
        if (playerInput.attack && !previousInput.attack && attackCooldown === 0) {
          const combat = this.component(player, 'combat');
          if (roomPlayerId)
            this.multiplayerAttackCooldowns.set(roomPlayerId, combat?.cooldown ?? ATTACK_COOLDOWN_SECONDS);
          else this.attackCooldown = combat?.cooldown ?? ATTACK_COOLDOWN_SECONDS;
          this.dispatch(player, 'attack');
          if (this.stopStepAfterTransition(playerInput)) return;
          this.startActionAnimation(player, 'attacking');
          for (const n of this.enemyNodes.slice())
            if (
              this.enabled(n) &&
              this.component(n, 'enemy') &&
              this.worldPosition(n).distanceTo(this.worldPosition(player)) <
                (combat?.range ?? DEFAULT_ATTACK_RANGE)
            )
              this.damage(n, combat?.damage ?? DEFAULT_ATTACK_DAMAGE);
          this.emit('attack', player.id);
        }
        if (roomPlayerId) {
          this.multiplayerInventories.set(
            roomPlayerId,
            this.inventory.map((stack) => ({ ...stack })),
          );
          this.inventory = previousInventory;
          this.multiplayerPrevious.set(roomPlayerId, { ...playerInput });
        } else {
          this.previous = { ...playerInput };
        }
      }
      for (const n of this.enemyNodes.slice()) {
        const enemy = this.component(n, 'enemy');
        if (!enemy || !this.enabled(n) || !players.length) continue;
        const target = players.reduce((nearest, candidate) => {
          const distance = this.worldPosition(candidate).distanceTo(this.worldPosition(n));
          return distance < this.worldPosition(nearest).distanceTo(this.worldPosition(n))
            ? candidate
            : nearest;
        }, players[0]);
        const d = this.worldPosition(target).sub(this.worldPosition(n));
        const voxelNavigation = this.terrainWorld?.generator.mode === 'voxel3d';
        if (!voxelNavigation) d.y = 0;
        const distance = d.length();
        if (distance > 0.1) {
          const direction = this.enemyChaseDirection(n, target, d);
          if (direction) {
            this.move(n, direction.multiplyScalar(enemy.speed * deltaSeconds));
            this.moving.add(n.id);
            n.transform.rotation[1] = Math.atan2(-direction.x, -direction.z);
            this.refreshSolids(n);
          }
        }
        const targetPlayerId = this.multiplayerPlayerByNode.get(target.id),
          damageCooldown = targetPlayerId
            ? (this.multiplayerDamageCooldowns.get(targetPlayerId) ?? 0)
            : this.damageCooldown;
        if (distance < enemy.range && damageCooldown === 0) {
          this.damage(target, enemy.damage);
          if (targetPlayerId) this.multiplayerDamageCooldowns.set(targetPlayerId, DAMAGE_COOLDOWN_SECONDS);
          else this.damageCooldown = DAMAGE_COOLDOWN_SECONDS;
        }
      }
      for (const player of players) {
        const roomPlayerId = this.multiplayerPlayerByNode.get(player.id),
          playerInput = roomPlayerId
            ? (playerInputs?.get(roomPlayerId) ?? this.multiplayerInputs.get(roomPlayerId) ?? {})
            : input,
          previousInventory = this.inventory,
          touchSet = roomPlayerId
            ? (this.multiplayerTouching.get(roomPlayerId) ?? new Set<string>())
            : this.touchingNodeIds,
          touchingNodeIds = new Set<string>();
        if (roomPlayerId) this.inventory = this.multiplayerInventories.get(roomPlayerId) ?? [];
        for (const n of this.contactNodes.slice()) {
          if (n.id === player.id || this.component(n, 'player') || !this.enabled(n)) continue;
          if (this.bounds(n).intersectsBox(this.bounds(player))) {
            touchingNodeIds.add(n.id);
            const item = this.component(n, 'collectible');
            if (item) {
              if (item.itemId) {
                const definition = this.items.get(item.itemId)!;
                const next = addInventoryItem(
                  this.inventory,
                  definition,
                  item.quantity,
                  this.inventorySlotLimit,
                );
                if (next) {
                  this.inventory = next;
                  n.enabled = false;
                  this.invalidateNavigation();
                  this.blockedPickups.delete(n.id);
                  this.message = `+${item.quantity} ${definition.name}`;
                  this.emit('collected', n.id, { itemId: definition.id, quantity: item.quantity });
                } else if (!this.blockedPickups.has(n.id)) {
                  this.blockedPickups.add(n.id);
                  this.message = 'Inventory full.';
                  this.emit('pickup-blocked', n.id, { itemId: definition.id, quantity: item.quantity });
                }
              } else {
                this.variables[item.variable] = (this.variables[item.variable] ?? 0) + item.amount;
                n.enabled = false;
                this.invalidateNavigation();
                this.emit('collected', n.id, { variable: item.variable, amount: item.amount });
              }
            }
            if (!touchSet.has(n.id)) {
              this.emit('touch', n.id);
              this.dispatch(n, 'touch');
              if (this.stopStepAfterTransition(playerInput)) return;
            }
          }
        }
        for (const id of touchSet) {
          if (touchingNodeIds.has(id)) continue;
          const target = this.nodes.get(id);
          if (!target || !this.enabled(target)) continue;
          this.emit('untouch', id);
          this.dispatch(target, 'untouch');
          if (this.stopStepAfterTransition(playerInput)) return;
        }
        if (roomPlayerId) {
          this.multiplayerTouching.set(roomPlayerId, touchingNodeIds);
          this.multiplayerInventories.set(
            roomPlayerId,
            this.inventory.map((stack) => ({ ...stack })),
          );
          this.inventory = previousInventory;
        } else this.touchingNodeIds = touchingNodeIds;
      }
      for (const n of this.patrolNodes.slice()) {
        const patrol = this.component(n, 'patrol');
        if (!patrol || !this.enabled(n)) continue;
        let i = this.patrolTargets.get(n.id) ?? 0;
        const d = new Vector3(...patrol.points[i]).sub(this.worldPosition(n));
        if (d.length() < 0.1) {
          i = (i + 1) % patrol.points.length;
          this.patrolTargets.set(n.id, i);
        } else {
          this.move(n, d.normalize().multiplyScalar(patrol.speed * deltaSeconds));
          this.moving.add(n.id);
        }
      }
      if (this.physics) {
        const physicsStep = this.physics.stepWithEvents(deltaSeconds);
        this.updateRigidBodyPoses(physicsStep.poses);
        for (const collision of physicsStep.collisions) {
          const nodeA = this.nodes.get(collision.nodeAId),
            nodeB = this.nodes.get(collision.nodeBId);
          if (!nodeA || !nodeB || !this.enabled(nodeA) || !this.enabled(nodeB)) continue;
          const event = collision.started ? 'collision' : 'separation';
          this.emit(event, nodeA.id, { otherNodeId: nodeB.id });
          this.dispatch(nodeA, event, undefined, nodeB);
          if (this.stopStepAfterTransition(input)) return;
          this.emit(event, nodeB.id, { otherNodeId: nodeA.id });
          this.dispatch(nodeB, event, undefined, nodeA);
          if (this.stopStepAfterTransition(input)) return;
        }
      } else
        for (const node of this.rigidBodyNodes.slice()) {
          if (!this.enabled(node)) continue;
          const body = this.component(node, 'rigid-body');
          if (body) this.simulateRigidBody(node, body, deltaSeconds);
        }
      for (const node of this.rigNodes.slice()) {
        if (!this.enabled(node) || !node.assetId) continue;
        const rig = this.assets.get(node.assetId)?.rig;
        if (!rig) continue;
        const settings = this.component(node, 'animation'),
          moving = this.moving.has(node.id),
          runningClip =
            this.sprinting.has(node.id) && moving
              ? rig.clips.find(
                  (clip) => clip.name.toLowerCase() === (settings?.running ?? 'run').toLowerCase(),
                )
              : undefined,
          previous = this.animationTimes.get(node.id),
          actionNames = [settings?.jumping, settings?.attacking].filter((name): name is string => !!name),
          actionClip =
            previous && actionNames.some((name) => name.toLowerCase() === previous.clip.toLowerCase())
              ? rig?.clips.find((clip) => clip.name.toLowerCase() === previous.clip.toLowerCase())
              : undefined,
          name =
            actionClip && previous && previous.time < actionClip.duration
              ? actionClip.name
              : moving
                ? (runningClip?.name ?? settings?.moving ?? 'walk')
                : (settings?.idle ?? 'idle');
        const clip = rig.clips.find((c) => c.name.toLowerCase() === name.toLowerCase());
        if (!clip) continue;
        const start = previous?.clip === clip.name ? previous.time : 0;
        const playerMotion = this.component(node, 'player'),
          speed = playerMotion
            ? playerMotion.speed * (this.sprinting.has(node.id) ? (playerMotion.sprintMultiplier ?? 1.6) : 1)
            : (this.component(node, 'enemy')?.speed ?? this.component(node, 'patrol')?.speed ?? 3);
        const end = start + deltaSeconds * (moving && clip.speed > 0 ? speed / clip.speed : 1);
        // Marker actions can leave this scene; its checkpoint must include this advanced clock.
        this.animationTimes.set(node.id, {
          clip: clip.name,
          time: clip.loop ? end : Math.min(end, clip.duration),
        });
        for (const marker of clip.events) {
          const first = Math.floor((start - marker.time) / clip.duration) + 1,
            last = clip.loop
              ? Math.floor((end - marker.time) / clip.duration)
              : start < marker.time && end >= marker.time
                ? first
                : first - 1;
          if (last >= first) {
            this.emit('animation', node.id, { clip: clip.name, marker: marker.name });
            this.dispatch(node, 'animation', marker.name);
            if (this.pendingSceneTransition) break;
          }
        }
        if (this.stopStepAfterTransition(input)) return;
      }
      for (const value of Object.values(this.variables))
        if (!Number.isFinite(value)) throw new Error('Gameplay produced a non-finite variable.');
      for (const value of Object.values(this.campaignVariables))
        if (!Number.isFinite(value)) throw new Error('Gameplay produced a non-finite campaign variable.');
      this.previous = { ...input };
      this.currentInteractionTarget = primaryPlayer ? this.findInteractionTarget(primaryPlayer) : null;
    } catch (e) {
      this.errors.push((e as Error).message);
      this.status = 'stopped';
      this.currentInteractionTarget = null;
      this.emit('error', undefined, (e as Error).message);
    }
  }
  setPaused(paused: boolean) {
    if (this.status === 'playing') this.paused = paused;
  }
  private dispatchUiEvent(eventId: string, input: GameInput) {
    if (!idSchema.safeParse(eventId).success) throw new Error('HUD event ID is invalid.');
    this.emit('ui', undefined, { eventId });
    for (const node of this.ruleNodes.slice()) {
      if (
        !this.enabled(node) ||
        !this.component(node, 'rules')?.rules.some((rule) => rule.event === 'ui' && rule.eventId === eventId)
      )
        continue;
      this.dispatch(node, 'ui', undefined, undefined, eventId);
      if (this.status !== 'playing') this.paused = false;
      if (this.stopStepAfterTransition(input)) return true;
    }
    return false;
  }
  private currentInteractionTarget: ReturnType<GameSimulation['findInteractionTarget']> = null;
  dispose() {
    this.disposed = true;
    this.pendingPhysicsSteps = [];
    this.physics?.dispose();
    this.physics = null;
  }
  animationState(id: string) {
    return this.animationTimes.get(id);
  }
  private grounded(node: SceneNode) {
    const box = this.bounds(node);
    return this.nearbySolids(box.clone().expandByScalar(0.03)).some(
      (n) =>
        n.id !== node.id &&
        this.enabled(n) &&
        this.isSolidCollider(n) &&
        (() => {
          const b = this.bounds(n);
          return (
            Math.abs(box.min.y - b.max.y) < 0.03 &&
            box.max.x > b.min.x &&
            box.min.x < b.max.x &&
            box.max.z > b.min.z &&
            box.min.z < b.max.z
          );
        })(),
    );
  }
  private terrainGrounded(node: SceneNode) {
    const box = this.bounds(node);
    if (this.terrainVoxelCell) return this.terrainVoxelGrounded(box);
    const height = this.terrainHeightUnder(box);
    return height !== null && Math.abs(box.min.y - height) <= 0.03;
  }
  private conditionValue(condition: RuleCondition) {
    return 'itemId' in condition && condition.itemId !== undefined
      ? this.inventory.reduce(
          (total, stack) => total + (stack.itemId === condition.itemId ? stack.quantity : 0),
          0,
        )
      : (('variable' in condition
          ? condition.scope === 'campaign'
            ? this.campaignVariables[condition.variable]
            : this.variables[condition.variable]
          : undefined) ?? 0);
  }
  private writeVariable(variable: string, value: number, scope: 'scene' | 'campaign' | undefined) {
    const target = scope === 'campaign' ? this.campaignVariables : this.variables;
    if (
      scope === 'campaign' &&
      !Object.hasOwn(target, variable) &&
      Object.keys(target).length >= MAX_CAMPAIGN_VARIABLES
    )
      throw new Error(`Gameplay exceeded ${MAX_CAMPAIGN_VARIABLES} campaign variables.`);
    target[variable] = value;
  }
  private conditionPasses(condition: RuleCondition) {
    const value = this.conditionValue(condition);
    return condition.op === '>='
      ? value >= condition.value
      : condition.op === '<='
        ? value <= condition.value
        : condition.op === '=='
          ? value === condition.value
          : condition.op === '>'
            ? value > condition.value
            : value < condition.value;
  }
  inspect() {
    const objectivesById = new Map(this.scene.objectives.map((objective) => [objective.id, objective]));
    const objectiveProgressById = new Map<string, { available: boolean; completed: boolean }>();
    const resolvingObjectiveIds = new Set<string>();
    const objectiveProgress = (id: string): { available: boolean; completed: boolean } => {
      const cached = objectiveProgressById.get(id);
      if (cached) return cached;
      const objective = objectivesById.get(id);
      if (!objective || resolvingObjectiveIds.has(id)) return { available: false, completed: false };

      resolvingObjectiveIds.add(id);
      const available = (objective.requires ?? []).every(
        (requiredId) => objectiveProgress(requiredId).completed,
      );
      const progress = {
        available,
        completed: available && this.conditionPasses(objective.condition),
      };
      resolvingObjectiveIds.delete(id);
      objectiveProgressById.set(id, progress);
      return progress;
    };
    return {
      sceneId: this.scene.id,
      playerId: [...this.nodes.values()].find((node) => this.component(node, 'player'))?.id ?? null,
      frame: this.frame,
      seconds: this.simulatedSeconds,
      status: this.status,
      paused: this.paused,
      message: this.message,
      interactionTarget: this.currentInteractionTarget,
      construction: this.constructionState(),
      variables: { ...this.variables },
      campaignVariables: { ...this.campaignVariables },
      objectives: this.scene.objectives.map((objective) => ({
        ...objective,
        current: this.conditionValue(objective.condition),
        ...objectiveProgress(objective.id),
      })),
      inventory: this.inventory.map((stack) => ({
        ...stack,
        name: this.items.get(stack.itemId)?.name ?? stack.itemId,
      })),
      health: { ...this.health },
      nodes: [...this.nodes.values()].map((n) => ({
        id: n.id,
        enabled: this.enabled(n),
        position: this.worldPosition(n).toArray(),
      })),
      events: [...this.events],
      errors: [...this.errors],
    };
  }
}
