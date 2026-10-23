import React, { useEffect, useState } from 'react';
import {
  DEFAULT_SCENE_LIGHTING,
  audioClipSchema,
  gameHudWidgetSchema,
  MAX_AUDIO_CLIP_BYTES,
  MAX_PROJECT_AUDIO_BYTES,
  sceneLightingSchema,
  type GameScene,
  type AudioClipDocument,
  type GameHudWidget,
  type ProjectOperation,
  type SceneLighting,
} from '../services/projectDocument';
import ObjectiveEditor from './ObjectiveEditor';
import HudEditor from './HudEditor';
import { terrainBiomeFieldSchema, type TerrainBiomeField } from '../services/terrainBiomeField';
import {
  TERRAIN_CAVE_BRANCH_LIMIT,
  TERRAIN_CAVE_DEPTH_LIMIT,
  TERRAIN_CAVE_ENTRANCE_LIMIT,
  TERRAIN_CAVE_NETWORK_REACH_DEFAULT,
  TERRAIN_CAVE_NETWORK_REACH_LIMIT,
} from '../services/terrainNoise';
import type { WorldDocument } from '../services/worldDocument';

type WorldSettings = Pick<WorldDocument, 'id' | 'name' | 'seed' | 'chunkSize' | 'voxelSize'> & {
  generator: Pick<
    WorldDocument['generator'],
    | 'mode'
    | 'landformScale'
    | 'size'
    | 'biomeField'
    | 'caveDensity'
    | 'caveEntrancesPerRegion'
    | 'caveDepth'
    | 'caveBranchCount'
    | 'caveCrossPassage'
    | 'caveNetwork'
    | 'caveNetworkReach'
    | 'overhangDensity'
    | 'overhangMaxHeight'
    | 'overhangProfile'
    | 'overhangFootprint'
    | 'overhangHeightMap'
  >;
};
type NewWorldOperation = Extract<ProjectOperation, { type: 'world.create' }>;
type UpdateWorldOperation = Extract<ProjectOperation, { type: 'world.update' }>;

function readDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('The audio file could not be read.'));
    reader.onload = () =>
      typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Invalid audio file.'));
    reader.readAsDataURL(file);
  });
}
const dataUrlBytes = (dataUrl: string) => {
  const payload = dataUrl.split(',', 2)[1] ?? '';
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
};

const worldValues = (world: WorldSettings | undefined) => ({
  name: world?.name ?? 'Terrain world',
  seed: String(world?.seed ?? 42),
  chunkSize: String(world?.chunkSize ?? 16),
  voxelSize: String(world?.voxelSize ?? 0.5),
  mode: world?.generator.mode ?? 'heightfield',
  landformScale: world?.generator.landformScale === undefined ? '' : String(world.generator.landformScale),
  caveDensity: world?.generator.caveDensity === undefined ? '' : String(world.generator.caveDensity),
  caveEntrancesPerRegion: String(world?.generator.caveEntrancesPerRegion ?? 1),
  caveDepth: String(world?.generator.caveDepth ?? 0),
  caveBranchCount: String(world?.generator.caveBranchCount ?? 0),
  caveCrossPassage: world?.generator.caveCrossPassage ?? false,
  caveNetwork: world?.generator.caveNetwork ?? false,
  caveNetworkReach: String(world?.generator.caveNetworkReach ?? TERRAIN_CAVE_NETWORK_REACH_DEFAULT),
  overhangDensity:
    world?.generator.overhangDensity === undefined ? '' : String(world.generator.overhangDensity),
  overhangMaxHeight: String(world?.generator.overhangMaxHeight ?? 8),
  overhangProfile: world?.generator.overhangProfile?.join(', ') ?? '',
  overhangFootprint: world?.generator.overhangFootprint?.map((row) => row.join(', ')).join('\n') ?? '',
  overhangHeightMap: world?.generator.overhangHeightMap?.map((row) => row.join(', ')).join('\n') ?? '',
});
const overhangProfileValues = (value: string): number[] | null => {
  if (!value.trim()) return [];
  const parts = value.split(',');
  if (parts.some((part) => !part.trim())) return null;
  const samples = parts.map((part) => Number(part.trim()));
  return samples.length <= 64 &&
    samples.every((sample) => Number.isFinite(sample) && sample >= 0 && sample <= 1)
    ? samples
    : null;
};
const overhangFootprintValues = (value: string): number[][] | null => {
  if (!value.trim()) return [];
  const rows = value
    .trim()
    .split(/\r?\n/)
    .map((line) =>
      line
        .trim()
        .split(',')
        .map((sample) => sample.trim()),
    );
  if (rows.some((row) => row.some((sample) => !sample))) return null;
  const values = rows.map((row) => row.map(Number));
  return values.length <= 64 &&
    values[0]?.length > 0 &&
    values[0].length <= 64 &&
    values.every(
      (row) =>
        row.length === values[0].length &&
        row.every((sample) => Number.isFinite(sample) && sample >= 0 && sample <= 1),
    )
    ? values
    : null;
};
const terrainModeHint = (mode: 'heightfield' | 'voxel3d') =>
  mode === 'voxel3d'
    ? 'Nearby terrain uses 16³ voxel chunks and a finite seeded cave. Optional cave fields, connected side passages and a curved world-spanning trunk add 3D cave routes; overhangs connect to the surface and extend to their configured height. Distant relief remains heightfield-based. Actor and rigid-body collision follows voxel occupancy. Navigation is not included.'
    : 'Terrain uses heightfield collision with streamed detail near the viewer and a coarser distant silhouette.';
const terrainCaveDensityHint =
  'Zero adds no seeded field beyond the finite passage or selected connected trunk; higher settings carve a seeded 3D field below a 3-cell surface cap and above a 2-cell bottom margin. Where the field reaches the surface cap, the configured number of separated 3×3 mouths can open per 256×256 logical-cell region.';
const terrainCaveEntrancesHint =
  'Limits generated 3×3 cave mouths to 0–4 per 256×256-cell region. The default is one; cave density and the bounded search may produce fewer.';
const terrainCaveDepthHint =
  'Sets the finite main passage depth below baseHeight in terrain cells. Zero keeps its existing automatic placement; positive values clamp to the vertical world bounds. The seeded cave field remains controlled separately by density.';
const terrainCaveBranchHint =
  'Adds up to four deterministic side passages. With the world-spanning cave network enabled, they branch from its trunk; otherwise they branch from the finite main tunnel. Narrow worlds may fit fewer.';
const terrainOverhangDensityHint =
  'Higher settings add seeded voxel terrain attached to the heightfield surface. Maximum height is configurable from 1 to 64 terrain cells (default 8). An optional 2D footprint controls where that density appears; distant terrain keeps its highest silhouette.';
