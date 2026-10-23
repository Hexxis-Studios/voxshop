import { useEffect, useRef, useState } from 'react';
import {
  identityTransform,
  type Component,
  type ProjectDocument,
  type SceneNode,
} from '../services/projectDocument';
import { fitAssetToBounds } from '../services/assetAssembly';
import { addComponent, availableComponentTypes } from './componentAuthoring';
import { ConstructionEditor } from './ConstructionEditor';
import { RigEditor } from './RigEditor';
import { RuleEditor } from './RuleEditor';
import { NumberField, TextField, VectorField } from './InspectorFields';
import { PlayerControlsEditor } from './PlayerControlsEditor';
import { resolvePlayerControls } from '../services/playerControls';

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
    [type, setType] = useState<Component['type']>('collider');
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
  const scene = project.scenes.find((s) => s.id === project.activeSceneId)!;
  const jointTargets = scene.nodes.filter(
    (candidate) =>
      candidate.id !== draft.id && candidate.components.some((component) => component.type === 'rigid-body'),
  );
  const behaviorTypes = availableComponentTypes(
    components,
    components.some((component) => component.type === 'player'),
    jointTargets.length > 0,
  );
  const nextBehavior = behaviorTypes.includes(type) ? type : (behaviorTypes[0] ?? '');
  const update = (i: number, patch: any) =>
    change({ ...draft, components: components.map((c, n) => (n === i ? { ...c, ...patch } : c)) });
  const available = project.assets.filter(
    (a) => a.id !== draft.assetId && (!a.equipment || a.equipment.bodyAssetId === draft.assetId),
  );
  const body = project.assets.find((a) => a.id === draft.assetId);
  const animationMarkers = [
    ...new Set(body?.rig?.clips.flatMap((clip) => clip.events.map((event) => event.name)) ?? []),
  ];
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
            <strong>{c.type === 'rigid-body' ? 'Rigid body' : c.type}</strong>
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
                Camera style
                <select value={c.style} onChange={(e) => update(i, { style: e.target.value })}>
                  <option value="first-person">First person</option>
                  <option value="third-person">Third person</option>
                  <option value="top-down">Top down</option>
                </select>
              </label>
              {c.style === 'first-person' && (
                <NumberField
                  label="Eye height"
                  value={c.cameraHeight ?? 1.6}
                  min={0.25}
                  max={10}
                  onChange={(value) => update(i, { cameraHeight: value })}
                />
              )}
              <NumberField label="Move speed" value={c.speed} onChange={(v) => update(i, { speed: v })} />
              <NumberField
                label="Sprint multiplier"
                value={c.sprintMultiplier ?? 1.6}
                min={1}
                max={4}
                onChange={(v) => update(i, { sprintMultiplier: v })}
              />
              <NumberField label="Jump strength" value={c.jump} onChange={(v) => update(i, { jump: v })} />
              <NumberField
                label="Gravity"
                value={c.gravity ?? 18}
                min={0}
                max={100}
                onChange={(v) => update(i, { gravity: v })}
              />
              <NumberField
                label="Terminal fall speed"
                value={c.terminalVelocity ?? 50}
                min={0.1}
                max={200}
                onChange={(v) => update(i, { terminalVelocity: v })}
              />
              <NumberField
                label="Coyote time (seconds)"
                value={c.coyoteTime ?? 0}
                min={0}
                max={0.5}
                onChange={(v) => update(i, { coyoteTime: v })}
              />
              <NumberField
                label="Jump buffer (seconds)"
                value={c.jumpBuffer ?? 0}
                min={0}
                max={0.5}
                onChange={(v) => update(i, { jumpBuffer: v })}
              />
              <NumberField
                label="Step height"
                value={c.stepHeight ?? 0}
                min={0}
                max={5}
                onChange={(v) => update(i, { stepHeight: v })}
              />
              {components.some(
                (component) =>
                  component.type === 'collider' && !!component.shape && component.solid && !component.sensor,
              ) && (
                <>
                  <NumberField
                    label="Maximum climb slope (degrees)"
                    value={c.maxSlopeAngle ?? 45}
                    min={0}
                    max={89}
                    onChange={(v) => update(i, { maxSlopeAngle: v })}
                  />
                  <small>Explicit-shape movement uses Rapier's swept-shape collision queries.</small>
                </>
              )}
              <PlayerControlsEditor
                controls={resolvePlayerControls(c.controls)}
                onChange={(controls) => update(i, { controls })}
              />
            </>
          )}
          {c.type === 'inventory' && (
            <>
              <NumberField
                label="Inventory slots"
                value={c.slots}
                min={1}
                max={128}
                onChange={(v) => update(i, { slots: v })}
              />
              <small>Items stack up to each scene item's authored maximum.</small>
            </>
          )}
          {c.type === 'construction' && (
            <ConstructionEditor construction={c} items={scene.items} onChange={(patch) => update(i, patch)} />
          )}
          {c.type === 'collider' && (
            <>
              <label className="studio-field">
                Collider shape
                <select value={c.shape ?? 'box'} onChange={(e) => update(i, { shape: e.target.value })}>
                  <option value="box">Box</option>
                  <option value="sphere">Sphere</option>
                  <option value="capsule">Capsule</option>
                </select>
              </label>
              <label className="studio-check">
                <input
                  type="checkbox"
                  checked={c.solid}
                  onChange={(e) => {
                    const checked = e.target.checked,
                      hasRigidBody = components.some((component) => component.type === 'rigid-body');
                    update(i, {
                      solid: checked,
                      ...(checked || hasRigidBody ? { sensor: !checked } : {}),
                    });
                  }}
                />
                Solid collision
              </label>
              <label className="studio-check">
                <input
                  type="checkbox"
                  checked={c.sensor ?? false}
                  onChange={(e) => {
                    const hasRigidBody = components.some((component) => component.type === 'rigid-body');
                    update(i, {
                      sensor: e.target.checked,
                      ...(e.target.checked ? { solid: false } : hasRigidBody ? { solid: true } : {}),
                    });
                  }}
                />
                Trigger sensor
              </label>
              <small>
                Solid colliders block movement. Sensors report overlap without blocking; sensor rigid bodies
                move under physics.
              </small>
              <VectorField
                label="Collider size (m)"
                value={c.size}
                onChange={(v) => update(i, { size: v })}
              />
              <small>Box dimensions or requested dimensions for the selected shape.</small>
              <VectorField
                label="Collider offset (m)"
                value={c.offset}
                onChange={(v) => update(i, { offset: v })}
              />
              <NumberField
                label="Friction"
                value={c.friction ?? 0.5}
                min={0}
                max={10}
                onChange={(v) => update(i, { friction: v })}
              />
              <NumberField
                label="Collider restitution"
                value={c.restitution ?? 0}
                min={0}
                max={1}
                onChange={(v) => update(i, { restitution: v })}
              />
            </>
          )}
          {c.type === 'interactable' && (
            <>
              <TextField
                label="Interaction prompt"
                value={c.prompt}
                maxLength={160}
                onChange={(v) => update(i, { prompt: v })}
              />
              <NumberField
                label="Interaction range · meters"
                value={c.range}
                min={0.001}
                max={100}
                onChange={(v) => update(i, { range: v })}
              />
              <label className="studio-check">
                <input
                  type="checkbox"
                  checked={c.requiresLineOfSight ?? false}
                  onChange={(e) => update(i, { requiresLineOfSight: e.target.checked })}
                />
                Requires line of sight
              </label>
              <small>
                A solid collider or terrain blocks this target when enabled. Add an Interact rule to define
                what E does.
              </small>
            </>
          )}
          {c.type === 'rigid-body' && (
            <>
              <label className="studio-field">
                Body type
                <select
                  value={c.bodyType ?? 'dynamic'}
                  onChange={(e) => update(i, { bodyType: e.target.value })}
                >
                  <option value="dynamic">Dynamic</option>
                  <option value="fixed">Fixed</option>
                  <option value="kinematic-position">Kinematic position</option>
                  <option value="kinematic-velocity">Kinematic velocity</option>
                </select>
              </label>
              <NumberField
                label="Mass (kg)"
                value={c.mass ?? 1}
                min={0.000001}
                max={1000000}
                onChange={(v) => update(i, { mass: v })}
              />
              <NumberField
                label="Gravity (m/s²)"
                value={c.gravity}
                min={0}
                max={100}
                onChange={(v) => update(i, { gravity: v })}
              />
              <NumberField
                label="Linear damping (1/s)"
                value={c.linearDamping}
                min={0}
                max={20}
                onChange={(v) => update(i, { linearDamping: v })}
              />
              <NumberField
                label="Restitution"
                value={c.restitution}
                min={0}
                max={1}
                onChange={(v) => update(i, { restitution: v })}
              />
              <NumberField
                label="Angular damping (1/s)"
                value={c.angularDamping ?? 0.1}
                min={0}
                max={20}
                onChange={(v) => update(i, { angularDamping: v })}
              />
              <VectorField
                label="Starting velocity (m/s)"
                value={c.velocity}
                min={-100}
                max={100}
                onChange={(v) => update(i, { velocity: v })}
              />
              <VectorField
                label="Starting angular velocity (rad/s)"
                value={c.angularVelocity ?? [0, 0, 0]}
                min={-100}
                max={100}
                onChange={(v) => update(i, { angularVelocity: v })}
              />
              <label className="studio-check">
                <input
                  type="checkbox"
                  checked={c.ccd ?? false}
                  onChange={(e) => update(i, { ccd: e.target.checked })}
                />
                Continuous collision detection
              </label>
              <label className="studio-check">
                <input
                  type="checkbox"
                  checked={c.canSleep ?? true}
                  onChange={(e) => update(i, { canSleep: e.target.checked })}
                />
                Allow sleep
              </label>
              <label className="studio-check">
                <input
                  type="checkbox"
                  checked={c.lockRotation ?? false}
                  onChange={(e) => update(i, { lockRotation: e.target.checked })}
                />
                Lock rotation
              </label>
            </>
          )}
          {c.type === 'joint' && (
            <>
              <label className="studio-field">
                Connected body
                <select
                  value={c.connectedNodeId}
                  onChange={(event) => update(i, { connectedNodeId: event.target.value })}
                >
                  {jointTargets.map((target) => (
                    <option key={target.id} value={target.id}>
                      {target.name} · {target.id}
                    </option>
                  ))}
                </select>
              </label>
              <label className="studio-field">
                Joint type
                <select
                  value={c.jointType}
                  onChange={(event) =>
                    update(i, {
                      jointType: event.target.value,
                      ...(event.target.value === 'fixed' ? { limits: undefined } : {}),
                    })
                  }
                >
                  <option value="fixed">Fixed</option>
                  <option value="revolute">Hinge</option>
                  <option value="prismatic">Slider</option>
                </select>
              </label>
              <VectorField
                label="This body anchor · meters"
                value={c.anchorSelf}
                onChange={(value) => update(i, { anchorSelf: value })}
              />
              <VectorField
                label="Connected body anchor · meters"
                value={c.anchorOther}
                onChange={(value) => update(i, { anchorOther: value })}
              />
              {c.jointType !== 'fixed' && (
                <>
                  <VectorField
                    label="Local joint axis"
                    value={c.axis}
                    onChange={(value) => update(i, { axis: value })}
                  />
                  <label className="studio-check">
                    <input
                      type="checkbox"
                      checked={!!c.limits}
                      onChange={(event) =>
                        update(i, {
                          limits: event.target.checked
                            ? c.jointType === 'revolute'
                              ? [-Math.PI / 2, Math.PI / 2]
                              : [-1, 1]
                            : undefined,
                        })
                      }
                    />
                    Enable motion limits
                  </label>
                  {c.limits && (
                    <div className="studio-two">
                      <NumberField
                        label={
                          c.jointType === 'revolute' ? 'Minimum angle · radians' : 'Minimum travel · meters'
                        }
                        value={c.limits[0]}
                        onChange={(value) => update(i, { limits: [value, c.limits![1]] })}
                      />
                      <NumberField
                        label={
                          c.jointType === 'revolute' ? 'Maximum angle · radians' : 'Maximum travel · meters'
                        }
                        value={c.limits[1]}
                        onChange={(value) => update(i, { limits: [c.limits![0], value] })}
                      />
                    </div>
                  )}
                </>
              )}
              <small>
                Both connected objects need rigid bodies with colliders. Anchors are local to each body.
              </small>
            </>
          )}
          {c.type === 'collectible' && (
            <>
              <label className="studio-field">
                Collected item
                <select
                  value={c.itemId ?? ''}
                  onChange={(e) => update(i, { itemId: e.target.value || undefined })}
                >
                  <option value="">Legacy score variable</option>
                  {scene.items.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name} · {item.id}
                    </option>
                  ))}
                </select>
              </label>
              {c.itemId ? (
                <NumberField
                  label="Pickup quantity"
                  value={c.quantity}
                  min={1}
                  max={9999}
                  onChange={(v) => update(i, { quantity: v })}
                />
              ) : (
                <>
                  <TextField
                    label="Score variable"
                    value={c.variable}
                    onChange={(v) => update(i, { variable: v })}
                  />
                  <NumberField label="Amount" value={c.amount} onChange={(v) => update(i, { amount: v })} />
                </>
              )}
              <small>
                Pickup items are defined in scene data. Legacy score collection remains supported.
              </small>
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
          {c.type === 'combat' && (
            <>
              <NumberField
                label="Attack damage"
                value={c.damage}
                min={0.01}
                max={10000}
                onChange={(v) => update(i, { damage: v })}
              />
              <NumberField
                label="Attack range"
                value={c.range}
                min={0.01}
                max={100}
                onChange={(v) => update(i, { range: v })}
              />
              <NumberField
                label="Attack cooldown (seconds)"
                value={c.cooldown}
                min={0}
                max={60}
                onChange={(v) => update(i, { cooldown: v })}
              />
              <small>Attack input damages each enabled enemy within range.</small>
            </>
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
              <TextField
                label="Run clip (optional)"
                value={c.running ?? ''}
                onChange={(v) => update(i, { running: v || undefined })}
              />
              <TextField
                label="Jump clip (optional)"
                value={c.jumping ?? ''}
                onChange={(v) => update(i, { jumping: v || undefined })}
              />
              <TextField
                label="Attack clip (optional)"
                value={c.attacking ?? ''}
                onChange={(v) => update(i, { attacking: v || undefined })}
              />
              <small>Jump and attack clips play once, then return to idle or movement.</small>
            </>
          )}
          {c.type === 'rules' && (
            <RuleEditor
              rules={c.rules}
              markers={animationMarkers}
              recipes={scene.recipes}
              items={scene.items}
              nodes={scene.nodes}
              scenes={project.scenes}
              prefabs={project.prefabs}
              audioClips={project.audioClips}
              sceneId={scene.id}
              onChange={(rules) => update(i, { rules })}
            />
          )}
          {c.type === 'patrol' && <p>{c.points.length} patrol points. Edit them under Advanced behaviors.</p>}
        </section>
      ))}
      <div className="studio-add-row">
        <select
          aria-label="Behavior to add"
          value={nextBehavior}
          onChange={(e) => setType(e.target.value as Component['type'])}
        >
          {behaviorTypes.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => {
            if (nextBehavior)
              change({
                ...draft,
                components: addComponent(
                  components,
                  nextBehavior,
                  nextBehavior === 'joint' ? jointTargets[0]?.id : undefined,
                ),
              });
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
      {draft.attachments.map((a, i) => {
        const attachedAsset = project.assets.find((item) => item.id === a.assetId),
          socket = body?.rig?.sockets.find((entry) => entry.name === a.socket);
        return (
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
            {socket?.fitBounds && attachedAsset ? (
              <>
                <button
                  type="button"
                  onClick={() => {
                    try {
                      const fit = fitAssetToBounds(attachedAsset!, socket.fitBounds!, a.transform.rotation);
                      change({
                        ...draft,
                        attachments: draft.attachments.map((item, n) =>
                          n === i ? { ...item, transform: { ...item.transform, ...fit } } : item,
                        ),
                      });
                      setError('');
                    } catch (cause) {
                      setError((cause as Error).message);
                    }
                  }}
                >
                  Auto-fit to socket bounds
                </button>
                {attachedAsset.rig && (
                  <small>
                    Fits the rigged asset in its rest pose; its own weights and rig are preserved.
                  </small>
                )}
              </>
            ) : (
              <small>Set fit bounds on this socket in the Rig Editor to enable auto-fit.</small>
            )}
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
              min={-100000}
              max={100000}
              onChange={(position) =>
                change({
                  ...draft,
                  attachments: draft.attachments.map((item, n) =>
                    n === i ? { ...item, transform: { ...item.transform, position } } : item,
                  ),
                })
              }
            />
            <VectorField
              label="Equipment rotation · radians"
              value={a.transform.rotation}
              onChange={(rotation) =>
                change({
                  ...draft,
                  attachments: draft.attachments.map((item, n) =>
                    n === i ? { ...item, transform: { ...item.transform, rotation } } : item,
                  ),
                })
              }
            />
            <VectorField
              label="Equipment scale · multiplier"
              value={a.transform.scale}
              min={0.001}
              max={1000}
              onChange={(scale) =>
                change({
                  ...draft,
                  attachments: draft.attachments.map((item, n) =>
                    n === i ? { ...item, transform: { ...item.transform, scale } } : item,
                  ),
                })
              }
            />
          </section>
        );
      })}
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
