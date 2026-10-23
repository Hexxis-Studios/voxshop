import React, { useState } from 'react';
import { retargetRigClip, type Asset, type ProjectDocument, type Rig } from '../services/projectDocument';
import { ANIMATION_PRESETS, addAnimationPreset, type AnimationPreset } from '../services/animationPresets';
import { RigPreview } from './RigPreview';
import {
  addRigClip,
  addRigKeyframe,
  addRigJoint,
  addRigLandmark,
  addRigMarker,
  addRigSocket,
  addRigTrack,
  animationClipUseCount,
  createCustomRig,
  jointAttachmentUseCount,
  jointRemovalBlock,
  parseRigJson,
  removeRigClip,
  removeRigKeyframe,
  removeRigMarker,
  removeRigJoint,
  removeRigLandmark,
  removeRigTrack,
  renameRigClip,
  renameRigJoint,
  rigJointEditBlock,
  socketUseCount,
  setRigJointParent,
  setRigTrackJoint,
  updateRigClipSettings,
  updateRigKeyframe,
  updateRigMarker,
  updateRigLandmark,
} from './rigAuthoring';

function motionPresetLabel(preset: AnimationPreset, profile: Rig['profile']) {
  if (profile === 'quadruped' && preset === 'attack') return 'Bite / lunge';
  if (profile === 'quadruped' && preset === 'wave') return 'Tail wag';
  return preset[0].toUpperCase() + preset.slice(1);
}

