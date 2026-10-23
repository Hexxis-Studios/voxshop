import React from 'react';
import type { GameHudWidget } from '../services/projectDocument';
import {
  formatGameHudValue,
  gameHudActiveTabs,
  gameHudStyle,
  gameHudTree,
  gameHudValue,
  type GameHudTreeNode,
  type GameHudState,
} from '../runtime/gameHud';

export default function GameHud({
  widgets,
  state,
  onAction,
  onEvent,
  onTab,
  onUseItem,
  onMoveItem,
  onSortInventory,
}: {
  widgets: GameHudWidget[];
  state: GameHudState | null;
  onAction: (action: Extract<GameHudWidget, { type: 'button' }>['action']) => void;
  onEvent: (eventId: string) => void;
  onTab?: (groupId: string, tabId: string) => void;
  onUseItem?: (itemId: string) => void;
  onMoveItem?: (fromIndex: number, toIndex: number) => void;
  onSortInventory?: () => void;
}) {
  const [selectedTabs, setSelectedTabs] = React.useState<Record<string, string>>({});
  if (!state || widgets.length === 0) return null;
  const controlledTabs = state.activeTabs !== undefined;
  const currentState = {
    ...state,
    activeTabs: gameHudActiveTabs(widgets, controlledTabs ? state.activeTabs : selectedTabs),
  };
  const selectTab = (groupId: string, tabId: string) => {
    if (!controlledTabs) setSelectedTabs((previous) => ({ ...previous, [groupId]: tabId }));
    onTab?.(groupId, tabId);
  };
  const tree = gameHudTree(widgets, currentState);
  if (tree.length === 0) return null;
  return (
    <div className="studio-authored-hud" aria-label="Game interface">
      {tree.map((node) =>
        renderHudNode(
          node,
          currentState,
          onAction,
          onEvent,
          selectTab,
          onUseItem,
          onMoveItem,
          onSortInventory,
        ),
      )}
    </div>
  );
}

function renderHudNode(
  node: GameHudTreeNode,
  state: GameHudState,
  onAction: (action: Extract<GameHudWidget, { type: 'button' }>['action']) => void,
  onEvent: (eventId: string) => void,
  onTab: (groupId: string, tabId: string) => void,
  onUseItem?: (itemId: string) => void,
  onMoveItem?: (fromIndex: number, toIndex: number) => void,
  onSortInventory?: () => void,
  inFlow = false,
) {
  const { widget, children } = node;
  if (widget.type !== 'panel')
    return renderHudWidget(
      widget,
      state,
      onAction,
      onEvent,
      onTab,
      onUseItem,
      onMoveItem,
      onSortInventory,
      inFlow,
    );
  return (
    <div
      key={widget.id}
      aria-hidden={children.length === 0 ? true : undefined}
      style={gameHudStyle(widget, inFlow)}
    >
      {children.map((child) =>
        renderHudNode(
          child,
          state,
          onAction,
          onEvent,
          onTab,
          onUseItem,
          onMoveItem,
          onSortInventory,
          widget.layout !== 'free',
        ),
      )}
    </div>
  );
}

