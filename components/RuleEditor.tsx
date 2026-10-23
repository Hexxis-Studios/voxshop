import React, { useEffect, useState } from 'react';
import {
  type Action,
  type AudioClipDocument,
  type CraftingRecipe,
  type GameScene,
  type ItemDefinition,
  type Prefab,
  type Rule,
  type RuleCondition,
  type SceneNode,
  COLLISION_OTHER_TARGET,
} from '../services/projectDocument';
import {
  actionTypes,
  addRuleCondition,
  addInventoryEntry,
  canCreateAction,
  createAction,
  createRule,
  defaultRuleCondition,
  parseActionJson,
  removeRuleCondition,
  removeInventoryEntry,
  ruleEvents,
  setRuleEvent,
  setRuleConditionMode,
  type InventoryEntry,
  updateRuleCondition,
  useRuleConditionGroup,
  updateInventoryEntry,
} from './ruleAuthoring';

export function RuleEditor({
  rules,
  recipes,
  items = [],
  markers = [],
  nodes,
  scenes,
  prefabs = [],
  audioClips = [],
  sceneId,
  onChange,
}: {
  rules: Rule[];
  recipes: CraftingRecipe[];
  items?: ItemDefinition[];
  markers?: string[];
  nodes: SceneNode[];
  scenes: Pick<GameScene, 'id' | 'name'>[];
  prefabs?: Pick<Prefab, 'id' | 'name'>[];
  audioClips?: Pick<AudioClipDocument, 'id' | 'name'>[];
  sceneId: string;
  onChange: (rules: Rule[]) => void;
}) {
  const [nextAction, setNextAction] = useState<Action['type']>('message');

  const updateRule = (index: number, next: Rule) =>
    onChange(rules.map((rule, i) => (i === index ? next : rule)));
  const updateAction = (ruleIndex: number, actionIndex: number, action: Action) =>
    updateRule(ruleIndex, {
      ...rules[ruleIndex],
      actions: rules[ruleIndex].actions.map((current, i) => (i === actionIndex ? action : current)),
    });

  return (
    <div>
      <p>Choose what happens when an event occurs. API v1 actions use bounded data, never scripts.</p>
      {rules.map((rule, ruleIndex) => (
        <section className="studio-component" key={ruleIndex}>
          <div>
            <strong>Rule {ruleIndex + 1}</strong>
            <button
              type="button"
              aria-label={`Remove rule ${ruleIndex + 1}`}
              onClick={() => onChange(rules.filter((_, i) => i !== ruleIndex))}
            >
              ×
            </button>
          </div>
          <label className="studio-field">
            Event
            <select
              value={rule.event}
              onChange={(e) => {
                const event = e.target.value as Rule['event'];
                updateRule(ruleIndex, setRuleEvent(rule, event));
              }}
            >
              {ruleEvents.map((event) => (
                <option key={event} value={event}>
                  {event}
                </option>
              ))}
            </select>
          </label>
          {(rule.event === 'ui' || rule.event === 'signal') && (
            <>
              <TextInput
                label={rule.event === 'ui' ? 'Event button ID' : 'Signal ID'}
                value={rule.eventId ?? ''}
                maxLength={64}
                pattern="[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}"
                onChange={(eventId) => updateRule(ruleIndex, { ...rule, eventId: eventId || undefined })}
              />
              <small>
                {rule.event === 'ui'
                  ? 'Match the stable ID authored on an Event button HUD widget.'
                  : 'Match the ID emitted by a rule action; every enabled listener with this ID runs.'}
              </small>
            </>
          )}
          {(rule.event === 'collision' || rule.event === 'separation') && (
            <small>
              Rapier events need colliders on both objects and a dynamic rigid body in the scene. Sensor
              overlaps count; use Touch/Untouch for player triggers.
            </small>
          )}
          {rule.event === 'animation' && (
            <>
              {markers.length ? (
                <label className="studio-field">
                  Marker filter (optional)
                  <select
                    aria-label="Marker filter (optional)"
                    value={rule.marker ?? ''}
                    onChange={(event) =>
                      updateRule(ruleIndex, { ...rule, marker: event.target.value || undefined })
                    }
                  >
                    <option value="">Any marker</option>
                    {rule.marker && !markers.includes(rule.marker) && (
                      <option value={rule.marker}>{rule.marker} · missing marker</option>
                    )}
                    {markers.map((marker) => (
                      <option key={marker} value={marker}>
                        {marker}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <TextInput
                  label="Marker filter (optional)"
                  value={rule.marker ?? ''}
                  maxLength={64}
                  pattern="[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}"
                  onChange={(marker) => updateRule(ruleIndex, { ...rule, marker: marker || undefined })}
                />
              )}
              <small>Leave blank to run this rule for every animation marker.</small>
            </>
          )}
          {rule.event === 'tick' && (
            <NumberInput
              label="Interval · seconds"
              value={rule.interval}
              min={0.05}
              max={3600}
              valid={(value) => Number.isFinite(value) && value >= 0.05 && value <= 3600}
              onChange={(interval) => updateRule(ruleIndex, { ...rule, interval })}
            />
          )}
          <label className="studio-check">
            <input
              type="checkbox"
              checked={rule.once}
              onChange={(e) => updateRule(ruleIndex, { ...rule, once: e.target.checked })}
            />
            Run once
          </label>
          <label className="studio-check">
            <input
              type="checkbox"
              checked={Boolean(rule.condition || rule.conditionGroup)}
              onChange={(e) =>
                updateRule(ruleIndex, {
                  ...rule,
                  condition: e.target.checked ? defaultRuleCondition() : undefined,
                  conditionGroup: undefined,
                })
              }
            />
            Require a condition
          </label>
          {rule.condition && (
            <>
              <ConditionFields
                condition={rule.condition}
                items={items}
                onChange={(condition) => updateRule(ruleIndex, { ...rule, condition })}
              />
              <button type="button" onClick={() => updateRule(ruleIndex, useRuleConditionGroup(rule))}>
                Use multiple conditions
              </button>
            </>
          )}
          {rule.conditionGroup && (
            <div className="studio-component">
              <label className="studio-field">
                Condition matching
                <select
                  value={rule.conditionGroup.mode}
                  onChange={(event) =>
                    updateRule(ruleIndex, setRuleConditionMode(rule, event.target.value as 'all' | 'any'))
                  }
                >
                  <option value="all">All conditions</option>
                  <option value="any">Any condition</option>
                </select>
              </label>
              {rule.conditionGroup.conditions.map((condition, conditionIndex) => (
                <div className="studio-component" key={conditionIndex}>
                  <div>
                    <strong>Condition {conditionIndex + 1}</strong>
                    <button
                      type="button"
                      aria-label={`Remove condition ${conditionIndex + 1} from rule ${ruleIndex + 1}`}
                      disabled={rule.conditionGroup!.conditions.length <= 1}
                      onClick={() => updateRule(ruleIndex, removeRuleCondition(rule, conditionIndex))}
                    >
                      ×
                    </button>
                  </div>
                  <ConditionFields
                    condition={condition}
                    items={items}
                    onChange={(next) =>
                      updateRule(ruleIndex, updateRuleCondition(rule, conditionIndex, next))
                    }
                  />
                </div>
              ))}
              <button
                type="button"
                disabled={rule.conditionGroup.conditions.length >= 8}
                onClick={() => updateRule(ruleIndex, addRuleCondition(rule))}
              >
                Add condition
              </button>
              <small>Rules support up to eight conditions with no nested groups.</small>
            </div>
          )}

          <h4>Actions</h4>
          {rule.actions.map((action, actionIndex) => (
            <ActionEditor
              key={actionIndex}
              action={action}
              index={actionIndex}
              allowCounterpart={rule.event === 'collision' || rule.event === 'separation'}
              recipes={recipes}
              items={items}
              nodes={nodes}
              scenes={scenes}
              prefabs={prefabs}
              audioClips={audioClips}
              onChange={(next) => updateAction(ruleIndex, actionIndex, next)}
              onRemove={() =>
                updateRule(ruleIndex, {
                  ...rule,
                  actions: rule.actions.filter((_, i) => i !== actionIndex),
                })
              }
              canRemove={rule.actions.length > 1}
            />
          ))}
          <div className="studio-add-row">
            <select
              aria-label={`Action type for rule ${ruleIndex + 1}`}
              value={nextAction}
              onChange={(e) => setNextAction(e.target.value as Action['type'])}
            >
              {actionTypes.map((type) => (
                <option
                  key={type}
                  value={type}
                  disabled={
                    (type === 'inventory' && items.length === 0) || (type === 'spawn' && !prefabs.length)
                  }
                >
                  {type}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={
                rule.actions.length >= 32 ||
                !canCreateAction(nextAction, {
                  recipes: recipes.length,
                  nodes: nodes.length,
                  items: items.length,
                  prefabs: prefabs.length,
                  audioClips: audioClips.length,
                })
              }
              onClick={() => {
                const action = createAction(
                  nextAction,
                  recipes[0]?.id,
                  nodes[0]?.id,
                  scenes.find((scene) => scene.id === sceneId)?.id,
                  items[0]?.id,
                  prefabs[0]?.id,
                  audioClips[0]?.id,
                );
                if (action) updateRule(ruleIndex, { ...rule, actions: [...rule.actions, action] });
              }}
            >
              Add action
            </button>
          </div>
          {nextAction === 'craft' && recipes.length === 0 && (
            <small>Create a recipe in the Scene catalog first.</small>
          )}
          {items.length === 0 && <small>Inventory actions require an item in the Scene catalog.</small>}
          {nextAction === 'enable' && nodes.length === 0 && <small>Add an object to the scene first.</small>}
          {nextAction === 'spawn' && prefabs.length === 0 && (
            <small>Save a scene subtree as a prefab first.</small>
          )}
          {nextAction === 'audio' && audioClips.length === 0 && (
            <small>Import an audio clip in Scene Settings first.</small>
          )}
          {rule.actions.length >= 32 && <small>Rules can have up to 32 actions.</small>}
          {rule.actions.some((action) => action.type === 'craft' || action.type === 'inventory') && (
            <small>
              Place Craft and Inventory actions before later actions that depend on success. A failed
              transaction stops later actions. A failed Run once rule can be retried until it succeeds.
            </small>
          )}
        </section>
      ))}
      <button type="button" disabled={rules.length >= 64} onClick={() => onChange([...rules, createRule()])}>
        Add rule
      </button>
      {rules.length >= 64 && <small>Objects can have up to 64 rules.</small>}
    </div>
  );
}

function ConditionFields({
  condition,
  items,
  onChange,
}: {
  condition: RuleCondition;
  items: ItemDefinition[];
  onChange: (condition: RuleCondition) => void;
}) {
  const itemCondition = condition.itemId !== undefined;
  return (
    <>
      <label className="studio-field">
        Condition source
        <select
          value={itemCondition ? 'inventory' : 'variable'}
          onChange={(event) => {
            if (event.target.value === 'inventory') {
              const itemId = itemCondition ? condition.itemId : items[0]?.id;
              if (itemId) onChange({ itemId, op: condition.op, value: itemCondition ? condition.value : 1 });
            } else
              onChange({
                variable: itemCondition ? 'score' : condition.variable,
                scope: itemCondition ? 'scene' : condition.scope,
                op: condition.op,
                value: condition.value,
              });
          }}
        >
          <option value="variable">Variable</option>
          <option value="inventory" disabled={!items.length && !itemCondition}>
            Inventory count
          </option>
        </select>
      </label>
      {itemCondition ? (
        <CatalogItemSelect
          label="Inventory item"
          value={condition.itemId}
          items={items}
          onChange={(itemId) => onChange({ itemId, op: condition.op, value: condition.value })}
        />
      ) : (
        <>
          <TextInput
            label="Variable"
            value={condition.variable}
            onChange={(variable) =>
              onChange({
                variable,
                scope: condition.scope ?? 'scene',
                op: condition.op,
                value: condition.value,
              })
            }
          />
          <label className="studio-field">
            Variable scope
            <select
              value={condition.scope ?? 'scene'}
              onChange={(event) =>
                onChange({
                  variable: condition.variable,
                  scope: event.target.value as 'scene' | 'campaign',
                  op: condition.op,
                  value: condition.value,
                })
              }
            >
              <option value="scene">This scene</option>
              <option value="campaign">Across scenes</option>
            </select>
          </label>
        </>
      )}
      <div className="studio-two">
        <label className="studio-field">
          Comparison
          <select
            value={condition.op}
            onChange={(event) => onChange({ ...condition, op: event.target.value as RuleCondition['op'] })}
          >
            {(['>=', '<=', '==', '>', '<'] as const).map((op) => (
              <option key={op} value={op}>
                {op}
              </option>
            ))}
          </select>
        </label>
        <NumberInput
          label="Value"
          value={condition.value}
          min={itemCondition ? 0 : undefined}
          max={itemCondition ? 1000000 : undefined}
          step={itemCondition ? 1 : 'any'}
          valid={
            itemCondition
              ? (value) => Number.isInteger(value) && value >= 0 && value <= 1000000
              : Number.isFinite
          }
          onChange={(value) => onChange({ ...condition, value })}
        />
      </div>
    </>
  );
}

function ActionEditor({
  action,
  index,
  allowCounterpart,
  recipes,
  items,
  nodes,
  scenes,
  prefabs,
  audioClips,
  onChange,
  onRemove,
  canRemove,
}: {
  action: Action;
  index: number;
  allowCounterpart: boolean;
  recipes: CraftingRecipe[];
  items: ItemDefinition[];
  nodes: SceneNode[];
  scenes: Pick<GameScene, 'id' | 'name'>[];
  prefabs: Pick<Prefab, 'id' | 'name'>[];
  audioClips: Pick<AudioClipDocument, 'id' | 'name'>[];
  onChange: (action: Action) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  return (
    <div className="studio-component">
      <div>
        <strong>{action.type}</strong>
        <button
          type="button"
          aria-label={`Remove action ${index + 1}`}
          disabled={!canRemove}
          onClick={onRemove}
        >
          ×
        </button>
      </div>
      {action.type === 'craft' ? (
        <>
          <label className="studio-field">
            Recipe
            <select
              value={action.recipeId}
              onChange={(e) => onChange({ ...action, recipeId: e.target.value })}
            >
              {!recipes.some((recipe) => recipe.id === action.recipeId) && (
                <option value={action.recipeId}>{action.recipeId} · missing recipe</option>
              )}
              {recipes.map((recipe) => (
                <option key={recipe.id} value={recipe.id}>
                  {recipe.name} · {recipe.id}
                </option>
              ))}
            </select>
          </label>
          <NumberInput
            label="Batches"
            value={action.batches}
            min={1}
            max={99}
            step={1}
            valid={(value) => Number.isInteger(value) && value >= 1 && value <= 99}
            onChange={(batches) => onChange({ ...action, batches })}
          />
        </>
      ) : action.type === 'inventory' ? (
        <>
          <CatalogItemListEditor
            label="Remove items"
            entries={action.remove}
            items={items}
            totalRows={action.remove.length + action.add.length}
            onChange={(remove) => onChange({ ...action, remove })}
          />
          <CatalogItemListEditor
            label="Add items"
            entries={action.add}
            items={items}
            totalRows={action.remove.length + action.add.length}
            onChange={(add) => onChange({ ...action, add })}
          />
          <small>Inventory changes are applied together; if any item check fails, the action fails.</small>
        </>
      ) : action.type === 'set' || action.type === 'add' ? (
        <>
          <TextInput
            label="Variable"
            value={action.variable}
            maxLength={64}
            pattern="[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}"
            onChange={(variable) => onChange({ ...action, variable })}
          />
          <label className="studio-field">
            Variable scope
            <select
              value={action.scope ?? 'scene'}
              onChange={(event) => onChange({ ...action, scope: event.target.value as 'scene' | 'campaign' })}
            >
              <option value="scene">This scene</option>
              <option value="campaign">Across scenes</option>
            </select>
          </label>
          <NumberInput
            label={action.type === 'set' ? 'Value' : 'Amount'}
            value={action.value}
            onChange={(value) => onChange({ ...action, value })}
          />
        </>
      ) : action.type === 'emit' ? (
        <>
          <TextInput
            label="Signal ID"
            value={action.eventId}
            maxLength={64}
            pattern="[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}"
            onChange={(eventId) => onChange({ ...action, eventId })}
          />
          <small>Runs enabled signal rules with the same ID after this rule finishes.</small>
        </>
      ) : action.type === 'message' ? (
        <label className="studio-field">
          Message
          <textarea
            rows={3}
            maxLength={500}
            value={action.text}
            onChange={(e) => onChange({ ...action, text: e.target.value })}
          />
        </label>
      ) : action.type === 'sound' ? (
        <>
          <label className="studio-field">
            Waveform
            <select
              value={action.waveform}
              onChange={(event) =>
                onChange({ ...action, waveform: event.target.value as typeof action.waveform })
              }
            >
              <option value="sine">Sine · smooth</option>
              <option value="square">Square · electronic</option>
              <option value="triangle">Triangle · mellow</option>
              <option value="sawtooth">Sawtooth · bright</option>
            </select>
          </label>
          <div className="studio-two">
            <NumberInput
              label="Start pitch · Hz"
              value={action.frequency}
              min={20}
              max={4000}
              valid={(value) => Number.isFinite(value) && value >= 20 && value <= 4000}
              onChange={(frequency) => onChange({ ...action, frequency })}
            />
            <NumberInput
              label="End pitch · Hz · optional"
              value={action.endFrequency ?? action.frequency}
              min={20}
              max={4000}
              valid={(value) => Number.isFinite(value) && value >= 20 && value <= 4000}
              onChange={(endFrequency) => onChange({ ...action, endFrequency })}
            />
          </div>
          <div className="studio-two">
            <NumberInput
              label="Duration · seconds"
              value={action.duration}
              min={0.02}
              max={2}
              valid={(value) => Number.isFinite(value) && value >= 0.02 && value <= 2}
              onChange={(duration) => onChange({ ...action, duration })}
            />
            <NumberInput
              label="Volume · 0–1"
              value={action.volume}
              min={0}
              max={1}
              valid={(value) => Number.isFinite(value) && value >= 0 && value <= 1}
              onChange={(volume) => onChange({ ...action, volume })}
            />
          </div>
          <small>Plays a short synthesized tone through the browser or desktop WebView audio output.</small>
        </>
      ) : action.type === 'audio' ? (
        <>
          <label className="studio-field">
            Imported audio clip
            <select
              value={action.clipId}
              onChange={(event) => onChange({ ...action, clipId: event.target.value })}
            >
              {audioClips.map((clip) => (
                <option key={clip.id} value={clip.id}>
                  {clip.name}
                </option>
              ))}
            </select>
          </label>
          <NumberInput
            label="Volume · 0–1"
            value={action.volume}
            min={0}
            max={1}
            valid={(value) => Number.isFinite(value) && value >= 0 && value <= 1}
            onChange={(volume) => onChange({ ...action, volume })}
          />
          <small>Plays this imported clip once through the browser or desktop audio output.</small>
        </>
      ) : action.type === 'damage' || action.type === 'heal' ? (
        <>
          <ActionTargetSelect
            value={action.target}
            nodes={nodes}
            allowCounterpart={allowCounterpart}
            onChange={(target) => onChange({ ...action, target })}
          />
          <NumberInput
            label={action.type === 'heal' ? 'Health restored' : 'Damage'}
            value={action.amount}
            min={0}
            max={10000}
            valid={(value) => Number.isFinite(value) && value > 0 && value <= 10000}
            onChange={(amount) => onChange({ ...action, amount })}
          />
          {action.type === 'heal' && <small>Only enabled objects with Health can be healed.</small>}
        </>
      ) : action.type === 'destroy' ? (
        <ActionTargetSelect
          value={action.target}
          nodes={nodes}
          allowCounterpart={allowCounterpart}
          onChange={(target) => onChange({ ...action, target })}
        />
      ) : action.type === 'teleport' ? (
        <>
          <ActionTargetSelect
            value={action.target}
            nodes={nodes}
            allowCounterpart={allowCounterpart}
            onChange={(target) => onChange({ ...action, target })}
          />
          <ActionJsonEditor action={action} onChange={onChange} />
        </>
      ) : action.type === 'transition' ? (
        <label className="studio-field">
          Destination scene
          <select value={action.sceneId} onChange={(e) => onChange({ ...action, sceneId: e.target.value })}>
            {!scenes.some((scene) => scene.id === action.sceneId) && (
              <option value={action.sceneId}>{action.sceneId} · missing scene</option>
            )}
            {scenes.map((scene) => (
              <option key={scene.id} value={scene.id}>
                {scene.name} · {scene.id}
              </option>
            ))}
          </select>
        </label>
      ) : action.type === 'spawn' ? (
        <>
          <label className="studio-field">
            Prefab
            <select
              value={action.prefabId}
              onChange={(event) => onChange({ ...action, prefabId: event.target.value })}
            >
              {!prefabs.some((prefab) => prefab.id === action.prefabId) && (
                <option value={action.prefabId}>{action.prefabId} · missing prefab</option>
              )}
              {prefabs.map((prefab) => (
                <option key={prefab.id} value={prefab.id}>
                  {prefab.name} · {prefab.id}
                </option>
              ))}
            </select>
          </label>
          <label className="studio-field">
            Placement
            <select
              value={action.position ? 'world' : 'offset'}
              onChange={(event) => {
                const vector = action.position ?? action.offset ?? [0, 0, 0];
                if (event.target.value === 'world') {
                  const { offset: _offset, ...rest } = action;
                  onChange({ ...rest, position: vector });
                } else {
                  const { position: _position, ...rest } = action;
                  onChange({ ...rest, offset: vector });
                }
              }}
            >
              <option value="offset">Relative to this object</option>
              <option value="world">World position</option>
            </select>
          </label>
          <div className="studio-two">
            {(['x', 'y', 'z'] as const).map((axis, index) => {
              const field = action.position ? 'position' : 'offset';
              const vector = action[field] ?? [0, 0, 0];
              return (
                <NumberInput
                  key={axis}
                  label={`${action.position ? 'World' : 'Offset'} ${axis.toUpperCase()}`}
                  value={vector[index]}
                  min={-100000}
                  max={100000}
                  onChange={(value) => {
                    const next = [...vector] as [number, number, number];
                    next[index] = value;
                    onChange({ ...action, [field]: next });
                  }}
                />
              );
            })}
          </div>
          <SpawnVectorEditor
            label="Override root rotation · Euler radians"
            axisLabel="Rotation"
            value={action.rotation}
            initial={[0, 0, 0]}
            min={-100000}
            max={100000}
            onChange={(rotation) => onChange({ ...action, rotation })}
          />
          <SpawnVectorEditor
            label="Override root scale"
            axisLabel="Scale"
            value={action.scale}
            initial={[1, 1, 1]}
            min={0.001}
            max={1000}
            valid={(value) => Number.isFinite(value) && value > 0 && value <= 1000}
            onChange={(scale) => onChange({ ...action, scale })}
          />
        </>
      ) : action.type === 'win' || action.type === 'lose' ? (
        <p>{action.type === 'win' ? 'Complete the game.' : 'End the game as a loss.'}</p>
      ) : (
        <ActionJsonEditor action={action} onChange={onChange} />
      )}
    </div>
  );
}

function SpawnVectorEditor({
  label,
  axisLabel,
  value,
  initial,
  min,
  max,
  valid,
  onChange,
}: {
  label: string;
  axisLabel: string;
  value?: [number, number, number];
  initial: [number, number, number];
  min: number;
  max: number;
  valid?: (value: number) => boolean;
  onChange: (value?: [number, number, number]) => void;
}) {
  return (
    <>
      <label className="studio-check">
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(event) => onChange(event.target.checked ? [...initial] : undefined)}
        />
        {label}
      </label>
      {value && (
        <div className="studio-two">
          {(['x', 'y', 'z'] as const).map((axis, index) => (
            <NumberInput
              key={axis}
              label={`${axisLabel} ${axis.toUpperCase()}`}
              value={value[index]}
              min={min}
              max={max}
              valid={valid}
              onChange={(nextValue) => {
                const next = [...value] as [number, number, number];
                next[index] = nextValue;
                onChange(next);
              }}
            />
          ))}
        </div>
      )}
    </>
  );
}

function ActionTargetSelect({
  value,
  nodes,
  allowCounterpart,
  onChange,
}: {
  value?: string;
  nodes: SceneNode[];
  allowCounterpart: boolean;
  onChange: (value?: string) => void;
}) {
  return (
    <label className="studio-field">
      Target
      <select value={value ?? ''} onChange={(event) => onChange(event.target.value || undefined)}>
        <option value="">This object</option>
        {allowCounterpart && <option value={COLLISION_OTHER_TARGET}>Other colliding object</option>}
        {value && value !== COLLISION_OTHER_TARGET && !nodes.some((node) => node.id === value) && (
          <option value={value}>{value} · missing object</option>
        )}
        {nodes.map((node) => (
          <option key={node.id} value={node.id}>
            {node.name} · {node.id}
          </option>
        ))}
      </select>
    </label>
  );
}

export function CatalogItemListEditor({
  label,
  entries,
  items,
  totalRows = entries.length,
  allowEmpty = false,
  quantityLabel,
  onChange,
}: {
  label: string;
  entries: InventoryEntry[];
  items: ItemDefinition[];
  totalRows?: number;
  allowEmpty?: boolean;
  quantityLabel?: string;
  onChange: (entries: InventoryEntry[]) => void;
}) {
  const actionLabel = label.startsWith('Remove') ? 'Remove' : label.startsWith('Place') ? 'Place' : 'Add';
  const availableItems = items.filter((item) => !entries.some((entry) => entry.itemId === item.id));
  const itemLabel = label.slice(0, -1);
  return (
    <fieldset className="studio-component">
      <legend>{label}</legend>
      {entries.map((entry, index) => (
        <div className="studio-two" key={`${entry.itemId}-${index}`}>
          <CatalogItemSelect
            label={`${itemLabel} ${index + 1}`}
            value={entry.itemId}
            items={items.filter(
              (item) =>
                item.id === entry.itemId ||
                !entries.some((other, i) => i !== index && other.itemId === item.id),
            )}
            onChange={(itemId) => onChange(updateInventoryEntry(entries, index, { itemId }))}
          />
          <NumberInput
            label={`${quantityLabel ?? `${actionLabel} quantity`} ${index + 1}`}
            value={entry.quantity}
            min={1}
            max={9999}
            step={1}
            valid={(value) => Number.isInteger(value) && value >= 1 && value <= 9999}
            onChange={(quantity) => onChange(updateInventoryEntry(entries, index, { quantity }))}
          />
          <button
            type="button"
            aria-label={`Remove row ${index + 1} from ${label.toLowerCase()}`}
            disabled={!allowEmpty && totalRows <= 1}
            onClick={() => onChange(removeInventoryEntry(entries, index))}
          >
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        disabled={entries.length >= 16 || availableItems.length === 0}
        onClick={() => {
          const item = availableItems[0];
          if (item) onChange(addInventoryEntry(entries, item.id));
        }}
      >
        Add item
      </button>
      {entries.length >= 16 && <small>This list can contain up to 16 distinct items.</small>}
      {availableItems.length === 0 && (
        <small>
          {items.length === 0
            ? 'Add an item to the Scene catalog to use this list.'
            : 'All catalog items are already used in this list.'}
        </small>
      )}
    </fieldset>
  );
}

function CatalogItemSelect({
  label,
  value,
  items,
  onChange,
}: {
  label: string;
  value: string;
  items: ItemDefinition[];
  onChange: (itemId: string) => void;
}) {
  const missing = value && !items.some((item) => item.id === value);
  return (
    <label className="studio-field">
      {label}
      <select aria-label={label} required value={value} onChange={(e) => onChange(e.target.value)}>
        {missing && <option value={value}>{value} · missing catalog item</option>}
        {!value && items.length === 0 && (
          <option value="" disabled>
            No catalog items
          </option>
        )}
        {items.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name} · {item.id}
          </option>
        ))}
      </select>
    </label>
  );
}

function ActionJsonEditor({ action, onChange }: { action: Action; onChange: (action: Action) => void }) {
  const [source, setSource] = useState(JSON.stringify(action, null, 2));
  const [error, setError] = useState('');
  useEffect(() => setSource(JSON.stringify(action, null, 2)), [action]);
  return (
    <>
      <label className="studio-field">
        Action data · API v1
        <textarea
          aria-label={`${action.type} action JSON`}
          rows={4}
          value={source}
          onChange={(e) => {
            setSource(e.target.value);
            setError('');
          }}
        />
      </label>
      <button
        type="button"
        onClick={() => {
          const parsed = parseActionJson(source);
          if (parsed.success) {
            onChange(parsed.action);
            setError('');
          } else setError(parsed.error);
        }}
      >
        Apply action data
      </button>
      {error && (
        <small role="alert" className="studio-error">
          {error}
        </small>
      )}
    </>
  );
}

function TextInput({
  label,
  value,
  onChange,
  maxLength,
  pattern,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  maxLength?: number;
  pattern?: string;
}) {
  return (
    <label className="studio-field">
      {label}
      <input
        value={value}
        maxLength={maxLength}
        pattern={pattern}
        title={
          pattern
            ? 'Use 1–64 letters, numbers, underscores or hyphens; start with a letter or number.'
            : undefined
        }
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function NumberInput({
  label,
  value,
  onChange,
  min,
  max,
  step = 'any',
  valid = Number.isFinite,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number | 'any';
  valid?: (value: number) => boolean;
}) {
  const [text, setText] = useState(String(value));
  const [error, setError] = useState('');
  useEffect(() => setText(String(value)), [value]);
  return (
    <label className="studio-field">
      {label}
      <input
        type="number"
        step={step}
        min={min}
        max={max}
        required
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const parsed = text === '' ? NaN : Number(text);
          if (valid(parsed)) {
            onChange(parsed);
            setError('');
          } else setError('Enter a valid number for this field.');
        }}
      />
      {error && <small role="alert">{error}</small>}
    </label>
  );
}
