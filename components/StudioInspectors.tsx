import React, { useEffect, useRef, useState } from 'react';
import {
  identityTransform,
  type Asset,
  type Component,
  type ProjectDocument,
  type SceneNode,
} from '../services/projectDocument';
import { localApi } from '../services/localApi';

export function NodeInspector({
  node,
  project,
  onApply,
  onDelete,
}: {
  node: SceneNode;
  project: ProjectDocument;
  onApply: (n: SceneNode, revision: number) => Promise<any>;
  onDelete: () => void;
}) {
  const [draft, setDraft] = useState<SceneNode>(structuredClone(node)),
    [dirty, setDirty] = useState(false),
    [advanced, setAdvanced] = useState(''),
    [error, setError] = useState(''),
    [type, setType] = useState('collider');
  const base = useRef(project.revision),
    id = useRef(node.id);
  useEffect(() => {
    if (id.current !== node.id || !dirty) {
      id.current = node.id;
      base.current = project.revision;
      setDraft(structuredClone(node));
      setAdvanced(JSON.stringify(node.components, null, 2));
      setDirty(false);
      setError('');
    }
  }, [node, project.revision]);
  const change = (next: SceneNode) => {
    setDraft(next);
    setDirty(true);
  };
  const components = draft.components;
  const behaviorTypes = [
    'player',
    'collider',
    'collectible',
    'gate',
    'health',
    'enemy',
    'animation',
    'rules',
    'patrol',
  ].filter((t) => !components.some((c) => c.type === t));
  const nextBehavior = behaviorTypes.includes(type) ? type : (behaviorTypes[0] ?? '');
  const update = (i: number, patch: any) =>
    change({ ...draft, components: components.map((c, n) => (n === i ? { ...c, ...patch } : c)) });
  const scene = project.scenes.find((s) => s.id === project.activeSceneId)!;
  const available = project.assets.filter(
    (a) => a.id !== draft.assetId && (!a.equipment || a.equipment.bodyAssetId === draft.assetId),
  );
  const body = project.assets.find((a) => a.id === draft.assetId);
  return (
    <form
      className="studio-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setError('');
        const result = await onApply(draft, base.current);
        if (result) {
          base.current = result.revision;
          setDirty(false);
        } else
          setError('The change was not applied. Your inspector edits are retained; see the workspace error.');
      }}
    >
      <label className="studio-field">
        Object name
        <input
          required
          maxLength={120}
          value={draft.name}
          onChange={(e) => change({ ...draft, name: e.target.value })}
        />
      </label>
      <code className="studio-id">{node.id}</code>
      <label className="studio-check">
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(e) => change({ ...draft, enabled: e.target.checked })}
        />
        Enabled
      </label>
      <label className="studio-field">
        Asset
        <select
          value={draft.assetId ?? ''}
          onChange={(e) => change({ ...draft, assetId: e.target.value || null, attachments: [] })}
        >
          <option value="">Empty object</option>
          {project.assets.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </label>
      <label className="studio-field">
        Parent
        <select
          value={draft.parentId ?? ''}
          onChange={(e) => change({ ...draft, parentId: e.target.value || null })}
        >
          <option value="">Scene root</option>
          {scene.nodes
            .filter((n) => n.id !== draft.id)
            .map((n) => (
              <option key={n.id} value={n.id}>
                {n.name}
              </option>
            ))}
        </select>
      </label>
      <h3>Transform</h3>
      {(['position', 'rotation', 'scale'] as const).map((channel) => (
        <fieldset className="studio-vector" key={channel}>
          <legend>
            {channel === 'rotation'
              ? 'Rotation · degrees'
              : channel === 'position'
                ? 'Position · meters'
                : 'Scale'}
          </legend>
          {['X', 'Y', 'Z'].map((axis, i) => (
            <label key={axis}>
              {axis}
              <input
                aria-label={`${channel} ${axis}`}
                type="number"
                step="any"
                min={channel === 'scale' ? 0.001 : undefined}
                value={Number(
                  (draft.transform[channel][i] * (channel === 'rotation' ? 180 / Math.PI : 1)).toFixed(4),
                )}
                onChange={(e) => {
                  const vector = [...draft.transform[channel]] as [number, number, number];
                  vector[i] = Number(e.target.value) * (channel === 'rotation' ? Math.PI / 180 : 1);
                  change({ ...draft, transform: { ...draft.transform, [channel]: vector } });
                }}
              />
            </label>
          ))}
        </fieldset>
      ))}
      <h3>Gameplay</h3>
      {components.map((c, i) => (
        <section className="studio-component" key={c.type}>
          <div>
            <strong>{c.type}</strong>
            <button
              type="button"
              aria-label={`Remove ${c.type} behavior`}
              onClick={() => change({ ...draft, components: components.filter((_, n) => n !== i) })}
            >
              ×
            </button>
          </div>
          {c.type === 'player' && (
            <>
              <label className="studio-field">
                Camera / controls
                <select value={c.style} onChange={(e) => update(i, { style: e.target.value })}>
                  <option value="third-person">Third person</option>
                  <option value="top-down">Top down</option>
                </select>
              </label>
              <NumberField label="Move speed" value={c.speed} onChange={(v) => update(i, { speed: v })} />
              <NumberField label="Jump strength" value={c.jump} onChange={(v) => update(i, { jump: v })} />
            </>
          )}
          {c.type === 'collider' && (
            <>
              <label className="studio-check">
                <input
                  type="checkbox"
                  checked={c.solid}
                  onChange={(e) => update(i, { solid: e.target.checked })}
                />
                Solid collision
              </label>
              <VectorField label="Collider size" value={c.size} onChange={(v) => update(i, { size: v })} />
              <VectorField
                label="Collider offset"
                value={c.offset}
                onChange={(v) => update(i, { offset: v })}
              />
            </>
          )}
          {c.type === 'collectible' && (
            <>
              <TextField
                label="Inventory variable"
                value={c.variable}
                onChange={(v) => update(i, { variable: v })}
              />
              <NumberField label="Amount" value={c.amount} onChange={(v) => update(i, { amount: v })} />
            </>
          )}
          {c.type === 'gate' && (
            <>
              <TextField
                label="Required variable"
                value={c.variable}
                onChange={(v) => update(i, { variable: v })}
              />
              <NumberField
                label="Required amount"
                value={c.required}
                onChange={(v) => update(i, { required: v })}
              />
            </>
          )}
          {c.type === 'health' && (
            <NumberField
              label="Maximum health"
              value={c.maximum}
              onChange={(v) => update(i, { maximum: v })}
            />
          )}
          {c.type === 'enemy' && (
            <>
              <NumberField label="Enemy speed" value={c.speed} onChange={(v) => update(i, { speed: v })} />
              <NumberField label="Hit damage" value={c.damage} onChange={(v) => update(i, { damage: v })} />
              <NumberField label="Attack range" value={c.range} onChange={(v) => update(i, { range: v })} />
            </>
          )}
          {c.type === 'animation' && (
            <>
              <TextField label="Idle clip" value={c.idle} onChange={(v) => update(i, { idle: v })} />
              <TextField label="Move clip" value={c.moving} onChange={(v) => update(i, { moving: v })} />
            </>
          )}
          {c.type === 'rules' && (
            <p>{c.rules.length} custom event rules. Edit them under Advanced behaviors.</p>
          )}
          {c.type === 'patrol' && <p>{c.points.length} patrol points. Edit them under Advanced behaviors.</p>}
        </section>
      ))}
      <div className="studio-add-row">
        <select aria-label="Behavior to add" value={nextBehavior} onChange={(e) => setType(e.target.value)}>
          {['player', 'collider', 'collectible', 'gate', 'health', 'enemy', 'animation', 'rules', 'patrol']
            .filter((t) => !components.some((c) => c.type === t))
            .map((t) => (
              <option key={t}>{t}</option>
            ))}
        </select>
        <button
          type="button"
          onClick={() => {
            const defaults: Record<string, Component> = {
              player: { type: 'player', style: 'third-person', speed: 3, jump: 6 },
              collider: { type: 'collider', size: [1, 2, 1], offset: [0, 1, 0], solid: true },
              collectible: { type: 'collectible', variable: 'score', amount: 1 },
              gate: { type: 'gate', variable: 'score', required: 5 },
              health: { type: 'health', maximum: 100 },
              enemy: { type: 'enemy', speed: 1, damage: 10, range: 1.5 },
              animation: { type: 'animation', idle: 'idle', moving: 'walk' },
              rules: {
                type: 'rules',
                apiVersion: 1,
                rules: [
                  {
                    event: 'interact',
                    interval: 1,
                    once: false,
                    actions: [{ type: 'message', text: 'Hello, creator!' }],
                  },
                ],
              },
              patrol: {
                type: 'patrol',
                points: [
                  [0, 0, 0],
                  [3, 0, 0],
                ],
                speed: 1,
              },
            };
            if (nextBehavior && !components.some((c) => c.type === nextBehavior))
              change({ ...draft, components: [...components, defaults[nextBehavior]] });
          }}
        >
          Add
        </button>
      </div>
      <details
        onToggle={(e) => {
          if (e.currentTarget.open) setAdvanced(JSON.stringify(draft.components, null, 2));
        }}
      >
        <summary>Advanced behaviors · API v1</summary>
        <p>
          Validated event/action rules and component data. Changes are bounded; JavaScript is never evaluated.
        </p>
        <textarea
          aria-label="Behavior JSON"
          rows={14}
          value={advanced}
          onChange={(e) => setAdvanced(e.target.value)}
        />
        <button
          type="button"
          onClick={() => {
            try {
              const value = JSON.parse(advanced);
              if (!Array.isArray(value)) throw new Error('Expected a component array.');
              change({ ...draft, components: value });
              setError('');
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          Use behavior JSON
        </button>
      </details>
      <h3>Equipment & attachments</h3>
      {draft.attachments.map((a, i) => (
        <section className="studio-component" key={a.slot}>
          <div>
            <strong>{project.assets.find((item) => item.id === a.assetId)?.name ?? a.assetId}</strong>
            <button
              type="button"
              aria-label={`Remove ${a.slot} equipment`}
              onClick={() => change({ ...draft, attachments: draft.attachments.filter((_, n) => n !== i) })}
            >
              ×
            </button>
          </div>
          <small>
            Slot: {a.slot} · socket: {a.socket}
          </small>
          {!project.assets.find((item) => item.id === a.assetId)?.equipment && (
            <label className="studio-field">
              Socket
              <select
                value={a.socket}
                onChange={(e) =>
                  change({
                    ...draft,
                    attachments: draft.attachments.map((item, n) =>
                      n === i ? { ...item, socket: e.target.value } : item,
                    ),
                  })
                }
              >
                {body?.rig?.sockets.map((s) => (
                  <option key={s.name} value={s.name}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <VectorField
            label="Equipment position · meters"
            value={a.transform.position}
            onChange={(position) =>
              change({
                ...draft,
                attachments: draft.attachments.map((item, n) =>
                  n === i ? { ...item, transform: { ...item.transform, position } } : item,
                ),
              })
            }
          />
        </section>
      ))}
      {body?.rig ? (
        <label className="studio-field">
          Attach an asset
          <select
            value=""
            onChange={(e) => {
              const item = project.assets.find((a) => a.id === e.target.value);
              if (!item) return;
              const fit = item.equipment;
              const socket = fit?.socket ?? body.rig!.sockets[0]?.name;
              if (!socket) {
                setError('Add a socket to the body rig first.');
                return;
              }
              const slot = fit?.kind ?? `attachment-${draft.attachments.length + 1}`;
              change({
                ...draft,
                attachments: [
                  ...draft.attachments.filter((a) => a.slot !== slot),
                  {
                    assetId: item.id,
                    socket,
                    slot,
                    transform: identityTransform(),
                    hiddenBones: fit?.hiddenBones ?? [],
                  },
                ],
              });
            }}
          >
            <option value="">Choose equipment…</option>
            {available.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p>Add a rig with named sockets to the asset to attach equipment.</p>
      )}
      {error && (
        <p className="studio-error" role="alert">
          {error}
        </p>
      )}
      {dirty && project.revision !== base.current && (
        <p className="studio-error">
          The project changed while you were editing. Applying will check revision {base.current}; reload this
          selection to use newer values.
        </p>
      )}
      <div className="studio-sticky-actions">
        <button className="studio-primary" type="submit" disabled={!dirty}>
          Apply object changes
        </button>
        <button
          type="button"
          onClick={() => {
            setDirty(false);
            base.current = project.revision;
            setDraft(structuredClone(node));
            setError('');
          }}
        >
          Reset fields
        </button>
      </div>
      <button type="button" className="studio-danger" onClick={onDelete}>
        Delete object & children
      </button>
    </form>
  );
}
export function AssetInspector({
  asset,
  project,
  onPlace,
  onSculpt,
  onApply,
  onDelete,
  onVariant,
  onFit,
}: {
  asset: Asset;
  project: ProjectDocument;
  onPlace: () => void;
  onSculpt: () => void;
  onApply: (a: Asset, revision: number) => Promise<any>;
  onDelete: () => void;
  onVariant: () => void;
  onFit: (kind: 'shell' | 'backpack' | 'blade') => void;
}) {
  const [preview, setPreview] = useState(''),
    [draft, setDraft] = useState(asset),
    [rig, setRig] = useState(''),
    [dirty, setDirty] = useState(false),
    [error, setError] = useState('');
  const base = useRef(project.revision),
    id = useRef(asset.id);
  useEffect(() => {
    if (id.current !== asset.id || !dirty) {
      id.current = asset.id;
      setDraft(asset);
      setRig(JSON.stringify(asset.rig, null, 2));
      base.current = project.revision;
      setDirty(false);
      setError('');
    }
  }, [asset, project.revision]);
  useEffect(() => {
    let disposed = false,
      url = '';
    void localApi(`/api/projects/${project.id}/assets/${asset.id}/preview`)
      .then(async (r) => {
        if (!r.ok) throw new Error(((await r.json()) as { error: string }).error);
        return r.blob();
      })
      .then((blob) => {
        url = URL.createObjectURL(blob);
        if (!disposed) setPreview(url);
        else URL.revokeObjectURL(url);
      })
      .catch((e) => {
        if (!disposed) setError(e.message);
      });
    return () => {
      disposed = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [asset, project.id]);
  const change = (a: Asset) => {
    setDraft(a);
    setDirty(true);
  };
  return (
    <div className="studio-form">
      {preview && (
        <img className="studio-preview" alt={`${asset.name} isometric voxel preview`} src={preview} />
      )}
      <div className="studio-two">
        <button className="studio-primary" onClick={onPlace}>
          Place in scene
        </button>
        <button onClick={onSculpt}>Sculpt asset</button>
      </div>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const p = await onApply(draft, base.current);
          if (p) {
            setDirty(false);
            base.current = p.revision;
          }
        }}
      >
        <label className="studio-field">
          Asset name
          <input
            required
            maxLength={120}
            value={draft.name}
            onChange={(e) => change({ ...draft, name: e.target.value })}
          />
        </label>
        <code className="studio-id">{asset.id}</code>
        <NumberField
          label="Voxel spacing · meters"
          value={draft.voxelSize}
          onChange={(v) => change({ ...draft, voxelSize: v })}
        />
        <VectorField
          label="Pivot · voxel coordinates"
          value={draft.pivot}
          onChange={(v) => change({ ...draft, pivot: v })}
        />
        <dl>
          <dt>Geometry</dt>
          <dd>{asset.model.voxels.length.toLocaleString()} voxels</dd>
          <dt>Source</dt>
          <dd>{asset.source.kind}</dd>
          <dt>Rig</dt>
          <dd>{asset.rig ? `${asset.rig.profile} · ${asset.rig.joints.length} joints` : 'Unrigged'}</dd>
          <dt>Clips</dt>
          <dd>{asset.rig?.clips.map((c) => c.name).join(', ') || 'None'}</dd>
        </dl>
        <details>
          <summary>Rig, sockets & animation</summary>
          <p>
            Positions are absolute bind positions in voxel coordinates. Socket transforms are relative to
            their joint. Up to four skin weights per voxel.
          </p>
          <textarea aria-label="Rig JSON" rows={16} value={rig} onChange={(e) => setRig(e.target.value)} />
          <button
            type="button"
            onClick={() => {
              try {
                change({ ...draft, rig: JSON.parse(rig) });
                setError('');
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            Use rig JSON
          </button>
        </details>
        {asset.recipe && (
          <details>
            <summary>Generation recipe & provenance</summary>
            <p>{asset.source.description}</p>
            <pre>{JSON.stringify(asset.recipe, null, 2)}</pre>
            <p>Create a variant before regenerating or sculpting another appearance.</p>
          </details>
        )}
        {error && (
          <p role="alert" className="studio-error">
            {error}
          </p>
        )}
        <button disabled={!dirty} className="studio-primary">
          Apply asset changes
        </button>
      </form>
      <button onClick={onVariant}>Create editable variant</button>
      {asset.rig && (
        <>
          <h3>Generate fitted equipment</h3>
          <div className="studio-two">
            <button onClick={() => onFit('shell')}>Body shell</button>
            <button onClick={() => onFit('backpack')}>Backpack</button>
            <button onClick={() => onFit('blade')}>Held blade</button>
          </div>
          <p>Equipment stays a separate asset. Attach it to a scene instance in its inspector.</p>
        </>
      )}
      <button className="studio-danger" onClick={onDelete}>
        Delete asset
      </button>
      <small>Deletion is blocked while scenes, variants or equipment still reference this asset.</small>
    </div>
  );
}
function TextField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="studio-field">
      {label}
      <input value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}
function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="studio-field">
      {label}
      <input type="number" step="any" value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}
function VectorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: [number, number, number];
  onChange: (v: [number, number, number]) => void;
}) {
  return (
    <fieldset className="studio-vector">
      <legend>{label}</legend>
      {['X', 'Y', 'Z'].map((axis, i) => (
        <label key={axis}>
          {axis}
          <input
            aria-label={`${label} ${axis}`}
            type="number"
            step="any"
            value={value[i]}
            onChange={(e) => {
              const next = [...value] as [number, number, number];
              next[i] = Number(e.target.value);
              onChange(next);
            }}
          />
        </label>
      ))}
    </fieldset>
  );
}
