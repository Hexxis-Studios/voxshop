import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { idSchema, type ProjectDocument } from '../services/projectDocument';
import type { ViewportCommand } from '../services/viewportProtocol';
import { disposeObject } from './assetMesh';
import { SceneVisuals } from './SceneVisuals';
import { GameSimulation, type GameInput } from './GameSimulation';
import { ProceduralAudioPlayer, type ProceduralSoundCue } from './proceduralAudio';
import { ImportedAudioPlayer } from './importedAudio';
import { GameSession } from './GameSession';
import { mapGamepadInput, type GamepadInput } from './gamepadInput';
import {
  DEFAULT_PLAYER_CONTROLS,
  keyboardActionForCode,
  movementFromKeys,
  resolvePlayerControls,
  type PlayerControls,
} from '../services/playerControls';
import { WorldStreamRenderer } from './WorldStreamRenderer';
import { WorldVoxelRenderer } from './WorldVoxelRenderer';
import {
  DEFAULT_FRAME_PACING,
  advanceFrameDeadline,
  measureFramePacing,
  normalizeFramePacing,
  type FramePacingSettings,
} from './framePacing';
import { updateSceneLighting } from './sceneLighting';
import { selectGameHudTab } from './gameHud';
import { createTerrainSurfaceSampler } from '../services/terrainNoise';
import { GpuTimerQueries } from './gpuTimerQueries';
import { OCCLUSION_QUERY_FRAME_BUDGET } from './occlusionQueries';
import type { PhysicsQueryResult } from './RapierPhysics';
import { MultiplayerGameConnection, type MultiplayerGameplayInput } from './MultiplayerGameConnection';
import { loadMultiplayerResumeSession } from './MultiplayerClient';
import type { MultiplayerConnectionInfo, MultiplayerRoomOptions } from './multiplayerControls';
import {
  createWorldCellSampler,
  type WorldCell,
  type WorldDocument,
  type WorldEdit,
} from '../services/worldDocument';

type ViewportOptions = {
  renderLoop?: 'display' | 'unlocked';
  simulationHz?: number;
  framePacing?: FramePacingSettings;
  asyncTerrainTiles?: boolean;
  createTerrainWorker?: () => Worker;
  asyncVoxelChunks?: boolean;
  createVoxelWorker?: () => Worker;
};
export type TerrainEditMode = 'place' | 'remove';
export type TerrainToolMode = TerrainEditMode | 'inspect';
export type TerrainBrushSize = 1 | 3 | 5;
export type TerrainBrushShape = 'brush' | 'cube' | 'sphere';
export type TerrainPaletteLayer = 'surface' | 'subsurface' | 'deep' | 'custom';
export type TerrainPaint = WorldCell;
export type TerrainInspection = {
  position: [number, number, number];
  physicalPosition: [number, number, number];
  cell: WorldCell | undefined;
  status: 'generated' | 'sparse' | 'removed' | 'empty';
};

export function cameraRelativeMovement(moveX: number, moveZ: number, yaw: number) {
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  return { moveX: moveX * cos + moveZ * sin, moveZ: -moveX * sin + moveZ * cos };
}

const MAX_TERRAIN_STROKE_CELLS = 10000;
type ViewportStepInput = GameInput & { uiTab?: { groupId: string; tabId: string } };
const TERRAIN_STROKE_SAMPLE_PIXELS = 4;
const FOLLOW_CAMERA = {
  'first-person': { distance: 0, pitch: 0 },
  'top-down': { distance: Math.hypot(20, 12), pitch: Math.atan2(20, 12) },
  'third-person': { distance: Math.hypot(6, 10), pitch: Math.atan2(6, 10) },
} as const;

export function activeWorldUnchanged(previous: ProjectDocument, next: ProjectDocument) {
  if (previous.id !== next.id) return false;
  const previousScene = previous.scenes.find((scene) => scene.id === previous.activeSceneId),
    nextScene = next.scenes.find((scene) => scene.id === next.activeSceneId),
    worldId = nextScene?.worldId;
  if (!worldId || previousScene?.worldId !== worldId) return false;
  const previousWorld = previous.worlds.find((world) => world.id === worldId),
    nextWorld = next.worlds.find((world) => world.id === worldId);
  return !!previousWorld && !!nextWorld && JSON.stringify(previousWorld) === JSON.stringify(nextWorld);
}

export function activeVoxelWorldCanApplyEditChanges(previous: ProjectDocument, next: ProjectDocument) {
  if (previous.id !== next.id) return false;
  const previousScene = previous.scenes.find((scene) => scene.id === previous.activeSceneId),
    nextScene = next.scenes.find((scene) => scene.id === next.activeSceneId),
    worldId = nextScene?.worldId;
  if (!worldId || previousScene?.worldId !== worldId) return false;
  const previousWorld = previous.worlds.find((world) => world.id === worldId),
    nextWorld = next.worlds.find((world) => world.id === worldId);
  return (
    !!previousWorld &&
    !!nextWorld &&
    previousWorld.generator.mode === 'voxel3d' &&
    nextWorld.generator.mode === 'voxel3d' &&
    JSON.stringify({ ...previousWorld, edits: [] }) === JSON.stringify({ ...nextWorld, edits: [] })
  );
}

export function terrainEditsFromHit(
  world: WorldDocument,
  mode: TerrainEditMode,
  point: readonly [number, number, number],
  normal: readonly [number, number, number],
  coarseSurface = false,
  brushSize: TerrainBrushSize = 1,
  paletteLayer: TerrainPaletteLayer = 'surface',
  customPaint?: TerrainPaint,
  brushShape: TerrainBrushShape = 'brush',
): WorldEdit[] {
  if (![1, 3, 5].includes(brushSize)) throw new Error('Terrain brush size must be 1, 3 or 5 cells.');
  if (!['brush', 'cube', 'sphere'].includes(brushShape)) throw new Error('Unknown terrain brush shape.');
  const axis = normal.reduce(
      (best, value, index) => (Math.abs(value) > Math.abs(normal[best]) ? index : best),
      0,
    ),
    direction = Math.sign(normal[axis]);
  if (!direction) throw new Error('The terrain face has no usable normal.');
  const cell = point.map((coordinate, index) =>
    Math.floor(coordinate / world.voxelSize - (index === axis ? direction * 1e-5 : 0) + 0.5),
  );
  if (coarseSurface && axis === 1 && direction > 0) {
    const [originX, originZ] = world.generator.origin,
      [width, depth] = world.generator.size;
    cell[0] = Math.max(originX, Math.min(originX + width - 1, cell[0]));
    cell[2] = Math.max(originZ, Math.min(originZ + depth - 1, cell[2]));
    const overrides = new Map(
      world.edits
        .filter((edit) => edit.x === cell[0] && edit.z === cell[2])
        .map((edit) => [edit.y, edit.value]),
    );
    let surface = createTerrainSurfaceSampler(world)(cell[0], cell[2]);
    for (const [y, value] of overrides) if (value && y > surface) surface = y;
    while (overrides.get(surface) === null) surface--;
    cell[1] = surface;
  }
  if (mode === 'place') cell[axis] += direction;
  const value =
      mode === 'remove'
        ? null
        : paletteLayer === 'custom'
          ? (customPaint ?? {
              color: world.generator.palette.surface,
              materialType: world.generator.palette.materialType,
            })
          : {
              color: world.generator.palette[paletteLayer],
              materialType: world.generator.palette.materialType,
            },
    half = Math.floor(brushSize / 2),
    edits = new Map<string, WorldEdit>();
  for (let x = -half; x <= half; x++)
    for (let y = -half; y <= half; y++)
      for (let z = -half; z <= half; z++) {
        if (brushShape === 'brush' && [x, y, z][axis] !== 0) continue;
        if (brushShape === 'sphere' && x * x + y * y + z * z > half * half) continue;
        const position = [...cell];
        position[0] += x;
        position[1] += y;
        position[2] += z;
        if (
          position.some(
            (coordinate) => !Number.isSafeInteger(coordinate) || Math.abs(coordinate) > 1_000_000_000,
          )
        )
          throw new RangeError('Terrain brush reaches beyond the supported world coordinate bounds.');
        const edit = { x: position[0], y: position[1], z: position[2], value };
        edits.set(`${edit.x},${edit.y},${edit.z}`, edit);
      }
  return [...edits.values()];
}

export function terrainEditFromHit(
  world: WorldDocument,
  mode: TerrainEditMode,
  point: readonly [number, number, number],
  normal: readonly [number, number, number],
  coarseSurface = false,
  paletteLayer: TerrainPaletteLayer = 'surface',
  customPaint?: TerrainPaint,
  brushShape: TerrainBrushShape = 'brush',
): WorldEdit {
  return terrainEditsFromHit(
    world,
    mode,
    point,
    normal,
    coarseSurface,
    1,
    paletteLayer,
    customPaint,
    brushShape,
  )[0];
}

export function createTerrainInspector(world: WorldDocument) {
  const sampleCell = createWorldCellSampler(world),
    sparseEdits = new Map(world.edits.map((edit) => [`${edit.x},${edit.y},${edit.z}`, edit.value]));
  return (
    point: readonly [number, number, number],
    normal: readonly [number, number, number],
    coarseSurface = false,
  ): TerrainInspection => {
    const { x, y, z } = terrainEditFromHit(world, 'remove', point, normal, coarseSurface),
      key = `${x},${y},${z}`,
      cell = sampleCell({ x, y, z }),
      hasSparseEdit = sparseEdits.has(key);
    return {
      position: [x, y, z],
      physicalPosition: [x * world.voxelSize, y * world.voxelSize, z * world.voxelSize],
      cell,
      status: hasSparseEdit ? (cell ? 'sparse' : 'removed') : cell ? 'generated' : 'empty',
    };
  };
}

