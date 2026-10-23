import { MAX_HUD_PANEL_DEPTH, type GameHudWidget, type RuleCondition } from '../services/projectDocument';

export type GameHudState = {
  variables: Record<string, number>;
  campaignVariables?: Record<string, number>;
  playerId: string | null;
  health: Record<string, number>;
  inventory: {
    itemId: string;
    quantity: number;
    name?: string;
    usable?: boolean;
    actionLabel?: string;
  }[];
  paused?: boolean;
  status?: string;
  activeTabs?: Record<string, string>;
};

export function gameHudValue(widget: Extract<GameHudWidget, { type: 'value' | 'bar' }>, state: GameHudState) {
  const { binding } = widget;
  if (binding.kind === 'variable')
    return (binding.scope === 'campaign' ? state.campaignVariables : state.variables)?.[binding.id] ?? 0;
  if (binding.kind === 'health') return state.playerId ? (state.health[state.playerId] ?? 0) : 0;
  return state.inventory.reduce(
    (quantity, stack) => quantity + (stack.itemId === binding.itemId ? stack.quantity : 0),
    0,
  );
}

export function gameHudCondition(condition: RuleCondition, state: GameHudState) {
  const actual =
    typeof condition.variable === 'string'
      ? ((condition.scope === 'campaign' ? state.campaignVariables : state.variables)?.[condition.variable] ??
        0)
      : state.inventory.reduce(
          (quantity, stack) => quantity + (stack.itemId === condition.itemId ? stack.quantity : 0),
          0,
        );
  if (condition.op === '>=') return actual >= condition.value;
  if (condition.op === '<=') return actual <= condition.value;
  if (condition.op === '==') return actual === condition.value;
  if (condition.op === '>') return actual > condition.value;
  return actual < condition.value;
}

export function gameHudActiveTabs(widgets: GameHudWidget[], selected: Record<string, string> = {}) {
  const tabs = new Map<string, string[]>();
  for (const widget of widgets) {
    if (widget.type !== 'tab-button') continue;
    const group = tabs.get(widget.groupId) ?? [];
    group.push(widget.tabId);
    tabs.set(widget.groupId, group);
  }
  return Object.fromEntries(
    [...tabs].map(([groupId, options]) => {
      const selectedTab = selected[groupId];
      return [groupId, selectedTab && options.includes(selectedTab) ? selectedTab : options[0]!];
    }),
  );
}

export function selectGameHudTab(
  widgets: GameHudWidget[],
  selected: Record<string, string>,
  groupId: string,
  tabId: string,
) {
  if (
    !widgets.some(
      (widget) => widget.type === 'tab-button' && widget.groupId === groupId && widget.tabId === tabId,
    )
  )
    return null;
  return { ...selected, [groupId]: tabId };
}

export function gameHudVisible(widget: GameHudWidget, state: GameHudState) {
  if (widget.visibleWhenPaused !== undefined && widget.visibleWhenPaused !== (state.paused === true))
    return false;
  if (
    widget.visibleWhenTab &&
    state.activeTabs?.[widget.visibleWhenTab.groupId] !== widget.visibleWhenTab.tabId
  )
    return false;
  return !widget.visibleWhen || gameHudCondition(widget.visibleWhen, state);
}

export type GameHudTreeNode = { widget: GameHudWidget; children: GameHudTreeNode[] };

/** Returns visible top-level widgets and their bounded visible panel descendants. */
export function gameHudTree(widgets: GameHudWidget[], state: GameHudState) {
  const currentState = { ...state, activeTabs: gameHudActiveTabs(widgets, state.activeTabs) };
  const visible = widgets.filter((widget) => gameHudVisible(widget, currentState));
  const children = new Map<string, GameHudWidget[]>();
  for (const widget of visible) {
    if (!widget.parentId) continue;
    const siblings = children.get(widget.parentId) ?? [];
    siblings.push(widget);
    children.set(widget.parentId, siblings);
  }
  const build = (widget: GameHudWidget, depth: number): GameHudTreeNode => ({
    widget,
    children:
      widget.type === 'panel' && depth < MAX_HUD_PANEL_DEPTH
        ? (children.get(widget.id) ?? []).map((child) => build(child, depth + 1))
        : [],
  });
  return visible.filter((widget) => !widget.parentId).map((widget) => build(widget, 0));
}