function renderHudWidget(
  widget: Exclude<GameHudWidget, { type: 'panel' }>,
  state: GameHudState,
  onAction: (action: Extract<GameHudWidget, { type: 'button' }>['action']) => void,
  onEvent: (eventId: string) => void,
  onTab: (groupId: string, tabId: string) => void,
  onUseItem?: (itemId: string) => void,
  onMoveItem?: (fromIndex: number, toIndex: number) => void,
  onSortInventory?: () => void,
  inFlow = false,
) {
  const style = gameHudStyle(widget, inFlow);
  if (widget.type === 'text')
    return (
      <div key={widget.id} style={style}>
        {widget.text}
      </div>
    );
  if (widget.type === 'value')
    return (
      <div key={widget.id} style={style}>
        {widget.prefix}
        {formatGameHudValue(gameHudValue(widget, state))}
        {widget.suffix}
      </div>
    );
  if (widget.type === 'bar') {
    const value = gameHudValue(widget, state);
    const percent = Math.max(0, Math.min(100, ((value - widget.min) / (widget.max - widget.min)) * 100));
    return (
      <div
        key={widget.id}
        style={style}
        role="progressbar"
        aria-label={widget.label || widget.id}
        aria-valuemin={widget.min}
        aria-valuemax={widget.max}
        aria-valuenow={value}
      >
        {widget.label && (
          <span>
            {widget.label} · {formatGameHudValue(value)}
          </span>
        )}
        <div className="studio-hud-bar">
          <span style={{ width: `${percent}%`, backgroundColor: widget.fillColor }} />
        </div>
      </div>
    );
  }
  if (widget.type === 'inventory') {
    const stacks = state.inventory.slice(0, widget.maxItems);
    return (
      <div key={widget.id} style={style} role="group" aria-label="Inventory">
        {onSortInventory && (
          <div style={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'flex-end' }}>
            <button
              type="button"
              className="studio-hud-button"
              style={{ position: 'static', pointerEvents: 'auto' }}
              aria-label="Sort inventory by name"
              disabled={state.status !== undefined && state.status !== 'playing'}
              onClick={onSortInventory}
            >
              Sort
            </button>
          </div>
        )}
        {stacks.length ? (
          stacks.map((stack, index) => {
            const name = stack.name ?? stack.itemId;
            return (
              <div
                key={stack.itemId}
                draggable={!!onMoveItem}
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData('text/plain', String(index));
                }}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  const fromIndex = Number(event.dataTransfer.getData('text/plain'));
                  if (Number.isInteger(fromIndex)) onMoveItem?.(fromIndex, index);
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '6px',
                  minWidth: 0,
                  pointerEvents: 'auto',
                }}
              >
                <span>
                  {index + 1}. {name} ×{stack.quantity}
                </span>
                {onMoveItem && (
                  <span style={{ display: 'inline-flex', gap: '2px' }}>
                    <button
                      type="button"
                      className="studio-hud-button"
                      style={{ position: 'static', pointerEvents: 'auto', padding: '2px 6px' }}
                      aria-label={`Move ${name} earlier`}
                      disabled={index === 0 || (state.status !== undefined && state.status !== 'playing')}
                      onClick={() => onMoveItem(index, index - 1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="studio-hud-button"
                      style={{ position: 'static', pointerEvents: 'auto', padding: '2px 6px' }}
                      aria-label={`Move ${name} later`}
                      disabled={
                        index === state.inventory.length - 1 ||
                        (state.status !== undefined && state.status !== 'playing')
                      }
                      onClick={() => onMoveItem(index, index + 1)}
                    >
                      ↓
                    </button>
                  </span>
                )}
                {widget.showUseButtons && stack.usable && onUseItem && (
                  <button
                    type="button"
                    className="studio-hud-button"
                    style={{ pointerEvents: 'auto' }}
                    aria-label={`${stack.actionLabel ?? 'Use'} ${name}`}
                    disabled={
                      state.paused === true || (state.status !== undefined && state.status !== 'playing')
                    }
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      onUseItem(stack.itemId);
                    }}
                  >
                    {stack.actionLabel ?? 'Use'}
                  </button>
                )}
              </div>
            );
          })
        ) : (
          <span>Inventory empty</span>
        )}
        {state.inventory.length > widget.maxItems && (
          <span>+{state.inventory.length - widget.maxItems} more</span>
        )}
      </div>
    );
  }
  if (widget.type === 'button') {
    const text = widget.action === 'togglePause' && state.paused ? 'Resume' : widget.text;
    return (
      <button
        key={widget.id}
        type="button"
        className="studio-hud-button"
        style={style}
        aria-label={text}
        aria-pressed={widget.action === 'togglePause' ? state.paused : undefined}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onAction(widget.action);
        }}
      >
        {text}
      </button>
    );
  }
  if (widget.type === 'tab-button') {
    const active = state.activeTabs?.[widget.groupId] === widget.tabId;
    return (
      <button
        key={widget.id}
        type="button"
        className="studio-hud-button"
        style={{ ...style, backgroundColor: active ? widget.fillColor : widget.background }}
        aria-pressed={active}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onTab(widget.groupId, widget.tabId);
        }}
      >
        {widget.text}
      </button>
    );
  }
  return (
    <button
      key={widget.id}
      type="button"
      className="studio-hud-button"
      style={style}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onEvent(widget.eventId);
      }}
    >
      {widget.text}
    </button>
  );
}