export function terrainStrokeSamples(
  from: readonly [number, number],
  to: readonly [number, number],
): [number, number][] {
  const distance = Math.hypot(to[0] - from[0], to[1] - from[1]),
    count = Math.max(1, Math.ceil(distance / TERRAIN_STROKE_SAMPLE_PIXELS));
  if (count > MAX_TERRAIN_STROKE_CELLS)
    throw new RangeError('Terrain stroke is too long. Use a shorter stroke.');
  return Array.from({ length: count }, (_, index) => {
    const progress = (index + 1) / count;
    return [from[0] + (to[0] - from[0]) * progress, from[1] + (to[1] - from[1]) * progress];
  });
}

export function addTerrainStrokeEdits(target: Map<string, WorldEdit>, additions: readonly WorldEdit[]) {
  const fresh = new Map<string, WorldEdit>();
  for (const edit of additions) {
    const key = `${edit.x},${edit.y},${edit.z}`;
    if (!target.has(key)) fresh.set(key, edit);
  }
  if (target.size + fresh.size > MAX_TERRAIN_STROKE_CELLS)
    throw new RangeError('A terrain stroke may contain at most 10,000 unique cells.');
  for (const [key, edit] of fresh) target.set(key, edit);
}

type TerrainStroke = {
  pointerId: number;
  project: ProjectDocument;
  world: WorldDocument;
  mode: TerrainEditMode;
  brushSize: TerrainBrushSize;
  brushShape: TerrainBrushShape;
  paletteLayer: TerrainPaletteLayer;
  customPaint: TerrainPaint;
  lastPoint: [number, number];
  edits: Map<string, WorldEdit>;
  error?: string;
};

