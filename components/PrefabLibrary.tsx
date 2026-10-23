import React from 'react';
import type { Prefab, SceneNode } from '../services/projectDocument';

type Props = {
  prefabs: Prefab[];
  selectedNode: SceneNode | null;
  linkedInstance: { prefab: Prefab; rootId: string } | null;
  disabled: boolean;
  busy: boolean;
  search: string;
  onSave: () => void;
  onUpdateSource: (prefab: Prefab, rootId: string) => void;
  onResetInstance: (prefab: Prefab, rootId: string) => void;
  onPlace: (prefab: Prefab) => void;
  onDelete: (prefab: Prefab) => void;
};

export default function PrefabLibrary({
  prefabs,
  selectedNode,
  linkedInstance,
  disabled,
  busy,
  search,
  onSave,
  onUpdateSource,
  onResetInstance,
  onPlace,
  onDelete,
}: Props) {
  return (
    <details className="studio-prefab-library">
      <summary>Reusable prefabs · {prefabs.length}</summary>
      <button disabled={disabled || busy || !selectedNode} onClick={onSave}>
        Save selected object and children
      </button>
      {linkedInstance && (
        <div>
          <small>
            Edits on this instance stay local. Updating the source shares them; other changed fields remain
            overrides.
          </small>
          <button
            disabled={disabled || busy}
            onClick={() => onUpdateSource(linkedInstance.prefab, linkedInstance.rootId)}
          >
            Update {linkedInstance.prefab.name} from this instance
          </button>
          <button
            disabled={disabled || busy}
            onClick={() => onResetInstance(linkedInstance.prefab, linkedInstance.rootId)}
          >
            Reset instance overrides
          </button>
        </div>
      )}
      {prefabs
        .filter((prefab) => prefab.name.toLowerCase().includes(search.toLowerCase()))
        .map((prefab) => (
          <div className="studio-prefab-row" key={prefab.id}>
            <span>
              <strong>{prefab.name}</strong>
              <small>{prefab.nodes.length} scene objects</small>
            </span>
            <button
              aria-label={`Place copy of ${prefab.name}`}
              disabled={disabled || busy}
              onClick={() => onPlace(prefab)}
            >
              Place copy
            </button>
            <button
              aria-label={`Delete prefab ${prefab.name}`}
              title="Delete prefab"
              disabled={disabled || busy}
              onClick={() => onDelete(prefab)}
            >
              ×
            </button>
          </div>
        ))}
      {!prefabs.length && <small>Save a selected hierarchy subtree for reuse.</small>}
    </details>
  );
}
