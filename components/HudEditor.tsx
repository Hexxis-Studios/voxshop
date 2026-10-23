import React, { useState } from 'react';
import {
  MAX_HUD_PANEL_DEPTH,
  type GameScene,
  type GameHudWidget,
  type RuleCondition,
} from '../services/projectDocument';

type WidgetType = GameHudWidget['type'];
type HudBinding = Extract<GameHudWidget, { type: 'value' | 'bar' }>['binding'];
const isVariableCondition = (
  condition: RuleCondition,
): condition is Extract<RuleCondition, { variable: string }> => typeof condition.variable === 'string';
const variableScope = (condition: RuleCondition) =>
  (isVariableCondition(condition) ? condition.scope : undefined) ?? 'scene';
const anchors: GameHudWidget['anchor'][] = [
  'top-left',
  'top-center',
  'top-right',
  'center-left',
  'center',
  'center-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
];
const actions: Extract<GameHudWidget, { type: 'button' }>['action'][] = [
  'togglePause',
  'jump',
  'interact',
  'attack',
  'useItem',
  'placeCell',
  'removeCell',
  'cyclePaint',
];
const defaults = (id: string) => ({
  id,
  anchor: 'top-left' as const,
  offsetX: 0,
  offsetY: 0,
  width: 200,
  fontSize: 16,
  color: '#f1f5f9',
  background: '#111827',
  fillColor: '#34d399',
  opacity: 0.85,
});
function newWidget(id: string, type: WidgetType): GameHudWidget {
  const base = defaults(id);
  if (type === 'value') return { ...base, type, binding: { kind: 'health' }, prefix: 'Health: ', suffix: '' };
  if (type === 'bar')
    return { ...base, type, binding: { kind: 'health' }, label: 'Health', min: 0, max: 100 };
  if (type === 'button') return { ...base, type, text: 'Interact', action: 'interact' };
  if (type === 'event-button') return { ...base, type, text: 'Continue', eventId: 'continue' };
  if (type === 'tab-button') return { ...base, type, text: 'Tab', groupId: 'main', tabId: `tab-${id}` };
  if (type === 'inventory') return { ...base, type, maxItems: 12, columns: 3, showUseButtons: true };
  if (type === 'panel') return { ...base, type, height: 180, layout: 'free', gap: 8, padding: 12 };
  return { ...base, type: 'text', text: 'New text' };
}
export default function HudEditor({
  scene,
  widgets,
  onChange,
}: {
  scene: GameScene;
  widgets: GameHudWidget[];
  onChange: (widgets: GameHudWidget[]) => void;
}) {
  const [newType, setNewType] = useState<WidgetType>('text');
  const replace = (index: number, widget: GameHudWidget, detachChildren = false) => {
    const previous = widgets[index];
    const removedTab =
      previous.type === 'tab-button' &&
      (widget.type !== 'tab-button' ||
        widget.groupId !== previous.groupId ||
        widget.tabId !== previous.tabId);
    onChange(
      widgets.map((current, currentIndex) => {
        if (currentIndex === index) return widget;
        let next = current;
        if (detachChildren && current.parentId === previous.id) next = { ...next, parentId: undefined };
        if (
          removedTab &&
          current.visibleWhenTab?.groupId === previous.groupId &&
          current.visibleWhenTab.tabId === previous.tabId
        ) {
          next = { ...next };
          delete next.visibleWhenTab;
        }
        return next;
      }),
    );
  };
  const update = (index: number, widget: GameHudWidget) => replace(index, widget);
  const isDescendant = (candidateId: string, ancestorId: string) => {
    let current = widgets.find((widget) => widget.id === candidateId);
    const seen = new Set<string>();
    while (current?.parentId && !seen.has(current.id)) {
      if (current.parentId === ancestorId) return true;
      seen.add(current.id);
      current = widgets.find((widget) => widget.id === current?.parentId);
    }
    return false;
  };
  const panelDepth = (panel: GameHudWidget) => {
    let current: GameHudWidget | undefined = panel;
    let depth = 1;
    const seen = new Set<string>();
    while (current?.parentId && !seen.has(current.id) && depth <= MAX_HUD_PANEL_DEPTH) {
      seen.add(current.id);
      depth++;
      current = widgets.find((widget) => widget.id === current?.parentId);
    }
    return depth;
  };
  const add = () => {
    if (widgets.length >= 32) return;
    let index = widgets.length + 1;
    while (widgets.some((widget) => widget.id === `hud-${index}`)) index++;
    onChange([...widgets, newWidget(`hud-${index}`, newType)]);
  };
  const changeType = (index: number, type: WidgetType) => {
    const old = widgets[index];
    replace(index, newWidget(old.id, type), true);
  };
  const remove = (index: number) => {
    const removed = widgets[index];
    onChange(
      widgets
        .filter((_, itemIndex) => itemIndex !== index)
        .map((widget) => {
          let next = widget.parentId === removed.id ? { ...widget, parentId: undefined } : widget;
          if (
            removed.type === 'tab-button' &&
            next.visibleWhenTab?.groupId === removed.groupId &&
            next.visibleWhenTab.tabId === removed.tabId
          ) {
            next = { ...next };
            delete next.visibleWhenTab;
          }
          return next;
        }),
    );
  };
  const tabGroups = [
    ...new Set(widgets.flatMap((widget) => (widget.type === 'tab-button' ? [widget.groupId] : []))),
  ];
  const tabsInGroup = (groupId: string) => [
    ...new Set(
      widgets.flatMap((widget) =>
        widget.type === 'tab-button' && widget.groupId === groupId ? [widget.tabId] : [],
      ),
    ),
  ];
  return (
    <fieldset className="studio-component">
      <legend>In-game HUD</legend>
      <p>
        Place text, live values, bars, inventory grids and action buttons over the game. Visibility conditions
        can target the pause state or let rules switch menu screens using scene or campaign variables and
        inventory. Panels may nest up to four levels, and tabs can switch visible panels or widgets. Agents
        can author the same widgets through scene.put.
      </p>
      {widgets.map((widget, index) => (
        <fieldset className="studio-hud-widget" key={widget.id}>
          <legend>{widget.id}</legend>
          <div className="studio-two">
            <label className="studio-field">
              Widget type
              <select
                value={widget.type}
                onChange={(event) => changeType(index, event.target.value as WidgetType)}
              >
                <option value="text">Text</option>
                <option value="panel">Background panel</option>
                <option value="value">Live value</option>
                <option value="bar">Progress bar</option>
                <option value="button">Action button</option>
                <option value="event-button">Rule event button</option>
                <option value="tab-button">Tab button</option>
                <option value="inventory">Inventory grid</option>
              </select>
            </label>
            <label className="studio-field">
              Anchor
              <select
                value={widget.anchor}
                onChange={(event) =>
                  update(index, { ...widget, anchor: event.target.value as GameHudWidget['anchor'] })
                }
              >
                {anchors.map((anchor) => (
                  <option key={anchor}>{anchor}</option>
                ))}
              </select>
            </label>
          </div>
          <label className="studio-field">
            Place inside panel
            <select
              value={widget.parentId ?? ''}
              onChange={(event) => update(index, { ...widget, parentId: event.target.value || undefined })}
            >
              <option value="">Anchored to screen</option>
              {widgets
                .filter(
                  (candidate) =>
                    candidate.type === 'panel' &&
                    candidate.id !== widget.id &&
                    !isDescendant(candidate.id, widget.id) &&
                    panelDepth(candidate) <= MAX_HUD_PANEL_DEPTH,
                )
                .map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.id}
                  </option>
                ))}
            </select>
          </label>
          {widget.type === 'text' ? (
            <label className="studio-field">
              Text
              <textarea
                maxLength={500}
                value={widget.text}
                onChange={(event) => update(index, { ...widget, text: event.target.value })}
              />
            </label>
          ) : widget.type === 'panel' ? (
            <div className="studio-two">
              <label className="studio-field">
                Height
                <input
                  type="number"
                  min={24}
                  max={1200}
                  value={widget.height}
                  onChange={(event) => update(index, { ...widget, height: Number(event.target.value) })}
                />
              </label>
              <label className="studio-field">
                Child layout
                <select
                  value={widget.layout}
                  onChange={(event) =>
                    update(index, { ...widget, layout: event.target.value as typeof widget.layout })
                  }
                >
                  <option value="free">Free placement</option>
                  <option value="column">Vertical stack</option>
                  <option value="row">Horizontal row</option>
                </select>
              </label>
              {widget.layout !== 'free' && (
                <>
                  <label className="studio-field">
                    Spacing
                    <input
                      type="number"
                      min={0}
                      max={64}
                      value={widget.gap}
                      onChange={(event) => update(index, { ...widget, gap: Number(event.target.value) })}
                    />
                  </label>
                  <label className="studio-field">
                    Inner padding
                    <input
                      type="number"
                      min={0}
                      max={64}
                      value={widget.padding}
                      onChange={(event) => update(index, { ...widget, padding: Number(event.target.value) })}
                    />
                  </label>
                </>
              )}
            </div>
          ) : widget.type === 'button' || widget.type === 'event-button' || widget.type === 'tab-button' ? (
            <div className="studio-two">
              <label className="studio-field">
                Button text
                <input
                  maxLength={120}
                  value={widget.text}
                  onChange={(event) => update(index, { ...widget, text: event.target.value })}
                />
              </label>
              {widget.type === 'button' ? (
                <label className="studio-field">
                  Action
                  <select
                    value={widget.action}
                    onChange={(event) =>
                      update(index, { ...widget, action: event.target.value as typeof widget.action })
                    }
                  >
                    {actions.map((action) => (
                      <option key={action} value={action}>
                        {action}
                      </option>
                    ))}
                  </select>
                </label>
              ) : widget.type === 'event-button' ? (
                <label className="studio-field">
                  Rule event ID
                  <input
                    maxLength={64}
                    pattern="[A-Za-z0-9][A-Za-z0-9_-]{0,63}"
                    value={widget.eventId}
                    onChange={(event) => update(index, { ...widget, eventId: event.target.value })}
                  />
                </label>
              ) : (
                <>
                  <label className="studio-field">
                    Tab group ID
                    <input
                      maxLength={64}
                      pattern="[A-Za-z0-9][A-Za-z0-9_-]{0,63}"
                      value={widget.groupId}
                      onChange={(event) => update(index, { ...widget, groupId: event.target.value })}
                    />
                  </label>
                  <label className="studio-field">
                    Tab ID
                    <input
                      maxLength={64}
                      pattern="[A-Za-z0-9][A-Za-z0-9_-]{0,63}"
                      value={widget.tabId}
                      onChange={(event) => update(index, { ...widget, tabId: event.target.value })}
                    />
                  </label>
                </>
              )}
            </div>
          ) : widget.type === 'inventory' ? (
            <>
              <div className="studio-two">
                <label className="studio-field">
                  Maximum stacks
                  <input
                    type="number"
                    min={1}
                    max={32}
                    value={widget.maxItems}
                    onChange={(event) => update(index, { ...widget, maxItems: Number(event.target.value) })}
                  />
                </label>
                <label className="studio-field">
                  Grid columns
                  <input
                    type="number"
                    min={1}
                    max={8}
                    value={widget.columns}
                    onChange={(event) => update(index, { ...widget, columns: Number(event.target.value) })}
                  />
                </label>
              </div>
              <label className="studio-field">
                <input
                  type="checkbox"
                  checked={widget.showUseButtons}
                  onChange={(event) => update(index, { ...widget, showUseButtons: event.target.checked })}
                />
                Show use/equip buttons for usable items
              </label>
            </>
          ) : (
            <>
              <label className="studio-field">
                Value source
                <select
                  value={
                    widget.binding.kind === 'variable'
                      ? widget.binding.scope === 'campaign'
                        ? 'campaign-variable'
                        : 'scene-variable'
                      : widget.binding.kind
                  }
                  onChange={(event) => {
                    const kind = event.target.value;
                    const binding =
                      kind === 'scene-variable' || kind === 'campaign-variable'
                        ? {
                            kind: 'variable' as const,
                            id:
                              widget.binding.kind === 'variable'
                                ? widget.binding.id
                                : (Object.keys(scene.variables)[0] ?? 'score'),
                            scope: kind === 'campaign-variable' ? ('campaign' as const) : ('scene' as const),
                          }
                        : kind === 'inventory'
                          ? {
                              kind: 'inventory' as const,
                              itemId:
                                widget.binding.kind === 'inventory'
                                  ? widget.binding.itemId
                                  : (scene.items[0]?.id ?? ''),
                            }
                          : { kind: 'health' as const };
                    update(index, { ...widget, binding });
                  }}
                >
                  <option value="health">Player health</option>
                  <option value="scene-variable">Scene variable</option>
                  <option value="campaign-variable">Campaign variable</option>
                  <option value="inventory" disabled={!scene.items.length}>
                    Inventory item
                  </option>
                </select>
              </label>
              {widget.binding.kind === 'variable' && (
                <label className="studio-field">
                  Variable ID
                  <input
                    value={widget.binding.id}
                    maxLength={64}
                    pattern="[A-Za-z0-9][A-Za-z0-9_-]{0,63}"
                    onChange={(event) => {
                      const binding: HudBinding = {
                        ...widget.binding,
                        kind: 'variable',
                        id: event.target.value,
                      };
                      update(index, { ...widget, binding });
                    }}
                  />
                </label>
              )}
              {widget.binding.kind === 'inventory' && (
                <label className="studio-field">
                  Inventory item
                  <select
                    value={widget.binding.itemId}
                    onChange={(event) => {
                      const binding: HudBinding = { kind: 'inventory', itemId: event.target.value };
                      update(index, { ...widget, binding });
                    }}
                  >
                    {scene.items.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {widget.type === 'value' ? (
                <div className="studio-two">
                  <label className="studio-field">
                    Prefix
                    <input
                      maxLength={120}
                      value={widget.prefix}
                      onChange={(event) => update(index, { ...widget, prefix: event.target.value })}
                    />
                  </label>
                  <label className="studio-field">
                    Suffix
                    <input
                      maxLength={120}
                      value={widget.suffix}
                      onChange={(event) => update(index, { ...widget, suffix: event.target.value })}
                    />
                  </label>
                </div>
              ) : (
                <label className="studio-field">
                  Bar label
                  <input
                    maxLength={120}
                    value={widget.label}
                    onChange={(event) => update(index, { ...widget, label: event.target.value })}
                  />
                </label>
              )}
            </>
          )}
          <div className="studio-three">
            <label className="studio-field">
              X offset
              <input
                type="number"
                min={-2000}
                max={2000}
                value={widget.offsetX}
                onChange={(event) => update(index, { ...widget, offsetX: Number(event.target.value) })}
              />
            </label>
            <label className="studio-field">
              Y offset
              <input
                type="number"
                min={-2000}
                max={2000}
                value={widget.offsetY}
                onChange={(event) => update(index, { ...widget, offsetY: Number(event.target.value) })}
              />
            </label>
            <label className="studio-field">
              Width
              <input
                type="number"
                min={40}
                max={1000}
                value={widget.width}
                onChange={(event) => update(index, { ...widget, width: Number(event.target.value) })}
              />
            </label>
          </div>
          {widget.type === 'bar' && (
            <>
              <div className="studio-two">
                <label className="studio-field">
                  Minimum
                  <input
                    type="number"
                    step="any"
                    value={widget.min}
                    onChange={(event) => update(index, { ...widget, min: Number(event.target.value) })}
                  />
                </label>
                <label className="studio-field">
                  Maximum
                  <input
                    type="number"
                    step="any"
                    value={widget.max}
                    onChange={(event) => update(index, { ...widget, max: Number(event.target.value) })}
                  />
                </label>
              </div>
              <label className="studio-field">
                Bar fill color
                <input
                  type="color"
                  value={widget.fillColor}
                  onChange={(event) => update(index, { ...widget, fillColor: event.target.value })}
                />
              </label>
            </>
          )}
          <fieldset className="studio-component">
            <legend>Visibility</legend>
            <label className="studio-field">
              Game state
              <select
                value={
                  widget.visibleWhenPaused === undefined
                    ? 'any'
                    : widget.visibleWhenPaused
                      ? 'paused'
                      : 'playing'
                }
                onChange={(event) => {
                  const next = { ...widget };
                  if (event.target.value === 'any') delete next.visibleWhenPaused;
                  else next.visibleWhenPaused = event.target.value === 'paused';
                  update(index, next);
                }}
              >
                <option value="any">Any state</option>
                <option value="playing">While playing</option>
                <option value="paused">While paused</option>
              </select>
            </label>
            <label className="studio-field">
              Show this widget when
              <select
                value={
                  widget.visibleWhen
                    ? typeof widget.visibleWhen.variable === 'string'
                      ? variableScope(widget.visibleWhen) === 'campaign'
                        ? 'campaign-variable'
                        : 'scene-variable'
                      : 'inventory'
                    : 'always'
                }
                onChange={(event) => {
                  const kind = event.target.value;
                  if (kind === 'always') {
                    const next = { ...widget };
                    delete next.visibleWhen;
                    update(index, next);
                    return;
                  }
                  const current = widget.visibleWhen;
                  const visibleWhen: RuleCondition =
                    kind === 'inventory'
                      ? {
                          itemId: current?.itemId ?? scene.items[0]?.id ?? 'item',
                          op: current?.op ?? '>=',
                          value: current?.value ?? 1,
                        }
                      : {
                          variable: current?.variable ?? Object.keys(scene.variables)[0] ?? 'started',
                          scope: kind === 'campaign-variable' ? 'campaign' : 'scene',
                          op: current?.op ?? '==',
                          value: current?.value ?? 1,
                        };
                  update(index, { ...widget, visibleWhen });
                }}
              >
                <option value="always">Always</option>
                <option value="scene-variable">Scene variable condition</option>
                <option value="campaign-variable">Campaign variable condition</option>
                <option value="inventory" disabled={!scene.items.length}>
                  Inventory condition
                </option>
              </select>
            </label>
            {widget.visibleWhen && (
              <div className="studio-three">
                {typeof widget.visibleWhen.variable === 'string' ? (
                  <label className="studio-field">
                    Variable ID
                    <input
                      value={widget.visibleWhen.variable}
                      maxLength={64}
                      pattern="[A-Za-z0-9][A-Za-z0-9_-]{0,63}"
                      onChange={(event) =>
                        update(index, {
                          ...widget,
                          visibleWhen: {
                            variable: event.target.value,
                            scope: variableScope(widget.visibleWhen!),
                            op: widget.visibleWhen!.op,
                            value: widget.visibleWhen!.value,
                          },
                        })
                      }
                    />
                  </label>
                ) : (
                  <label className="studio-field">
                    Inventory item
                    <select
                      value={widget.visibleWhen.itemId}
                      onChange={(event) =>
                        update(index, {
                          ...widget,
                          visibleWhen: {
                            itemId: event.target.value,
                            op: widget.visibleWhen!.op,
                            value: widget.visibleWhen!.value,
                          },
                        })
                      }
                    >
                      {scene.items.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {typeof widget.visibleWhen.variable === 'string' && (
                  <label className="studio-field">
                    Variable scope
                    <select
                      value={variableScope(widget.visibleWhen)}
                      onChange={(event) => {
                        const condition = widget.visibleWhen!;
                        if (!isVariableCondition(condition)) return;
                        update(index, {
                          ...widget,
                          visibleWhen: {
                            ...condition,
                            scope: event.target.value as 'scene' | 'campaign',
                          },
                        });
                      }}
                    >
                      <option value="scene">This scene</option>
                      <option value="campaign">Whole campaign</option>
                    </select>
                  </label>
                )}
                <label className="studio-field">
                  Comparison
                  <select
                    value={widget.visibleWhen.op}
                    onChange={(event) => {
                      const condition = widget.visibleWhen!;
                      const op = event.target.value as RuleCondition['op'];
                      const visibleWhen = isVariableCondition(condition)
                        ? {
                            variable: condition.variable,
                            scope: variableScope(condition),
                            op,
                            value: condition.value,
                          }
                        : { itemId: condition.itemId ?? '', op, value: condition.value };
                      update(index, { ...widget, visibleWhen });
                    }}
                  >
                    <option value="==">is</option>
                    <option value=">=">at least</option>
                    <option value="&lt;=">at most</option>
                    <option value="&gt;">greater than</option>
                    <option value="&lt;">less than</option>
                  </select>
                </label>
                <label className="studio-field">
                  Value
                  <input
                    type="number"
                    step={typeof widget.visibleWhen.itemId === 'string' ? 1 : 'any'}
                    min={typeof widget.visibleWhen.itemId === 'string' ? 0 : undefined}
                    value={widget.visibleWhen.value}
                    onChange={(event) => {
                      const condition = widget.visibleWhen!;
                      const value = Number(event.target.value);
                      const visibleWhen = isVariableCondition(condition)
                        ? {
                            variable: condition.variable,
                            scope: variableScope(condition),
                            op: condition.op,
                            value,
                          }
                        : { itemId: condition.itemId ?? '', op: condition.op, value };
                      update(index, { ...widget, visibleWhen });
                    }}
                  />
                </label>
              </div>
            )}
            <div className="studio-two">
              <label className="studio-field">
                Show this widget on tab
                <select
                  value={widget.visibleWhenTab?.groupId ?? ''}
                  disabled={tabGroups.length === 0}
                  onChange={(event) => {
                    const next = { ...widget };
                    if (!event.target.value) delete next.visibleWhenTab;
                    else {
                      const groupId = event.target.value;
                      const tabs = tabsInGroup(groupId);
                      if (tabs.length) next.visibleWhenTab = { groupId, tabId: tabs[0]! };
                    }
                    update(index, next);
                  }}
                >
                  <option value="">All tabs</option>
                  {tabGroups.map((groupId) => (
                    <option key={groupId} value={groupId}>
                      {groupId}
                    </option>
                  ))}
                </select>
              </label>
              {widget.visibleWhenTab && (
                <label className="studio-field">
                  Tab page
                  <select
                    value={widget.visibleWhenTab.tabId}
                    onChange={(event) =>
                      update(index, {
                        ...widget,
                        visibleWhenTab: { ...widget.visibleWhenTab!, tabId: event.target.value },
                      })
                    }
                  >
                    {tabsInGroup(widget.visibleWhenTab.groupId).map((tabId) => (
                      <option key={tabId} value={tabId}>
                        {tabId}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          </fieldset>
          <div className="studio-three">
            <label className="studio-field">
              Text color
              <input
                type="color"
                value={widget.color}
                onChange={(event) => update(index, { ...widget, color: event.target.value })}
              />
            </label>
            <label className="studio-field">
              Background
              <input
                type="color"
                value={widget.background}
                onChange={(event) => update(index, { ...widget, background: event.target.value })}
              />
            </label>
            <label className="studio-field">
              Font size
              <input
                type="number"
                min={10}
                max={64}
                value={widget.fontSize}
                onChange={(event) => update(index, { ...widget, fontSize: Number(event.target.value) })}
              />
            </label>
          </div>
          <button type="button" onClick={() => remove(index)}>
            Remove widget
          </button>
        </fieldset>
      ))}
      <div className="studio-inline-actions">
        <select
          aria-label="New HUD widget type"
          value={newType}
          onChange={(event) => setNewType(event.target.value as WidgetType)}
        >
          <option value="text">Text</option>
          <option value="panel">Background panel</option>
          <option value="value">Live value</option>
          <option value="bar">Progress bar</option>
          <option value="button">Action button</option>
          <option value="event-button">Rule event button</option>
          <option value="tab-button">Tab button</option>
          <option value="inventory">Inventory grid</option>
        </select>
        <button type="button" disabled={widgets.length >= 32} onClick={add}>
          Add HUD widget
        </button>
      </div>
    </fieldset>
  );
}
