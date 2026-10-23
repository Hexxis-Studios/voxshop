import React, { useEffect, useState } from 'react';
import type { Asset, GameScene, SceneScatter } from '../services/projectDocument';
import type { WorldDocument } from '../services/worldDocument';
import { isScatterableAsset, SCATTER_ASSET_MAX_VOXELS } from '../services/worldScatter';

export type SceneScatterBounds = { minX: number; maxX: number; minZ: number; maxZ: number };
export type SceneScatterCreateInput = {
  type: 'scene.scatter.create';
  sceneId: string;
  id: string;
  assetId: string;
  seed: number;
  count: number;
  bounds: SceneScatterBounds;
  snapToTerrain: boolean;
  groundY: number;
  scaleRange: [number, number];
  randomYaw: boolean;
};

export function defaultSceneScatterBounds(
  scene: Pick<GameScene, 'bounds'>,
  world: Pick<WorldDocument, 'voxelSize' | 'generator'> | null,
): SceneScatterBounds {
  if (!world) {
    const halfSize = Math.min(8, scene.bounds);
    return { minX: -halfSize, maxX: halfSize, minZ: -halfSize, maxZ: halfSize };
  }

  const [originX, originZ] = world.generator.origin;
  const [width, depth] = world.generator.size;
  const minX = (originX - 0.5) * world.voxelSize;
  const maxX = (originX + width - 0.5) * world.voxelSize;
  const minZ = (originZ - 0.5) * world.voxelSize;
  const maxZ = (originZ + depth - 0.5) * world.voxelSize;
  const centerX = (minX + maxX) / 2;
  const centerZ = (minZ + maxZ) / 2;
  return {
    minX: Math.max(minX, centerX - 32),
    maxX: Math.min(maxX, centerX + 32),
    minZ: Math.max(minZ, centerZ - 32),
    maxZ: Math.min(maxZ, centerZ + 32),
  };
}

export function nextSceneScatterId(groups: readonly Pick<SceneScatter, 'id'>[]) {
  const used = new Set(groups.map((group) => group.id));
  for (let index = 1; ; index++) {
    const id = `scatter-${index}`;
    if (!used.has(id)) return id;
  }
}

const numberText = (value: number) => String(value);
const numericValue = (value: string) => (value.trim() === '' ? null : Number(value));
const validNumber = (value: string, min: number, max: number) => {
  const parsed = numericValue(value);
  return parsed !== null && Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null;
};
const validInteger = (value: string, min: number, max: number) => {
  const parsed = validNumber(value, min, max);
  return parsed !== null && Number.isInteger(parsed) ? parsed : null;
};

