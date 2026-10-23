import {
  MAX_GAME_PROGRESS_BYTES,
  clearProgressStorage,
  getBrowserProgressStorage,
  loadProgressFromStorage,
  parseGameProgress,
  progressStorageAvailable,
  type GameProgressSnapshot,
  type ProgressStorageLike,
  type ProgressStorageLoadResult,
} from './gameProgress';

/** Browser-local campaign progress for one exported game's entry scene. */
export const CAMPAIGN_PROGRESS_VERSION = 1;
export const MAX_CAMPAIGN_PROGRESS_BYTES = 2 * 1024 * 1024;
export const MAX_CAMPAIGN_SCENES = 100;
export const MAX_CAMPAIGN_VARIABLES = 256;
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export type CampaignProgressSnapshot = {
  version: 1;
  projectId: string;
  startSceneId: string;
  activeSceneId: string;
  scenes: GameProgressSnapshot[];
  campaignVariables: Record<string, number>;
};

export type CampaignProgressLoadResult = ProgressStorageLoadResult<CampaignProgressSnapshot>;
export type CampaignProgressSaveResult = 'saved' | 'too-large' | 'invalid' | 'unavailable';

function serializedBytes(serialized: string) {
  return new TextEncoder().encode(serialized).byteLength;
}

/** Validate the complete campaign document and every nested scene snapshot. */
export function parseCampaignProgress(
  serialized: string,
  projectId: string,
  startSceneId: string,
): CampaignProgressSnapshot | null {
  if (
    typeof serialized !== 'string' ||
    serializedBytes(serialized) > MAX_CAMPAIGN_PROGRESS_BYTES ||
    typeof projectId !== 'string' ||
    typeof startSceneId !== 'string' ||
    !idPattern.test(projectId) ||
    !idPattern.test(startSceneId)
  )
    return null;

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
        !['version', 'projectId', 'startSceneId', 'activeSceneId', 'scenes', 'campaignVariables'].includes(
          key,
        ),
    ) ||
    raw.version !== CAMPAIGN_PROGRESS_VERSION ||
    raw.projectId !== projectId ||
    raw.startSceneId !== startSceneId ||
    typeof raw.activeSceneId !== 'string' ||
    !idPattern.test(raw.activeSceneId) ||
    !Array.isArray(raw.scenes) ||
    raw.scenes.length < 1 ||
    raw.scenes.length > MAX_CAMPAIGN_SCENES
  )
    return null;

  const scenes: GameProgressSnapshot[] = [];
  const sceneIds = new Set<string>();
  for (const entry of raw.scenes) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.sceneId !== 'string' || !idPattern.test(candidate.sceneId)) return null;
    if (sceneIds.has(candidate.sceneId)) return null;
    let sceneSerialized: string;
    try {
      sceneSerialized = JSON.stringify(entry);
    } catch {
      return null;
    }
    if (typeof sceneSerialized !== 'string' || serializedBytes(sceneSerialized) > MAX_GAME_PROGRESS_BYTES)
      return null;
    const snapshot = parseGameProgress(sceneSerialized, projectId, candidate.sceneId);
    if (!snapshot) return null;
    scenes.push(snapshot);
    sceneIds.add(snapshot.sceneId);
  }

  if (!sceneIds.has(startSceneId) || !sceneIds.has(raw.activeSceneId)) return null;
  const campaignVariables: Record<string, number> = {};
  if (raw.campaignVariables !== undefined) {
    if (
      !raw.campaignVariables ||
      typeof raw.campaignVariables !== 'object' ||
      Array.isArray(raw.campaignVariables)
    )
      return null;
    const entries = Object.entries(raw.campaignVariables);
    if (entries.length > MAX_CAMPAIGN_VARIABLES) return null;
    for (const [id, value] of entries) {
      if (!idPattern.test(id) || typeof value !== 'number' || !Number.isFinite(value)) return null;
      campaignVariables[id] = value;
    }
  }
  return {
    version: CAMPAIGN_PROGRESS_VERSION,
    projectId,
    startSceneId,
    activeSceneId: raw.activeSceneId,
    scenes,
    campaignVariables,
  };
}

export function serializeCampaignProgress(snapshot: CampaignProgressSnapshot): string | null {
  let serialized: string;
  try {
    serialized = JSON.stringify(snapshot);
  } catch {
    return null;
  }
  return parseCampaignProgress(serialized, snapshot.projectId, snapshot.startSceneId) ? serialized : null;
}

export function campaignProgressStorageKey(projectId: string, startSceneId: string) {
  if (
    typeof projectId !== 'string' ||
    typeof startSceneId !== 'string' ||
    !idPattern.test(projectId) ||
    !idPattern.test(startSceneId)
  )
    throw new Error('Invalid game identity.');
  return `voxshop:campaign-progress:v${CAMPAIGN_PROGRESS_VERSION}:${projectId}:${startSceneId}`;
}

/** Safe wrapper around browser storage; accessors may throw in private or restricted contexts. */
export class CampaignProgressStore {
  readonly key: string;
  constructor(
    private readonly projectId: string,
    private readonly startSceneId: string,
    private readonly getStorage: () => ProgressStorageLike | null = getBrowserProgressStorage,
  ) {
    this.key = campaignProgressStorageKey(projectId, startSceneId);
  }

  get available() {
    return progressStorageAvailable(this.getStorage);
  }

  load(): CampaignProgressLoadResult {
    return loadProgressFromStorage(this.key, this.getStorage, (serialized) =>
      parseCampaignProgress(serialized, this.projectId, this.startSceneId),
    );
  }

  save(snapshot: CampaignProgressSnapshot): CampaignProgressSaveResult {
    let serialized: string;
    try {
      serialized = JSON.stringify(snapshot);
    } catch {
      return 'invalid';
    }
    if (typeof serialized !== 'string') return 'invalid';
    if (serializedBytes(serialized) > MAX_CAMPAIGN_PROGRESS_BYTES) return 'too-large';
    if (!parseCampaignProgress(serialized, this.projectId, this.startSceneId)) {
      const raw = JSON.parse(serialized);
      return Array.isArray(raw?.scenes) &&
        raw.scenes.some((scene: unknown) => serializedBytes(JSON.stringify(scene)) > MAX_GAME_PROGRESS_BYTES)
        ? 'too-large'
        : 'invalid';
    }
    try {
      const storage = this.getStorage();
      if (!storage) return 'unavailable';
      storage.setItem(this.key, serialized);
      return 'saved';
    } catch {
      return 'unavailable';
    }
  }

  clear() {
    return clearProgressStorage(this.key, this.getStorage);
  }
}
