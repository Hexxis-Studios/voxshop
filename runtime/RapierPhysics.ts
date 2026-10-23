import * as RAPIER from '@dimforge/rapier3d-compat';
import { Matrix4, Quaternion, Vector3 } from 'three';
import type { GameScene, ParsedComponent, SceneNode } from '../services/projectDocument';
import type { PhysicsQuery } from '../services/viewportProtocol';
import type { WorldCell, WorldDocument } from '../services/worldDocument';

type Pose = { position: Vector3; rotation: Quaternion; scale: Vector3 };
type PhysicsBodyType = 'dynamic' | 'fixed' | 'kinematic-position' | 'kinematic-velocity';
type BodyRecord = {
  node: SceneNode;
  body: RAPIER.RigidBody;
  bodyType: PhysicsBodyType;
  canSleep: boolean;
  lastPose: Pose;
};
type PlatformPose = Pick<Pose, 'position' | 'rotation'>;
export type PhysicsPose = { position: Vector3; rotation: Quaternion; previousPosition: Vector3 };
export type PhysicsCollisionEvent = {
  nodeAId: string;
  nodeBId: string;
  started: boolean;
};
export type PhysicsStep = { poses: Map<string, PhysicsPose>; collisions: PhysicsCollisionEvent[] };
export type PhysicsMotion = {
  linearVelocity: [number, number, number];
  angularVelocity: [number, number, number];
  sleeping: boolean;
};
export type PhysicsQueryHit = {
  nodeId: string | null;
  source: 'scene' | 'terrain' | 'environment';
  distance: number;
  position: [number, number, number];
  normal: [number, number, number];
};
export type PhysicsQueryResult =
  | { available: false; shape: PhysicsQuery['shape']; reason: string }
  | { available: true; shape: 'ray'; hit: PhysicsQueryHit | null }
  | { available: true; shape: 'shape-cast'; hit: PhysicsQueryHit | null }
  | {
      available: true;
      shape: 'box' | 'sphere' | 'capsule';
      nodeIds: string[];
      sources: ('terrain' | 'environment')[];
      truncated: boolean;
    };
export type CharacterMovement = { movement: Vector3; grounded: boolean };

type CharacterMovementState = {
  grounded: boolean | null;
  supportNodeId: string | null;
  supportRevision: number;
};
type PlatformDisplacement = {
  previous: PlatformPose;
  current: PlatformPose;
  delta: Vector3;
  revision: number;
};
export type RapierPhysicsSnapshot = {
  format: 1;
  rapierVersion: string;
  compatibilityKey: string;
  world: Uint8Array;
  bodyHandles: { nodeId: string; handle: number }[];
  colliderHandles: { nodeId: string; handle: number }[];
  jointHandles?: { nodeId: string; handle: number }[];
  terrainBodyHandle?: number;
  terrainColliderHandles?: { key: string; hash: string; handle: number }[];
  worldBodyCount: number;
  worldColliderCount: number;
};

export type PhysicsTerrainSource = {
  world: WorldDocument;
  cellAt: (position: { x: number; y: number; z: number }) => WorldCell | undefined;
  surfaceAt: (x: number, z: number) => number | null;
  smoothSurface: boolean;
};

type TerrainCollider = { handle: RAPIER.ColliderHandle; hash: string };
type TerrainPoint = [number, number, number];

export const MAX_RAPIER_SNAPSHOT_BYTES = 32 * 1024 * 1024;
export const MAX_RAPIER_SNAPSHOT_ENTRIES = 100_000;
const MAX_PHYSICS_QUERY_HITS = 128;
const PHYSICS_TERRAIN_CHUNK_SIZE = 16;
const MAX_PHYSICS_TERRAIN_CHUNKS = 256;

function isMotionVector(value: unknown): value is [number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    [0, 1, 2].every((index) => {
      const entry = value[index];
      return typeof entry === 'number' && Number.isFinite(entry) && Math.abs(entry) <= 10000;
    })
  );
}

function isPhysicsMotion(value: unknown): value is PhysicsMotion {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const motion = value as Record<string, unknown>;
  return (
    isMotionVector(motion.linearVelocity) &&
    isMotionVector(motion.angularVelocity) &&
    typeof motion.sleeping === 'boolean'
  );
}

function poseFromMatrix(matrix: Matrix4): Pose {
  const position = new Vector3(),
    rotation = new Quaternion(),
    scale = new Vector3();
  matrix.decompose(position, rotation, scale);
  return { position, rotation, scale };
}

function component<T extends ParsedComponent['type']>(node: SceneNode, type: T) {
  return node.components.find((entry) => entry.type === type) as
    Extract<ParsedComponent, { type: T }> | undefined;
}

function colliderDescriptor(
  node: SceneNode,
  pose: Pose,
  bodyComponent?: Extract<ParsedComponent, { type: 'rigid-body' }>,
  captureCollisions = false,
) {
  const collider = component(node, 'collider');
  const size = collider?.size ?? [1, 1, 1];
  const sx = Math.max(0.01, Math.abs(size[0] * pose.scale.x)),
    sy = Math.max(0.01, Math.abs(size[1] * pose.scale.y)),
    sz = Math.max(0.01, Math.abs(size[2] * pose.scale.z));
  let descriptor: RAPIER.ColliderDesc;
  switch (collider?.shape ?? 'box') {
    case 'sphere':
      descriptor = RAPIER.ColliderDesc.ball(Math.max(sx, sy, sz) * 0.5);
      break;
    case 'capsule': {
      const radius = Math.max(sx, sz) * 0.5,
        halfHeight = Math.max(0, sy * 0.5 - radius);
      descriptor =
        halfHeight < 1e-4
          ? RAPIER.ColliderDesc.ball(radius)
          : RAPIER.ColliderDesc.capsule(halfHeight, radius);
      break;
    }
    default:
      descriptor = RAPIER.ColliderDesc.cuboid(sx * 0.5, sy * 0.5, sz * 0.5);
  }
  const offset = collider?.offset ?? [0, 0, 0];
  return (
    descriptor
      .setTranslation(offset[0] * pose.scale.x, offset[1] * pose.scale.y, offset[2] * pose.scale.z)
      .setSensor(collider?.sensor ?? !collider?.solid)
      // Rapier's default matrix excludes moving kinematic bodies against fixed
      // sensors. Event-driven sensors need those pairs active for trigger rules.
      .setActiveCollisionTypes(
        captureCollisions
          ? RAPIER.ActiveCollisionTypes.DEFAULT |
              RAPIER.ActiveCollisionTypes.KINEMATIC_FIXED |
              RAPIER.ActiveCollisionTypes.KINEMATIC_KINEMATIC
          : RAPIER.ActiveCollisionTypes.DEFAULT,
      )
      .setFriction(collider?.friction ?? 0.5)
      .setRestitution(Math.max(collider?.restitution ?? 0, bodyComponent?.restitution ?? 0))
      .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Average)
      .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Max)
      .setActiveEvents(captureCollisions ? RAPIER.ActiveEvents.COLLISION_EVENTS : RAPIER.ActiveEvents.NONE)
      .setMass(bodyComponent?.bodyType === 'dynamic' ? (bodyComponent.mass ?? 1) : 0)
  );
}

