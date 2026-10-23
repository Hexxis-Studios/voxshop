import type { ProjectDocument } from '../services/projectDocument';
import type { GameInput, GameSimulation, RuntimeEvent } from './GameSimulation';
import { GameSimulation as Simulation } from './GameSimulation';
import { parseCampaignProgress, type CampaignProgressSnapshot } from './campaignProgress';
import type { GameProgressSnapshot } from './gameProgress';

const MAX_SCENE_TRANSITIONS_PER_UPDATE = 16;

/** Owns scene-local simulations and their in-memory progress for one Play session. */
export class GameSession {
  private current: GameSimulation;
  private progress = new Map<string, GameProgressSnapshot>();
  private campaign: ReturnType<GameSimulation['campaignState']>;
  private campaignVariables: Record<string, number> = {};
  private disposed = false;
  private heldEdgeInputs = new Set<'jump' | 'interact' | 'attack'>();
  private heldUseItem: string | undefined;
  private lastInput: GameInput = {};
  readonly scenePath: string[];
  readonly restoredScenes = new Set<string>();

  constructor(
    private project: ProjectDocument,
    readonly startSceneId: string,
    progress?: unknown,
    private onSceneChange?: (simulation: GameSimulation) => void,
    private readonly onEvent?: (event: RuntimeEvent) => void,
  ) {
    if (!project.scenes.some((scene) => scene.id === startSceneId)) throw new Error('Scene not found.');
    this.scenePath = [startSceneId];

    let activeSceneId = startSceneId,
      initialProgress = progress,
      restoredCampaign: CampaignProgressSnapshot | null = null;
    if (isCampaignProgressCandidate(progress)) {
      restoredCampaign = parseCampaignValue(progress, project.id, startSceneId);
      if (restoredCampaign && this.validateCampaign(restoredCampaign)) {
        activeSceneId = restoredCampaign.activeSceneId;
        initialProgress = restoredCampaign.scenes.find((snapshot) => snapshot.sceneId === activeSceneId);
        this.campaignVariables = { ...restoredCampaign.campaignVariables };
      } else {
        // A malformed or incompatible campaign is ignored as one unit. In particular,
        // do not fall back to restoring just its entry-scene snapshot.
        restoredCampaign = null;
        initialProgress = undefined;
        this.campaignVariables = {};
      }
    }

    const active = new Simulation(
      project,
      activeSceneId,
      initialProgress,
      restoredCampaign ? undefined : this.onEvent,
      this.campaignVariables,
    );
    if (restoredCampaign && !active.progressRestored) {
      const ready = active.ready;
      active.dispose();
      void ready.catch(() => undefined);
      restoredCampaign = null;
      activeSceneId = startSceneId;
      initialProgress = undefined;
      this.campaignVariables = {};
      this.current = new Simulation(project, startSceneId, undefined, this.onEvent, this.campaignVariables);
    } else {
      this.current = active;
    }
    if (restoredCampaign) {
      for (const snapshot of restoredCampaign.scenes) this.progress.set(snapshot.sceneId, snapshot);
      if (activeSceneId !== startSceneId) this.scenePath.push(activeSceneId);
    }
    this.campaign = this.current.campaignState();
    if (this.current.progressRestored) this.restoredScenes.add(this.current.scene.id);
    this.consumeTransitions();
  }

  get simulation() {
    return this.current;
  }

  get ready() {
    return this.waitForReady();
  }

  step(input: GameInput = {}, deltaSeconds?: number) {
    this.lastInput = { ...input };
    this.current.step(this.inputForCurrentScene(input), deltaSeconds);
    this.consumeTransitions(input);
  }

  progressWasRestored(sceneId: string) {
    return this.restoredScenes.has(sceneId);
  }