export function RigEditor({
  asset,
  project,
  json,
  onJsonChange,
  onChange,
}: {
  asset: Asset;
  project: ProjectDocument;
  json: string;
  onJsonChange: (value: string) => void;
  onChange: (asset: Asset) => void;
}) {
  const [error, setError] = useState('');
  const retargetSources = project.assets.filter(
    (candidate) => candidate.id !== asset.id && candidate.rig?.clips.length,
  );
  const [retargetSourceId, setRetargetSourceId] = useState(retargetSources[0]?.id ?? '');
  const [retargetSourceClipName, setRetargetSourceClipName] = useState('');
  const [retargetClipName, setRetargetClipName] = useState('');
  const [retargetMap, setRetargetMap] = useState<Record<string, string>>({});
  const [motionPreset, setMotionPreset] = useState<AnimationPreset>('walk');
  const [motionIntensity, setMotionIntensity] = useState(1);
  const rig = asset.rig;
  const jointEditBlock = rigJointEditBlock(project, asset);
  const retargetSource =
    retargetSources.find((candidate) => candidate.id === retargetSourceId) ?? retargetSources[0];
  const retargetSourceClip =
    retargetSource?.rig?.clips.find((clip) => clip.name === retargetSourceClipName) ??
    retargetSource?.rig?.clips[0];
  const retargetDefaultName = retargetSourceClip ? `${retargetSourceClip.name.slice(0, 52)}_copy` : '';
  const effectiveRetargetName = retargetClipName || retargetDefaultName;
  const effectiveRetargetMap = (retargetSourceClip?.tracks ?? []).flatMap((track) => {
    const targetJoint = Object.hasOwn(retargetMap, track.joint)
      ? retargetMap[track.joint]
      : rig?.joints.some((joint) => joint.name === track.joint)
        ? track.joint
        : '';
    return targetJoint ? [{ sourceJoint: track.joint, targetJoint }] : [];
  });
  const changeRig = (update: (value: Rig) => Rig) => {
    if (!rig) return;
    try {
      const next = update(rig);
      onChange({ ...asset, rig: next });
      onJsonChange(JSON.stringify(next, null, 2));
      setError('');
    } catch (cause) {
      setError((cause as Error).message);
    }
  };
  const updateJoint = (name: string, patch: Partial<Rig['joints'][number]>) =>
    changeRig((current) => ({
      ...current,
      joints: current.joints.map((joint) => (joint.name === name ? { ...joint, ...patch } : joint)),
    }));
  const updateSocket = (name: string, patch: Partial<Rig['sockets'][number]>) =>
    changeRig((current) => ({
      ...current,
      sockets: current.sockets.map((socket) => (socket.name === name ? { ...socket, ...patch } : socket)),
    }));

  return (
    <section aria-label="Rig authoring">
      <p>
        Joint positions use absolute voxel coordinates. Bind rotations are local radians; animation keys are
        deltas from that pose. Socket transforms are relative to their joint. Optional fit bounds define a
        socket-local meter-space box for preserving-shape equipment fitting.
      </p>
      {!rig ? (
        <button
          type="button"
          onClick={() => {
            const next = createCustomRig();
            onChange({ ...asset, rig: next });
            onJsonChange(JSON.stringify(next, null, 2));
          }}
        >
          Add custom rig
        </button>
      ) : (
        <>
          <RigPreview asset={asset} />
          <section className="studio-component" aria-label="Rig joints">
            <div>
              <strong>Joints</strong>
              <small>{rig.joints.length}/128</small>
            </div>
            {rig.joints.map((joint, index) => {
              const removeBlock = jointRemovalBlock(asset, joint.name, project);
              const renameBlock =
                jointEditBlock ??
                (jointAttachmentUseCount(project, asset.id, joint.name) > 0
                  ? 'Equipment masks use this joint. Change those references before renaming it.'
                  : null);
              return (
                <article className="studio-catalog-card" key={`${index}:${joint.name}`}>
                  <label className="studio-field">
                    Joint {index + 1} name
                    <input
                      required
                      maxLength={64}
                      pattern="[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}"
                      value={joint.name}
                      disabled={Boolean(renameBlock)}
                      title={renameBlock ?? undefined}
                      onChange={(event) => {
                        const nextName = event.target.value;
                        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(nextName)) return;
                        try {
                          const next = renameRigJoint(asset, joint.name, nextName);
                          onChange(next);
                          onJsonChange(JSON.stringify(next.rig, null, 2));
                          setError('');
                        } catch (cause) {
                          setError((cause as Error).message);
                        }
                      }}
                    />
                  </label>
                  <label className="studio-field">
                    Parent joint
                    <select
                      aria-label={`Joint ${joint.name} parent`}
                      value={joint.parent ?? ''}
                      disabled={Boolean(jointEditBlock)}
                      onChange={(event) => {
                        try {
                          const next = setRigJointParent(rig, joint.name, event.target.value || null);
                          onChange({ ...asset, rig: next });
                          onJsonChange(JSON.stringify(next, null, 2));
                          setError('');
                        } catch (cause) {
                          setError((cause as Error).message);
                        }
                      }}
                    >
                      <option value="">Root</option>
                      {rig.joints
                        .filter((candidate) => candidate.name !== joint.name)
                        .map((candidate) => (
                          <option key={candidate.name} value={candidate.name}>
                            {candidate.name}
                          </option>
                        ))}
                    </select>
                  </label>
                  <VectorField
                    label={`Joint ${joint.name} bind position`}
                    value={joint.position}
                    min={-100_000}
                    max={100_000}
                    disabled={Boolean(jointEditBlock)}
                    onChange={(position) => updateJoint(joint.name, { position })}
                  />
                  <VectorField
                    label={`Joint ${joint.name} bind rotation (radians)`}
                    value={joint.rotation}
                    min={-Math.PI * 2}
                    max={Math.PI * 2}
                    disabled={Boolean(jointEditBlock)}
                    onChange={(rotation) => updateJoint(joint.name, { rotation })}
                  />
                  <div className="studio-catalog-card-actions">
                    {removeBlock && <small>{removeBlock}</small>}
                    <button
                      type="button"
                      aria-label={`Remove joint ${joint.name}`}
                      disabled={Boolean(removeBlock)}
                      title={removeBlock ?? undefined}
                      onClick={() => {
                        try {
                          const next = removeRigJoint(asset, joint.name);
                          onChange(next);
                          onJsonChange(JSON.stringify(next.rig, null, 2));
                          setError('');
                        } catch (cause) {
                          setError((cause as Error).message);
                        }
                      }}
                    >
                      Remove joint
                    </button>
                  </div>
                </article>
              );
            })}
            {jointEditBlock && <small role="status">{jointEditBlock}</small>}
            <button
              type="button"
              disabled={rig.joints.length >= 128 || Boolean(jointEditBlock)}
              onClick={() => changeRig(addRigJoint)}
            >
              + Add joint
            </button>
          </section>

          <section className="studio-component" aria-label="Rig landmarks">
            <div>
              <strong>Landmarks</strong>
              <small>{Object.keys(rig.landmarks).length}</small>
            </div>
            {Object.entries(rig.landmarks).map(([name, position], index) => (
              <article className="studio-catalog-card" key={name}>
                <label className="studio-field">
                  <LandmarkNameField
                    index={index}
                    name={name}
                    onCommit={(nextName) => {
                      if (nextName !== name)
                        changeRig((current) => updateRigLandmark(current, name, { name: nextName }));
                    }}
                  />
                </label>
                <VectorField
                  label={`Landmark ${name} position`}
                  value={position}
                  min={-100_000}
                  max={100_000}
                  onChange={(nextPosition) =>
                    changeRig((current) => updateRigLandmark(current, name, { position: nextPosition }))
                  }
                />
                <button
                  type="button"
                  aria-label={`Remove landmark ${name}`}
                  onClick={() => changeRig((current) => removeRigLandmark(current, name))}
                >
                  Remove landmark
                </button>
              </article>
            ))}
            <button type="button" onClick={() => changeRig(addRigLandmark)}>
              + Add landmark
            </button>
          </section>

          <section className="studio-component" aria-label="Rig sockets">
            <div>
              <strong>Sockets</strong>
              <small>{rig.sockets.length}/64</small>
            </div>
            {rig.sockets.map((socket, index) => {
              const uses = socketUseCount(project, asset.id, socket.name);
              return (
                <article className="studio-catalog-card" key={`${index}:${socket.name}`}>
                  <label className="studio-field">
                    Socket {index + 1} name
                    <input
                      required
                      maxLength={64}
                      pattern="[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}"
                      value={socket.name}
                      disabled={uses > 0}
                      onChange={(event) => {
                        const nextName = event.target.value;
                        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(nextName)) return;
                        if (
                          rig.sockets.some((entry) => entry.name === nextName && entry.name !== socket.name)
                        ) {
                          setError('Socket names must be unique.');
                          return;
                        }
                        updateSocket(socket.name, { name: nextName });
                      }}
                    />
                  </label>
                  <label className="studio-field">
                    Attached joint
                    <select
                      aria-label={`Socket ${socket.name} joint`}
                      value={socket.joint}
                      onChange={(event) => updateSocket(socket.name, { joint: event.target.value })}
                    >
                      {rig.joints.map((joint) => (
                        <option key={joint.name} value={joint.name}>
                          {joint.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <VectorField
                    label={`Socket ${socket.name} position`}
                    value={socket.transform.position}
                    min={-100_000}
                    max={100_000}
                    onChange={(position) =>
                      updateSocket(socket.name, {
                        transform: { ...socket.transform, position },
                      })
                    }
                  />
                  <VectorField
                    label={`Socket ${socket.name} rotation`}
                    value={socket.transform.rotation}
                    min={-100_000}
                    max={100_000}
                    onChange={(rotation) =>
                      updateSocket(socket.name, {
                        transform: { ...socket.transform, rotation },
                      })
                    }
                  />
                  <VectorField
                    label={`Socket ${socket.name} scale`}
                    value={socket.transform.scale}
                    min={0.001}
                    max={1000}
                    onChange={(scale) =>
                      updateSocket(socket.name, {
                        transform: { ...socket.transform, scale },
                      })
                    }
                  />
                  {socket.fitBounds ? (
                    <>
                      <VectorField
                        label={`Socket ${socket.name} fit minimum · meters`}
                        value={socket.fitBounds.min}
                        min={-100_000}
                        max={100_000}
                        onChange={(min) =>
                          updateSocket(socket.name, { fitBounds: { ...socket.fitBounds!, min } })
                        }
                      />
                      <VectorField
                        label={`Socket ${socket.name} fit maximum · meters`}
                        value={socket.fitBounds.max}
                        min={-100_000}
                        max={100_000}
                        onChange={(max) =>
                          updateSocket(socket.name, { fitBounds: { ...socket.fitBounds!, max } })
                        }
                      />
                      <button
                        type="button"
                        onClick={() => updateSocket(socket.name, { fitBounds: undefined })}
                      >
                        Remove equipment fit bounds
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() =>
                        updateSocket(socket.name, {
                          fitBounds: { min: [-0.1, -0.1, -0.1], max: [0.1, 0.1, 0.1] },
                        })
                      }
                    >
                      Add equipment fit bounds
                    </button>
                  )}
                  <div className="studio-catalog-card-actions">
                    {uses > 0 && (
                      <small>
                        Used by {uses} attachment(s); change those references before renaming or removing it.
                      </small>
                    )}
                    <button
                      type="button"
                      aria-label={`Remove socket ${socket.name}`}
                      disabled={uses > 0}
                      title={uses ? 'Change attached equipment references first.' : undefined}
                      onClick={() =>
                        changeRig((current) => ({
                          ...current,
                          sockets: current.sockets.filter((entry) => entry.name !== socket.name),
                        }))
                      }
                    >
                      Remove socket
                    </button>
                  </div>
                </article>
              );
            })}
            <button type="button" disabled={rig.sockets.length >= 64} onClick={() => changeRig(addRigSocket)}>
              + Add socket
            </button>
          </section>
          <section className="studio-component" aria-label="Animation clips">
            <div>
              <strong>Animation clips</strong>
              <small>{rig.clips.length}/64</small>
            </div>
            <div className="studio-motion-presets" aria-label="Motion presets">
              <label className="studio-field">
                Starting motion
                <select
                  aria-label="Starting motion preset"
                  value={motionPreset}
                  onChange={(event) => setMotionPreset(event.target.value as AnimationPreset)}
                >
                  {ANIMATION_PRESETS.map((preset) => (
                    <option key={preset} value={preset}>
                      {motionPresetLabel(preset, rig.profile)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="studio-field">
                Motion intensity
                <input
                  type="number"
                  min={0}
                  max={2}
                  step="0.1"
                  value={motionIntensity}
                  onChange={(event) => setMotionIntensity(Number(event.target.value))}
                />
              </label>
              <button
                type="button"
                disabled={rig.clips.length >= 64}
                onClick={() =>
                  changeRig((current) =>
                    addAnimationPreset(current, motionPreset, { intensity: motionIntensity }),
                  )
                }
              >
                Add {motionPresetLabel(motionPreset, rig.profile).toLowerCase()} motion
              </button>
              <small>
                {rig.profile === 'quadruped'
                  ? 'Creates editable gait, head, limb, and tail poses with timing. Tune the keys below, then assign jump and attack clips on a scene actor.'
                  : 'Creates editable poses, gait markers and timing. Tune the keys below, then assign jump and attack clips on a scene actor.'}
              </small>
            </div>
            <button type="button" disabled={rig.clips.length >= 64} onClick={() => changeRig(addRigClip)}>
              + Add clip
            </button>
            {rig.clips.map((clip) => {
              const uses = animationClipUseCount(project, asset.id, clip.name);
              const trackedJoints = new Set(clip.tracks.map((track) => track.joint));
              const nextJoint = rig.joints.find((joint) => !trackedJoints.has(joint.name));
              return (
                <details className="studio-catalog-card" key={clip.name}>
                  <summary>
                    {clip.name} · {clip.tracks.length} track(s) · {clip.events.length} marker(s)
                  </summary>
                  <label className="studio-field">
                    Clip name
                    <input
                      required
                      maxLength={64}
                      pattern="[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}"
                      value={clip.name}
                      disabled={uses > 0}
                      title={uses > 0 ? 'Resolve scene animation and marker references first.' : undefined}
                      onChange={(event) =>
                        changeRig((current) => renameRigClip(current, clip.name, event.target.value, uses))
                      }
                    />
                  </label>
                  {uses > 0 && (
                    <small>
                      Has {uses} scene animation or marker reference(s). Resolve those before renaming or
                      removing this clip.
                    </small>
                  )}
                  <label className="studio-field">
                    Duration (seconds)
                    <input
                      type="number"
                      min={0.001}
                      max={3600}
                      step="any"
                      value={clip.duration}
                      onChange={(event) =>
                        changeRig((current) =>
                          updateRigClipSettings(current, clip.name, {
                            duration: Number(event.target.value),
                          }),
                        )
                      }
                    />
                  </label>
                  <label className="studio-field">
                    Blend in (seconds)
                    <input
                      type="number"
                      min={0}
                      max={2}
                      step="0.01"
                      value={clip.blendIn}
                      title="Crossfade from the current pose when this clip starts; set to 0 to switch immediately."
                      onChange={(event) =>
                        changeRig((current) =>
                          updateRigClipSettings(current, clip.name, { blendIn: Number(event.target.value) }),
                        )
                      }
                    />
                  </label>
                  <label className="studio-field">
                    <input
                      type="checkbox"
                      checked={clip.loop}
                      onChange={(event) =>
                        changeRig((current) =>
                          updateRigClipSettings(current, clip.name, { loop: event.target.checked }),
                        )
                      }
                    />
                    Loop clip
                  </label>
                  <label className="studio-field">
                    Authored move speed (m/s; 0 = no scaling)
                    <input
                      type="number"
                      min={0}
                      max={1000}
                      step="any"
                      value={clip.speed}
                      title="While moving, runtime scales clip time by actor movement speed divided by this value."
                      onChange={(event) =>
                        changeRig((current) =>
                          updateRigClipSettings(current, clip.name, { speed: Number(event.target.value) }),
                        )
                      }
                    />
                  </label>
                  <fieldset className="studio-component">
                    <legend>Animation markers</legend>
                    {clip.events.map((marker, markerIndex) => (
                      <article className="studio-catalog-card" key={`${markerIndex}:${marker.name}`}>
                        <label className="studio-field">
                          Marker name
                          <input
                            required
                            maxLength={64}
                            pattern="[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}"
                            aria-label={`${clip.name} marker ${markerIndex + 1} name`}
                            value={marker.name}
                            onChange={(event) =>
                              changeRig((current) =>
                                updateRigMarker(current, clip.name, markerIndex, {
                                  name: event.target.value,
                                }),
                              )
                            }
                          />
                        </label>
                        <label className="studio-field">
                          Marker time (seconds)
                          <input
                            type="number"
                            min={0}
                            max={clip.duration}
                            step="any"
                            aria-label={`${clip.name} marker ${markerIndex + 1} time`}
                            value={marker.time}
                            onChange={(event) =>
                              changeRig((current) =>
                                updateRigMarker(current, clip.name, markerIndex, {
                                  time: Number(event.target.value),
                                }),
                              )
                            }
                          />
                        </label>
                        <button
                          type="button"
                          onClick={() =>
                            changeRig((current) => removeRigMarker(current, clip.name, markerIndex))
                          }
                        >
                          Remove marker
                        </button>
                      </article>
                    ))}
                    <button
                      type="button"
                      disabled={clip.events.length >= 256}
                      onClick={() => changeRig((current) => addRigMarker(current, clip.name))}
                    >
                      + Add marker
                    </button>
                  </fieldset>
                  {clip.tracks.map((track) => (
                    <fieldset className="studio-component" key={track.joint}>
                      <legend>{track.joint} track</legend>
                      <label className="studio-field">
                        Joint
                        <select
                          aria-label={`${clip.name} track joint`}
                          value={track.joint}
                          onChange={(event) =>
                            changeRig((current) =>
                              setRigTrackJoint(current, clip.name, track.joint, event.target.value),
                            )
                          }
                        >
                          {rig.joints.map((joint) => (
                            <option
                              key={joint.name}
                              value={joint.name}
                              disabled={joint.name !== track.joint && trackedJoints.has(joint.name)}
                            >
                              {joint.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      {track.keys.map((key, keyIndex) => (
                        <article className="studio-catalog-card" key={`${keyIndex}:${key.time}`}>
                          <label className="studio-field">
                            Interpolation to next key
                            <select
                              aria-label={`${clip.name} ${track.joint} key ${keyIndex + 1} interpolation`}
                              value={key.interpolation ?? 'linear'}
                              onChange={(event) =>
                                changeRig((current) =>
                                  updateRigKeyframe(current, clip.name, track.joint, keyIndex, {
                                    interpolation: event.target.value as 'linear' | 'smooth' | 'step',
                                  }),
                                )
                              }
                            >
                              <option value="linear">Linear</option>
                              <option value="smooth">Smooth ease in/out</option>
                              <option value="step">Hold until next key</option>
                            </select>
                          </label>
                          <label className="studio-field">
                            Keyframe time (seconds)
                            <input
                              type="number"
                              min={0}
                              max={clip.duration}
                              step="any"
                              value={key.time}
                              onChange={(event) =>
                                changeRig((current) =>
                                  updateRigKeyframe(current, clip.name, track.joint, keyIndex, {
                                    time: Number(event.target.value),
                                  }),
                                )
                              }
                            />
                          </label>
                          <VectorField
                            label="Rotation (radians)"
                            value={key.rotation}
                            min={-100_000}
                            max={100_000}
                            onChange={(rotation) =>
                              changeRig((current) =>
                                updateRigKeyframe(current, clip.name, track.joint, keyIndex, { rotation }),
                              )
                            }
                          />
                          <label className="studio-field">
                            <input
                              type="checkbox"
                              aria-label={`${clip.name} ${track.joint} key ${keyIndex + 1} position offset`}
                              checked={Boolean(key.position)}
                              onChange={(event) =>
                                changeRig((current) =>
                                  updateRigKeyframe(current, clip.name, track.joint, keyIndex, {
                                    position: event.target.checked ? [0, 0, 0] : undefined,
                                  }),
                                )
                              }
                            />
                            Add position offset (local voxels)
                          </label>
                          {key.position && (
                            <VectorField
                              label="Position offset (local voxels)"
                              value={key.position}
                              min={-100_000}
                              max={100_000}
                              onChange={(position) =>
                                changeRig((current) =>
                                  updateRigKeyframe(current, clip.name, track.joint, keyIndex, { position }),
                                )
                              }
                            />
                          )}
                          <button
                            type="button"
                            disabled={track.keys.length <= 1}
                            onClick={() =>
                              changeRig((current) =>
                                removeRigKeyframe(current, clip.name, track.joint, keyIndex),
                              )
                            }
                          >
                            Remove keyframe
                          </button>
                        </article>
                      ))}
                      <div className="studio-catalog-card-actions">
                        <button
                          type="button"
                          disabled={
                            track.keys.length >= 2048 ||
                            Math.max(...track.keys.map((key) => key.time)) >= clip.duration
                          }
                          onClick={() =>
                            changeRig((current) => addRigKeyframe(current, clip.name, track.joint))
                          }
                        >
                          + Add keyframe
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            changeRig((current) => removeRigTrack(current, clip.name, track.joint))
                          }
                        >
                          Remove track
                        </button>
                      </div>
                    </fieldset>
                  ))}
                  <div className="studio-catalog-card-actions">
                    <button
                      type="button"
                      disabled={!nextJoint || clip.tracks.length >= 128}
                      onClick={() =>
                        nextJoint && changeRig((current) => addRigTrack(current, clip.name, nextJoint.name))
                      }
                    >
                      + Add joint track
                    </button>
                    <button
                      type="button"
                      disabled={uses > 0}
                      onClick={() => changeRig((current) => removeRigClip(current, clip.name, uses))}
                    >
                      Remove clip
                    </button>
                  </div>
                </details>
              );
            })}
          </section>
          <section className="studio-component" aria-label="Retarget animation">
            <strong>Copy animation from another rig</strong>
            {retargetSources.length === 0 ? (
              <small>Add another rigged asset with an animation clip to retarget it here.</small>
            ) : (
              <>
                <label className="studio-field">
                  Source asset
                  <select
                    value={retargetSource?.id ?? ''}
                    onChange={(event) => {
                      const next = retargetSources.find((candidate) => candidate.id === event.target.value);
                      setRetargetSourceId(event.target.value);
                      setRetargetSourceClipName(next?.rig?.clips[0]?.name ?? '');
                      setRetargetMap({});
                      setRetargetClipName('');
                    }}
                  >
                    {retargetSources.map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.name}
                      </option>
                    ))}
                  </select>
                </label>
                {retargetSourceClip && retargetSource?.rig && (
                  <>
                    <label className="studio-field">
                      Source clip
                      <select
                        value={retargetSourceClip.name}
                        onChange={(event) => {
                          setRetargetSourceClipName(event.target.value);
                          setRetargetMap({});
                          setRetargetClipName('');
                        }}
                      >
                        {retargetSource.rig.clips.map((clip) => (
                          <option key={clip.name} value={clip.name}>
                            {clip.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="studio-field">
                      New clip name
                      <input
                        required
                        maxLength={64}
                        pattern="[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}"
                        value={effectiveRetargetName}
                        onChange={(event) => setRetargetClipName(event.target.value)}
                      />
                    </label>
                    <fieldset className="studio-component">
                      <legend>Joint mapping</legend>
                      {retargetSourceClip.tracks.map((track) => {
                        const mapped = effectiveRetargetMap.find(
                          (entry) => entry.sourceJoint === track.joint,
                        )?.targetJoint;
                        const usedByOtherTracks = new Set(
                          effectiveRetargetMap
                            .filter((entry) => entry.sourceJoint !== track.joint)
                            .map((entry) => entry.targetJoint),
                        );
                        return (
                          <label className="studio-field" key={track.joint}>
                            {track.joint}
                            <select
                              aria-label={`Map source joint ${track.joint}`}
                              value={mapped ?? ''}
                              onChange={(event) =>
                                setRetargetMap((current) => ({
                                  ...current,
                                  [track.joint]: event.target.value,
                                }))
                              }
                            >
                              <option value="">Skip this track</option>
                              {rig.joints.map((joint) => (
                                <option
                                  key={joint.name}
                                  value={joint.name}
                                  disabled={joint.name !== mapped && usedByOtherTracks.has(joint.name)}
                                >
                                  {joint.name}
                                </option>
                              ))}
                            </select>
                          </label>
                        );
                      })}
                    </fieldset>
                    <small>
                      Mapped rotation deltas are automatically converted between the source and target bind
                      axes. Unmapped tracks are skipped; key position offsets preserve meters across different
                      voxel sizes.
                    </small>
                    <button
                      type="button"
                      disabled={!effectiveRetargetName || effectiveRetargetMap.length === 0}
                      onClick={() =>
                        changeRig((current) =>
                          retargetRigClip(
                            retargetSource.rig!,
                            retargetSourceClip.name,
                            current,
                            effectiveRetargetName,
                            effectiveRetargetMap,
                            retargetSource.voxelSize,
                            asset.voxelSize,
                          ),
                        )
                      }
                    >
                      Copy animation to this rig
                    </button>
                  </>
                )}
              </>
            )}
          </section>
          <p>
            Profile: <code>{rig.profile}</code> · {rig.clips.length} animation clip(s) retained
          </p>
        </>
      )}
      <details>
        <summary>Advanced rig JSON</summary>
        <p>
          Use this for rig fields without dedicated controls. The editor checks the rig schema before applying
          JSON.
        </p>
        <textarea
          aria-label="Rig JSON"
          rows={16}
          value={json}
          onChange={(event) => onJsonChange(event.target.value)}
        />
        <button
          type="button"
          onClick={() => {
            try {
              onChange({ ...asset, rig: parseRigJson(json) });
              setError('');
            } catch (cause) {
              setError((cause as Error).message);
            }
          }}
        >
          Apply advanced JSON
        </button>
      </details>
      {error && (
        <p role="alert" className="studio-error">
          {error}
        </p>
      )}
    </section>
  );
}

function VectorField({
  label,
  value,
  onChange,
  min,
  max,
  disabled = false,
}: {
  label: string;
  value: [number, number, number];
  onChange: (value: [number, number, number]) => void;
  min?: number;
  max?: number;
  disabled?: boolean;
}) {
  return (
    <fieldset className="studio-vector">
      <legend>{label}</legend>
      {(['X', 'Y', 'Z'] as const).map((axis, index) => (
        <label key={axis}>
          {axis}
          <input
            aria-label={`${label} ${axis}`}
            type="number"
            step="any"
            min={min}
            max={max}
            disabled={disabled}
            value={value[index]}
            onChange={(event) => {
              const next = [...value] as [number, number, number];
              next[index] = Number(event.target.value);
              onChange(next);
            }}
          />
        </label>
      ))}
    </fieldset>
  );
}

function LandmarkNameField({
  index,
  name,
  onCommit,
}: {
  index: number;
  name: string;
  onCommit: (name: string) => void;
}) {
  const [draft, setDraft] = useState(name);
  return (
    <>
      Landmark {index + 1} name
      <input
        required
        maxLength={64}
        pattern="[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}"
        aria-label={`Landmark ${name} name`}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => onCommit(draft)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            event.currentTarget.blur();
          }
        }}
      />
    </>
  );
}