export function formatGameHudValue(value: number) {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
}

const anchorLayout: Record<GameHudWidget['anchor'], { x: string; y: string; transform: string }> = {
  'top-left': { x: 'left', y: 'top', transform: '' },
  'top-center': { x: 'center', y: 'top', transform: 'translateX(-50%)' },
  'top-right': { x: 'right', y: 'top', transform: '' },
  'center-left': { x: 'left', y: 'center', transform: 'translateY(-50%)' },
  center: { x: 'center', y: 'center', transform: 'translate(-50%, -50%)' },
  'center-right': { x: 'right', y: 'center', transform: 'translateY(-50%)' },
  'bottom-left': { x: 'left', y: 'bottom', transform: '' },
  'bottom-center': { x: 'center', y: 'bottom', transform: 'translateX(-50%)' },
  'bottom-right': { x: 'right', y: 'bottom', transform: '' },
};

export function gameHudStyle(widget: GameHudWidget, inFlow = false) {
  const layout = anchorLayout[widget.anchor];
  const horizontalOffset = `${widget.offsetX}px`;
  const verticalOffset = `${widget.offsetY}px`;
  const centerOffset = (offset: number) => `calc(50% ${offset < 0 ? '-' : '+'} ${Math.abs(offset)}px)`;
  return {
    position: inFlow ? ('relative' as const) : ('absolute' as const),
    ...(!inFlow && layout.x === 'left' ? { left: horizontalOffset } : {}),
    ...(!inFlow && layout.x === 'right' ? { right: `${-widget.offsetX}px` } : {}),
    ...(!inFlow && layout.x === 'center' ? { left: centerOffset(widget.offsetX) } : {}),
    ...(!inFlow && layout.y === 'top' ? { top: verticalOffset } : {}),
    ...(!inFlow && layout.y === 'bottom' ? { bottom: `${-widget.offsetY}px` } : {}),
    ...(!inFlow && layout.y === 'center' ? { top: centerOffset(widget.offsetY) } : {}),
    transform: inFlow ? 'none' : layout.transform,
    width: `${widget.width}px`,
    ...(widget.type === 'panel' ? { height: `${widget.height}px` } : {}),
    ...(widget.type === 'panel' && widget.layout !== 'free'
      ? {
          display: 'flex',
          flexDirection: widget.layout === 'row' ? ('row' as const) : ('column' as const),
          gap: `${widget.gap}px`,
        }
      : {}),
    ...(widget.type === 'inventory'
      ? { display: 'grid', gridTemplateColumns: `repeat(${widget.columns}, minmax(0, 1fr))`, gap: '6px' }
      : {}),
    maxWidth: '100%',
    boxSizing: 'border-box' as const,
    overflowWrap: 'anywhere' as const,
    padding: '8px 10px',
    borderRadius: '7px',
    color: widget.color,
    backgroundColor: widget.background,
    opacity: widget.opacity,
    font: `500 ${widget.fontSize}px/1.3 system-ui, sans-serif`,
    pointerEvents:
      widget.type === 'button' || widget.type === 'event-button' || widget.type === 'tab-button'
        ? ('auto' as const)
        : ('none' as const),
    ...(widget.type === 'panel' && widget.layout !== 'free' ? { padding: `${widget.padding}px` } : {}),
  };
}

export function gameHudStamp(widgets: GameHudWidget[], state: GameHudState) {
  const currentState = { ...state, activeTabs: gameHudActiveTabs(widgets, state.activeTabs) };
  return JSON.stringify(
    widgets.map((widget) => [
      widget,
      gameHudVisible(widget, currentState),
      'binding' in widget ? gameHudValue(widget, currentState) : null,
      widget.type === 'inventory' ? currentState.inventory : null,
      state.paused ?? false,
      currentState.activeTabs,
    ]),
  );
}
