import { useEffect, useMemo, useRef, useState } from 'react';
import { type Asset, type ProjectDocument, validateProject } from '../services/projectDocument';
import { localApi } from '../services/localApi';
import { RigEditor } from './RigEditor';
import { DraftRecovery, NumberField, VectorField } from './InspectorFields';

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
    [rig, setRig] = useState(JSON.stringify(asset.rig, null, 2)),
    [dirty, setDirty] = useState(false),
    [error, setError] = useState('');
  const base = useRef(project.revision),
    id = useRef(asset.id);
  const rigTextHasEdits = rig !== JSON.stringify(draft.rig, null, 2),
    hasLocalEdits = dirty || rigTextHasEdits,
    draftConflict = hasLocalEdits && project.revision !== base.current;
  const gridSize = useMemo(() => {
    if (!draft.model.voxels.length) return [0, 0, 0];
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const voxel of draft.model.voxels) {
      const position = [voxel.x, voxel.y, voxel.z];
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis], position[axis]);
        max[axis] = Math.max(max[axis], position[axis]);
      }
    }
    return max.map((value, axis) => value - min[axis] + 1);
  }, [draft.model.voxels]);
  useEffect(() => {
    if (id.current !== asset.id || !hasLocalEdits) {
      id.current = asset.id;
      setDraft(asset);
      setRig(JSON.stringify(asset.rig, null, 2));
      base.current = project.revision;
      setDirty(false);
      setError('');
    }
  }, [asset, project.revision, hasLocalEdits]);
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
    if (a.rig !== draft.rig) setRig(JSON.stringify(a.rig, null, 2));
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
          try {
            const checked = validateProject({
              ...project,
              assets: project.assets.map((item) => (item.id === draft.id ? draft : item)),
            });
            const p = await onApply(
              checked.assets.find((item) => item.id === draft.id)!,
              base.current,
            );
            if (p) {
              setDirty(false);
              base.current = p.revision;
            }
          } catch (cause) {
            setError((cause as Error).message);
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
        <p>
          Changes physical size while keeping this model's voxel layout. Terrain worlds use their own cell
          size.
        </p>
        <VectorField
          label="Pivot · voxel coordinates"
          value={draft.pivot}
          onChange={(v) => change({ ...draft, pivot: v })}
        />
        <dl>
          <dt>Geometry</dt>
          <dd>{draft.model.voxels.length.toLocaleString()} voxels</dd>
          <dt>Grid size (W × H × D)</dt>
          <dd>{gridSize.map((size) => (size * draft.voxelSize).toFixed(2)).join(' × ')} m</dd>
          <dt>Source</dt>
          <dd>{asset.source.kind}</dd>
          <dt>Rig</dt>
          <dd>{asset.rig ? `${asset.rig.profile} · ${asset.rig.joints.length} joints` : 'Unrigged'}</dd>
          <dt>Clips</dt>
          <dd>{asset.rig?.clips.map((c) => c.name).join(', ') || 'None'}</dd>
        </dl>
        <details>
          <summary>Rig authoring · joints, sockets & animation</summary>
          <RigEditor asset={draft} project={project} json={rig} onJsonChange={setRig} onChange={change} />
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
        {draftConflict && (
          <DraftRecovery
            kind="asset"
            baseRevision={base.current}
            currentRevision={project.revision}
            draft={{ asset: draft, rigText: rig }}
            onReload={() => {
              setDraft(asset);
              setRig(JSON.stringify(asset.rig, null, 2));
              base.current = project.revision;
              setDirty(false);
              setError('');
            }}
          />
        )}
        <button disabled={!dirty || draftConflict} className="studio-primary">
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