const biomePresets: TerrainBiomeField['biomes'] = [
  {
    id: 'grassland',
    name: 'Grassland',
    palette: {
      surface: 0x79a94e,
      subsurface: 0x806044,
      deep: 0x5e6269,
      surfaceDepth: 3,
      subsurfaceDepth: 6,
      materialType: 'STANDARD',
    },
  },
  {
    id: 'tundra',
    name: 'Tundra',
    palette: {
      surface: 0xc5d8dd,
      subsurface: 0x817969,
      deep: 0x526376,
      surfaceDepth: 3,
      subsurfaceDepth: 6,
      materialType: 'STANDARD',
    },
  },
  {
    id: 'desert',
    name: 'Desert',
    palette: {
      surface: 0xd2a85a,
      subsurface: 0x986d43,
      deep: 0x514b48,
      surfaceDepth: 3,
      subsurfaceDepth: 6,
      materialType: 'STANDARD',
    },
  },
  {
    id: 'volcanic',
    name: 'Volcanic',
    palette: {
      surface: 0x5c3830,
      subsurface: 0x332c30,
      deep: 0x171a20,
      surfaceDepth: 3,
      subsurfaceDepth: 6,
      materialType: 'STANDARD',
    },
  },
];
const initialBiomeField = (world: WorldDocument): TerrainBiomeField => ({
  scale: Math.max(
    8,
    Math.min(1_000_000, Math.round(Math.min(...world.generator.size) * world.voxelSize * 0.5)),
  ),
  biomes: biomePresets.slice(0, 2),
});