function hasCollisionRules(node: SceneNode) {
  return (
    component(node, 'rules')?.rules.some(
      (rule) => rule.event === 'collision' || rule.event === 'separation',
    ) ?? false
  );
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

function physicsCompatibilityKey(scene: GameScene, hasTerrain: boolean, terrain?: WorldDocument) {
  const nodes = scene.nodes
    .map((node) => ({
      id: node.id,
      parentId: node.parentId,
      scale: node.transform.scale,
      physics: (() => {
        const rigidBody = component(node, 'rigid-body'),
          collider = component(node, 'collider'),
          joint = component(node, 'joint');
        return rigidBody || joint || (collider && (collider.solid || collider.sensor))
          ? {
              rigidBody: rigidBody ?? null,
              collider: collider ?? null,
              ...(joint && { joint }),
              hasMovement: !!(
                component(node, 'player') ||
                component(node, 'enemy') ||
                component(node, 'patrol')
              ),
              hasCollisionRules: hasCollisionRules(node),
            }
          : null;
      })(),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const terrainTopology = terrain && {
    format: 1,
    id: terrain.id,
    seed: terrain.seed,
    chunkSize: terrain.chunkSize,
    voxelSize: terrain.voxelSize,
    generator: terrain.generator,
  };
  return JSON.stringify(stableValue({ bounds: scene.bounds, hasTerrain, terrainTopology, nodes }));
}

function rapierHandleIndex(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  if (Number.isSafeInteger(value)) return value;
  // The installed WASM binding represents nonzero handle indices as subnormal
  // doubles. Preserve those values for Rapier lookups, but decode their index
  // here so count bounds remain meaningful.
  const index = value / Number.MIN_VALUE;
  return Number.isSafeInteger(index) && index >= 0 ? index : null;
}

function isSnapshotEntry(value: unknown): value is { nodeId: string; handle: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  const index = rapierHandleIndex(entry.handle);
  return typeof entry.nodeId === 'string' && index !== null && index <= MAX_RAPIER_SNAPSHOT_ENTRIES;
}

function isSnapshotEnvelope(value: unknown): value is RapierPhysicsSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const snapshot = value as Record<string, unknown>;
  return (
    snapshot.format === 1 &&
    typeof snapshot.rapierVersion === 'string' &&
    typeof snapshot.compatibilityKey === 'string' &&
    snapshot.world instanceof Uint8Array &&
    snapshot.world.byteLength > 0 &&
    snapshot.world.byteLength <= MAX_RAPIER_SNAPSHOT_BYTES &&
    Array.isArray(snapshot.bodyHandles) &&
    snapshot.bodyHandles.length <= MAX_RAPIER_SNAPSHOT_ENTRIES &&
    snapshot.bodyHandles.every(isSnapshotEntry) &&
    Array.isArray(snapshot.colliderHandles) &&
    snapshot.colliderHandles.length <= MAX_RAPIER_SNAPSHOT_ENTRIES &&
    snapshot.colliderHandles.every(isSnapshotEntry) &&
    (snapshot.jointHandles === undefined ||
      (Array.isArray(snapshot.jointHandles) &&
        snapshot.jointHandles.length <= MAX_RAPIER_SNAPSHOT_ENTRIES &&
        snapshot.jointHandles.every(isSnapshotEntry))) &&
    (snapshot.terrainBodyHandle === undefined ||
      (rapierHandleIndex(snapshot.terrainBodyHandle) !== null &&
        Array.isArray(snapshot.terrainColliderHandles) &&
        snapshot.terrainColliderHandles.length <= MAX_RAPIER_SNAPSHOT_ENTRIES &&
        snapshot.terrainColliderHandles.every(
          (entry) =>
            !!entry &&
            typeof entry.key === 'string' &&
            entry.key.length <= 96 &&
            typeof entry.hash === 'string' &&
            /^[a-f0-9]{16}$/.test(entry.hash) &&
            rapierHandleIndex(entry.handle) !== null,
        ))) &&
    (snapshot.terrainBodyHandle !== undefined || snapshot.terrainColliderHandles === undefined) &&
    Number.isSafeInteger(snapshot.worldBodyCount) &&
    Number.isSafeInteger(snapshot.worldColliderCount) &&
    (snapshot.worldBodyCount as number) >= 0 &&
    (snapshot.worldColliderCount as number) >= 0 &&
    (snapshot.worldBodyCount as number) <= MAX_RAPIER_SNAPSHOT_ENTRIES &&
    (snapshot.worldColliderCount as number) <= MAX_RAPIER_SNAPSHOT_ENTRIES
  );
}

function rigidBodyDescriptor(
  node: SceneNode,
  pose: Pose,
  rigidBody: Extract<ParsedComponent, { type: 'rigid-body' }> | undefined,
  hasPlayerMovement: boolean,
) {
  const bodyType: PhysicsBodyType =
    rigidBody?.bodyType ?? (hasPlayerMovement ? 'kinematic-position' : 'fixed');
  let descriptor: RAPIER.RigidBodyDesc;
  switch (bodyType) {
    case 'fixed':
      descriptor = RAPIER.RigidBodyDesc.fixed();
      break;
    case 'kinematic-position':
      descriptor = RAPIER.RigidBodyDesc.kinematicPositionBased();
      break;
    case 'kinematic-velocity':
      descriptor = RAPIER.RigidBodyDesc.kinematicVelocityBased();
      break;
    default:
      descriptor = RAPIER.RigidBodyDesc.dynamic();
  }
  const gravity = rigidBody?.gravity ?? 18,
    linearDamping = rigidBody?.linearDamping ?? 0.15,
    angularDamping = rigidBody?.angularDamping ?? 0.1,
    velocity = rigidBody?.velocity ?? [0, 0, 0],
    angularVelocity = rigidBody?.angularVelocity ?? [0, 0, 0];
  descriptor
    .setTranslation(pose.position.x, pose.position.y, pose.position.z)
    .setRotation(pose.rotation)
    .setEnabled(node.enabled)
    .setGravityScale(gravity / 9.81)
    .setLinearDamping(linearDamping)
    .setAngularDamping(angularDamping)
    .setLinvel(...velocity)
    .setAngvel({ x: angularVelocity[0], y: angularVelocity[1], z: angularVelocity[2] })
    .setCanSleep(rigidBody?.canSleep ?? true)
    .setCcdEnabled(rigidBody?.ccd ?? false);
  if (rigidBody?.lockRotation) descriptor.lockRotations();
  return { descriptor, bodyType };
}

/**
 * A small adapter around Rapier for authored scene colliders and rigid bodies.
 * Terrain remains owned by GameSimulation's bounded, sparse terrain query path.
 */
export class RapierPhysics {
  private readonly bodies = new Map<string, BodyRecord>();
  private readonly characterMovement = new Map<string, CharacterMovementState>();
  private readonly platformDisplacements = new Map<string, PlatformDisplacement>();
  private platformDisplacementRevision = 0;
  private joints = new Map<string, RAPIER.ImpulseJoint>();
  private colliderNodes = new Map<RAPIER.ColliderHandle, string>();
  private terrainBody: RAPIER.RigidBody | null = null;
  private terrainSource: PhysicsTerrainSource | null = null;
  private terrainColliders = new Map<string, TerrainCollider>();
  private loadedSurfaceChunks = new Set<string>();
  private loadedVoxelChunks = new Set<string>();
  private readonly eventQueue: RAPIER.EventQueue | null;
  private disposed = false;

  private constructor(
    private world: RAPIER.World,
    eventQueue: RAPIER.EventQueue | null,
    private readonly scene: GameScene,
    private readonly getWorldMatrix: (node: SceneNode) => Matrix4,
    private compatibilityKey: string,
  ) {
    this.eventQueue = eventQueue;
  }

  static async create(
    scene: GameScene,
    getWorldMatrix: (node: SceneNode) => Matrix4,
    hasTerrain: boolean,
    monitorCollisionEvents = false,
    terrain?: PhysicsTerrainSource,
  ) {
    await RAPIER.init();
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const eventQueue =
      monitorCollisionEvents ||
      scene.nodes.some((node) => component(node, 'collider') && hasCollisionRules(node))
        ? new RAPIER.EventQueue(true)
        : null;
    world.numSolverIterations = 8;
    world.numInternalPgsIterations = 2;
    const physics = new RapierPhysics(
      world,
      eventQueue,
      scene,
      getWorldMatrix,
      physicsCompatibilityKey(scene, hasTerrain, terrain?.world),
    );
    if (terrain) {
      physics.terrainSource = terrain;
      physics.terrainBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    }
    for (const node of scene.nodes) physics.addNode(node);
    physics.addJoints();
    if (!hasTerrain) physics.addDefaultGroundAndBounds();
    physics.syncTerrainColliders();
    return physics;
  }

  updateTerrain(world: WorldDocument, changedCell?: { x: number; y: number; z: number }) {
    const source = this.terrainSource;
    if (!source || this.disposed) return;
    const previousSmoothSurface = source.smoothSurface;
    source.world = world;
    source.smoothSurface =
      source.smoothSurface && world.generator.mode !== 'voxel3d' && world.edits.length === 0;
    this.compatibilityKey = physicsCompatibilityKey(this.scene, true, world);
    if (!changedCell || previousSmoothSurface !== source.smoothSurface) {
      this.clearTerrainColliders();
      this.syncTerrainColliders();
      return;
    }
    const size = PHYSICS_TERRAIN_CHUNK_SIZE,
      cx = Math.floor(changedCell.x / size),
      cz = Math.floor(changedCell.z / size);
    for (const chunk of this.loadedSurfaceChunks) {
      const [loadedX, , loadedZ] = chunk.split(',').map(Number);
      if (loadedX === cx && loadedZ === cz) this.rebuildSurfaceChunk(chunk);
    }
    for (const chunk of this.loadedVoxelChunks) {
      const [loadedX, , loadedZ] = chunk.split(',').map(Number);
      if (loadedX === cx && loadedZ === cz) this.rebuildVoxelChunk(chunk);
    }
  }

  addNode(node: SceneNode) {
    if (this.disposed || this.bodies.has(node.id)) return;
    const rigidBody = component(node, 'rigid-body'),
      collider = component(node, 'collider');
    if (!rigidBody && (!collider || (!collider.solid && !collider.sensor))) return;
    const pose = poseFromMatrix(this.getWorldMatrix(node)),
      movement = component(node, 'player') || component(node, 'enemy') || component(node, 'patrol'),
      { descriptor, bodyType } = rigidBodyDescriptor(node, pose, rigidBody, !!movement),
      body = this.world.createRigidBody(descriptor);
    if (collider || rigidBody) {
      const created = this.world.createCollider(
        colliderDescriptor(node, pose, rigidBody, hasCollisionRules(node)),
        body,
      );
      this.colliderNodes.set(created.handle, node.id);
    }
    this.bodies.set(node.id, {
      node,
      body,
      bodyType,
      canSleep: rigidBody?.canSleep ?? true,
      lastPose: pose,
    });
    this.addJoints();
  }

  characterGrounded(nodeId: string) {
    return this.characterMovement.get(nodeId)?.grounded ?? null;
  }

  platformMotionRevision(nodeId: string) {
    return this.platformDisplacements.get(nodeId)?.revision ?? 0;
  }

  platformMotionSince(nodeId: string, revision: number, point?: Vector3) {
    const motion = this.platformDisplacements.get(nodeId);
    if (!motion || motion.revision <= revision) return null;
    const rotated = 1 - Math.abs(motion.previous.rotation.dot(motion.current.rotation)) > 1e-8;
    if (!point) return { delta: motion.delta.clone(), revision: motion.revision, rotated };
    const localPoint = point
      .clone()
      .sub(motion.previous.position)
      .applyQuaternion(motion.previous.rotation.clone().invert());
    const currentPoint = localPoint.applyQuaternion(motion.current.rotation).add(motion.current.position);
    return { delta: currentPoint.sub(point), revision: motion.revision, rotated };
  }

  moveCharacter(
    nodeId: string,
    desiredMovement: Vector3,
    stepHeight: number,
    maxSlopeAngle: number,
    groundedBeforeMove: boolean,
  ) {
    const record = this.bodies.get(nodeId),
      authoredCollider = record && component(record.node, 'collider');
    if (
      this.disposed ||
      !record ||
      record.bodyType !== 'kinematic-position' ||
      !record.node.enabled ||
      !authoredCollider ||
      !authoredCollider.solid ||
      authoredCollider.sensor ||
      record.body.numColliders() !== 1
    )
      return null;

    this.syncAuthoredTransforms();
    const pose = this.scenePose(record);
    record.body.setTranslation(pose.position, true);
    record.body.setRotation(pose.rotation, true);
    record.lastPose = pose;
    this.syncTerrainColliders();

    let carriedSupportNodeId: string | null = null;
    const collider = record.body.collider(0),
      ignoredContacts = new Set<number>(),
      filter = (otherCollider: RAPIER.Collider) => {
        if (otherCollider.isSensor() || ignoredContacts.has(otherCollider.handle)) return false;
        const otherId = this.colliderNodes.get(otherCollider.handle);
        if (otherId && otherId === carriedSupportNodeId) return false;
        if (!otherId) return true;
        const other = this.bodies.get(otherId)?.node,
          otherDescription = other && component(other, 'collider');
        return !!(
          other &&
          other.enabled &&
          otherDescription?.solid &&
          !component(other, 'player') &&
          !component(other, 'enemy')
        );
      },
      slopeCosine = Math.cos((Math.max(0, Math.min(89, maxSlopeAngle)) * Math.PI) / 180),
      stepForwardDistance =
        Math.max(
          Math.abs(authoredCollider.size[0] * pose.scale.x),
          Math.abs(authoredCollider.size[2] * pose.scale.z),
        ) * 0.5,
      start = collider.translation(),
      position = new Vector3(start.x, start.y, start.z),
      rotation = collider.rotation(),
      initialPosition = position.clone();
    const previousState = this.characterMovement.get(nodeId) ?? {
        grounded: null,
        supportNodeId: null,
        supportRevision: -1,
      },
      previousGrounded = previousState.grounded,
      previousSupportNodeId = previousState.supportNodeId;
    let carriedPlatform = false,
      effectiveMovement = desiredMovement.clone();
    if (groundedBeforeMove && desiredMovement.y <= 1e-5 && previousSupportNodeId) {
      const displacement = this.platformMotionSince(
        previousSupportNodeId,
        previousState.supportRevision,
        position,
      );
      if (displacement) {
        effectiveMovement.add(displacement.delta);
        if (desiredMovement.y <= 1e-5) effectiveMovement.y = displacement.delta.y;
        previousState.supportRevision = displacement.revision;
        carriedPlatform = true;
        carriedSupportNodeId = previousSupportNodeId;
      }
    }
    let remaining = effectiveMovement,
      grounded =
        carriedPlatform || (previousGrounded === null && groundedBeforeMove && desiredMovement.y <= 0),
      supportNodeId = carriedPlatform ? previousSupportNodeId : null;
    for (let iteration = 0; iteration < 5 && remaining.lengthSq() > 1e-10; iteration++) {
      const hit = this.castCharacter(collider, position, rotation, remaining, filter);
      if (!hit) {
        position.add(remaining);
        remaining.set(0, 0, 0);
        break;
      }
      const time = Math.max(0, Math.min(1, hit.time_of_impact));
      position.addScaledVector(remaining, time);
      remaining.multiplyScalar(1 - time);
      const normal = new Vector3(hit.normal1.x, hit.normal1.y, hit.normal1.z).normalize();
      const shapeWitness = new Vector3(hit.witness2.x, hit.witness2.y, hit.witness2.z)
          .applyQuaternion(new Quaternion(rotation.x, rotation.y, rotation.z, rotation.w))
          .add(position),
        separation = shapeWitness
          .sub(new Vector3(hit.witness1.x, hit.witness1.y, hit.witness1.z))
          .dot(normal);
      if (separation < 0) position.addScaledVector(normal, -separation);
      if (normal.y >= slopeCosine && remaining.y <= 1e-5) {
        grounded = true;
        supportNodeId = this.colliderNodes.get(hit.collider.handle) ?? null;
      }

      const movingIntoWall = remaining.x * normal.x + remaining.z * normal.z < -1e-6;
      if (normal.y < slopeCosine && movingIntoWall) {
        const stepped =
          stepHeight > 0
            ? this.tryCharacterStep(
                collider,
                position,
                rotation,
                remaining,
                stepHeight,
                stepForwardDistance,
                slopeCosine,
                filter,
              )
            : null;
        if (stepped) {
          position.copy(stepped);
          remaining.set(0, 0, 0);
          grounded = true;
          break;
        }
        remaining.x = 0;
        remaining.z = 0;
        if (remaining.y > 0) remaining.y = 0;
        continue;
      }

      const intoSurface = remaining.dot(normal);
      if (intoSurface < 0) remaining.addScaledVector(normal, -intoSurface);
      if (remaining.dot(normal) >= -1e-6) ignoredContacts.add(hit.collider.handle);
    }
    const state = previousState,
      currentSupportNodeId = grounded ? supportNodeId : null;
    if (currentSupportNodeId !== state.supportNodeId)
      state.supportRevision = currentSupportNodeId
        ? (this.platformDisplacements.get(currentSupportNodeId)?.revision ?? -1)
        : -1;
    state.grounded = grounded;
    state.supportNodeId = currentSupportNodeId;
    this.characterMovement.set(nodeId, state);
    return { movement: position.sub(initialPosition), grounded };
  }

  private castCharacter(
    collider: RAPIER.Collider,
    position: Vector3,
    rotation: RAPIER.Rotation,
    movement: Vector3,
    filter: (collider: RAPIER.Collider) => boolean,
  ) {
    const ignoredContacts = new Set<number>();
    for (let attempt = 0; attempt < 8; attempt++) {
      const hit = this.world.castShape(
        position,
        rotation,
        movement,
        collider.shape,
        0.01,
        1,
        true,
        RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
        undefined,
        collider,
        undefined,
        (other) => !ignoredContacts.has(other.handle) && filter(other),
      );
      if (!hit) return null;
      const normal = new Vector3(hit.normal1.x, hit.normal1.y, hit.normal1.z);
      if (hit.time_of_impact > 1e-6 || movement.dot(normal) < -1e-6) return hit;
      ignoredContacts.add(hit.collider.handle);
    }
    return null;
  }

  private tryCharacterStep(
    collider: RAPIER.Collider,
    position: Vector3,
    rotation: RAPIER.Rotation,
    movement: Vector3,
    stepHeight: number,
    stepForwardDistance: number,
    slopeCosine: number,
    filter: (collider: RAPIER.Collider) => boolean,
  ) {
    const horizontal = new Vector3(movement.x, 0, movement.z);
    if (horizontal.lengthSq() < 1e-10) return null;
    const forward = horizontal.clone().normalize().multiplyScalar(stepForwardDistance).add(horizontal);
    const raisedBy = new Vector3(0, stepHeight, 0);
    if (this.castCharacter(collider, position, rotation, raisedBy, filter)) return null;
    const raised = position.clone().add(raisedBy);
    if (this.castCharacter(collider, raised, rotation, forward, filter)) return null;
    const advanced = raised.add(forward),
      down = new Vector3(0, -(stepHeight + 0.05), 0),
      landing = this.castCharacter(collider, advanced, rotation, down, filter);
    if (!landing || landing.normal1.y < slopeCosine) return null;
    return advanced.addScaledVector(down, Math.max(0, Math.min(1, landing.time_of_impact)));
  }

  private addJoints() {
    for (const node of this.scene.nodes) {
      const descriptor = component(node, 'joint');
      if (!descriptor || this.joints.has(node.id)) continue;
      const self = this.bodies.get(node.id),
        other = this.bodies.get(descriptor.connectedNodeId);
      if (!self || !other) continue;
      const anchorSelf = {
          x: descriptor.anchorSelf[0],
          y: descriptor.anchorSelf[1],
          z: descriptor.anchorSelf[2],
        },
        anchorOther = {
          x: descriptor.anchorOther[0],
          y: descriptor.anchorOther[1],
          z: descriptor.anchorOther[2],
        },
        axis = { x: descriptor.axis[0], y: descriptor.axis[1], z: descriptor.axis[2] };
      const data =
        descriptor.jointType === 'fixed'
          ? RAPIER.JointData.fixed(anchorSelf, { x: 0, y: 0, z: 0, w: 1 }, anchorOther, {
              x: 0,
              y: 0,
              z: 0,
              w: 1,
            })
          : descriptor.jointType === 'revolute'
            ? RAPIER.JointData.revolute(anchorSelf, anchorOther, axis)
            : RAPIER.JointData.prismatic(anchorSelf, anchorOther, axis);
      const joint = this.world.createImpulseJoint(data, self.body, other.body, true);
      if (descriptor.limits && descriptor.jointType !== 'fixed') {
        const [minimum, maximum] = descriptor.limits;
        (joint as RAPIER.RevoluteImpulseJoint | RAPIER.PrismaticImpulseJoint).setLimits(minimum, maximum);
      }
      this.joints.set(node.id, joint);
    }
  }

  private addDefaultGroundAndBounds() {
    const bound = this.scene.bounds,
      ground = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(bound + 1, 0.5, bound + 1), ground);
    const thickness = 0.5,
      height = Math.max(100, bound * 2),
      walls: [number, number, number, number, number, number][] = [
        [bound + thickness, 0, 0, thickness, height, bound + thickness],
        [-bound - thickness, 0, 0, thickness, height, bound + thickness],
        [0, 0, bound + thickness, bound + thickness, height, thickness],
        [0, 0, -bound - thickness, bound + thickness, height, thickness],
      ];
    for (const [x, y, z, hx, hy, hz] of walls) {
      const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, z));
      this.world.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz), body);
    }
  }

  private scenePose(record: BodyRecord) {
    return poseFromMatrix(this.getWorldMatrix(record.node));
  }

  private isPoseDifferent(a: Pose, b: Pose) {
    return (
      a.position.distanceToSquared(b.position) > 1e-10 || 1 - Math.abs(a.rotation.dot(b.rotation)) > 1e-8
    );
  }

  private rememberPlatformDisplacement(nodeId: string, previous: PlatformPose, current: PlatformPose) {
    const delta = current.position.clone().sub(previous.position);
    if (delta.lengthSq() <= 1e-10 && 1 - Math.abs(previous.rotation.dot(current.rotation)) <= 1e-8) return;
    this.platformDisplacements.set(nodeId, {
      delta,
      previous: {
        position: previous.position.clone(),
        rotation: previous.rotation.clone(),
      },
      current: {
        position: current.position.clone(),
        rotation: current.rotation.clone(),
      },
      revision: ++this.platformDisplacementRevision,
    });
  }

  syncAuthoredTransforms() {
    const changedNodeIds: string[] = [];
    for (const record of this.bodies.values()) {
      const { body, node } = record;
      if (body.isEnabled() !== node.enabled) body.setEnabled(node.enabled);
      if (!node.enabled) continue;
      const current = this.scenePose(record);
      const changed = this.isPoseDifferent(current, record.lastPose);
      if (record.bodyType === 'kinematic-position') {
        if (changed) {
          changedNodeIds.push(node.id);
          this.rememberPlatformDisplacement(node.id, record.lastPose, current);
          body.setNextKinematicTranslation(current.position);
          body.setNextKinematicRotation(current.rotation);
          record.lastPose = current;
        } else {
          body.setNextKinematicTranslation(current.position);
          body.setNextKinematicRotation(current.rotation);
        }
      } else if (changed) {
        changedNodeIds.push(node.id);
        body.setTranslation(current.position, true);
        body.setRotation(current.rotation, true);
        record.lastPose = current;
      }
    }
    return changedNodeIds;
  }

  private terrainCandidates(deltaSeconds = 0) {
    const surface = new Map<string, number>(),
      voxel = new Map<string, number>(),
      add = (map: Map<string, number>, key: string, distance: number) =>
        map.set(key, Math.min(map.get(key) ?? Infinity, distance));
    const source = this.terrainSource,
      world = source?.world;
    if (!source || !world) return { surface: new Set<string>(), voxel: new Set<string>() };
    const size = world.voxelSize;
    for (const record of this.bodies.values()) {
      if (!record.node.enabled || record.bodyType === 'fixed') continue;
      const translation = record.body.translation(),
        current =
          record.bodyType === 'kinematic-position'
            ? record.lastPose.position.clone()
            : new Vector3(translation.x, translation.y, translation.z),
        positions = [current];
      if (deltaSeconds > 0 && record.bodyType !== 'kinematic-position') {
        const velocity = record.body.linvel();
        positions.push(
          current.clone().addScaledVector(new Vector3(velocity.x, velocity.y, velocity.z), deltaSeconds),
        );
      }
      for (const position of positions) {
        const cellX = Math.floor(position.x / size + 0.5),
          cellY = Math.floor(position.y / size + 0.5),
          cellZ = Math.floor(position.z / size + 0.5),
          cx = Math.floor(cellX / PHYSICS_TERRAIN_CHUNK_SIZE),
          cy = Math.floor(cellY / PHYSICS_TERRAIN_CHUNK_SIZE),
          cz = Math.floor(cellZ / PHYSICS_TERRAIN_CHUNK_SIZE);
        const surfaceCellY = source.smoothSurface ? source.surfaceAt(cellX, cellZ) : null;
        const surfaceCy = Math.floor((surfaceCellY ?? cellY) / PHYSICS_TERRAIN_CHUNK_SIZE);
        for (let dy = -1; dy <= 1; dy++)
          for (let dz = -1; dz <= 1; dz++)
            for (let dx = -1; dx <= 1; dx++)
              add(surface, `${cx + dx},${surfaceCy + dy},${cz + dz}`, dx * dx + dy * dy + dz * dz);
        if (!source.smoothSurface)
          for (let dy = -1; dy <= 1; dy++)
            for (let dz = -1; dz <= 1; dz++)
              for (let dx = -1; dx <= 1; dx++)
                add(voxel, `${cx + dx},${cy + dy},${cz + dz}`, dx * dx + dy * dy + dz * dz);
      }
    }
    const candidates = [
      ...[...surface].map(([key, distance]) => ({ kind: 'surface' as const, key, distance })),
      ...[...voxel].map(([key, distance]) => ({ kind: 'voxel' as const, key, distance })),
    ]
      .sort((a, b) => a.distance - b.distance || a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key))
      .slice(0, MAX_PHYSICS_TERRAIN_CHUNKS);
    return {
      surface: new Set(candidates.filter((entry) => entry.kind === 'surface').map((entry) => entry.key)),
      voxel: new Set(candidates.filter((entry) => entry.kind === 'voxel').map((entry) => entry.key)),
    };
  }

  private addTerrainCollider(key: string, points: TerrainPoint[], origin: [number, number, number]) {
    const source = this.terrainSource,
      body = this.terrainBody;
    if (!source || !body || !points.length) return;
    const cells = new Int32Array(points.length * 3);
    let first = 0x811c9dc5,
      second = 0x9e3779b9;
    points.forEach(([x, y, z], index) => {
      cells[index * 3] = x;
      cells[index * 3 + 1] = y;
      cells[index * 3 + 2] = z;
      for (const value of [x, y, z]) {
        first = Math.imul(first ^ value, 0x01000193);
        second = Math.imul(second + value, 0x85ebca6b);
      }
    });
    const hash = `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`,
      voxelSize = source.world.voxelSize,
      collider = this.world.createCollider(
        RAPIER.ColliderDesc.voxels(cells, { x: voxelSize, y: voxelSize, z: voxelSize }).setTranslation(
          (origin[0] - 0.5) * voxelSize,
          (origin[1] - 0.5) * voxelSize,
          (origin[2] - 0.5) * voxelSize,
        ),
        body,
      );
    this.terrainColliders.set(key, { handle: collider.handle, hash });
  }

  private addTerrainMeshCollider(key: string, vertices: number[], indices: number[]) {
    const source = this.terrainSource,
      body = this.terrainBody;
    if (!source || !body || !indices.length) return;
    const vertexData = Float32Array.from(vertices),
      indexData = Uint32Array.from(indices),
      vertexBits = new Int32Array(vertexData.buffer),
      hashValues = new Int32Array(vertexBits.length + indexData.length);
    hashValues.set(vertexBits);
    hashValues.set(indexData, vertexBits.length);
    let first = 0x811c9dc5,
      second = 0x9e3779b9;
    for (const value of hashValues) {
      first = Math.imul(first ^ value, 0x01000193);
      second = Math.imul(second + value, 0x85ebca6b);
    }
    const hash = `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`,
      collider = this.world.createCollider(
        RAPIER.ColliderDesc.trimesh(
          vertexData,
          indexData,
          RAPIER.TriMeshFlags.ORIENTED | RAPIER.TriMeshFlags.MERGE_DUPLICATE_VERTICES,
        ),
        body,
      );
    this.terrainColliders.set(key, { handle: collider.handle, hash });
  }

  private removeTerrainCollider(key: string) {
    const terrain = this.terrainColliders.get(key);
    if (!terrain) return;
    this.world.removeCollider(this.world.getCollider(terrain.handle), false);
    this.terrainColliders.delete(key);
  }

  private rebuildSurfaceChunk(chunk: string) {
    if (!this.loadedSurfaceChunks.has(chunk) || !this.terrainSource) return;
    const key = `s:${chunk}`;
    this.removeTerrainCollider(key);
    const [cx, cy, cz] = chunk.split(',').map(Number),
      minX = cx! * PHYSICS_TERRAIN_CHUNK_SIZE,
      minY = cy! * PHYSICS_TERRAIN_CHUNK_SIZE,
      minZ = cz! * PHYSICS_TERRAIN_CHUNK_SIZE,
      { world, cellAt, surfaceAt } = this.terrainSource,
      [originX, originZ] = world.generator.origin,
      maxX = originX + world.generator.size[0],
      maxY = world.generator.maxY,
      maxZ = originZ + world.generator.size[1],
      points: TerrainPoint[] = [];
    if (this.terrainSource.smoothSurface) {
      const vertices: number[] = [],
        indices: number[] = [],
        size = world.voxelSize;
      const cornerHeightAt = (cornerX: number, cornerZ: number) => {
        let total = 0,
          count = 0;
        for (let dz = -1; dz <= 0; dz++)
          for (let dx = -1; dx <= 0; dx++) {
            const sampleX = cornerX + dx,
              sampleZ = cornerZ + dz;
            if (sampleX < originX || sampleX >= maxX || sampleZ < originZ || sampleZ >= maxZ) continue;
            const surface = surfaceAt(sampleX, sampleZ);
            if (
              surface === null ||
              surface < world.generator.minY ||
              surface > maxY ||
              !cellAt({ x: sampleX, y: surface, z: sampleZ })
            )
              continue;
            total += surface;
            count++;
          }
        return count ? total / count : null;
      };
      for (let z = minZ; z < minZ + PHYSICS_TERRAIN_CHUNK_SIZE; z++)
        for (let x = minX; x < minX + PHYSICS_TERRAIN_CHUNK_SIZE; x++) {
          const corners = [
              [x, z],
              [x + 1, z],
              [x + 1, z + 1],
              [x, z + 1],
            ] as const,
            heights = corners.map(([sampleX, sampleZ]) => cornerHeightAt(sampleX, sampleZ));
          const validHeights = heights.filter((height): height is number => height !== null);
          if (validHeights.length !== 4) continue;
          const averageHeight = validHeights.reduce((sum, height) => sum + height, 0) / 4;
          if (Math.floor(averageHeight / PHYSICS_TERRAIN_CHUNK_SIZE) !== cy) continue;
          const base = vertices.length / 3;
          corners.forEach(([sampleX, sampleZ], index) => {
            vertices.push(sampleX * size, (validHeights[index]! + 0.5) * size, sampleZ * size);
          });
          // The triangles face up so Rapier reports the slope normal to capsule casts.
          indices.push(base, base + 3, base + 2, base, base + 2, base + 1);
        }
      this.addTerrainMeshCollider(key, vertices, indices);
      return;
    }
    for (let z = minZ; z < minZ + PHYSICS_TERRAIN_CHUNK_SIZE; z++)
      for (let x = minX; x < minX + PHYSICS_TERRAIN_CHUNK_SIZE; x++) {
        if (x < originX || x >= maxX || z < originZ || z >= maxZ) continue;
        const y = surfaceAt(x, z);
        if (
          y === null ||
          y < world.generator.minY ||
          y > maxY ||
          Math.floor(y / PHYSICS_TERRAIN_CHUNK_SIZE) !== cy ||
          !cellAt({ x, y, z })
        )
          continue;
        points.push([x - minX, y - minY, z - minZ]);
      }
    this.addTerrainCollider(key, points, [minX, minY, minZ]);
  }

  private rebuildVoxelChunk(chunk: string) {
    if (!this.loadedVoxelChunks.has(chunk) || !this.terrainSource) return;
    const key = `v:${chunk}`;
    this.removeTerrainCollider(key);
    const [cx, cy, cz] = chunk.split(',').map(Number),
      minX = cx! * PHYSICS_TERRAIN_CHUNK_SIZE,
      minY = cy! * PHYSICS_TERRAIN_CHUNK_SIZE,
      minZ = cz! * PHYSICS_TERRAIN_CHUNK_SIZE,
      { world, cellAt, surfaceAt } = this.terrainSource,
      [originX, originZ] = world.generator.origin,
      maxX = originX + world.generator.size[0],
      maxY = world.generator.maxY + 1,
      maxZ = originZ + world.generator.size[1],
      points: TerrainPoint[] = [];
    for (
      let y = Math.max(minY, world.generator.minY);
      y < Math.min(minY + PHYSICS_TERRAIN_CHUNK_SIZE, maxY);
      y++
    )
      for (let z = minZ; z < minZ + PHYSICS_TERRAIN_CHUNK_SIZE; z++)
        for (let x = minX; x < minX + PHYSICS_TERRAIN_CHUNK_SIZE; x++) {
          if (x < originX || x >= maxX || z < originZ || z >= maxZ || !cellAt({ x, y, z })) continue;
          if (surfaceAt(x, z) === y) continue;
          points.push([x - minX, y - minY, z - minZ]);
        }
    this.addTerrainCollider(key, points, [minX, minY, minZ]);
  }

  private syncTerrainColliders(deltaSeconds = 0) {
    if (!this.terrainSource || !this.terrainBody) return;
    const desired = this.terrainCandidates(deltaSeconds);
    for (const chunk of this.loadedSurfaceChunks) {
      if (desired.surface.has(chunk)) continue;
      this.removeTerrainCollider(`s:${chunk}`);
      this.loadedSurfaceChunks.delete(chunk);
    }
    for (const chunk of this.loadedVoxelChunks) {
      if (desired.voxel.has(chunk)) continue;
      this.removeTerrainCollider(`v:${chunk}`);
      this.loadedVoxelChunks.delete(chunk);
    }
    for (const chunk of desired.surface)
      if (!this.loadedSurfaceChunks.has(chunk)) {
        this.loadedSurfaceChunks.add(chunk);
        this.rebuildSurfaceChunk(chunk);
      }
    for (const chunk of desired.voxel)
      if (!this.loadedVoxelChunks.has(chunk)) {
        this.loadedVoxelChunks.add(chunk);
        this.rebuildVoxelChunk(chunk);
      }
  }

  private clearTerrainColliders() {
    for (const key of this.terrainColliders.keys()) this.removeTerrainCollider(key);
    this.loadedSurfaceChunks.clear();
    this.loadedVoxelChunks.clear();
  }

  query(query: PhysicsQuery): PhysicsQueryResult {
    if (this.disposed)
      return { available: false, shape: query.shape, reason: 'Physics scene has been disposed.' };
    const excluded = new Set(query.excludeNodeIds),
      accepts = (collider: RAPIER.Collider) => {
        if (!collider.isEnabled() || (!query.includeSensors && collider.isSensor())) return false;
        const nodeId = this.colliderNodes.get(collider.handle);
        if (nodeId && (excluded.has(nodeId) || !this.bodies.get(nodeId)?.node.enabled)) return false;
        return collider.parent()?.isEnabled() ?? true;
      };
    // ponytail: scan the bounded 5,000-node scene for agent-only probes; use the broad phase if measured query latency warrants it.
    if (query.shape === 'ray') {
      const origin = new Vector3(...query.origin),
        direction = new Vector3(...query.direction).normalize(),
        ray = new RAPIER.Ray(origin, direction);
      let hit: PhysicsQueryHit | null = null;
      this.world.colliders.forEach((collider) => {
        if (!accepts(collider)) return;
        const intersection = collider.castRayAndGetNormal(ray, query.maxDistance, true);
        if (!intersection || (hit && intersection.timeOfImpact >= hit.distance)) return;
        const position = origin.clone().addScaledVector(direction, intersection.timeOfImpact),
          nodeId = this.colliderNodes.get(collider.handle) ?? null,
          source = nodeId ? 'scene' : this.isTerrainCollider(collider.handle) ? 'terrain' : 'environment';
        hit = {
          nodeId,
          source,
          distance: intersection.timeOfImpact,
          position: position.toArray() as [number, number, number],
          normal: [intersection.normal.x, intersection.normal.y, intersection.normal.z],
        };
      });
      return {
        available: true,
        shape: 'ray',
        hit,
      };
    }

    if (query.shape === 'shape-cast') {
      const castShape = query.castShape,
        position = new Vector3(...query.position),
        direction = new Vector3(...query.direction).normalize(),
        rotation =
          castShape.shape === 'box' || castShape.shape === 'capsule'
            ? new Quaternion(...castShape.rotation).normalize()
            : new Quaternion(),
        shape =
          castShape.shape === 'box'
            ? new RAPIER.Cuboid(castShape.size[0] / 2, castShape.size[1] / 2, castShape.size[2] / 2)
            : castShape.shape === 'sphere'
              ? new RAPIER.Ball(castShape.radius)
              : new RAPIER.Capsule(castShape.halfHeight, castShape.radius),
        zeroVelocity = new Vector3(),
        maxDistance = query.maxDistance;
      let hit: PhysicsQueryHit | null = null;
      this.world.colliders.forEach((collider) => {
        if (!accepts(collider)) return;
        const targetPosition = collider.translation(),
          targetRotation = collider.rotation();
        const intersection = shape.castShape(
          position,
          rotation,
          direction,
          collider.shape,
          targetPosition,
          targetRotation,
          zeroVelocity,
          0,
          maxDistance,
          true,
        );
        if (!intersection || (hit && intersection.time_of_impact >= hit.distance)) return;
        const nodeId = this.colliderNodes.get(collider.handle) ?? null,
          source = nodeId ? 'scene' : this.isTerrainCollider(collider.handle) ? 'terrain' : 'environment',
          targetOrientation = new Quaternion(
            targetRotation.x,
            targetRotation.y,
            targetRotation.z,
            targetRotation.w,
          ),
          worldPosition = new Vector3(
            intersection.witness2.x,
            intersection.witness2.y,
            intersection.witness2.z,
          )
            .applyQuaternion(targetOrientation)
            .add(new Vector3(targetPosition.x, targetPosition.y, targetPosition.z)),
          worldNormal = new Vector3(intersection.normal2.x, intersection.normal2.y, intersection.normal2.z)
            .applyQuaternion(targetOrientation)
            .normalize();
        hit = {
          nodeId,
          source,
          distance: intersection.time_of_impact,
          position: worldPosition.toArray() as [number, number, number],
          normal: worldNormal.toArray() as [number, number, number],
        };
      });
      return {
        available: true,
        shape: 'shape-cast',
        hit,
      };
    }

    const position = { x: query.position[0], y: query.position[1], z: query.position[2] },
      rotation =
        query.shape === 'box' || query.shape === 'capsule'
          ? new Quaternion(...query.rotation).normalize()
          : new Quaternion(),
      shape =
        query.shape === 'box'
          ? new RAPIER.Cuboid(query.size[0] / 2, query.size[1] / 2, query.size[2] / 2)
          : query.shape === 'sphere'
            ? new RAPIER.Ball(query.radius)
            : new RAPIER.Capsule(query.halfHeight, query.radius),
      nodeIds = new Set<string>(),
      sources = new Set<'terrain' | 'environment'>();
    let truncated = false;
    this.world.colliders.forEach((collider) => {
      if (!accepts(collider) || !collider.intersectsShape(shape, position, rotation)) return;
      const nodeId = this.colliderNodes.get(collider.handle) ?? null,
        source = nodeId ? null : this.isTerrainCollider(collider.handle) ? 'terrain' : 'environment';
      if ((nodeId && nodeIds.has(nodeId)) || (source && sources.has(source))) return;
      if (nodeIds.size + sources.size >= MAX_PHYSICS_QUERY_HITS) {
        truncated = true;
        return;
      }
      if (nodeId) nodeIds.add(nodeId);
      else if (source) sources.add(source);
    });
    return {
      available: true,
      shape: query.shape,
      nodeIds: [...nodeIds].sort(),
      sources: [...sources].sort(),
      truncated,
    };
  }

  private isTerrainCollider(handle: RAPIER.ColliderHandle) {
    for (const terrain of this.terrainColliders.values()) if (terrain.handle === handle) return true;
    return false;
  }

  stepWithEvents(deltaSeconds: number): PhysicsStep {
    this.syncAuthoredTransforms();
    this.syncTerrainColliders(deltaSeconds);
    const previous = new Map<string, PlatformPose>();
    for (const [id, record] of this.bodies) {
      if (!record.node.enabled || (record.bodyType !== 'dynamic' && record.bodyType !== 'kinematic-velocity'))
        continue;
      const position = record.body.translation(),
        rotation = record.body.rotation();
      previous.set(id, {
        position: new Vector3(position.x, position.y, position.z),
        rotation: new Quaternion(rotation.x, rotation.y, rotation.z, rotation.w),
      });
    }
    this.world.timestep = deltaSeconds;
    this.world.step(this.eventQueue ?? undefined);
    const collisions: PhysicsCollisionEvent[] = [];
    this.eventQueue?.drainCollisionEvents((handleA, handleB, started) => {
      const nodeAId = this.colliderNodes.get(handleA),
        nodeBId = this.colliderNodes.get(handleB);
      if (nodeAId && nodeBId && nodeAId !== nodeBId) collisions.push({ nodeAId, nodeBId, started });
    });
    const poses = new Map<string, PhysicsPose>();
    for (const [id, record] of this.bodies) {
      if (!record.node.enabled || (record.bodyType !== 'dynamic' && record.bodyType !== 'kinematic-velocity'))
        continue;
      const translation = record.body.translation(),
        rotation = record.body.rotation(),
        position = new Vector3(translation.x, translation.y, translation.z),
        quaternion = new Quaternion(rotation.x, rotation.y, rotation.z, rotation.w);
      poses.set(id, {
        position,
        rotation: quaternion,
        previousPosition: previous.get(id)?.position ?? position.clone(),
      });
      const previousPose = previous.get(id) ?? {
        position: position.clone(),
        rotation: quaternion.clone(),
      };
      this.rememberPlatformDisplacement(id, previousPose, {
        position: position.clone(),
        rotation: quaternion.clone(),
      });
      record.lastPose = { ...record.lastPose, position: position.clone(), rotation: quaternion.clone() };
    }
    return { poses, collisions };
  }

  step(deltaSeconds: number) {
    return this.stepWithEvents(deltaSeconds).poses;
  }

  captureMotion(id: string): PhysicsMotion | null {
    if (this.disposed) return null;
    const record = this.bodies.get(id);
    if (!record || !record.body.isValid()) return null;
    const linear = record.body.linvel(),
      angular = record.body.angvel();
    return {
      linearVelocity: [linear.x, linear.y, linear.z],
      angularVelocity: [angular.x, angular.y, angular.z],
      sleeping: record.body.isSleeping(),
    };
  }

  /**
   * Capture a local rollback snapshot at a step boundary. Rapier serializes its
   * integration, body, collider and contact-phase state, but not JS node maps or
   * EventQueue contents, so the envelope stores handle mappings separately.
   */
  captureSnapshot(): RapierPhysicsSnapshot | null {
    if (this.disposed) return null;
    if (
      this.world.bodies.len() > MAX_RAPIER_SNAPSHOT_ENTRIES ||
      this.world.colliders.len() > MAX_RAPIER_SNAPSHOT_ENTRIES
    )
      return null;
    const world = this.world.takeSnapshot();
    if (!world.length || world.byteLength > MAX_RAPIER_SNAPSHOT_BYTES) return null;
    return {
      format: 1,
      rapierVersion: RAPIER.version(),
      compatibilityKey: this.compatibilityKey,
      world: world.slice(),
      bodyHandles: [...this.bodies.entries()]
        .map(([nodeId, record]) => ({ nodeId, handle: record.body.handle }))
        .sort((a, b) => a.nodeId.localeCompare(b.nodeId)),
      colliderHandles: [...this.colliderNodes.entries()]
        .map(([handle, nodeId]) => ({ nodeId, handle }))
        .sort((a, b) => a.nodeId.localeCompare(b.nodeId)),
      jointHandles: [...this.joints.entries()]
        .map(([nodeId, joint]) => ({ nodeId, handle: joint.handle }))
        .sort((a, b) => a.nodeId.localeCompare(b.nodeId)),
      ...(this.terrainBody && {
        terrainBodyHandle: this.terrainBody.handle,
        terrainColliderHandles: [...this.terrainColliders.entries()]
          .map(([key, terrain]) => ({ key, hash: terrain.hash, handle: terrain.handle }))
          .sort((a, b) => a.key.localeCompare(b.key)),
      }),
      worldBodyCount: this.world.bodies.len(),
      worldColliderCount: this.world.colliders.len(),
    };
  }

  /**
   * Restore a snapshot only into a physics adapter built from the same physics
   * topology and Rapier runtime. Existing world state is left intact on failure.
   */
  restoreSnapshot(value: unknown): boolean {
    if (this.disposed || !isSnapshotEnvelope(value)) return false;
    const snapshot = value;
    if (
      snapshot.rapierVersion !== RAPIER.version() ||
      snapshot.compatibilityKey !== this.compatibilityKey ||
      snapshot.bodyHandles.length !== this.bodies.size ||
      snapshot.colliderHandles.length !== this.colliderNodes.size ||
      (snapshot.jointHandles ?? []).length !== this.joints.size ||
      (this.terrainBody === null) !== (snapshot.terrainBodyHandle === undefined) ||
      (this.terrainBody !== null &&
        (!snapshot.terrainColliderHandles ||
          snapshot.terrainColliderHandles.length !== this.terrainColliders.size)) ||
      snapshot.worldBodyCount !== this.world.bodies.len() ||
      snapshot.worldColliderCount !== this.world.colliders.len()
    )
      return false;

    const currentTerrain = [...this.terrainColliders.entries()].sort(([a], [b]) => a.localeCompare(b)),
      savedTerrain = snapshot.terrainColliderHandles ?? [];
    if (
      currentTerrain.some(
        ([key, terrain], index) =>
          key !== savedTerrain[index]?.key || terrain.hash !== savedTerrain[index]?.hash,
      )
    )
      return false;

    const bodyNodeIds = new Set<string>(),
      bodyHandles = new Set<number>(),
      colliderNodeHandles = new Set<number>(),
      terrainHandles = new Set<number>(),
      jointNodeIds = new Set<string>(),
      jointHandles = new Set<number>(),
      nextColliderNodes = new Map<RAPIER.ColliderHandle, string>(),
      nextTerrainColliders = new Map<string, TerrainCollider>(),
      nextJoints = new Map<string, RAPIER.ImpulseJoint>(),
      expectedColliderCounts = new Map<string, number>(),
      actualColliderCounts = new Map<string, number>();
    for (const nodeId of this.colliderNodes.values()) {
      expectedColliderCounts.set(nodeId, (expectedColliderCounts.get(nodeId) ?? 0) + 1);
    }
    for (const { nodeId, handle } of snapshot.bodyHandles) {
      const handleIndex = rapierHandleIndex(handle);
      if (
        handleIndex === null ||
        !this.bodies.has(nodeId) ||
        bodyNodeIds.has(nodeId) ||
        bodyHandles.has(handle) ||
        handleIndex >= snapshot.worldBodyCount
      )
        return false;
      bodyNodeIds.add(nodeId);
      bodyHandles.add(handle);
    }
    for (const { nodeId, handle } of snapshot.colliderHandles) {
      const handleIndex = rapierHandleIndex(handle);
      if (
        handleIndex === null ||
        !this.bodies.has(nodeId) ||
        colliderNodeHandles.has(handle) ||
        handleIndex >= snapshot.worldColliderCount
      )
        return false;
      colliderNodeHandles.add(handle);
      nextColliderNodes.set(handle, nodeId);
      actualColliderCounts.set(nodeId, (actualColliderCounts.get(nodeId) ?? 0) + 1);
    }
    for (const { nodeId, handle } of snapshot.jointHandles ?? []) {
      const handleIndex = rapierHandleIndex(handle);
      if (
        handleIndex === null ||
        !this.joints.has(nodeId) ||
        jointNodeIds.has(nodeId) ||
        jointHandles.has(handle) ||
        handleIndex >= this.world.impulseJoints.len()
      )
        return false;
      jointNodeIds.add(nodeId);
      jointHandles.add(handle);
    }
    const terrainBodyIndex =
      snapshot.terrainBodyHandle === undefined ? null : rapierHandleIndex(snapshot.terrainBodyHandle);
    if (
      (snapshot.terrainBodyHandle !== undefined &&
        (terrainBodyIndex === null ||
          terrainBodyIndex >= snapshot.worldBodyCount ||
          bodyHandles.has(snapshot.terrainBodyHandle))) ||
      savedTerrain.some(({ handle, key, hash }) => {
        const index = rapierHandleIndex(handle),
          expected = this.terrainColliders.get(key);
        if (
          index === null ||
          index >= snapshot.worldColliderCount ||
          colliderNodeHandles.has(handle) ||
          terrainHandles.has(handle) ||
          !expected ||
          expected.hash !== hash
        )
          return true;
        terrainHandles.add(handle);
        nextTerrainColliders.set(key, { handle, hash });
        return false;
      })
    )
      return false;
    if (
      expectedColliderCounts.size !== actualColliderCounts.size ||
      [...expectedColliderCounts].some(([id, count]) => actualColliderCounts.get(id) !== count)
    )
      return false;

    let restored: RAPIER.World | null = null,
      restoredTerrainBody: RAPIER.RigidBody | null = null,
      reboundBodies = new Map<string, RAPIER.RigidBody>(),
      lastPoses = new Map<string, Pose>();
    try {
      restored = RAPIER.World.restoreSnapshot(snapshot.world.slice());
      if (
        !restored ||
        restored.bodies.len() !== snapshot.worldBodyCount ||
        restored.colliders.len() !== snapshot.worldColliderCount ||
        restored.impulseJoints.len() !== jointHandles.size
      ) {
        restored?.free();
        return false;
      }
      for (const { nodeId, handle } of snapshot.bodyHandles) {
        const body = restored.bodies.get(handle);
        if (!body?.isValid()) {
          restored.free();
          return false;
        }
        reboundBodies.set(nodeId, body);
      }
      if (snapshot.terrainBodyHandle !== undefined) {
        restoredTerrainBody = restored.bodies.get(snapshot.terrainBodyHandle);
        if (!restoredTerrainBody?.isValid()) {
          restored.free();
          return false;
        }
      }
      for (const { nodeId, handle } of snapshot.colliderHandles) {
        const collider = restored.colliders.get(handle),
          body = reboundBodies.get(nodeId);
        if (!collider || !body || collider.parent()?.handle !== body.handle) {
          restored.free();
          return false;
        }
      }
      for (const { key, handle } of savedTerrain) {
        const collider = restored.colliders.get(handle);
        if (
          !collider ||
          collider.parent()?.handle !== restoredTerrainBody?.handle ||
          !nextTerrainColliders.has(key)
        ) {
          restored.free();
          return false;
        }
      }
      for (const { nodeId, handle } of snapshot.jointHandles ?? []) {
        const joint = restored.impulseJoints.get(handle);
        if (!joint?.isValid()) {
          restored.free();
          return false;
        }
        nextJoints.set(nodeId, joint);
      }
      for (const [nodeId, body] of reboundBodies) {
        const record = this.bodies.get(nodeId)!;
        lastPoses.set(nodeId, this.scenePose(record));
      }
    } catch {
      restored?.free();
      return false;
    }

    const previous = this.world;
    this.eventQueue?.clear();
    this.world = restored!;
    this.colliderNodes = nextColliderNodes;
    this.terrainBody = restoredTerrainBody;
    this.terrainColliders = nextTerrainColliders;
    this.joints = nextJoints;
    for (const [nodeId, body] of reboundBodies) {
      const record = this.bodies.get(nodeId)!;
      record.body = body;
      // The scene transform is external to Rapier's snapshot. Track its
      // current value so it does not overwrite restored dynamic poses.
      record.lastPose = lastPoses.get(nodeId)!;
    }
    restored = null;
    this.characterMovement.clear();
    this.platformDisplacements.clear();
    previous.free();
    return true;
  }

  restoreMotion(id: string, state: PhysicsMotion): boolean {
    if (this.disposed || !isPhysicsMotion(state)) return false;
    if (
      state.sleeping &&
      [...state.linearVelocity, ...state.angularVelocity].some((velocity) => velocity !== 0)
    )
      return false;
    const record = this.bodies.get(id);
    if (
      !record ||
      !record.body.isValid() ||
      (state.sleeping && (record.bodyType !== 'dynamic' || !record.canSleep))
    )
      return false;
    record.body.setLinvel(
      { x: state.linearVelocity[0], y: state.linearVelocity[1], z: state.linearVelocity[2] },
      true,
    );
    record.body.setAngvel(
      { x: state.angularVelocity[0], y: state.angularVelocity[1], z: state.angularVelocity[2] },
      true,
    );
    if (state.sleeping) record.body.sleep();
    else record.body.wakeUp();
    return true;
  }

  setBodyPose(id: string, position: Vector3, rotation?: Quaternion) {
    const record = this.bodies.get(id);
    if (!record) return;
    record.body.setTranslation(position, true);
    if (rotation) record.body.setRotation(rotation, true);
    record.lastPose = {
      ...record.lastPose,
      position: position.clone(),
      rotation: rotation?.clone() ?? record.lastPose.rotation,
    };
  }

  linearVelocity(id: string) {
    const velocity = this.bodies.get(id)?.body.linvel();
    return velocity ? new Vector3(velocity.x, velocity.y, velocity.z) : new Vector3();
  }

  setLinearVelocity(id: string, velocity: Vector3) {
    const body = this.bodies.get(id)?.body;
    if (body) body.setLinvel(velocity, true);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.eventQueue?.free();
    this.characterMovement.clear();
    this.platformDisplacements.clear();
    this.world.free();
    this.bodies.clear();
    this.colliderNodes.clear();
    this.joints.clear();
  }
}