export function SceneScatterEditor({
  assets,
  scene,
  world,
  busy,
  onCreate,
  onDelete,
}: {
  assets: readonly Asset[];
  scene: GameScene;
  world: WorldDocument | null;
  busy: boolean;
  onCreate: (input: SceneScatterCreateInput) => void | Promise<void>;
  onDelete: (id: string) => void | Promise<void>;
}) {
  const scatterableAssets = assets.filter(isScatterableAsset);
  const groups = scene.scatterGroups ?? [];
  const [assetId, setAssetId] = useState(scatterableAssets[0]?.id ?? '');
  const [seed, setSeed] = useState(numberText(world?.seed ?? 1));
  const [count, setCount] = useState('100');
  const [bounds, setBounds] = useState(() => defaultSceneScatterBounds(scene, world));
  const [snapToTerrain, setSnapToTerrain] = useState(!!world);
  const [groundY, setGroundY] = useState('0');
  const [minScale, setMinScale] = useState('0.8');
  const [maxScale, setMaxScale] = useState('1.2');
  const [randomYaw, setRandomYaw] = useState(true);
  const worldSignature = JSON.stringify([
    scene.id,
    scene.bounds,
    world?.id,
    world?.seed,
    world?.voxelSize,
    world?.generator.origin,
    world?.generator.size,
  ]);

  useEffect(() => {
    setSeed(numberText(world?.seed ?? 1));
    setBounds(defaultSceneScatterBounds(scene, world));
    setSnapToTerrain(!!world);
  }, [worldSignature]);
  useEffect(() => {
    if (!scatterableAssets.some((asset) => asset.id === assetId)) setAssetId(scatterableAssets[0]?.id ?? '');
  }, [assets, assetId]);

  const parsedCount = validInteger(count, 1, 1000);
  const parsedSeed = validInteger(seed, -2_147_483_648, 2_147_483_647);
  const parsedGroundY = numericValue(groundY);
  const parsedMinScale = validNumber(minScale, Number.MIN_VALUE, 100);
  const parsedMaxScale = validNumber(maxScale, Number.MIN_VALUE, 100);
  const parsedBounds = {
    minX: Number.isFinite(bounds.minX) ? bounds.minX : null,
    maxX: Number.isFinite(bounds.maxX) ? bounds.maxX : null,
    minZ: Number.isFinite(bounds.minZ) ? bounds.minZ : null,
    maxZ: Number.isFinite(bounds.maxZ) ? bounds.maxZ : null,
  };
  const canCreate =
    !!scatterableAssets.find((asset) => asset.id === assetId) &&
    parsedCount !== null &&
    parsedSeed !== null &&
    parsedGroundY !== null &&
    Number.isFinite(parsedGroundY) &&
    parsedMinScale !== null &&
    parsedMaxScale !== null &&
    parsedMinScale <= parsedMaxScale &&
    parsedBounds.minX !== null &&
    parsedBounds.maxX !== null &&
    parsedBounds.minZ !== null &&
    parsedBounds.maxZ !== null &&
    parsedBounds.minX < parsedBounds.maxX &&
    parsedBounds.minZ < parsedBounds.maxZ;

  const setBound = (key: keyof SceneScatterBounds, value: string) => {
    const parsed = numericValue(value);
    setBounds((current) => ({ ...current, [key]: parsed ?? Number.NaN }));
  };

  return (
    <section className="studio-component scene-scatter-editor" aria-label="Scene scatter">
      <div className="scene-scatter-editor__header">
        <strong>Seeded scene scatter</strong>
        <small>Place repeatable asset groups inside horizontal bounds.</small>
      </div>
      <div className="studio-two">
        <label className="studio-field">
          Scatter asset
          <select
            value={assetId}
            disabled={busy || scatterableAssets.length === 0}
            onChange={(event) => setAssetId(event.target.value)}
          >
            {scatterableAssets.length ? (
              scatterableAssets.map((asset) => (
                <option key={asset.id} value={asset.id}>
                  {asset.name} · {asset.id}
                </option>
              ))
            ) : (
              <option value="">No scatter-ready assets available</option>
            )}
          </select>
        </label>
        {scatterableAssets.length === 0 && (
          <small>
            Scatter uses static opaque voxel assets with 1–
            {SCATTER_ASSET_MAX_VOXELS.toLocaleString()} voxels.
          </small>
        )}
        <label className="studio-field">
          Instance count
          <input
            type="number"
            min={1}
            max={1000}
            step={1}
            value={count}
            disabled={busy}
            onChange={(event) => setCount(event.target.value)}
          />
        </label>
        <label className="studio-field">
          Seed
          <input
            type="number"
            min={-2_147_483_648}
            max={2_147_483_647}
            step={1}
            value={seed}
            disabled={busy}
            onChange={(event) => setSeed(event.target.value)}
          />
        </label>
        <label className="studio-field">
          Minimum scale
          <input
            type="number"
            min={Number.MIN_VALUE}
            max={100}
            step="any"
            value={minScale}
            disabled={busy}
            onChange={(event) => setMinScale(event.target.value)}
          />
        </label>
        <label className="studio-field">
          Maximum scale
          <input
            type="number"
            min={Number.MIN_VALUE}
            max={100}
            step="any"
            value={maxScale}
            disabled={busy}
            onChange={(event) => setMaxScale(event.target.value)}
          />
        </label>
      </div>
      <fieldset className="studio-component" disabled={busy}>
        <legend>Scatter bounds (m)</legend>
        <div className="studio-two">
          {(['minX', 'maxX', 'minZ', 'maxZ'] as const).map((key) => (
            <label className="studio-field" key={key}>
              {key}
              <input
                type="number"
                step="any"
                value={Number.isFinite(bounds[key]) ? bounds[key] : ''}
                onChange={(event) => setBound(key, event.target.value)}
              />
            </label>
          ))}
        </div>
      </fieldset>
      <label className="studio-check">
        <input
          type="checkbox"
          checked={snapToTerrain}
          disabled={busy || !world}
          onChange={(event) => setSnapToTerrain(event.target.checked)}
        />
        Snap to terrain
      </label>
      <label className="studio-field">
        Ground Y (m)
        <input
          type="number"
          step="any"
          value={groundY}
          disabled={busy || snapToTerrain}
          onChange={(event) => setGroundY(event.target.value)}
        />
      </label>
      <label className="studio-check">
        <input
          type="checkbox"
          checked={randomYaw}
          disabled={busy}
          onChange={(event) => setRandomYaw(event.target.checked)}
        />
        Random yaw
      </label>
      <button
        type="button"
        className="studio-primary"
        disabled={busy || !canCreate}
        onClick={() => {
          if (
            !canCreate ||
            parsedCount === null ||
            parsedSeed === null ||
            parsedGroundY === null ||
            parsedMinScale === null ||
            parsedMaxScale === null
          )
            return;
          onCreate({
            type: 'scene.scatter.create',
            sceneId: scene.id,
            id: nextSceneScatterId(groups),
            assetId,
            seed: parsedSeed,
            count: parsedCount,
            bounds: {
              minX: parsedBounds.minX!,
              maxX: parsedBounds.maxX!,
              minZ: parsedBounds.minZ!,
              maxZ: parsedBounds.maxZ!,
            },
            snapToTerrain,
            groundY: parsedGroundY,
            scaleRange: [parsedMinScale, parsedMaxScale],
            randomYaw,
          });
        }}
      >
        Create scatter group
      </button>
      <section className="scene-scatter-editor__groups" aria-label="Existing scatter groups">
        <strong>Existing groups</strong>
        {groups.length ? (
          groups.map((group) => (
            <article className="studio-catalog-card scene-scatter-editor__group" key={group.id}>
              <div className="scene-scatter-editor__group-info">
                <strong>{assets.find((asset) => asset.id === group.assetId)?.name ?? group.assetId}</strong>
                <small>
                  {group.count} seeded placements · seed {group.seed} · scale {group.scaleRange[0]}–
                  {group.scaleRange[1]}
                </small>
                <small>Group ID: {group.id}</small>
              </div>
              <button
                type="button"
                aria-label={`Delete scatter group ${group.id}`}
                disabled={busy}
                onClick={() => void onDelete(group.id)}
              >
                Delete
              </button>
            </article>
          ))
        ) : (
          <small>No scatter groups in this scene.</small>
        )}
      </section>
    </section>
  );
}