  /** A durable copy of every visited scene's local state and the current campaign state. */
  progressSnapshot(): CampaignProgressSnapshot | null {
    const active = this.current.progressSnapshot();
    if (!active) return null;
    const scenes = new Map(this.progress);
    scenes.set(active.sceneId, active);
    const snapshot: CampaignProgressSnapshot = {
      version: 1,
      projectId: this.project.id,
      startSceneId: this.startSceneId,
      activeSceneId: active.sceneId,
      scenes: structuredClone([...scenes.values()]),
      campaignVariables: { ...this.campaignVariables },
    };
    return snapshot;
  }

  private validateCampaign(snapshot: CampaignProgressSnapshot) {
    const existingScenes = new Set(this.project.scenes.map((scene) => scene.id));
    if (snapshot.scenes.some((scene) => !existingScenes.has(scene.sceneId))) return false;

    for (const sceneSnapshot of snapshot.scenes) {
      const validation = new Simulation(this.project, sceneSnapshot.sceneId, sceneSnapshot);
      const restored = validation.progressRestored,
        ready = validation.ready;
      validation.dispose();
      void ready.catch(() => undefined);
      if (!restored) return false;
    }
    return true;
  }

  private inputForCurrentScene(input: GameInput) {
    const current = { ...input };
    for (const action of ['jump', 'interact', 'attack'] as const) {
      if (!input[action]) this.heldEdgeInputs.delete(action);
      else if (this.heldEdgeInputs.has(action)) current[action] = false;
    }
    if (this.heldUseItem !== undefined) {
      if (input.useItem !== this.heldUseItem) this.heldUseItem = undefined;
      else delete current.useItem;
    }
    return current;
  }

  private consumeTransitions(input: GameInput = {}) {
    for (let count = 0; count < MAX_SCENE_TRANSITIONS_PER_UPDATE; count++) {
      const nextSceneId = this.current.takeSceneTransition();
      if (!nextSceneId) return;
      for (const action of ['jump', 'interact', 'attack'] as const)
        if (input[action]) this.heldEdgeInputs.add(action);
      if (input.useItem) this.heldUseItem = input.useItem;
      const destination = this.project.scenes.find((scene) => scene.id === nextSceneId);
      if (!destination) {
        this.current.status = 'stopped';
        this.current.errors.push(`Scene transition target ${nextSceneId} is missing.`);
        return;
      }
      const snapshot = this.current.progressSnapshot();
      if (snapshot) this.progress.set(this.current.scene.id, snapshot);
      this.campaign = this.current.campaignState();
      this.current.dispose();
      this.current = new Simulation(
        this.project,
        nextSceneId,
        this.progress.get(nextSceneId),
        this.onEvent,
        this.campaignVariables,
      );
      if (!this.current.applyCampaignState(this.campaign)) {
        this.current.status = 'stopped';
        this.current.errors.push(
          `Scene ${nextSceneId} cannot accept the campaign inventory; check item definitions and slot limits.`,
        );
        return;
      }
      if (this.current.progressRestored) this.restoredScenes.add(nextSceneId);
      this.scenePath.push(nextSceneId);
      this.onSceneChange?.(this.current);
    }
    if (this.current.takeSceneTransition()) {
      this.current.status = 'stopped';
      this.current.errors.push(
        `Gameplay exceeded ${MAX_SCENE_TRANSITIONS_PER_UPDATE} scene transitions in one update.`,
      );
    }
  }

  private async waitForReady() {
    for (let count = 0; count <= MAX_SCENE_TRANSITIONS_PER_UPDATE; count++) {
      const active = this.current;
      await active.ready;
      if (this.disposed || active === this.current) {
        if (!this.disposed) this.consumeTransitions(this.lastInput);
        if (active === this.current || this.disposed) return;
      }
    }
  }

  dispose() {
    this.disposed = true;
    this.current.dispose();
    this.progress.clear();
  }
}

function isCampaignProgressCandidate(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return ['startSceneId', 'activeSceneId', 'scenes'].some((key) => Object.hasOwn(value, key));
}

function parseCampaignValue(
  value: Record<string, unknown>,
  projectId: string,
  startSceneId: string,
): CampaignProgressSnapshot | null {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return null;
  }
  return typeof serialized === 'string' ? parseCampaignProgress(serialized, projectId, startSceneId) : null;
}