export default function SceneSettings({
  scene,
  worlds,
  audioClips = [],
  apply,
  addAudioClip,
  deleteAudioClip,
  createWorld,
  updateWorld,
}: {
  scene: GameScene | undefined;
  worlds: WorldDocument[];
  audioClips?: AudioClipDocument[];
  apply: (s: GameScene) => Promise<any>;
  addAudioClip?: (clip: AudioClipDocument) => Promise<any>;
  deleteAudioClip?: (id: string) => Promise<any>;
  createWorld: (world: NewWorldOperation, scene: GameScene) => Promise<any>;
  updateWorld: (world: UpdateWorldOperation, scene: GameScene) => Promise<any>;
}) {
  const [text, setText] = useState(scene?.instructions ?? '');
  const [worldId, setWorldId] = useState(scene?.worldId ?? '');
  const [background, setBackground] = useState(scene?.background ?? 0x111827);
  const [groundColor, setGroundColor] = useState(scene?.groundColor ?? 0x334155);
  const [lighting, setLighting] = useState<SceneLighting>(() =>
    structuredClone(scene?.lighting ?? DEFAULT_SCENE_LIGHTING),
  );
  const [bounds, setBounds] = useState(String(scene?.bounds ?? 40));
  const [objectives, setObjectives] = useState<GameScene['objectives']>(scene?.objectives ?? []);
  const [hud, setHud] = useState<GameHudWidget[]>(scene?.hud ?? []);
  const [musicClipId, setMusicClipId] = useState(scene?.music?.clipId ?? '');
  const [musicVolume, setMusicVolume] = useState(scene?.music?.volume ?? 0.5);
  const [audioError, setAudioError] = useState('');
  const [edit, setEdit] = useState(() => worldValues(worlds.find((world) => world.id === scene?.worldId)));
  const [biomeField, setBiomeField] = useState<TerrainBiomeField | null>(null);
  const [name, setName] = useState('Terrain world');
  const [width, setWidth] = useState(256);
  const [depth, setDepth] = useState(256);
  const [voxelSize, setVoxelSize] = useState(0.5);
  const [landformScale, setLandformScale] = useState(96);
  const [caveDensity, setCaveDensity] = useState(0);
  const [caveEntrancesPerRegion, setCaveEntrancesPerRegion] = useState(1);
  const [caveDepth, setCaveDepth] = useState(0);
  const [caveBranchCount, setCaveBranchCount] = useState(0);
  const [caveCrossPassage, setCaveCrossPassage] = useState(true);
  const [caveNetwork, setCaveNetwork] = useState(false);
  const [caveNetworkReach, setCaveNetworkReach] = useState(TERRAIN_CAVE_NETWORK_REACH_DEFAULT);
  const [overhangDensity, setOverhangDensity] = useState(0);
  const [overhangMaxHeight, setOverhangMaxHeight] = useState(8);
  const [overhangProfile, setOverhangProfile] = useState('');
  const [overhangFootprint, setOverhangFootprint] = useState('');
  const [overhangHeightMap, setOverhangHeightMap] = useState('');
  const [seed, setSeed] = useState(42);
  const [mode, setMode] = useState<'heightfield' | 'voxel3d'>('heightfield');
  const newOverhangProfile = overhangProfileValues(overhangProfile);
  const newOverhangFootprint = overhangFootprintValues(overhangFootprint);
  const newOverhangHeightMap = overhangFootprintValues(overhangHeightMap);
  const canCreate =
    name.trim().length > 0 &&
    Number.isInteger(width) &&
    width >= 16 &&
    width <= 1_000_000 &&
    Number.isInteger(depth) &&
    depth >= 16 &&
    depth <= 1_000_000 &&
    Number.isFinite(voxelSize) &&
    voxelSize >= 0.001 &&
    voxelSize <= 100 &&
    Number.isFinite(landformScale) &&
    landformScale >= 8 &&
    landformScale <= 1_000_000 &&
    Number.isFinite(caveDensity) &&
    caveDensity >= 0 &&
    caveDensity <= 1 &&
    Number.isInteger(caveEntrancesPerRegion) &&
    caveEntrancesPerRegion >= 0 &&
    caveEntrancesPerRegion <= TERRAIN_CAVE_ENTRANCE_LIMIT &&
    Number.isInteger(caveDepth) &&
    caveDepth >= 0 &&
    caveDepth <= TERRAIN_CAVE_DEPTH_LIMIT &&
    Number.isInteger(caveBranchCount) &&
    caveBranchCount >= 0 &&
    caveBranchCount <= TERRAIN_CAVE_BRANCH_LIMIT &&
    Number.isInteger(caveNetworkReach) &&
    caveNetworkReach >= 0 &&
    caveNetworkReach <= TERRAIN_CAVE_NETWORK_REACH_LIMIT &&
    Number.isFinite(overhangDensity) &&
    overhangDensity >= 0 &&
    overhangDensity <= 1 &&
    Number.isInteger(overhangMaxHeight) &&
    overhangMaxHeight >= 1 &&
    overhangMaxHeight <= 64 &&
    newOverhangProfile !== null &&
    newOverhangFootprint !== null &&
    newOverhangHeightMap !== null &&
    Number.isInteger(seed) &&
    seed >= -2_147_483_648 &&
    seed <= 2_147_483_647;
  const selectedWorld = worlds.find((world) => world.id === worldId);
  const activeWorld = worlds.find((world) => world.id === scene?.worldId);
  // Ignore sparse edits so terrain clicks do not reset an in-progress settings draft.
  const activeWorldSignature = activeWorld
    ? JSON.stringify([
        activeWorld.id,
        activeWorld.name,
        activeWorld.seed,
        activeWorld.chunkSize,
        activeWorld.voxelSize,
        activeWorld.generator.mode,
        activeWorld.generator.landformScale,
        activeWorld.generator.caveDensity,
        activeWorld.generator.caveEntrancesPerRegion,
        activeWorld.generator.caveDepth,
        activeWorld.generator.caveBranchCount,
        activeWorld.generator.caveCrossPassage,
        activeWorld.generator.caveNetwork,
        activeWorld.generator.caveNetworkReach,
        activeWorld.generator.overhangDensity,
        activeWorld.generator.overhangMaxHeight,
        activeWorld.generator.overhangProfile,
        activeWorld.generator.overhangFootprint,
        activeWorld.generator.overhangHeightMap,
        activeWorld.generator.size,
        activeWorld.generator.biomeField,
      ])
    : '';
  const editSeed = Number(edit.seed),
    editChunkSize = Number(edit.chunkSize),
    editVoxelSize = Number(edit.voxelSize),
    editLandformScale = Number(edit.landformScale),
    editCaveDensity = Number(edit.caveDensity),
    editCaveEntrancesPerRegion = Number(edit.caveEntrancesPerRegion),
    editCaveDepth = Number(edit.caveDepth),
    editCaveBranchCount = Number(edit.caveBranchCount),
    editCaveNetworkReach = Number(edit.caveNetworkReach),
    editOverhangDensity = Number(edit.overhangDensity),
    editOverhangMaxHeight = Number(edit.overhangMaxHeight),
    editOverhangProfile = overhangProfileValues(edit.overhangProfile),
    editOverhangFootprint = overhangFootprintValues(edit.overhangFootprint),
    editOverhangHeightMap = overhangFootprintValues(edit.overhangHeightMap);
  const canUpdate =
    !!selectedWorld &&
    edit.name.trim().length > 0 &&
    edit.name.trim().length <= 120 &&
    Number.isInteger(editSeed) &&
    editSeed >= -2_147_483_648 &&
    editSeed <= 2_147_483_647 &&
    Number.isInteger(editChunkSize) &&
    editChunkSize >= 1 &&
    editChunkSize <= 32 &&
    Number.isFinite(editVoxelSize) &&
    editVoxelSize >= 0.001 &&
    editVoxelSize <= 100 &&
    (edit.landformScale.trim() === '' ||
      (Number.isFinite(editLandformScale) && editLandformScale >= 1 && editLandformScale <= 1_000_000)) &&
    (edit.caveDensity.trim() === '' ||
      (Number.isFinite(editCaveDensity) && editCaveDensity >= 0 && editCaveDensity <= 1)) &&
    Number.isInteger(editCaveEntrancesPerRegion) &&
    editCaveEntrancesPerRegion >= 0 &&
    editCaveEntrancesPerRegion <= TERRAIN_CAVE_ENTRANCE_LIMIT &&
    Number.isInteger(editCaveDepth) &&
    editCaveDepth >= 0 &&
    editCaveDepth <= TERRAIN_CAVE_DEPTH_LIMIT &&
    Number.isInteger(editCaveBranchCount) &&
    editCaveBranchCount >= 0 &&
    editCaveBranchCount <= TERRAIN_CAVE_BRANCH_LIMIT &&
    Number.isInteger(editCaveNetworkReach) &&
    editCaveNetworkReach >= 0 &&
    editCaveNetworkReach <= TERRAIN_CAVE_NETWORK_REACH_LIMIT &&
    (edit.overhangDensity.trim() === '' ||
      (Number.isFinite(editOverhangDensity) && editOverhangDensity >= 0 && editOverhangDensity <= 1)) &&
    Number.isInteger(editOverhangMaxHeight) &&
    editOverhangMaxHeight >= 1 &&
    editOverhangMaxHeight <= 64 &&
    editOverhangProfile !== null &&
    editOverhangFootprint !== null &&
    editOverhangHeightMap !== null &&
    (!biomeField || terrainBiomeFieldSchema.safeParse(biomeField).success);
  const sceneBounds = Number(bounds);
  const hudBindingsValid = hud.every((widget) => {
    const conditionItemId = widget.visibleWhen?.itemId;
    if (conditionItemId && !scene?.items.some((item) => item.id === conditionItemId)) return false;
    const binding = widget.type === 'value' || widget.type === 'bar' ? widget.binding : null;
    if (!binding || binding.kind !== 'inventory') return true;
    return scene?.items.some((item) => item.id === binding.itemId) ?? false;
  });
  const canSaveScene =
    Number.isFinite(sceneBounds) &&
    sceneBounds > 0 &&
    sceneBounds <= 10_000 &&
    sceneLightingSchema.safeParse(lighting).success &&
    hud.length <= 32 &&
    new Set(hud.map((widget) => widget.id)).size === hud.length &&
    hud.every((widget) => gameHudWidgetSchema.safeParse(widget).success) &&
    hud.every((widget) => widget.type !== 'bar' || widget.max > widget.min) &&
    hudBindingsValid;
  const sceneDraft = (nextWorldId = worldId) => ({
    ...scene!,
    instructions: text,
    objectives,
    hud,
    music: musicClipId ? { clipId: musicClipId, volume: musicVolume } : undefined,
    worldId: nextWorldId || null,
    background,
    groundColor,
    lighting,
    bounds: sceneBounds,
  });

  const selectWorld = (
    id: string,
    selected: WorldSettings | undefined = worlds.find((world) => world.id === id),
  ) => {
    setWorldId(id);
    if (selected) {
      setEdit(worldValues(selected));
      setBiomeField(selected.generator.biomeField ?? null);
    }
  };
  useEffect(() => {
    setText(scene?.instructions ?? '');
  }, [scene?.id, scene?.instructions]);
  useEffect(() => {
    setBackground(scene?.background ?? 0x111827);
    setGroundColor(scene?.groundColor ?? 0x334155);
    setLighting(structuredClone(scene?.lighting ?? DEFAULT_SCENE_LIGHTING));
    setBounds(String(scene?.bounds ?? 40));
  }, [scene?.id, scene?.background, scene?.groundColor, scene?.lighting, scene?.bounds]);
  useEffect(() => {
    setObjectives(scene?.objectives ?? []);
  }, [scene?.id, scene?.objectives]);
  useEffect(() => {
    setHud(scene?.hud ?? []);
  }, [scene?.id, scene?.hud]);
  useEffect(() => {
    setMusicClipId(scene?.music?.clipId ?? '');
    setMusicVolume(scene?.music?.volume ?? 0.5);
  }, [scene?.id, scene?.music?.clipId, scene?.music?.volume]);
  useEffect(() => {
    const id = scene?.worldId ?? '';
    setWorldId(id);
    setEdit(worldValues(activeWorld));
    setBiomeField(activeWorld?.generator.biomeField ?? null);
  }, [activeWorldSignature, scene?.id, scene?.worldId]);
  return scene ? (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (canSaveScene) void apply(sceneDraft());
      }}
    >
      <fieldset className="studio-component">
        <legend>Scene appearance</legend>
        <div className="studio-two">
          <label className="studio-field">
            Background color
            <input
              type="color"
              aria-label="Scene background color"
              value={`#${background.toString(16).padStart(6, '0')}`}
              onChange={(event) => setBackground(Number.parseInt(event.target.value.slice(1), 16))}
            />
          </label>
          <label className="studio-field">
            Scene floor color
            <input
              type="color"
              aria-label="Scene floor color"
              value={`#${groundColor.toString(16).padStart(6, '0')}`}
              onChange={(event) => setGroundColor(Number.parseInt(event.target.value.slice(1), 16))}
            />
          </label>
          <label className="studio-field">
            Scene floor half-width in meters
            <input
              type="number"
              aria-label="Scene floor half-width in meters"
              min={0.1}
              max={10_000}
              step="any"
              value={bounds}
              onChange={(event) => setBounds(event.target.value)}
            />
          </label>
        </div>
        <p>
          Background color also tints scene fog. Floor color and size apply when no terrain world is selected.
        </p>
      </fieldset>
      <fieldset className="studio-component">
        <legend>Scene audio</legend>
        <label className="studio-field">
          Looping scene music
          <select
            aria-label="Looping scene music"
            value={musicClipId}
            onChange={(event) => setMusicClipId(event.target.value)}
          >
            <option value="">No music</option>
            {audioClips.map((clip) => (
              <option key={clip.id} value={clip.id}>
                {clip.name}
              </option>
            ))}
          </select>
        </label>
        {musicClipId && (
          <label className="studio-field">
            Music volume · 0–1
            <input
              aria-label="Music volume"
              type="number"
              min={0}
              max={1}
              step="any"
              value={musicVolume}
              onChange={(event) => setMusicVolume(Number(event.target.value))}
            />
          </label>
        )}
        <label className="studio-field">
          Import audio clip · up to 3 MiB each, 12 MiB per project
          <input
            aria-label="Import audio clip"
            type="file"
            accept="audio/*"
            disabled={!addAudioClip}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              const input = event.currentTarget;
              setAudioError('');
              void (async () => {
                try {
                  if (!file.type.toLowerCase().startsWith('audio/') || file.size <= 0)
                    throw new Error('Choose a supported audio file.');
                  if (file.size > MAX_AUDIO_CLIP_BYTES) throw new Error('Audio clips may not exceed 3 MiB.');
                  if (
                    audioClips.reduce((total, clip) => total + dataUrlBytes(clip.dataUrl), 0) + file.size >
                    MAX_PROJECT_AUDIO_BYTES
                  )
                    throw new Error('Project audio may not exceed 12 MiB.');
                  const clip = audioClipSchema.parse({
                    id: `audio-${crypto.randomUUID().replaceAll('-', '')}`,
                    name: file.name.slice(0, 120),
                    mimeType: file.type.toLowerCase(),
                    dataUrl: await readDataUrl(file),
                  });
                  await addAudioClip!(clip);
                } catch (error) {
                  setAudioError((error as Error).message);
                } finally {
                  input.value = '';
                }
              })();
            }}
          />
        </label>
        {audioClips.length > 0 && (
          <ul>
            {audioClips.map((clip) => (
              <li key={clip.id}>
                {clip.name} · {clip.mimeType} · {(dataUrlBytes(clip.dataUrl) / (1024 * 1024)).toFixed(1)} MiB
                {deleteAudioClip && (
                  <button
                    type="button"
                    aria-label={`Delete audio clip ${clip.name}`}
                    onClick={() =>
                      void deleteAudioClip(clip.id).catch((error) => setAudioError(error.message))
                    }
                  >
                    Delete
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        <small>
          Music starts after browser audio is permitted by a user gesture. Rule actions can play imported
          clips once.
        </small>
        {audioError && <small role="alert">{audioError}</small>}
      </fieldset>
      <fieldset className="studio-component">
        <legend>Scene lighting</legend>
        <div className="studio-two">
          <label className="studio-field">
            Sky tint
            <input
              type="color"
              aria-label="Hemisphere sky tint"
              value={`#${lighting.hemisphere.skyColor.toString(16).padStart(6, '0')}`}
              onChange={(event) =>
                setLighting({
                  ...lighting,
                  hemisphere: {
                    ...lighting.hemisphere,
                    skyColor: Number.parseInt(event.target.value.slice(1), 16),
                  },
                })
              }
            />
          </label>
          <label className="studio-field">
            Ground tint
            <input
              type="color"
              aria-label="Hemisphere ground tint"
              value={`#${lighting.hemisphere.groundColor.toString(16).padStart(6, '0')}`}
              onChange={(event) =>
                setLighting({
                  ...lighting,
                  hemisphere: {
                    ...lighting.hemisphere,
                    groundColor: Number.parseInt(event.target.value.slice(1), 16),
                  },
                })
              }
            />
          </label>
          <label className="studio-field">
            Hemisphere intensity
            <input
              type="number"
              aria-label="Hemisphere light intensity"
              min={0}
              max={10}
              step="any"
              value={lighting.hemisphere.intensity}
              onChange={(event) =>
                setLighting({
                  ...lighting,
                  hemisphere: { ...lighting.hemisphere, intensity: Number(event.target.value) },
                })
              }
            />
          </label>
          <label className="studio-field">
            Directional light color
            <input
              type="color"
              aria-label="Directional light color"
              value={`#${lighting.directional.color.toString(16).padStart(6, '0')}`}
              onChange={(event) =>
                setLighting({
                  ...lighting,
                  directional: {
                    ...lighting.directional,
                    color: Number.parseInt(event.target.value.slice(1), 16),
                  },
                })
              }
            />
          </label>
          <label className="studio-field">
            Directional light intensity
            <input
              type="number"
              aria-label="Directional light intensity"
              min={0}
              max={10}
              step="any"
              value={lighting.directional.intensity}
              onChange={(event) =>
                setLighting({
                  ...lighting,
                  directional: { ...lighting.directional, intensity: Number(event.target.value) },
                })
              }
            />
          </label>
        </div>
        <fieldset className="studio-vector">
          <legend>Directional light position · meters</legend>
          {(['X', 'Y', 'Z'] as const).map((axis, index) => (
            <label key={axis}>
              {axis}
              <input
                type="number"
                aria-label={`Directional light position ${axis}`}
                min={-10_000}
                max={10_000}
                step="any"
                value={lighting.directional.position[index]}
                onChange={(event) => {
                  const position = [...lighting.directional.position] as [number, number, number];
                  position[index] = Number(event.target.value);
                  setLighting({ ...lighting, directional: { ...lighting.directional, position } });
                }}
              />
            </label>
          ))}
        </fieldset>
        <label className="studio-check">
          <input
            type="checkbox"
            checked={lighting.directional.castShadow}
            onChange={(event) =>
              setLighting({
                ...lighting,
                directional: { ...lighting.directional, castShadow: event.target.checked },
              })
            }
          />
          Directional light casts shadows
        </label>
        <button type="button" onClick={() => setLighting(structuredClone(DEFAULT_SCENE_LIGHTING))}>
          Reset to default lighting
        </button>
        <p>Scenes without saved lighting use the established default hemisphere and directional lights.</p>
      </fieldset>
      <label className="studio-field">
        Player instructions
        <textarea value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <ObjectiveEditor objectives={objectives} items={scene.items} onChange={setObjectives} />
      <HudEditor scene={scene} widgets={hud} onChange={setHud} />
      <label className="studio-field">
        Terrain world
        <select value={worldId} onChange={(e) => selectWorld(e.target.value)}>
          <option value="">Scene ground only</option>
          {worlds.map((world) => (
            <option key={world.id} value={world.id}>
              {world.name}
            </option>
          ))}
        </select>
      </label>
      {selectedWorld && (
        <fieldset className="studio-component">
          <legend>Edit selected terrain world</legend>
          <label className="studio-field">
            World name
            <input
              value={edit.name}
              maxLength={120}
              onChange={(e) => setEdit({ ...edit, name: e.target.value })}
            />
          </label>
          <label className="studio-field">
            Terrain representation
            <select
              value={edit.mode}
              onChange={(e) => setEdit({ ...edit, mode: e.target.value as 'heightfield' | 'voxel3d' })}
            >
              <option value="heightfield">Heightfield with distant terrain</option>
              <option value="voxel3d">3D voxels with caves</option>
            </select>
          </label>
          <p>{terrainModeHint(edit.mode)}</p>
          <div className="studio-two">
            <label className="studio-field">
              Seed
              <input
                type="number"
                min={-2_147_483_648}
                max={2_147_483_647}
                step={1}
                value={edit.seed}
                onChange={(e) => setEdit({ ...edit, seed: e.target.value })}
              />
            </label>
            <label className="studio-field">
              Chunk size
              <input
                type="number"
                min={1}
                max={32}
                step={1}
                value={edit.chunkSize}
                onChange={(e) => setEdit({ ...edit, chunkSize: e.target.value })}
              />
            </label>
            <label className="studio-field">
              Terrain cell edge in meters
              <input
                type="number"
                min={0.001}
                max={100}
                step="any"
                value={edit.voxelSize}
                onChange={(e) => setEdit({ ...edit, voxelSize: e.target.value })}
              />
            </label>
            <label className="studio-field">
              Landform scale in meters
              <input
                type="number"
                min={1}
                max={1_000_000}
                step="any"
                value={edit.landformScale}
                placeholder="Keep saved terrain frequency"
                onChange={(e) => setEdit({ ...edit, landformScale: e.target.value })}
              />
            </label>
            {edit.mode === 'voxel3d' && (
              <>
                <label className="studio-field">
                  Connected overhang density (0–1)
                  <input
                    type="number"
                    min={0}
                    max={1}
                    step="any"
                    value={edit.overhangDensity}
                    placeholder="Keep saved setting"
                    onChange={(e) => setEdit({ ...edit, overhangDensity: e.target.value })}
                  />
                </label>
                <label className="studio-field">
                  Maximum overhang height (terrain cells)
                  <input
                    type="number"
                    min={1}
                    max={64}
                    step={1}
                    value={edit.overhangMaxHeight}
                    onChange={(e) => setEdit({ ...edit, overhangMaxHeight: e.target.value })}
                  />
                </label>
                <label className="studio-field">
                  Overhang layer-density profile (comma-separated 0–1 samples)
                  <input
                    type="text"
                    value={edit.overhangProfile}
                    placeholder="Uniform density"
                    onChange={(e) => setEdit({ ...edit, overhangProfile: e.target.value })}
                  />
                </label>
                <p>
                  Samples run from the overhang base to its maximum height and interpolate between layers.
                  Each sample scales the seeded density; 0 ends the connected column. Leave empty for the
                  original uniform profile. Up to 64 samples.
                </p>
                <label className="studio-field">
                  Horizontal overhang footprint (rows +Z, columns +X; comma-separated 0–1 samples)
                  <textarea
                    rows={4}
                    value={edit.overhangFootprint}
                    placeholder="Leave empty for seeded noise"
                    onChange={(e) => setEdit({ ...edit, overhangFootprint: e.target.value })}
                  />
                </label>
                <p>
                  The rectangular map spans the world bounds and interpolates between samples. 0 suppresses
                  overhangs, 1 keeps full seeded density. Use up to 64 rows and 64 columns.
                </p>
                <label className="studio-field">
                  Deterministic overhang height map (normalized 0–1; rows +Z, columns +X)
                  <textarea
                    rows={4}
                    value={edit.overhangHeightMap}
                    placeholder="Leave empty to use seeded overhang density"
                    onChange={(e) => setEdit({ ...edit, overhangHeightMap: e.target.value })}
                  />
                </label>
                <p>
                  This map spans the world bounds: 0 means no extension, 1 means the configured maximum
                  height. Values interpolate between columns and round to terrain cells. When set, it fully
                  controls the overhang silhouette and takes priority over the seeded density, profile and
                  footprint.
                </p>
                <p>{terrainOverhangDensityHint}</p>
                <label className="studio-field">
                  Additional cave field density (0–1)
                  <input
                    type="number"
                    min={0}
                    max={1}
                    step="any"
                    value={edit.caveDensity}
                    placeholder="Keep saved setting"
                    onChange={(e) => setEdit({ ...edit, caveDensity: e.target.value })}
                  />
                </label>
                <p>{terrainCaveDensityHint}</p>
                <label className="studio-field">
                  Cave mouths per 256×256-cell region (0–{TERRAIN_CAVE_ENTRANCE_LIMIT})
                  <input
                    type="number"
                    min={0}
                    max={TERRAIN_CAVE_ENTRANCE_LIMIT}
                    step={1}
                    value={edit.caveEntrancesPerRegion}
                    onChange={(e) => setEdit({ ...edit, caveEntrancesPerRegion: e.target.value })}
                  />
                </label>
                <p>
                  {terrainCaveEntrancesHint} With the cave network enabled, these mouths connect to its trunk
                  up to the configured reach.
                </p>
                <label className="studio-field">
                  Main cave passage depth (terrain cells; 0 = automatic)
                  <input
                    type="number"
                    min={0}
                    max={TERRAIN_CAVE_DEPTH_LIMIT}
                    step={1}
                    value={edit.caveDepth}
                    onChange={(e) => setEdit({ ...edit, caveDepth: e.target.value })}
                  />
                </label>
                <p>{terrainCaveDepthHint}</p>
                <label className="studio-field">
                  Connected side passages (0–{TERRAIN_CAVE_BRANCH_LIMIT})
                  <input
                    type="number"
                    min={0}
                    max={TERRAIN_CAVE_BRANCH_LIMIT}
                    step={1}
                    value={edit.caveBranchCount}
                    onChange={(e) => setEdit({ ...edit, caveBranchCount: e.target.value })}
                  />
                </label>
                <p>{terrainCaveBranchHint}</p>
                <label className="studio-field">
                  <input
                    type="checkbox"
                    checked={edit.caveCrossPassage}
                    onChange={(e) => setEdit({ ...edit, caveCrossPassage: e.target.checked })}
                  />
                  Generate connected cross-passage
                </label>
                <label className="studio-field">
                  <input
                    type="checkbox"
                    checked={edit.caveNetwork}
                    onChange={(e) => setEdit({ ...edit, caveNetwork: e.target.checked })}
                  />
                  Generate a curved, world-spanning cave trunk
                </label>
                <label className="studio-field">
                  Cave-mouth connector reach in terrain cells (0–{TERRAIN_CAVE_NETWORK_REACH_LIMIT})
                  <input
                    type="number"
                    min={0}
                    max={TERRAIN_CAVE_NETWORK_REACH_LIMIT}
                    step={1}
                    value={edit.caveNetworkReach}
                    onChange={(e) => setEdit({ ...edit, caveNetworkReach: e.target.value })}
                  />
                </label>
                <p>
                  Adds one connected tunnel along the longer world axis and opens the central entrance down to
                  it. Generated cave mouths connect when they fall within this lateral reach; the default is{' '}
                  {TERRAIN_CAVE_NETWORK_REACH_DEFAULT} cells. It requires at least seven terrain cells across
                  and vertically.
                </p>
              </>
            )}
          </div>
          <p aria-live="polite">
            Logical terrain extent (width × depth): {selectedWorld.generator.size[0]} ×{' '}
            {selectedWorld.generator.size[1]} cells at {edit.voxelSize} m per cell ={' '}
            {(selectedWorld.generator.size[0] * editVoxelSize).toFixed(2)} m ×{' '}
            {(selectedWorld.generator.size[1] * editVoxelSize).toFixed(2)} m.
          </p>
          <p>
            This uses the saved world bounds. It describes logical extent and does not indicate how many
            terrain cells are currently resident or rendered.
          </p>
          <p>
            This sets the physical edge length of each terrain cell. Asset voxel size is independent. Landform
            scale sets the width of hills and mountains.
          </p>
          <fieldset className="studio-component">
            <legend>Biome palettes (optional)</legend>
            {biomeField ? (
              <>
                <label className="studio-field">
                  Region scale in meters
                  <input
                    type="number"
                    min={8}
                    max={1_000_000}
                    step={1}
                    value={biomeField.scale}
                    onChange={(event) => setBiomeField({ ...biomeField, scale: Number(event.target.value) })}
                  />
                </label>
                <p>
                  Biome scale controls region width in world meters; it is independent of terrain cell size.
                </p>
                {biomeField.biomes.map((biome) => (
                  <section className="studio-component" key={biome.id}>
                    <strong>{biome.name}</strong>
                    <label className="studio-field">
                      Biome name
                      <input
                        value={biome.name}
                        maxLength={40}
                        onChange={(event) =>
                          setBiomeField({
                            ...biomeField,
                            biomes: biomeField.biomes.map((item) =>
                              item.id === biome.id ? { ...item, name: event.target.value } : item,
                            ),
                          })
                        }
                      />
                    </label>
                    <div className="studio-two">
                      {(['surface', 'subsurface', 'deep'] as const).map((layer) => (
                        <label className="studio-field" key={layer}>
                          {layer} color
                          <input
                            type="color"
                            value={`#${biome.palette[layer].toString(16).padStart(6, '0')}`}
                            onChange={(event) =>
                              setBiomeField({
                                ...biomeField,
                                biomes: biomeField.biomes.map((item) =>
                                  item.id === biome.id
                                    ? {
                                        ...item,
                                        palette: {
                                          ...item.palette,
                                          [layer]: Number.parseInt(event.target.value.slice(1), 16),
                                        },
                                      }
                                    : item,
                                ),
                              })
                            }
                          />
                        </label>
                      ))}
                      <label className="studio-field">
                        Surface depth in cells
                        <input
                          type="number"
                          min={1}
                          max={16}
                          value={biome.palette.surfaceDepth}
                          onChange={(event) =>
                            setBiomeField({
                              ...biomeField,
                              biomes: biomeField.biomes.map((item) =>
                                item.id === biome.id
                                  ? {
                                      ...item,
                                      palette: { ...item.palette, surfaceDepth: Number(event.target.value) },
                                    }
                                  : item,
                              ),
                            })
                          }
                        />
                      </label>
                      <label className="studio-field">
                        Subsurface depth in cells
                        <input
                          type="number"
                          min={1}
                          max={32}
                          value={biome.palette.subsurfaceDepth}
                          onChange={(event) =>
                            setBiomeField({
                              ...biomeField,
                              biomes: biomeField.biomes.map((item) =>
                                item.id === biome.id
                                  ? {
                                      ...item,
                                      palette: {
                                        ...item.palette,
                                        subsurfaceDepth: Number(event.target.value),
                                      },
                                    }
                                  : item,
                              ),
                            })
                          }
                        />
                      </label>
                      <label className="studio-field">
                        Material
                        <select
                          value={biome.palette.materialType}
                          onChange={(event) =>
                            setBiomeField({
                              ...biomeField,
                              biomes: biomeField.biomes.map((item) =>
                                item.id === biome.id
                                  ? {
                                      ...item,
                                      palette: {
                                        ...item.palette,
                                        materialType: event.target.value as typeof item.palette.materialType,
                                      },
                                    }
                                  : item,
                              ),
                            })
                          }
                        >
                          <option value="STANDARD">Standard</option>
                          <option value="METALLIC">Metallic</option>
                          <option value="GLASS">Glass</option>
                          <option value="EMISSIVE">Emissive</option>
                        </select>
                      </label>
                    </div>
                    <button
                      type="button"
                      disabled={biomeField.biomes.length <= 2}
                      onClick={() =>
                        setBiomeField({
                          ...biomeField,
                          biomes: biomeField.biomes.filter((item) => item.id !== biome.id),
                        })
                      }
                    >
                      Remove {biome.name}
                    </button>
                    <small>Stable ID: {biome.id}</small>
                  </section>
                ))}
                <div className="studio-two">
                  {biomePresets.slice(2).map((preset) => (
                    <button
                      type="button"
                      key={preset.id}
                      disabled={biomeField.biomes.length >= 8}
                      onClick={() => {
                        const suffix =
                          biomeField.biomes.filter((item) => item.id.startsWith(preset.id)).length + 1;
                        const exists = biomeField.biomes.some((item) => item.id === preset.id);
                        setBiomeField({
                          ...biomeField,
                          biomes: [
                            ...biomeField.biomes,
                            { ...preset, id: exists ? `${preset.id}-${suffix}` : preset.id },
                          ],
                        });
                      }}
                    >
                      Add {preset.name}
                    </button>
                  ))}
                </div>
                <button type="button" onClick={() => setBiomeField(null)}>
                  Remove biome field
                </button>
              </>
            ) : (
              <button type="button" onClick={() => setBiomeField(initialBiomeField(selectedWorld))}>
                Add Grassland and Tundra presets
              </button>
            )}
          </fieldset>
          <button
            type="button"
            className="studio-primary"
            disabled={!canUpdate || !canSaveScene}
            onClick={() => {
              if (!selectedWorld || !canUpdate) return;
              const operation: UpdateWorldOperation = {
                type: 'world.update',
                worldId: selectedWorld.id,
                name: edit.name.trim(),
                seed: editSeed,
                chunkSize: editChunkSize,
                voxelSize: editVoxelSize,
                generator: {
                  mode: edit.mode,
                  ...(edit.landformScale.trim() === '' ? {} : { landformScale: editLandformScale }),
                  ...(edit.caveDensity.trim() === '' ? {} : { caveDensity: editCaveDensity }),
                  caveEntrancesPerRegion: editCaveEntrancesPerRegion,
                  caveDepth: editCaveDepth,
                  caveBranchCount: editCaveBranchCount,
                  caveCrossPassage: edit.caveCrossPassage,
                  caveNetwork: edit.caveNetwork,
                  caveNetworkReach: editCaveNetworkReach,
                  ...(edit.overhangDensity.trim() === '' ? {} : { overhangDensity: editOverhangDensity }),
                  overhangMaxHeight: editOverhangMaxHeight,
                  overhangProfile: editOverhangProfile!.length ? editOverhangProfile : null,
                  overhangFootprint: editOverhangFootprint!.length ? editOverhangFootprint : null,
                  overhangHeightMap: editOverhangHeightMap!.length ? editOverhangHeightMap : null,
                  biomeField,
                },
              };
              void updateWorld(operation, sceneDraft(selectedWorld.id));
            }}
          >
            Update world and use in scene
          </button>
        </fieldset>
      )}
      <fieldset className="studio-component">
        <legend>Create a terrain world</legend>
        <label className="studio-field">
          World name
          <input value={name} maxLength={120} required onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="studio-field">
          Terrain representation
          <select value={mode} onChange={(e) => setMode(e.target.value as 'heightfield' | 'voxel3d')}>
            <option value="heightfield">Heightfield with distant terrain</option>
            <option value="voxel3d">3D voxels with caves</option>
          </select>
        </label>
        <p>{terrainModeHint(mode)}</p>
        <div className="studio-two">
          <label className="studio-field">
            Width in cells
            <input
              type="number"
              min={16}
              max={1_000_000}
              step={1}
              required
              value={width}
              onChange={(e) => setWidth(Number(e.target.value))}
            />
          </label>
          <label className="studio-field">
            Depth in cells
            <input
              type="number"
              min={16}
              max={1_000_000}
              step={1}
              required
              value={depth}
              onChange={(e) => setDepth(Number(e.target.value))}
            />
          </label>
          <label className="studio-field">
            Terrain cell edge in meters
            <input
              type="number"
              min={0.001}
              max={100}
              step="any"
              required
              value={voxelSize}
              onChange={(e) => setVoxelSize(Number(e.target.value))}
            />
          </label>
          <label className="studio-field">
            Landform scale in meters
            <input
              type="number"
              min={8}
              max={1_000_000}
              step="any"
              required
              value={landformScale}
              onChange={(e) => setLandformScale(Number(e.target.value))}
            />
          </label>
          {mode === 'voxel3d' && (
            <>
              <label className="studio-field">
                Connected overhang density (0–1)
                <input
                  type="number"
                  min={0}
                  max={1}
                  step="any"
                  value={overhangDensity}
                  onChange={(e) => setOverhangDensity(Number(e.target.value))}
                />
              </label>
              <label className="studio-field">
                Maximum overhang height (terrain cells)
                <input
                  type="number"
                  min={1}
                  max={64}
                  step={1}
                  value={overhangMaxHeight}
                  onChange={(e) => setOverhangMaxHeight(Number(e.target.value))}
                />
              </label>
              <label className="studio-field">
                Overhang layer-density profile (comma-separated 0–1 samples)
                <input
                  type="text"
                  value={overhangProfile}
                  placeholder="Uniform density"
                  onChange={(e) => setOverhangProfile(e.target.value)}
                />
              </label>
              <p>
                Samples run from the overhang base to its maximum height and interpolate between layers. Each
                sample scales the seeded density; 0 ends the connected column. Leave empty for the original
                uniform profile. Up to 64 samples.
              </p>
              <label className="studio-field">
                Horizontal overhang footprint (rows +Z, columns +X; comma-separated 0–1 samples)
                <textarea
                  rows={4}
                  value={overhangFootprint}
                  placeholder="Leave empty for seeded noise"
                  onChange={(e) => setOverhangFootprint(e.target.value)}
                />
              </label>
              <p>
                The rectangular map spans the world bounds and interpolates between samples. 0 suppresses
                overhangs, 1 keeps full seeded density. Use up to 64 rows and 64 columns.
              </p>
              <label className="studio-field">
                Deterministic overhang height map (normalized 0–1; rows +Z, columns +X)
                <textarea
                  rows={4}
                  value={overhangHeightMap}
                  placeholder="Leave empty to use seeded overhang density"
                  onChange={(e) => setOverhangHeightMap(e.target.value)}
                />
              </label>
              <p>
                This map spans the world bounds: 0 means no extension, 1 means the configured maximum height.
                Values interpolate between columns and round to terrain cells. When set, it fully controls the
                overhang silhouette and takes priority over the seeded density, profile and footprint.
              </p>
              <p>{terrainOverhangDensityHint}</p>
              <label className="studio-field">
                Additional cave field density (0–1)
                <input
                  type="number"
                  min={0}
                  max={1}
                  step="any"
                  value={caveDensity}
                  onChange={(e) => setCaveDensity(Number(e.target.value))}
                />
              </label>
              <p>{terrainCaveDensityHint}</p>
              <label className="studio-field">
                Cave mouths per 256×256-cell region (0–{TERRAIN_CAVE_ENTRANCE_LIMIT})
                <input
                  type="number"
                  min={0}
                  max={TERRAIN_CAVE_ENTRANCE_LIMIT}
                  step={1}
                  value={caveEntrancesPerRegion}
                  onChange={(e) => setCaveEntrancesPerRegion(Number(e.target.value))}
                />
              </label>
              <p>
                {terrainCaveEntrancesHint} With the cave network enabled, these mouths connect to its trunk up
                to the configured reach.
              </p>
              <label className="studio-field">
                Main cave passage depth (terrain cells; 0 = automatic)
                <input
                  type="number"
                  min={0}
                  max={TERRAIN_CAVE_DEPTH_LIMIT}
                  step={1}
                  value={caveDepth}
                  onChange={(e) => setCaveDepth(Number(e.target.value))}
                />
              </label>
              <p>{terrainCaveDepthHint}</p>
              <label className="studio-field">
                Connected side passages (0–{TERRAIN_CAVE_BRANCH_LIMIT})
                <input
                  type="number"
                  min={0}
                  max={TERRAIN_CAVE_BRANCH_LIMIT}
                  step={1}
                  value={caveBranchCount}
                  onChange={(e) => setCaveBranchCount(Number(e.target.value))}
                />
              </label>
              <p>{terrainCaveBranchHint}</p>
              <label className="studio-field">
                <input
                  type="checkbox"
                  checked={caveCrossPassage}
                  onChange={(e) => setCaveCrossPassage(e.target.checked)}
                />
                Generate connected cross-passage
              </label>
              <label className="studio-field">
                <input
                  type="checkbox"
                  checked={caveNetwork}
                  onChange={(e) => setCaveNetwork(e.target.checked)}
                />
                Generate a curved, world-spanning cave trunk
              </label>
              <label className="studio-field">
                Cave-mouth connector reach in terrain cells (0–{TERRAIN_CAVE_NETWORK_REACH_LIMIT})
                <input
                  type="number"
                  min={0}
                  max={TERRAIN_CAVE_NETWORK_REACH_LIMIT}
                  step={1}
                  value={caveNetworkReach}
                  onChange={(e) => setCaveNetworkReach(Number(e.target.value))}
                />
              </label>
              <p>
                Adds one connected tunnel along the longer world axis and opens the central entrance down to
                it. With cave density enabled, generated mouths within the configured lateral reach also
                connect through a shaft and tunnel. The default reach is {TERRAIN_CAVE_NETWORK_REACH_DEFAULT}{' '}
                terrain cells. It requires at least seven terrain cells across and vertically.
              </p>
            </>
          )}
          <label className="studio-field">
            Seed
            <input
              type="number"
              min={-2_147_483_648}
              max={2_147_483_647}
              step={1}
              required
              value={seed}
              onChange={(e) => setSeed(Number(e.target.value))}
            />
          </label>
        </div>
        <p aria-live="polite">
          Logical terrain extent (width × depth): {width} × {depth} cells at {voxelSize} m per cell ={' '}
          {(width * voxelSize).toFixed(2)} m × {(depth * voxelSize).toFixed(2)} m.
        </p>
        <p>
          This is the logical world extent; it does not indicate how many terrain cells are currently resident
          or rendered. Generated assets have their own independent voxel size.
        </p>
        <p>Landform scale controls the width of hills and mountains; larger values create broader terrain.</p>
        <button
          type="button"
          disabled={!canCreate || !canSaveScene}
          onClick={async () => {
            const id = `world-${crypto.randomUUID().replaceAll('-', '')}`;
            const world: NewWorldOperation = {
              type: 'world.create',
              id,
              name,
              seed,
              chunkSize: 16,
              voxelSize,
              generator: {
                type: 'terrain',
                version: 1,
                mode,
                origin: [-Math.floor(width / 2), -Math.floor(depth / 2)],
                size: [width, depth],
                minY: -32,
                maxY: 128,
                baseHeight: 16,
                amplitude: 32,
                noise: 0.35,
                landformScale,
                ...(mode === 'voxel3d' && caveDensity > 0 ? { caveDensity } : {}),
                ...(mode === 'voxel3d' ? { caveEntrancesPerRegion } : {}),
                ...(mode === 'voxel3d' && caveDepth > 0 ? { caveDepth } : {}),
                ...(mode === 'voxel3d' && caveBranchCount > 0 ? { caveBranchCount } : {}),
                ...(mode === 'voxel3d' ? { caveCrossPassage } : {}),
                ...(mode === 'voxel3d' && caveNetwork ? { caveNetwork: true } : {}),
                ...(mode === 'voxel3d' ? { caveNetworkReach } : {}),
                ...(mode === 'voxel3d' && overhangDensity > 0 ? { overhangDensity } : {}),
                ...(mode === 'voxel3d' && overhangDensity > 0 ? { overhangMaxHeight } : {}),
                ...(mode === 'voxel3d' && newOverhangProfile?.length
                  ? { overhangProfile: newOverhangProfile }
                  : {}),
                ...(mode === 'voxel3d' && newOverhangFootprint?.length
                  ? { overhangFootprint: newOverhangFootprint }
                  : {}),
                ...(mode === 'voxel3d' && newOverhangHeightMap?.length
                  ? { overhangHeightMap: newOverhangHeightMap }
                  : {}),
                palette: {
                  surface: 0x79a94e,
                  subsurface: 0x806044,
                  deep: 0x5e6269,
                  surfaceDepth: 3,
                  subsurfaceDepth: 6,
                  materialType: 'STANDARD',
                },
              },
            };
            const saved = await createWorld(world, sceneDraft(id));
            if (saved)
              selectWorld(id, {
                id,
                name: name.trim(),
                seed,
                chunkSize: 16,
                voxelSize,
                generator: {
                  mode,
                  size: world.generator.size,
                  landformScale,
                  caveDensity: world.generator.caveDensity,
                  caveEntrancesPerRegion: world.generator.caveEntrancesPerRegion ?? 1,
                  caveDepth: world.generator.caveDepth ?? 0,
                  caveCrossPassage: world.generator.caveCrossPassage ?? false,
                  caveNetwork: world.generator.caveNetwork ?? false,
                  caveNetworkReach: world.generator.caveNetworkReach ?? TERRAIN_CAVE_NETWORK_REACH_DEFAULT,
                  overhangDensity: world.generator.overhangDensity,
                  overhangMaxHeight: world.generator.overhangMaxHeight ?? 8,
                  overhangProfile: world.generator.overhangProfile,
                  overhangFootprint: world.generator.overhangFootprint,
                  overhangHeightMap: world.generator.overhangHeightMap,
                  biomeField: undefined,
                },
              });
          }}
        >
          Create and use terrain
        </button>
      </fieldset>
      <button disabled={!canSaveScene}>Save scene settings</button>
    </form>
  ) : null;
}