export class GameViewport {
  readonly scene = new THREE.Scene();
  private readonly sceneLights = new THREE.Group();
  readonly camera = new THREE.PerspectiveCamera(50, 1, 0.1, 2000);
  readonly renderer: THREE.WebGLRenderer;
  private readonly gpuTimer: GpuTimerQueries;
  readonly controls: OrbitControls;
  private session: GameSession | null = null;
  private readonly audio = new ProceduralAudioPlayer();
  private readonly importedAudio: ImportedAudioPlayer;
  private runtimeSceneId: string | null = null;
  get simulation() {
    return this.session?.simulation ?? null;
  }
  get ready() {
    return this.session?.ready ?? Promise.resolve();
  }
  get scenePath() {
    return this.session?.scenePath ?? [this.project.activeSceneId];
  }
  campaignProgressSnapshot() {
    return this.session?.progressSnapshot() ?? null;
  }
  private visuals!: SceneVisuals;
  private worldRenderer: WorldStreamRenderer | WorldVoxelRenderer | null = null;
  private renderedWorld: WorldDocument | null = null;
  private loadedWorldId: string | null = null;
  private project: ProjectDocument;
  private frame = 0;
  private renderTimer: number | null = null;
  private renderTaskChannel: MessageChannel | null = null;
  private renderTaskPending = false;
  private nextCappedFrameAt = 0;
  private disposed = false;
  private last = 0;
  private elapsed = 0;
  private accumulator = 0;
  private keys = new Set<string>();
  private touchMovement = { moveX: 0, moveZ: 0 };
  private gamepadInput: GamepadInput = mapGamepadInput(null);
  private readonly playerControlsCache = new WeakMap<GameSimulation, PlayerControls>();
  private gameCameraYaw = 0;
  private gameCameraPitch: number | null = null;
  private readonly gameCameraOffset = new THREE.Vector3();
  private readonly gameCameraLookTarget = new THREE.Vector3();
  private mouseLookPointer: { id: number; x: number; y: number } | null = null;
  private pending: GameInput = {};
  private multiplayer?: MultiplayerGameConnection;
  private multiplayerError?: string;
  private remoteTopology = '';
  private observer: ResizeObserver;
  private selected: THREE.Box3Helper | null = null;
  private selectedId: string | null = null;
  private terrainMode: TerrainToolMode | null = null;
  private terrainBrushSize: TerrainBrushSize = 1;
  private terrainBrushShape: TerrainBrushShape = 'brush';
  private terrainPaletteLayer: TerrainPaletteLayer = 'surface';
  private terrainCustomPaint: TerrainPaint = { color: 0x55aa44, materialType: 'STANDARD' };
  private terrainStroke: TerrainStroke | null = null;
  private terrainInspectPointerId: number | null = null;
  private terrainInspector: ReturnType<typeof createTerrainInspector> | null = null;
  private stateStamp = '';
  private agentPaused = false;
  private cameraOverride = false;
  private editorViewBeforePlay: {
    position: THREE.Vector3;
    target: THREE.Vector3;
    near: number;
    far: number;
    cameraOverride: boolean;
  } | null = null;
  private frameIntervalMs = 0;
  private readonly renderLoop: 'display' | 'unlocked';
  private framePacing: FramePacingSettings = { ...DEFAULT_FRAME_PACING };
  private lastFrameStartedAt = 0;
  private readonly simulationDelta: number;
  private readonly terrainWorkerFactory?: () => Worker;
  private readonly voxelWorkerFactory?: () => Worker;
  private performanceWindowStart = performance.now();
  private renderCallsInWindow = 0;
  private rendererCallMsInWindow = 0;
  private simulatedStepsInWindow = 0;
  private totalRendererCalls = 0;
  private totalRendererCallMs = 0;
  private totalSimulationSteps = 0;
  private rendererCallsPerSecond = 0;
  private rendererCallMsPerCall = 0;
  private simulationHz = 0;
  private performanceCaptureActive = false;
  private activeHudTabs: Record<string, string> = {};
  private activeHudSceneId = '';
  onState?: (state: ReturnType<GameSimulation['inspect']> | null) => void;
  onHudTab?: (activeTabs: Record<string, string>) => void;
  onPerformance?: (stats: ReturnType<GameViewport['performanceInfo']>) => void;
  onTerrainEdit?: (projectId: string, worldId: string, edits: WorldEdit[]) => void;
  onTerrainEditError?: (message: string) => void;
  onTerrainInspect?: (inspection: TerrainInspection | null) => void;
  progressRestoredSceneId: string | null = null;
  constructor(
    private container: HTMLElement,
    project: ProjectDocument,
    private onSelect?: (id: string) => void,
    options: ViewportOptions = {},
  ) {
    this.importedAudio = new ImportedAudioPlayer(project.audioClips);
    this.renderLoop = options.renderLoop ?? 'display';
    if (options.framePacing) this.framePacing = normalizeFramePacing(options.framePacing);
    if (this.renderLoop === 'unlocked' && typeof MessageChannel !== 'undefined') {
      this.renderTaskChannel = new MessageChannel();
      this.renderTaskChannel.port1.onmessage = () => this.onRenderTask();
      this.renderTaskChannel.port1.start();
    }
    this.terrainWorkerFactory = options.asyncTerrainTiles ? options.createTerrainWorker : undefined;
    this.voxelWorkerFactory = options.asyncVoxelChunks ? options.createVoxelWorker : undefined;
    const simulationHz = options.simulationHz ?? 60;
    if (!Number.isInteger(simulationHz) || simulationHz < 1 || simulationHz > 1000)
      throw new Error('Simulation rate must be an integer from 1 to 1000 Hz.');
    this.simulationDelta = 1 / simulationHz;
    this.project = project;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.gpuTimer = new GpuTimerQueries(
      this.renderer.getContext() as unknown as ConstructorParameters<typeof GpuTimerQueries>[0],
    );
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    container.appendChild(this.renderer.domElement);
    this.camera.position.set(15, 14, 20);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 1, 0);
    this.controls.enableDamping = true;
    this.sceneLights.name = 'scene-lights';
    this.scene.add(this.sceneLights);
    this.renderer.domElement.tabIndex = 0;
    this.renderer.domElement.setAttribute(
      'aria-label',
      'Scene viewport. Select objects with a click. In Play mode, keyboard and standard or remapped raw gamepad buttons follow the selected player’s authored control bindings; right-drag to look.',
    );
    this.renderer.domElement.addEventListener('pointerdown', this.terrainPointerDown, true);
    this.renderer.domElement.addEventListener('pointermove', this.terrainPointerMove);
    this.renderer.domElement.addEventListener('pointerup', this.pointer);
    this.renderer.domElement.addEventListener('pointercancel', this.terrainPointerCancel);
    this.renderer.domElement.addEventListener('contextmenu', this.contextMenu);
    window.addEventListener('pointerdown', this.unlockAudio, true);
    window.addEventListener('keydown', this.unlockAudio, true);
    this.renderer.domElement.addEventListener('keydown', this.keyDown);
    this.renderer.domElement.addEventListener('keyup', this.keyUp);
    this.renderer.domElement.addEventListener('blur', this.blur);
    window.addEventListener('blur', this.blur);
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
    this.resize();
    this.load(project);
    this.scheduleFrame();
  }
  private keyDown = (event: KeyboardEvent) => this.handleKeyDown(event);
  lookByTouch(deltaX: number, deltaY: number) {
    const simulation = this.simulation;
    if (!simulation || simulation.paused || !Number.isFinite(deltaX) || !Number.isFinite(deltaY))
      return false;
    const player = [...simulation.nodes.values()].find((node) => simulation.component(node, 'player')),
      settings = player && simulation.component(player, 'player');
    if (!settings) return false;
    this.adjustGameCamera(settings.style, deltaX * 0.006, -deltaY * 0.006);
    this.cameraOverride = false;
    return true;
  }
  setTouchMovement(moveX: number, moveZ: number) {
    if (this.simulation?.paused) {
      this.touchMovement = { moveX: 0, moveZ: 0 };
      return;
    }
    this.touchMovement = {
      moveX: Number.isFinite(moveX) ? Math.max(-1, Math.min(1, moveX)) : 0,
      moveZ: Number.isFinite(moveZ) ? Math.max(-1, Math.min(1, moveZ)) : 0,
    };
    if (this.touchMovement.moveX !== 0 || this.touchMovement.moveZ !== 0) {
      this.agentPaused = false;
      this.cameraOverride = false;
    }
  }
  triggerAction(
    action:
      'togglePause' | 'jump' | 'interact' | 'attack' | 'useItem' | 'placeCell' | 'removeCell' | 'cyclePaint',
  ) {
    if (!this.simulation) return false;
    this.audio.unlock();
    if (action === 'togglePause') return this.toggleGamePause();
    return this.pressGameplayAction(action);
  }
  triggerUseItem(itemId: string) {
    const simulation = this.simulation;
    if (!simulation) return false;
    const slot = simulation.inventory.findIndex(
      (stack) => stack.itemId === itemId && !!simulation.items.get(itemId)?.use,
    );
    if (slot < 0) return false;
    this.audio.unlock();
    return this.pressGameplayAction('useItem', slot);
  }
  moveInventoryStack(fromIndex: number, toIndex: number) {
    const simulation = this.simulation;
    if (this.multiplayer) return this.multiplayer.send({ inventoryMove: { fromIndex, toIndex } });
    if (!simulation || !simulation.moveInventoryStack(fromIndex, toIndex)) return false;
    this.onState?.(simulation.inspect());
    return true;
  }
  sortInventoryByName() {
    const simulation = this.simulation;
    if (this.multiplayer) return this.multiplayer.send({ inventorySort: true });
    if (!simulation || !simulation.sortInventoryByName()) return false;
    this.onState?.(simulation.inspect());
    return true;
  }
  triggerHudEvent(eventId: string) {
    if (!this.simulation || !idSchema.safeParse(eventId).success) return false;
    this.audio.unlock();
    if (this.multiplayer) return this.multiplayer.send({ uiEventId: eventId });
    if (this.simulation.paused) {
      this.session!.step({ uiEventId: eventId }, this.simulationDelta);
      this.accumulator = 0;
      this.onState?.(this.simulation.inspect());
      return true;
    }
    this.pending.uiEventId = eventId;
    this.agentPaused = false;
    this.cameraOverride = false;
    return true;
  }
  selectHudTab(groupId: string, tabId: string) {
    const simulation = this.simulation;
    if (!simulation) return false;
    const next = selectGameHudTab(simulation.scene.hud ?? [], this.activeHudTabs, groupId, tabId);
    if (!next) return false;
    this.activeHudTabs = next;
    this.onHudTab?.({ ...next });
    return true;
  }
  private activePlayerControls() {
    const simulation = this.simulation;
    if (!simulation) return DEFAULT_PLAYER_CONTROLS;
    const cached = this.playerControlsCache.get(simulation);
    if (cached) return cached;
    const player = this.controlledPlayer(simulation);
    const controls = resolvePlayerControls(player && simulation.component(player, 'player')?.controls);
    this.playerControlsCache.set(simulation, controls);
    return controls;
  }
  private controlledPlayer(simulation = this.simulation) {
    if (!simulation) return;
    const localNodeId = simulation.selectedMultiplayerPlayerNodeId;
    return (
      (localNodeId && simulation.nodes.get(localNodeId)) ||
      [...simulation.nodes.values()].find((node) => simulation.component(node, 'player'))
    );
  }
  private pressGameplayAction(
    action: 'jump' | 'interact' | 'attack' | 'useItem' | 'placeCell' | 'removeCell' | 'cyclePaint',
    itemSlot?: number,
  ) {
    const simulation = this.simulation;
    if (!simulation || simulation.paused) return false;
    if (action === 'useItem') {
      const slots = itemSlot === undefined ? simulation.inventory.map((_, index) => index) : [itemSlot];
      const itemId = slots
        .map((slot) => simulation.inventory[slot]?.itemId)
        .find((id) => id && simulation.items.get(id)?.use);
      if (!itemId) return false;
      this.pending.useItem = itemId;
    } else if (action === 'jump') this.pending.jump = true;
    else if (action === 'interact') this.pending.interact = true;
    else if (action === 'attack') this.pending.attack = true;
    else if (action === 'placeCell') {
      this.pending.placeCell = true;
      this.pending.removeCell = false;
    } else if (action === 'removeCell') {
      this.pending.removeCell = true;
      this.pending.placeCell = false;
    } else {
      const construction = simulation.constructionState();
      if (!construction?.enabled || construction.palette.length === 0) return false;
      const index = construction.palette.findIndex((paint) => paint.id === construction.selectedId);
      this.selectConstructionPaint(construction.palette[(index + 1) % construction.palette.length].id);
    }
    this.agentPaused = false;
    this.cameraOverride = false;
    return true;
  }
  private toggleGamePause() {
    if (this.multiplayer) return false;
    const simulation = this.simulation;
    if (!simulation || simulation.status !== 'playing') return false;
    simulation.setPaused(!simulation.paused);
    this.accumulator = 0;
    this.pending = {};
    this.keys.clear();
    this.touchMovement = { moveX: 0, moveZ: 0 };
    if (!simulation.paused) {
      this.agentPaused = false;
      this.cameraOverride = false;
    }
    this.stateStamp = '';
    this.onState?.(simulation.inspect());
    return true;
  }
  private handleKeyDown(event: KeyboardEvent) {
    if (!this.simulation) {
      if (event.code === 'KeyF' && this.selectedId) {
        event.preventDefault();
        this.focus(this.selectedId);
      }
      return;
    }
    const binding = keyboardActionForCode(event.code, this.activePlayerControls().keyboard);
    if (binding) {
      if (binding.action === 'togglePause') {
        event.preventDefault();
        if (!this.keys.has(event.code)) this.toggleGamePause();
        this.keys.add(event.code);
        return;
      }
      if (this.simulation.paused) {
        event.preventDefault();
        return;
      }
      this.agentPaused = false;
      this.cameraOverride = false;
      event.preventDefault();
      if (!this.keys.has(event.code))
        if (binding.action === 'useItem') this.pressGameplayAction('useItem', binding.itemSlot);
        else if (
          binding.action === 'jump' ||
          binding.action === 'interact' ||
          binding.action === 'attack' ||
          binding.action === 'placeCell' ||
          binding.action === 'removeCell' ||
          binding.action === 'cyclePaint'
        )
          this.pressGameplayAction(binding.action);
      this.keys.add(event.code);
    }
  }
  private keyUp = (event: KeyboardEvent) => this.keys.delete(event.code);
  private unlockAudio = () => {
    this.audio.unlock();
    this.importedAudio.unlock();
  };
  private pollGamepad() {
    let pads: (Gamepad | null)[] = [];
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function') {
        pads = navigator.getGamepads();
      }
    } catch {
      // Some browsers restrict Gamepad API access until the user interacts with the page.
    }
    const controls = this.activePlayerControls();
    const input = mapGamepadInput(pads, this.gamepadInput, controls.gamepad, controls.gamepad.axes);
    this.gamepadInput = input;
    if (!this.simulation) return input;
    if (input.lookX !== 0 || input.lookY !== 0 || input.moveX !== 0 || input.moveZ !== 0)
      this.cameraOverride = false;
    if (
      input.lookX !== 0 ||
      input.lookY !== 0 ||
      input.moveX !== 0 ||
      input.moveZ !== 0 ||
      input.pressedButtons.size
    )
      this.agentPaused = false;
    for (const action of [
      'togglePause',
      'jump',
      'interact',
      'attack',
      'useItem',
      'placeCell',
      'removeCell',
      'cyclePaint',
    ] as const)
      if (controls.gamepad[action].some((button) => input.pressedButtons.has(button))) {
        if (action === 'togglePause') this.toggleGamePause();
        else this.pressGameplayAction(action);
      }
    return input;
  }
  private blur = () => {
    this.keys.clear();
    this.touchMovement = { moveX: 0, moveZ: 0 };
    this.pending = {};
    this.mouseLookPointer = null;
    this.cancelTerrainStroke('Terrain stroke canceled before release; no cells were saved.');
    this.cancelTerrainInspection();
  };
  private terrainPointerDown = (event: PointerEvent) => {
    if (this.simulation && event.button === 2) {
      event.preventDefault();
      this.mouseLookPointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
      this.renderer.domElement.focus();
      try {
        this.renderer.domElement.setPointerCapture(event.pointerId);
      } catch {
        this.mouseLookPointer = null;
      }
      return;
    }
    if (this.simulation || !this.terrainMode || event.button !== 0) return;
    const scene = this.project.scenes.find((candidate) => candidate.id === this.project.activeSceneId),
      world = scene?.worldId && this.project.worlds.find((candidate) => candidate.id === scene.worldId);
    if (!world) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (this.terrainMode === 'inspect') {
      this.terrainInspectPointerId = event.pointerId;
      this.renderer.domElement.focus();
      this.renderer.domElement.setPointerCapture(event.pointerId);
      return;
    }
    if (this.terrainStroke) return;
    const stroke: TerrainStroke = {
      pointerId: event.pointerId,
      project: this.project,
      world,
      mode: this.terrainMode,
      brushSize: this.terrainBrushSize,
      brushShape: this.terrainBrushShape,
      paletteLayer: this.terrainPaletteLayer,
      customPaint: this.terrainCustomPaint,
      lastPoint: [event.clientX, event.clientY],
      edits: new Map(),
    };
    this.terrainStroke = stroke;
    try {
      this.renderer.domElement.setPointerCapture(event.pointerId);
      this.addTerrainStrokePoint(stroke, event.clientX, event.clientY);
    } catch (error) {
      stroke.error = (error as Error).message;
      this.finishTerrainStroke(event);
    }
  };
  private terrainPointerMove = (event: PointerEvent) => {
    const look = this.mouseLookPointer;
    if (look?.id === event.pointerId) {
      event.preventDefault();
      this.lookByTouch(event.clientX - look.x, event.clientY - look.y);
      look.x = event.clientX;
      look.y = event.clientY;
      return;
    }
    const stroke = this.terrainStroke;
    if (!stroke || event.pointerId !== stroke.pointerId) return;
    event.preventDefault();
    this.addTerrainStrokeSegment(stroke, [event.clientX, event.clientY]);
  };
  private terrainPointerCancel = (event: PointerEvent) => {
    if (this.mouseLookPointer?.id === event.pointerId) this.mouseLookPointer = null;
    if (this.terrainStroke?.pointerId === event.pointerId)
      this.cancelTerrainStroke('Terrain stroke canceled before release; no cells were saved.');
    if (this.terrainInspectPointerId === event.pointerId) this.cancelTerrainInspection();
  };
  private pointer = (event: PointerEvent) => {
    if (this.mouseLookPointer?.id === event.pointerId) {
      this.mouseLookPointer = null;
      if (this.renderer.domElement.hasPointerCapture(event.pointerId))
        this.renderer.domElement.releasePointerCapture(event.pointerId);
      return;
    }
    if (this.terrainInspectPointerId === event.pointerId) {
      this.terrainInspectPointerId = null;
      if (this.renderer.domElement.hasPointerCapture(event.pointerId))
        this.renderer.domElement.releasePointerCapture(event.pointerId);
      const scene = this.project.scenes.find((candidate) => candidate.id === this.project.activeSceneId),
        world = scene?.worldId && this.project.worlds.find((candidate) => candidate.id === scene.worldId),
        hit = world && this.terrainHit(world, event.clientX, event.clientY);
      this.onTerrainInspect?.(
        hit && this.terrainInspector ? this.terrainInspector(hit.point, hit.normal, hit.coarseSurface) : null,
      );
      return;
    }
    if (this.terrainStroke?.pointerId === event.pointerId) {
      this.finishTerrainStroke(event);
      return;
    }
    if (this.simulation) {
      if (event.button === 2) return;
      this.agentPaused = false;
      this.pending.attack = true;
      this.renderer.domElement.focus();
      return;
    }
    if (this.terrainMode) {
      return;
    }
    const rect = this.renderer.domElement.getBoundingClientRect(),
      ray = new THREE.Raycaster();
    ray.setFromCamera(
      new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        (-(event.clientY - rect.top) / rect.height) * 2 + 1,
      ),
      this.camera,
    );
    const hits = ray.intersectObjects(this.visuals.pickables, true);
    if (hits.length) {
      const id = this.visuals.nodeAt(hits[0]);
      if (id) this.onSelect?.(id);
    }
  };
  private contextMenu = (event: MouseEvent) => {
    if (this.simulation) event.preventDefault();
  };
  private terrainHit(world: WorldDocument, x: number, y: number) {
    const groups = [
      this.scene.getObjectByName(`world:${world.id}`),
      this.scene.getObjectByName(`voxel-world:${world.id}`),
    ].filter((object): object is THREE.Object3D => !!object);
    if (!groups.length) return null;
    const rect = this.renderer.domElement.getBoundingClientRect(),
      ray = new THREE.Raycaster();
    ray.setFromCamera(
      new THREE.Vector2(((x - rect.left) / rect.width) * 2 - 1, (-(y - rect.top) / rect.height) * 2 + 1),
      this.camera,
    );
    const hit = ray.intersectObjects(groups, true)[0];
    if (!hit?.face) return null;
    const normal = hit.face.normal
      .clone()
      .applyMatrix3(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld))
      .normalize();
    return {
      point: hit.point.toArray() as [number, number, number],
      normal: normal.toArray() as [number, number, number],
      coarseSurface: Boolean(hit.object.userData.worldLod && hit.object.userData.worldLod !== 'near'),
    };
  }
  private addTerrainStrokePoint(stroke: TerrainStroke, x: number, y: number) {
    if (stroke.error) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return;
    try {
      const hit = this.terrainHit(stroke.world, x, y);
      if (!hit) return;
      addTerrainStrokeEdits(
        stroke.edits,
        terrainEditsFromHit(
          stroke.world,
          stroke.mode,
          hit.point,
          hit.normal,
          hit.coarseSurface,
          stroke.brushSize,
          stroke.paletteLayer,
          stroke.customPaint,
          stroke.brushShape,
        ),
      );
    } catch (error) {
      stroke.error = (error as Error).message;
    }
  }
  private addTerrainStrokeSegment(stroke: TerrainStroke, point: [number, number]) {
    if (stroke.error) return;
    try {
      for (const sample of terrainStrokeSamples(stroke.lastPoint, point))
        this.addTerrainStrokePoint(stroke, sample[0], sample[1]);
    } catch (error) {
      stroke.error = (error as Error).message;
    }
    stroke.lastPoint = point;
  }
  private finishTerrainStroke(event: PointerEvent) {
    const stroke = this.terrainStroke;
    if (!stroke || event.pointerId !== stroke.pointerId) return;
    this.addTerrainStrokeSegment(stroke, [event.clientX, event.clientY]);
    this.terrainStroke = null;
    if (this.renderer.domElement.hasPointerCapture(event.pointerId))
      this.renderer.domElement.releasePointerCapture(event.pointerId);
    if (stroke.error) {
      this.onTerrainEditError?.(stroke.error);
      return;
    }
    if (!activeWorldUnchanged(stroke.project, this.project)) {
      if (stroke.edits.size)
        this.onTerrainEditError?.('Terrain changed while drawing; the stroke was not applied.');
      return;
    }
    if (stroke.edits.size)
      this.onTerrainEdit?.(stroke.project.id, stroke.world.id, [...stroke.edits.values()]);
  }
  private cancelTerrainStroke(message?: string) {
    const stroke = this.terrainStroke;
    if (!stroke) return;
    this.terrainStroke = null;
    if (this.renderer.domElement.hasPointerCapture(stroke.pointerId))
      this.renderer.domElement.releasePointerCapture(stroke.pointerId);
    if (message && stroke.edits.size) this.onTerrainEditError?.(message);
  }
  private cancelTerrainInspection() {
    const pointerId = this.terrainInspectPointerId;
    if (pointerId !== null && this.renderer.domElement.hasPointerCapture(pointerId))
      this.renderer.domElement.releasePointerCapture(pointerId);
    this.terrainInspectPointerId = null;
  }
  resize() {
    const w = this.container.clientWidth,
      h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
  load(project: ProjectDocument) {
    const previousProjectId = this.project.id,
      unchangedWorld = activeWorldUnchanged(this.project, project),
      updateVoxelEdits =
        this.worldRenderer instanceof WorldVoxelRenderer &&
        !unchangedWorld &&
        activeVoxelWorldCanApplyEditChanges(this.project, project),
      preserveWorldRenderer = !!this.worldRenderer && (unchangedWorld || updateVoxelEdits),
      projectChanged = previousProjectId !== project.id;
    if (this.terrainStroke && !activeWorldUnchanged(this.terrainStroke.project, project))
      this.cancelTerrainStroke('Terrain changed while drawing; the stroke was not applied.');
    if (!unchangedWorld) this.onTerrainInspect?.(null);
    this.cancelTerrainInspection();
    this.stop();
    this.project = project;
    this.select(null);
    this.renderScene(project.activeSceneId, {
      unchangedWorld,
      updateVoxelEdits,
      preserveWorldRenderer,
      projectChanged,
    });
  }
  private renderScene(
    sceneId: string,
    {
      unchangedWorld = false,
      updateVoxelEdits = false,
      preserveWorldRenderer = false,
      projectChanged = false,
    }: {
      unchangedWorld?: boolean;
      updateVoxelEdits?: boolean;
      preserveWorldRenderer?: boolean;
      projectChanged?: boolean;
    } = {},
  ) {
    this.visuals?.dispose();
    if (!preserveWorldRenderer) {
      this.worldRenderer?.dispose();
      this.worldRenderer = null;
    }
    const previous = this.scene.getObjectByName('ground');
    if (previous) disposeObject(previous);
    const project = this.project;
    const scene = project.scenes.find((candidate) => candidate.id === sceneId);
    if (!scene) throw new Error('Scene not found.');
    this.runtimeSceneId = sceneId;
    updateSceneLighting(this.sceneLights, scene.lighting);
    this.scene.background = new THREE.Color(scene.background);
    this.scene.fog = new THREE.Fog(scene.background, 80, 250);
    const world = scene.worldId && project.worlds.find((candidate) => candidate.id === scene.worldId);
    if (world) {
      if (!unchangedWorld || !this.terrainInspector) this.terrainInspector = createTerrainInspector(world);
      if (projectChanged) this.loadedWorldId = null;
      const volumetric = world.generator.mode === 'voxel3d';
      if (updateVoxelEdits && this.worldRenderer instanceof WorldVoxelRenderer)
        this.worldRenderer.updateWorld(world);
      if (!preserveWorldRenderer) {
        this.worldRenderer = volumetric
          ? new WorldVoxelRenderer(this.scene, world, this.voxelWorkerFactory, this.terrainWorkerFactory)
          : new WorldStreamRenderer(this.scene, world, undefined, this.terrainWorkerFactory);
      }
      const view = volumetric ? WorldVoxelRenderer.view(world) : WorldStreamRenderer.view(world);
      const mapRadius = Math.min(world.generator.size[0], world.generator.size[1]) * world.voxelSize * 0.5;
      const visibleDistance = Math.max(
        view.distance,
        Math.min(view.horizonDistance, mapRadius + view.distance),
      );
      if (this.loadedWorldId !== world.id) {
        const direction = this.camera.position.clone().sub(this.controls.target).normalize();
        if (!direction.lengthSq()) direction.set(1, 1, 1).normalize();
        this.controls.target.copy(view.target);
        this.camera.position.copy(view.target).addScaledVector(direction, view.distance);
        this.camera.lookAt(view.target);
        this.controls.update();
      }
      this.camera.near = Math.min(0.1, Math.max(0.001, world.voxelSize * 0.1));
      this.camera.far = visibleDistance * 1.05;
      this.camera.updateProjectionMatrix();
      this.scene.fog = new THREE.Fog(
        scene.background,
        Math.min(view.distance * 2, visibleDistance * 0.65),
        visibleDistance,
      );
      this.loadedWorldId = world.id;
      this.renderedWorld = world;
    } else {
      this.terrainInspector = null;
      if (this.loadedWorldId || projectChanged) {
        this.camera.position.set(15, 14, 20);
        this.controls.target.set(0, 1, 0);
        this.camera.near = 0.1;
        this.camera.far = 2000;
        this.camera.updateProjectionMatrix();
        this.controls.update();
      }
      this.loadedWorldId = null;
      this.renderedWorld = null;
      const ground = new THREE.Mesh(
        new THREE.PlaneGeometry(scene.bounds * 2, scene.bounds * 2),
        new THREE.MeshStandardMaterial({ color: scene.groundColor, roughness: 1 }),
      );
      ground.name = 'ground';
      ground.rotation.x = -Math.PI / 2;
      ground.receiveShadow = true;
      ground.position.y = -0.015;
      this.scene.add(ground);
    }
    const assets = new Map(project.assets.map((a) => [a.id, a]));
    this.visuals = new SceneVisuals(this.scene, scene.nodes, assets, this.renderer);
  }
  select(id: string | null) {
    if (id !== this.selectedId) this.onTerrainInspect?.(null);
    this.selectedId = id;
    if (this.selected) {
      this.scene.remove(this.selected);
      this.selected.geometry.dispose();
      (this.selected.material as THREE.Material).dispose();
      this.selected = null;
    }
    if (id && this.visuals.nodes.has(id)) {
      this.selected = new THREE.Box3Helper(this.visuals.bounds(id), 0x67e8f9);
      this.scene.add(this.selected);
    }
  }
  setTerrainMode(mode: TerrainToolMode | null) {
    if (this.terrainStroke && mode !== this.terrainMode) this.cancelTerrainStroke();
    if (mode !== this.terrainMode) this.cancelTerrainInspection();
    this.terrainMode = this.simulation ? null : mode;
    if (this.terrainMode !== 'inspect') this.onTerrainInspect?.(null);
    this.renderer.domElement.setAttribute(
      'aria-label',
      this.terrainMode === 'inspect'
        ? 'Terrain inspection viewport. Click a visible terrain cell to read its coordinates and material.'
        : 'Scene viewport. Select objects with a click. In Play mode, player-specific authored controls drive movement and actions.',
    );
  }
  setTerrainBrushSize(size: TerrainBrushSize) {
    this.terrainBrushSize = size;
  }
  setTerrainBrushShape(shape: TerrainBrushShape) {
    this.terrainBrushShape = shape;
  }
  setTerrainPaletteLayer(layer: TerrainPaletteLayer) {
    this.terrainPaletteLayer = layer;
  }
  setTerrainCustomPaint(paint: TerrainPaint) {
    this.terrainCustomPaint = paint;
  }
  focus(id: string) {
    if (!this.visuals.nodes.has(id)) throw Error('Scene object not found.');
    const bounds = this.visuals.bounds(id);
    this.frameBounds(bounds);
  }
  frameAll() {
    const bounds = new THREE.Box3();
    for (const id of this.visuals.nodes.keys()) bounds.union(this.visuals.bounds(id));

    // Frame only the bounded local voxel terrain and exact near terrain tiles.
    // Coarser streamed LODs can span hundreds of meters in a large world and
    // would make the playable area and authored props too small to inspect.
    const activeScene = this.project.scenes.find((scene) => scene.id === this.project.activeSceneId);
    const activeWorld = activeScene?.worldId;
    if (activeWorld) {
      const terrainGroups = new Set<THREE.Object3D>(
        [this.worldRenderer?.group, this.scene.getObjectByName(`world:${activeWorld}`)].filter(
          (group): group is THREE.Object3D => !!group,
        ),
      );
      for (const group of terrainGroups) {
        group.traverse((object) => {
          const userData = object.userData as { worldChunk?: unknown; worldLod?: string };
          if (
            object instanceof THREE.Mesh &&
            (userData.worldChunk !== undefined || userData.worldLod === 'near')
          )
            bounds.union(new THREE.Box3().setFromObject(object));
        });
      }
    }
    this.frameBounds(bounds);
  }
  private frameBounds(bounds: THREE.Box3) {
    if (bounds.isEmpty()) throw Error('The scene object has no visible geometry to frame.');
    const sphere = bounds.getBoundingSphere(new THREE.Sphere());
    const direction = this.camera.position.clone().sub(this.controls.target).normalize();
    if (direction.lengthSq() === 0) direction.set(1, 1, 1).normalize();
    const angle = Math.atan(
      Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * Math.min(1, this.camera.aspect),
    );
    const distance = Math.max(0.5, (sphere.radius / Math.sin(angle)) * 1.2);
    if (this.scene.fog instanceof THREE.Fog)
      this.scene.fog.far = Math.max(this.scene.fog.far, distance + sphere.radius * 2);
    this.controls.target.copy(sphere.center);
    this.camera.position.copy(sphere.center).addScaledVector(direction, distance);
    this.camera.far = Math.max(2000, distance + sphere.radius * 2);
    this.camera.updateProjectionMatrix();
    this.cameraOverride = true;
    this.camera.lookAt(sphere.center);
    this.controls.update();
  }
  play(agentDriven = false, progress?: unknown, sceneId = this.project.activeSceneId, remote = false) {
    if (!remote) this.disconnectMultiplayer();
    if (!this.project.scenes.some((scene) => scene.id === sceneId)) throw new Error('Scene not found.');
    if (!this.session)
      this.editorViewBeforePlay = {
        position: this.camera.position.clone(),
        target: this.controls.target.clone(),
        near: this.camera.near,
        far: this.camera.far,
        cameraOverride: this.cameraOverride,
      };
    this.terrainMode = null;
    this.audio.unlock();
    this.importedAudio.unlock();
    this.activeHudTabs = {};
    this.activeHudSceneId = sceneId;
    this.onHudTab?.({});
    this.onTerrainInspect?.(null);
    this.select(null);
    this.session?.dispose();
    this.session = null;
    if (this.runtimeSceneId !== sceneId) this.renderScene(sceneId);
    this.session = new GameSession(
      this.project,
      sceneId,
      progress,
      (simulation) => {
        if (this.activeHudSceneId !== simulation.scene.id) {
          this.activeHudSceneId = simulation.scene.id;
          this.activeHudTabs = {};
          this.onHudTab?.({});
        }
        this.renderScene(simulation.scene.id);
        this.importedAudio.setMusic(simulation.scene.music);
        this.syncTerrainRenderer(simulation.terrainWorldDocument);
        this.stateStamp = '';
        this.onState?.(simulation.inspect());
      },
      (event) => {
        if (event.type === 'sound') this.audio.play(event.data as ProceduralSoundCue);
        if (event.type === 'audio') {
          const cue = event.data as { clipId: string; volume: number };
          this.importedAudio.play(cue.clipId, cue.volume);
        }
      },
    );
    const activeSceneId = this.session.simulation.scene.id;
    this.importedAudio.setMusic(this.session.simulation.scene.music);
    if (this.runtimeSceneId !== activeSceneId) this.renderScene(activeSceneId);
    this.progressRestoredSceneId = this.session.progressWasRestored(activeSceneId) ? activeSceneId : null;
    this.syncTerrainRenderer();
    this.controls.enabled = false;
    this.accumulator = 0;
    this.stateStamp = '';
    this.agentPaused = agentDriven;
    this.cameraOverride = false;
    this.gameCameraYaw = 0;
    this.gameCameraPitch = null;
    this.blur();
    this.renderer.domElement.focus();
    this.onState?.(this.session.simulation.inspect());
  }
  stop() {
    this.disconnectMultiplayer();
    this.importedAudio.stop();
    if (!this.simulation) return;
    this.audio.clearPending();
    this.session?.dispose();
    this.session = null;
    this.activeHudTabs = {};
    this.activeHudSceneId = '';
    this.onHudTab?.({});
    this.progressRestoredSceneId = null;
    const scene = this.project.scenes.find((entry) => entry.id === this.project.activeSceneId)!;
    if (this.runtimeSceneId !== this.project.activeSceneId) this.renderScene(this.project.activeSceneId);
    else {
      this.syncTerrainRenderer(this.project.worlds.find((world) => world.id === scene.worldId) ?? null);
      this.visuals.dispose();
      this.visuals = new SceneVisuals(
        this.scene,
        scene.nodes,
        new Map(this.project.assets.map((asset) => [asset.id, asset])),
        this.renderer,
      );
    }
    this.agentPaused = false;
    this.gameCameraYaw = 0;
    this.gameCameraPitch = null;
    this.controls.enabled = true;
    this.blur();
    const view = this.editorViewBeforePlay;
    this.editorViewBeforePlay = null;
    if (view) {
      this.camera.position.copy(view.position);
      this.controls.target.copy(view.target);
      this.camera.near = view.near;
      this.camera.far = view.far;
      this.camera.lookAt(view.target);
      this.camera.updateProjectionMatrix();
      this.controls.update();
      this.cameraOverride = view.cameraOverride;
    } else {
      this.cameraOverride = false;
    }
    this.accumulator = 0;
    this.stateStamp = '';
    this.onState?.(null);
  }
  multiplayerInfo(): MultiplayerConnectionInfo {
    return (
      this.multiplayer?.info() ?? {
        state: 'disconnected',
        ...(this.multiplayerError ? { error: this.multiplayerError } : {}),
      }
    );
  }
  private disconnectMultiplayer(pageExit = false) {
    const connection = this.multiplayer;
    this.multiplayer = undefined;
    this.remoteTopology = '';
    if (connection) void (pageExit ? connection.disconnectForPageExit() : connection.close()).catch(() => {});
  }
  async joinMultiplayerRoom(options: MultiplayerRoomOptions) {
    await this.leaveMultiplayerRoom();
    this.multiplayerError = undefined;
    this.play(true);
    const connection = new MultiplayerGameConnection(
      options,
      {
        projectId: this.project.id,
        revision: this.project.revision,
        sceneId: this.project.activeSceneId,
      },
      (game, playerId) => {
        if (this.multiplayer !== connection || this.disposed) return;
        if (game.sceneId !== this.simulation?.scene.id) {
          if (!this.project.scenes.some((scene) => scene.id === game.sceneId))
            throw Error('The host entered a scene missing from this game export.');
          this.play(true, undefined, game.sceneId, true);
          this.remoteTopology = '';
        }
        const simulation = this.simulation!;
        if (!simulation.applyMultiplayerState(game, playerId))
          throw Error('The authoritative room state does not match this game.');
        const topology = game.nodes.map((node) => node.nodeId).join(':');
        if (topology !== this.remoteTopology) {
          this.visuals.dispose();
          this.visuals = new SceneVisuals(
            this.scene,
            simulation.scene.nodes,
            new Map(this.project.assets.map((asset) => [asset.id, asset])),
            this.renderer,
          );
          this.remoteTopology = topology;
        }
        this.playerControlsCache.delete(simulation);
        this.syncTerrainRenderer(simulation.terrainWorldDocument);
        this.onState?.(simulation.inspect());
      },
    );
    this.multiplayer = connection;
    this.agentPaused = false;
    try {
      await connection.connect();
    } catch (cause) {
      if (this.multiplayer === connection) {
        this.multiplayerError = cause instanceof Error ? cause.message : 'Could not join the game room.';
        this.disconnectMultiplayer();
        this.stop();
      }
      throw cause;
    }
  }
  async resumeMultiplayerRoom() {
    const projectBinding = {
      projectId: this.project.id,
      revision: this.project.revision,
      sceneId: this.project.activeSceneId,
    };
    const options = loadMultiplayerResumeSession(projectBinding);
    if (!options) return false;
    await this.joinMultiplayerRoom(options);
    return true;
  }
  async leaveMultiplayerRoom() {
    const connection = this.multiplayer;
    this.multiplayer = undefined;
    this.multiplayerError = undefined;
    if (connection) {
      await connection.close();
      this.stop();
    }
  }
  private updateGameCamera(
    target: THREE.Vector3,
    style: 'first-person' | 'top-down' | 'third-person',
    dt: number,
    lookX: number,
    lookY: number,
  ) {
    const preset = FOLLOW_CAMERA[style];
    this.adjustGameCamera(style, lookX * dt * 2.4, -lookY * dt * 1.8);
    const horizontalDistance = Math.cos(this.gameCameraPitch!) * preset.distance;
    this.gameCameraOffset.set(
      Math.sin(this.gameCameraYaw) * horizontalDistance,
      Math.sin(this.gameCameraPitch!) * preset.distance,
      Math.cos(this.gameCameraYaw) * horizontalDistance,
    );
    this.controls.target.copy(target);
    const follow = this.agentPaused ? 1 : 1 - Math.exp(-dt * 6);
    this.camera.position.set(
      this.camera.position.x + (target.x + this.gameCameraOffset.x - this.camera.position.x) * follow,
      this.camera.position.y + (target.y + this.gameCameraOffset.y - this.camera.position.y) * follow,
      this.camera.position.z + (target.z + this.gameCameraOffset.z - this.camera.position.z) * follow,
    );
    if (style === 'first-person') {
      const horizontal = Math.cos(this.gameCameraPitch!);
      this.gameCameraLookTarget.set(
        target.x - Math.sin(this.gameCameraYaw) * horizontal,
        target.y + Math.sin(this.gameCameraPitch!),
        target.z - Math.cos(this.gameCameraYaw) * horizontal,
      );
      this.camera.lookAt(this.gameCameraLookTarget);
    } else {
      this.camera.lookAt(target);
    }
  }
  private adjustGameCamera(
    style: 'first-person' | 'top-down' | 'third-person',
    yawDelta: number,
    pitchDelta: number,
  ) {
    const preset = FOLLOW_CAMERA[style];
    if (this.gameCameraPitch === null) this.gameCameraPitch = preset.pitch;
    this.gameCameraYaw += yawDelta;
    this.gameCameraPitch = THREE.MathUtils.clamp(
      this.gameCameraPitch + pitchDelta,
      THREE.MathUtils.degToRad(style === 'first-person' ? -85 : 8),
      THREE.MathUtils.degToRad(style === 'first-person' ? 85 : 80),
    );
  }
  capture(alreadyRendered = false) {
    if (!alreadyRendered) this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }
  selectConstructionPaint(id: string) {
    if (this.multiplayer) return this.multiplayer.send({ constructionPaint: id });
    if (!this.simulation) throw new Error('Start Play before selecting construction paint.');
    const selected = this.simulation.selectConstructionPaint(id);
    this.onState?.(this.simulation.inspect());
    return selected;
  }
  /** Advances an agent walkthrough step and applies at most one requested terrain edit. */
  step(input: ViewportStepInput = {}, frames = 1) {
    if (this.multiplayer)
      throw Error('A shared room is advanced by its host. Use live controls to send player intentions.');
    if (!this.simulation) throw new Error('Start Play before advancing the game.');
    if (!Number.isInteger(frames) || frames < 1 || frames > 18000)
      throw new Error('Frames must be 1..18000.');
    if (input.placeCell && input.removeCell)
      throw new Error('Place and remove cannot be requested in the same Play step.');
    if (input.uiTab && !this.selectHudTab(input.uiTab.groupId, input.uiTab.tabId))
      throw new Error(`HUD tab ${input.uiTab.groupId}/${input.uiTab.tabId} is not in the active scene.`);
    if (this.simulation.status !== 'playing') return this.simulation.inspect();
    const { constructionPaint, uiTab: _uiTab, ...simulationInput } = input;
    if (
      !input.togglePause &&
      constructionPaint !== undefined &&
      !this.selectConstructionPaint(constructionPaint)
    )
      throw new Error(this.simulation.message);
    if (!input.togglePause) this.applyTerrainInput(input);
    for (let i = 0; i < frames; i++)
      this.session!.step(
        i === 0 ? simulationInput : { ...simulationInput, uiEventId: undefined, togglePause: undefined },
      );
    return this.simulation.inspect();
  }
  private applyTerrainInput(input: GameInput): WorldEdit | undefined {
    const mode = input.placeCell ? 'place' : input.removeCell ? 'remove' : null;
    if (!mode || !this.simulation || this.simulation.status !== 'playing') return;
    const simulation = this.simulation,
      world = simulation.terrainWorldDocument;
    if (!world) return;
    const rect = this.renderer.domElement.getBoundingClientRect(),
      hit = this.terrainHit(world, rect.left + rect.width / 2, rect.top + rect.height / 2);
    if (!hit) {
      simulation.message = 'Aim at seeded terrain to place or remove a cell.';
      this.onState?.(simulation.inspect());
      return;
    }
    const construction = simulation.constructionState(),
      paint = construction?.palette.find((paint) => paint.id === construction.selectedId),
      edit = terrainEditFromHit(
        world,
        mode,
        hit.point,
        hit.normal,
        hit.coarseSurface,
        paint ? 'custom' : 'surface',
        paint && { color: paint.color, materialType: paint.materialType },
      );
    if (this.multiplayer) return edit;
    let updated: WorldDocument | null;
    try {
      updated = simulation.editTerrain(edit);
    } catch (error) {
      simulation.message = (error as Error).message;
      this.onState?.(simulation.inspect());
      return;
    }
    if (!updated) {
      this.onState?.(simulation.inspect());
      return;
    }
    this.syncTerrainRenderer(updated);
    this.onState?.(simulation.inspect());
  }
  private syncTerrainRenderer(next = this.simulation?.terrainWorldDocument ?? null) {
    const previous = this.renderedWorld;
    if (!next || !previous || !this.worldRenderer || next.id !== previous.id) return;
    const previousEdits = new Map(previous.edits.map((edit) => [`${edit.x},${edit.y},${edit.z}`, edit])),
      nextEdits = new Map(next.edits.map((edit) => [`${edit.x},${edit.y},${edit.z}`, edit])),
      keys = new Set([...previousEdits.keys(), ...nextEdits.keys()]),
      changed = [...keys]
        .filter((key) => JSON.stringify(previousEdits.get(key)) !== JSON.stringify(nextEdits.get(key)))
        .map((key) => nextEdits.get(key) ?? previousEdits.get(key)!);
    if (changed.length) {
      if (this.worldRenderer instanceof WorldVoxelRenderer) this.worldRenderer.updateWorld(next);
      else this.worldRenderer.updateWorldEdits(next.edits, changed);
    }
    this.renderedWorld = next;
  }
  performanceInfo() {
    return {
      rendererCallsPerSecond: this.rendererCallsPerSecond,
      rendererCallMsPerCall: this.rendererCallMsPerCall,
      simulationHz: this.simulationHz,
      renderLoop: this.renderLoop,
      framePacing: { ...this.framePacing },
      frameIntervalMs: this.frameIntervalMs,
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      gpu: this.gpuTimer.stats(),
      visuals: this.visuals.stats(),
      world: this.worldRenderer?.stats() ?? null,
    };
  }
  framePacingSettings() {
    return { ...this.framePacing };
  }
  setFramePacing(value: unknown) {
    this.framePacing = normalizeFramePacing(value);
    this.nextCappedFrameAt = this.framePacing.capFrameRate
      ? performance.now() + 1000 / this.framePacing.maxFpsTarget
      : 0;
    if (
      this.renderLoop === 'unlocked' &&
      this.simulation?.status === 'playing' &&
      !this.simulation.paused &&
      !this.agentPaused
    ) {
      if (this.renderTimer !== null) clearTimeout(this.renderTimer);
      this.renderTimer = null;
      cancelAnimationFrame(this.frame);
      this.frame = 0;
      this.scheduleFrame();
    }
    return this.framePacingSettings();
  }
  async measurePerformance(durationMs = 5000) {
    if (!Number.isInteger(durationMs) || durationMs < 1000 || durationMs > 30000)
      throw new Error('Performance measurement duration must be an integer from 1000 to 30000 ms.');
    if (
      this.renderLoop !== 'unlocked' ||
      this.simulation?.status !== 'playing' ||
      this.simulation.paused ||
      this.agentPaused
    )
      throw new Error('Start active standalone play before measuring performance.');
    if (this.performanceCaptureActive) throw new Error('A performance measurement is already in progress.');
    this.performanceCaptureActive = true;
    const before = {
      atMs: performance.now(),
      rendererCalls: this.totalRendererCalls,
      rendererCallMs: this.totalRendererCallMs,
      simulationSteps: this.totalSimulationSteps,
    };
    this.gpuTimer.startCapture();
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, durationMs));
      const sample = measureFramePacing(before, {
        atMs: performance.now(),
        rendererCalls: this.totalRendererCalls,
        rendererCallMs: this.totalRendererCallMs,
        simulationSteps: this.totalSimulationSteps,
      });
      return {
        ...sample,
        renderLoop: this.renderLoop,
        framePacing: this.framePacingSettings(),
        drawCalls: this.renderer.info.render.calls,
        triangles: this.renderer.info.render.triangles,
        gpu: this.gpuTimer.stats(),
        visuals: this.visuals.stats(),
        world: this.worldRenderer?.stats() ?? null,
        note: 'GPU elapsed time is an asynchronous WebGL timer-query sample and is reported only when the context supports it. Renderer call time, requestAnimationFrame cadence, GPU elapsed time and display-presented frames are distinct measurements.',
      };
    } finally {
      this.gpuTimer.stopCapture();
      this.performanceCaptureActive = false;
    }
  }
  private scheduleFrame() {
    if (
      this.renderLoop === 'unlocked' &&
      this.simulation?.status === 'playing' &&
      !this.simulation.paused &&
      !this.agentPaused
    ) {
      if (!this.framePacing.capFrameRate && this.renderTaskChannel) {
        // Message tasks yield to the browser without a zero-delay timer's minimum-delay clamp.
        if (!this.renderTaskPending) {
          this.renderTaskPending = true;
          this.renderTaskChannel.port2.postMessage(0);
        }
        return;
      }
      if (this.framePacing.capFrameRate) {
        if (!this.nextCappedFrameAt)
          this.nextCappedFrameAt =
            Math.max(this.lastFrameStartedAt, performance.now()) + 1000 / this.framePacing.maxFpsTarget;
        const delay = Math.max(0, this.nextCappedFrameAt - performance.now());
        this.renderTimer = window.setTimeout(() => {
          this.renderTimer = null;
          this.onCappedFrame(performance.now());
        }, delay);
        return;
      }
      this.renderTimer = window.setTimeout(() => {
        this.renderTimer = null;
        this.render(performance.now());
      }, 0);
    } else this.frame = requestAnimationFrame(this.render);
  }
  private onCappedFrame(now: number) {
    if (this.disposed || !this.framePacing.capFrameRate) return;
    if (now < this.nextCappedFrameAt) {
      this.scheduleFrame();
      return;
    }
    this.nextCappedFrameAt = advanceFrameDeadline(this.nextCappedFrameAt, now, this.framePacing.maxFpsTarget);
    this.render(now);
  }
  private onRenderTask() {
    this.renderTaskPending = false;
    if (this.disposed || this.framePacing.capFrameRate) return;
    this.render(performance.now());
  }
  private updatePerformance(now: number) {
    const elapsed = now - this.performanceWindowStart;
    if (elapsed < 1000) return;
    this.rendererCallsPerSecond = (this.renderCallsInWindow * 1000) / elapsed;
    this.rendererCallMsPerCall = this.renderCallsInWindow
      ? this.rendererCallMsInWindow / this.renderCallsInWindow
      : 0;
    this.simulationHz = (this.simulatedStepsInWindow * 1000) / elapsed;
    this.renderCallsInWindow = 0;
    this.rendererCallMsInWindow = 0;
    this.simulatedStepsInWindow = 0;
    this.performanceWindowStart = now;
    this.onPerformance?.(this.performanceInfo());
  }
  async observe(input: ViewportCommand, expected?: Pick<ProjectDocument, 'id' | 'revision'>) {
    const assertExpectedProject = () => {
      if (expected && (this.project.id !== expected.id || this.project.revision !== expected.revision))
        throw new Error('The viewport is still opening the requested project revision. Retry the capture.');
    };
    assertExpectedProject();
    const command = input;
    let benchmark: Record<string, unknown> | undefined;
    let physicsQueries: PhysicsQueryResult[] | undefined;
    if (command.type === 'benchmark') {
      const previousOcclusionMode = this.visuals.occlusionCullingEnabled;
      if (command.occlusionCullingEnabled !== undefined)
        this.visuals.setOcclusionEnabled(command.occlusionCullingEnabled);
      try {
        const intervals: number[] = [];
        let previous = 0;
        const started = performance.now();
        const nextBenchmarkFrame = async () => {
          const now = await new Promise<number>((resolve) => {
            const timeout = setTimeout(() => resolve(-1), 10000);
            requestAnimationFrame((time) => {
              clearTimeout(timeout);
              resolve(time);
            });
          });
          if (now < 0 || performance.now() - started > 12000)
            throw Error('The viewport did not produce benchmark frames within 12 seconds.');
          return now;
        };
        const registeredBatches = this.visuals.stats().occlusion.registeredBatches;
        const warmupFrames = this.visuals.occlusionCullingEnabled
          ? Math.max(6, Math.ceil(registeredBatches / OCCLUSION_QUERY_FRAME_BUDGET) * 2 + 2)
          : 6;
        for (let i = 0; i < warmupFrames; i++) previous = await nextBenchmarkFrame();

        const rendererCallsBefore = this.totalRendererCalls;
        const rendererCallMsBefore = this.totalRendererCallMs;
        const occlusionBefore = this.visuals.stats().occlusion;
        let rendererCalls = 0;
        let rendererCallMs = 0;
        let occlusionAfter = occlusionBefore;
        this.gpuTimer.startCapture();
        try {
          for (let i = 0; i < command.frames; i++) {
            const now = await nextBenchmarkFrame();
            intervals.push(now - previous);
            previous = now;
          }
          rendererCalls = this.totalRendererCalls - rendererCallsBefore;
          rendererCallMs = this.totalRendererCallMs - rendererCallMsBefore;
          occlusionAfter = this.visuals.stats().occlusion;
          // Timer-query results arrive asynchronously; one extra rendered frame drains the last sample.
          await nextBenchmarkFrame();
        } finally {
          this.gpuTimer.stopCapture();
        }

        const sorted = intervals.slice().sort((a, b) => a - b);
        const elapsedMs = intervals.reduce((sum, n) => sum + n, 0);
        const meanMs = elapsedMs / intervals.length;
        const gl = this.renderer.getContext(),
          debug = gl.getExtension('WEBGL_debug_renderer_info');
        benchmark = {
          frames: intervals.length,
          meanMs,
          p50Ms: sorted[Math.floor(sorted.length * 0.5)],
          p95Ms: sorted[Math.floor(sorted.length * 0.95)],
          animationFrameCallbacksPerSecond: 1000 / meanMs,
          averageFps: 1000 / meanMs, // Compatibility alias; this is callback cadence.
          rendererCalls,
          rendererCallsPerSecond: elapsedMs > 0 ? (rendererCalls * 1000) / elapsedMs : 0,
          rendererCallMs,
          rendererCallMsPerCall: rendererCalls ? rendererCallMs / rendererCalls : 0,
          gpu: this.gpuTimer.stats(),
          drawCalls: this.renderer.info.render.calls,
          triangles: this.renderer.info.render.triangles,
          occlusionCullingEnabled: this.visuals.occlusionCullingEnabled,
          occlusion: {
            available: occlusionAfter.available,
            registeredBatches: occlusionAfter.registeredBatches,
            visibleResults: occlusionAfter.visibleResults - occlusionBefore.visibleResults,
            occludedResults: occlusionAfter.occludedResults - occlusionBefore.occludedResults,
            discardedResults: occlusionAfter.discardedResults - occlusionBefore.discardedResults,
            suppressedInstances: occlusionAfter.suppressedInstances - occlusionBefore.suppressedInstances,
            suppressedBatchFrames:
              occlusionAfter.suppressedBatchFrames - occlusionBefore.suppressedBatchFrames,
          },
          world: this.worldRenderer?.stats() ?? null,
          renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
          visible: document.visibilityState,
          note: 'Reports requestAnimationFrame callback cadence, renderer.render() call counts and synchronous CPU call time, plus asynchronous WebGL GPU elapsed-time samples when supported. Occlusion can be temporarily selected for same-scene comparisons and is restored before the response capture. None represents monitor-presented frames; the GPU timer covers renderer.render() and may be unavailable or disjoint.',
        };
      } finally {
        this.visuals.setOcclusionEnabled(previousOcclusionMode);
      }
    }
    if (command.type === 'play') this.play(true);
    if (command.type === 'stop') this.stop();
    if (command.type === 'focus') this.focus(command.nodeId);
    if (command.type === 'physics-query') {
      if (!this.simulation) throw new Error('Start Play before querying the physics scene.');
      await this.session?.ready;
      const simulation = this.simulation;
      if (!simulation) throw new Error('The active game scene changed before the physics query completed.');
      physicsQueries = await Promise.all(command.queries.map((query) => simulation.queryPhysics(query)));
    }
    if (command.type === 'step' || command.type === 'sequence') {
      if (!this.simulation) throw new Error('Start Play before walking through the game.');
      this.agentPaused = true;
      await this.session!.ready;
      const steps = command.type === 'step' ? [command] : command.steps;
      for (const step of steps) this.step(step.input, step.frames);
    }
    if (command.type === 'camera') {
      if (
        new THREE.Vector3(...command.position).distanceToSquared(new THREE.Vector3(...command.target)) <
        0.000001
      )
        throw new Error('Camera position and target must differ.');
      this.cameraOverride = true;
      this.camera.position.set(...command.position);
      this.controls.target.set(...command.target);
      this.controls.update();
      this.camera.lookAt(this.controls.target);
    }
    await this.session?.ready;
    assertExpectedProject();
    this.resize();
    // Inspection must work when the editor tab is suspended and requestAnimationFrame is paused.
    // Render without elapsed time so taking a screenshot never advances gameplay.
    const now = performance.now();
    this.last = now;
    this.render(now, false);
    const image = this.capture(true);
    return {
      image,
      observation: {
        timestamp: Date.now(),
        projectId: this.project.id,
        revision: this.project.revision,
        width: this.renderer.domElement.width,
        height: this.renderer.domElement.height,
        camera: {
          position: this.camera.position.toArray(),
          target: this.controls.target.toArray(),
          verticalFov: this.camera.fov,
          near: this.camera.near,
          far: this.camera.far,
        },
        hudTabs: { ...this.activeHudTabs },
        render: {
          calls: this.renderer.info.render.calls,
          triangles: this.renderer.info.render.triangles,
          geometries: this.renderer.info.memory.geometries,
          textures: this.renderer.info.memory.textures,
          frameIntervalMs: this.frameIntervalMs,
          rendererCallMsPerCall: this.rendererCallMsPerCall,
          gpu: this.gpuTimer.stats(),
          ...this.visuals.stats(),
          world: this.worldRenderer?.stats() ?? null,
        },
        state: this.simulation?.inspect() ?? null,
        agentPaused: this.agentPaused,
        ...(benchmark && { benchmark }),
        ...(physicsQueries && { physicsQueries }),
      },
    };
  }
  private render = (now: number, scheduleNextFrame = true) => {
    if (this.disposed) return;
    this.lastFrameStartedAt = now;
    const elapsedMs = this.last ? now - this.last : 0;
    const dt = Math.min(0.1, elapsedMs / 1000);
    this.last = now;
    if (elapsedMs > 0)
      this.frameIntervalMs = this.frameIntervalMs ? this.frameIntervalMs * 0.9 + elapsedMs * 0.1 : elapsedMs;
    this.elapsed += dt;
    let sim = this.simulation;
    if (sim) {
      const gamepad = this.pollGamepad();
      const inputDelta = this.multiplayer ? 1 / 30 : this.simulationDelta;
      this.accumulator += this.agentPaused || sim.paused ? 0 : dt;
      while (this.accumulator >= inputDelta && sim && !sim.paused) {
        const current = sim;
        const controls = this.activePlayerControls();
        const keyboardMovement = movementFromKeys(this.keys, controls.keyboard);
        const movement = cameraRelativeMovement(
          Math.max(-1, Math.min(1, keyboardMovement.moveX + this.touchMovement.moveX + gamepad.moveX)),
          Math.max(-1, Math.min(1, keyboardMovement.moveZ + this.touchMovement.moveZ + gamepad.moveZ)),
          this.gameCameraYaw,
        );
        const input = {
          ...movement,
          sprint:
            controls.keyboard.sprint.some((code) => code && this.keys.has(code)) ||
            controls.gamepad.sprint.some((button) => gamepad.heldButtons.has(button)),
          ...this.pending,
        };
        const terrainEdit = this.applyTerrainInput(input);
        if (this.multiplayer) {
          const intention: MultiplayerGameplayInput = {
            ...movement,
            sprint: input.sprint,
            jump: input.jump,
            interact: input.interact,
            attack: input.attack,
            useItem: input.useItem,
            uiEventId: input.uiEventId,
            ...(terrainEdit ? { terrainEdit } : {}),
          };
          this.multiplayer.send(intention);
          this.pending = {};
          this.accumulator = 0;
          break;
        }
        const frame = current.frame;
        this.session!.step(input, this.simulationDelta);
        const active = this.simulation;
        if (!active) {
          sim = null;
          break;
        }
        const steps = active === current ? active.frame - frame : 1;
        this.simulatedStepsInWindow += steps;
        this.totalSimulationSteps += steps;
        this.pending = {};
        this.accumulator -= this.simulationDelta;
        sim = active;
      }
      if (sim) {
        const activeSimulation = sim;
        this.visuals.addNodes(activeSimulation.scene.nodes);
        for (const n of activeSimulation.nodes.values()) {
          this.visuals.update(n, activeSimulation.enabled(n));
          const visual = this.visuals.nodes.get(n.id)!;
          const animation = activeSimulation.animationState(n.id);
          visual.animate(animation?.clip ?? 'idle', animation?.time ?? 0);
        }
        const player = this.controlledPlayer(activeSimulation);
        if (player) {
          const target = activeSimulation.worldPosition(player),
            c = activeSimulation.component(player, 'player')!;
          if (c.style === 'first-person' && !this.cameraOverride) {
            target.y += c.cameraHeight ?? 1.6;
            const visual = this.visuals.nodes.get(player.id);
            if (visual) visual.group.visible = false;
          }
          if (!this.cameraOverride) {
            if (c.style !== 'first-person') target.y += 1;
            if (!activeSimulation.paused)
              this.updateGameCamera(target, c.style, dt, gamepad.lookX, gamepad.lookY);
          }
        }
        const stamp = `${activeSimulation.frame}:${activeSimulation.status}:${activeSimulation.paused}`;
        if (
          (activeSimulation.frame % 6 === 0 || activeSimulation.status !== 'playing') &&
          stamp !== this.stateStamp
        ) {
          this.stateStamp = stamp;
          this.onState?.(activeSimulation.inspect());
        }
      }
    } else {
      this.controls.update();
      for (const v of this.visuals.nodes.values()) v.animate('idle', this.elapsed);
      if (this.selected && this.selectedId) this.selected.box.copy(this.visuals.bounds(this.selectedId));
    }
    this.visuals.flush();
    this.worldRenderer?.update(this.controls.target, this.camera);
    const rendererCallStarted = performance.now();
    const gpuQueryStarted = this.gpuTimer.begin();
    try {
      this.renderer.render(this.scene, this.camera);
    } finally {
      if (gpuQueryStarted) this.gpuTimer.end();
    }
    const rendererCallMs = performance.now() - rendererCallStarted;
    this.rendererCallMsInWindow += rendererCallMs;
    this.totalRendererCallMs += rendererCallMs;
    this.renderCallsInWindow++;
    this.totalRendererCalls++;
    this.updatePerformance(now);
    if (scheduleNextFrame) this.scheduleFrame();
  };
  dispose() {
    this.disconnectMultiplayer(true);
    this.session?.dispose();
    this.session = null;
    this.disposed = true;
    this.audio.dispose();
    this.importedAudio.dispose();
    window.removeEventListener('pointerdown', this.unlockAudio, true);
    window.removeEventListener('keydown', this.unlockAudio, true);
    cancelAnimationFrame(this.frame);
    if (this.renderTimer !== null) clearTimeout(this.renderTimer);
    this.renderTaskChannel?.port1.close();
    this.renderTaskChannel?.port2.close();
    this.renderTaskChannel = null;
    this.renderTaskPending = false;
    this.observer.disconnect();
    window.removeEventListener('blur', this.blur);
    this.renderer.domElement.removeEventListener('pointerdown', this.terrainPointerDown, true);
    this.renderer.domElement.removeEventListener('pointermove', this.terrainPointerMove);
    this.renderer.domElement.removeEventListener('pointerup', this.pointer);
    this.renderer.domElement.removeEventListener('pointercancel', this.terrainPointerCancel);
    this.renderer.domElement.removeEventListener('contextmenu', this.contextMenu);
    this.renderer.domElement.removeEventListener('keydown', this.keyDown);
    this.renderer.domElement.removeEventListener('keyup', this.keyUp);
    this.renderer.domElement.removeEventListener('blur', this.blur);
    this.controls.dispose();
    this.select(null);
    this.visuals.dispose();
    this.gpuTimer.dispose();
    this.worldRenderer?.dispose();
    disposeObject(this.scene);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
