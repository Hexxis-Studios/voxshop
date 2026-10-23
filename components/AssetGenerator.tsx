import React, { useEffect, useRef, useState } from 'react';
import type { ProjectOperation } from '../services/projectDocument';
const uid = () => crypto.randomUUID();
const familyNames: Record<string, string> = {
  quadruped: 'New creature',
  biped: 'New character',
  machine: 'New machine',
  box: 'New box',
  ellipsoid: 'New ellipsoid',
  cylinder: 'New cylinder',
  ramp: 'New ramp',
  terrain: 'New terrain',
  custom: 'New asset',
};
export const DEFAULT_CUSTOM_RECIPE = JSON.stringify({
  version: 1,
  shapes: [{ kind: 'box', center: [0, 5, 0], size: [10, 10, 10], color: 14493255 }],
});
export default function AssetGenerator({
  onClose,
  onGenerate,
}: {
  onClose: () => void;
  onGenerate: (o: ProjectOperation[], assetId: string) => Promise<void>;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    [name, setName] = useState('New creature'),
    [family, setFamily] = useState('quadruped'),
    [color, setColor] = useState('#d88747'),
    [detail, setDetail] = useState(24),
    [width, setWidth] = useState(10),
    [depth, setDepth] = useState(24),
    [voxelSize, setVoxelSize] = useState(0.1),
    [seed, setSeed] = useState(1),
    [noise, setNoise] = useState(0.25),
    [terrainPalette, setTerrainPalette] = useState(true),
    [surfaceColor, setSurfaceColor] = useState('#5aaa5a'),
    [subsurfaceColor, setSubsurfaceColor] = useState('#7b5c3a'),
    [deepColor, setDeepColor] = useState('#686b70'),
    [surfaceDepth, setSurfaceDepth] = useState(3),
    [subsurfaceDepth, setSubsurfaceDepth] = useState(4),
    [text, setText] = useState(DEFAULT_CUSTOM_RECIPE),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const character = ['biped', 'quadruped', 'machine'].includes(family);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="studio-dialog studio-generator-dialog"
      aria-labelledby="generator-title"
      onCancel={onClose}
    >
      <form
        className="studio-generator-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            const id = uid(),
              rgb = parseInt(color.slice(1), 16);
            let op: ProjectOperation;
            if (character)
              op = {
                type: 'asset.character',
                id,
                name,
                profile: family as 'biped' | 'quadruped' | 'machine',
                height: detail,
                width,
                color: rgb,
                voxelSize,
              };
            else {
              const recipe =
                family === 'custom'
                  ? JSON.parse(text)
                  : {
                      version: 1,
                      seed,
                      shapes: [
                        {
                          kind: family,
                          center: [0, detail / 2, 0],
                          size: [width, detail, depth],
                          color: rgb,
                          noise,
                          ...(family === 'terrain' &&
                            terrainPalette && {
                              palette: {
                                surface: parseInt(surfaceColor.slice(1), 16),
                                subsurface: parseInt(subsurfaceColor.slice(1), 16),
                                deep: parseInt(deepColor.slice(1), 16),
                                surfaceDepth,
                                subsurfaceDepth,
                              },
                            }),
                        },
                      ],
                    };
              op = { type: 'asset.generate', id, name, recipe, voxelSize };
            }
            await onGenerate([op], id);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="studio-generator-content">
          <span className="studio-eyebrow">ORIGINAL · EDITABLE · PROCEDURAL</span>
          <h2 id="generator-title">Generate an asset</h2>
          <p>
            {family === 'terrain'
              ? 'Seeded hills with editable color layers.'
              : 'Start with a family or compose your own recipe. Every voxel stays editable.'}
          </p>
          <label className="studio-field">
            Name
            <input required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="studio-field">
            Generator
            <select
              aria-label="Generator"
              value={family}
              onChange={(e) => {
                const next = e.target.value;
                if (name === familyNames[family]) setName(familyNames[next]);
                setFamily(next);
                const rig = ['biped', 'quadruped', 'machine'].includes(next);
                setWidth(rig ? 10 : next === 'terrain' ? 64 : 24);
                setDepth(next === 'terrain' ? 64 : 24);
                setDetail(next === 'terrain' ? 12 : 24);
                setVoxelSize(next === 'terrain' ? 0.5 : 0.1);
              }}
            >
              <option value="quadruped">Creature · quadruped rig</option>
              <option value="biped">Character · biped rig</option>
              <option value="machine">Machine · articulated rig</option>
              <option value="box">Prop · box</option>
              <option value="ellipsoid">Prop · ellipsoid</option>
              <option value="cylinder">Prop · cylinder</option>
              <option value="ramp">Prop · ramp</option>
              <option value="terrain">Terrain · seeded hills</option>
              <option value="custom">Custom shape recipe</option>
            </select>
          </label>
          <label className="studio-field">
            Asset voxel edge length · meters
            <input
              type="number"
              required
              min={0.001}
              max={100}
              step={0.001}
              value={voxelSize}
              onChange={(e) => setVoxelSize(Number(e.target.value))}
            />
            <small>
              This sets each asset’s physical voxel size; terrain uses a separate cell size. Changing this
              does not change the model’s voxel count.
            </small>
          </label>
          {family !== 'custom' && (
            <>
              <div className={family === 'terrain' && terrainPalette ? undefined : 'studio-two'}>
                {(family !== 'terrain' || !terrainPalette) && (
                  <label className="studio-field">
                    Color
                    <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
                  </label>
                )}
                <label className="studio-field">
                  Height (voxels)
                  <input
                    type="number"
                    required
                    min={character ? 12 : 1}
                    max={character ? 80 : 128}
                    value={detail}
                    onChange={(e) => setDetail(Number(e.target.value))}
                  />
                </label>
              </div>
              <div className="studio-two">
                <label className="studio-field">
                  Width (voxels)
                  <input
                    type="number"
                    required
                    min={character ? 6 : 1}
                    max={character ? 30 : 128}
                    value={width}
                    onChange={(e) => setWidth(Number(e.target.value))}
                  />
                </label>
                {!character && (
                  <label className="studio-field">
                    Depth (voxels)
                    <input
                      type="number"
                      required
                      min={1}
                      max={128}
                      value={depth}
                      onChange={(e) => setDepth(Number(e.target.value))}
                    />
                  </label>
                )}
              </div>
              {family === 'terrain' && (
                <>
                  <div className="studio-two">
                    <label className="studio-field">
                      Seed
                      <input
                        type="number"
                        required
                        value={seed}
                        onChange={(e) => setSeed(Number(e.target.value))}
                      />
                    </label>
                    <label className="studio-field">
                      Hill variation
                      <input
                        type="number"
                        required
                        min={0}
                        max={1}
                        step={0.05}
                        value={noise}
                        onChange={(e) => setNoise(Number(e.target.value))}
                      />
                    </label>
                  </div>
                  <label className="studio-check">
                    <input
                      type="checkbox"
                      checked={terrainPalette}
                      onChange={(e) => setTerrainPalette(e.target.checked)}
                    />
                    Layered terrain colors
                  </label>
                  {terrainPalette && (
                    <div
                      style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }}
                    >
                      <label className="studio-field">
                        Surface color
                        <input
                          type="color"
                          value={surfaceColor}
                          onChange={(e) => setSurfaceColor(e.target.value)}
                        />
                      </label>
                      <label className="studio-field">
                        Soil color
                        <input
                          type="color"
                          value={subsurfaceColor}
                          onChange={(e) => setSubsurfaceColor(e.target.value)}
                        />
                      </label>
                      <label className="studio-field">
                        Deep color
                        <input
                          type="color"
                          value={deepColor}
                          onChange={(e) => setDeepColor(e.target.value)}
                        />
                      </label>
                    </div>
                  )}
                  {terrainPalette && (
                    <details>
                      <summary>Layer thickness</summary>
                      <div className="studio-two">
                        <label className="studio-field">
                          Surface (voxels)
                          <input
                            type="number"
                            required
                            min={1}
                            max={16}
                            value={surfaceDepth}
                            onChange={(e) => setSurfaceDepth(Number(e.target.value))}
                          />
                        </label>
                        <label className="studio-field">
                          Soil (voxels)
                          <input
                            type="number"
                            required
                            min={1}
                            max={32}
                            value={subsurfaceDepth}
                            onChange={(e) => setSubsurfaceDepth(Number(e.target.value))}
                          />
                        </label>
                      </div>
                    </details>
                  )}
                </>
              )}
              <p>
                {family === 'terrain'
                  ? `Terrain grid: ${(width * voxelSize).toFixed(2)} m × ${(detail * voxelSize).toFixed(2)} m × ${(depth * voxelSize).toFixed(2)} m (width × height × depth). The same seed and settings reproduce these hills.`
                  : family === 'ramp'
                    ? `Solid voxel wedge rising toward its positive X side. At this spacing, ${detail} voxels make a ${(detail * voxelSize).toFixed(2)} m tall ramp.`
                    : `At this spacing, ${detail} voxels make a ${(detail * voxelSize).toFixed(2)} m shape. ${character ? 'Rig and animation are included.' : 'Change each dimension independently; every voxel remains editable.'}`}
              </p>
            </>
          )}
          {family === 'custom' && (
            <label className="studio-field">
              Recipe JSON
              <textarea required rows={10} value={text} onChange={(e) => setText(e.target.value)} />
            </label>
          )}
          {error && (
            <p role="alert" className="studio-error">
              {error}
            </p>
          )}
        </div>
        <div className="studio-dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="studio-primary" disabled={busy}>
            {busy ? 'Generating…' : 'Generate asset'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
