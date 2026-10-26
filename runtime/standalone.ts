import { GameViewport } from './GameViewport';
import type { GameHudWidget, ProjectDocument } from '../services/projectDocument';
import { creatorWalkthrough } from './creatorWalkthrough';
import { GameProgressStore } from './gameProgress';
import {
  CampaignProgressStore,
  MAX_CAMPAIGN_PROGRESS_BYTES,
  parseCampaignProgress,
  serializeCampaignProgress,
} from './campaignProgress';
import type { CampaignProgressSnapshot } from './campaignProgress';
import { GameSession } from './GameSession';
import type { GameSimulation } from './GameSimulation';
import {
  describeMultiplayerConnection,
  multiplayerErrorMessage,
  validateMultiplayerRoomOptions,
} from './multiplayerControls';
import { describePlayerControls } from '../services/playerControls';
import { DEFAULT_FRAME_PACING, normalizeFramePacing, type FramePacingSettings } from './framePacing';
import {
  formatGameHudValue,
  gameHudActiveTabs,
  gameHudStamp,
  gameHudStyle,
  gameHudTree,
  gameHudValue,
} from './gameHud';
const project = JSON.parse(document.getElementById('voxshop-project')!.textContent!) as ProjectDocument;
const framePacingStorageKey = `voxshop:${project.id}:frame-pacing:v1`;
const loadFramePacing = (): FramePacingSettings => {
  try {
    const stored = localStorage.getItem(framePacingStorageKey);
    return stored ? normalizeFramePacing(JSON.parse(stored)) : { ...DEFAULT_FRAME_PACING };
  } catch {
    return { ...DEFAULT_FRAME_PACING };
  }
};
const saveFramePacing = (settings: FramePacingSettings) => {
  try {
    localStorage.setItem(framePacingStorageKey, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
};
const workerSources: { terrain?: string; voxel?: string } = (() => {
  const text = document.getElementById('voxshop-workers')?.textContent;
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return {
      terrain: typeof parsed.terrain === 'string' ? parsed.terrain : '',
      voxel: typeof parsed.voxel === 'string' ? parsed.voxel : '',
    };
  } catch {
    return {};
  }
})();
const workerUrls = new Map<string, string>();
function embeddedWorkerFactory(kind: 'terrain' | 'voxel', source: string): (() => Worker) | undefined {
  if (
    !source ||
    typeof Worker === 'undefined' ||
    typeof Blob === 'undefined' ||
    typeof URL === 'undefined' ||
    typeof URL.createObjectURL !== 'function'
  )
    return;
  return () => {
    let url = workerUrls.get(kind);
    if (!url) {
      url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      workerUrls.set(kind, url);
    }
    return new Worker(url);
  };
}
const terrainWorkerFactory = embeddedWorkerFactory('terrain', workerSources.terrain ?? '');
const voxelWorkerFactory = embeddedWorkerFactory('voxel', workerSources.voxel ?? '');
window.addEventListener('pagehide', () => {
  if (typeof URL.revokeObjectURL === 'function')
    for (const url of workerUrls.values()) URL.revokeObjectURL(url);
  workerUrls.clear();
});
const scene = project.scenes.find((candidate) => candidate.id === project.activeSceneId)!;
const campaignStore = new CampaignProgressStore(project.id, project.activeSceneId);
const legacyStore = new GameProgressStore(project.id, project.activeSceneId);
const savedProgress = () => {
  const result = campaignStore.load();
  if (result.status === 'empty') return legacyStore.load();
  if (result.status === 'invalid') {
    const legacy = legacyStore.load();
    if (legacy.status === 'loaded') return legacy;
  }
  return result;
};
const viewport = new GameViewport(document.getElementById('game')!, project, undefined, {
  renderLoop: 'unlocked',
  simulationHz: 240,
  framePacing: loadFramePacing(),
  asyncTerrainTiles: !!terrainWorkerFactory,
  createTerrainWorker: terrainWorkerFactory,
  asyncVoxelChunks: !!voxelWorkerFactory,
  createVoxelWorker: voxelWorkerFactory,
});
const instructionsForScene = (target: typeof scene) =>
  [
    target.instructions,
    target.worldId ? 'Use the configured Place and Remove actions to edit one terrain cell.' : '',
  ]
    .filter(Boolean)
    .join(' · ');
const controlsForScene = (target: typeof scene) => {
  const player = target.nodes
    .flatMap((node) => node.components)
    .find((component) => component.type === 'player');
  return player
    ? `Controls: ${describePlayerControls(player.controls)}. Drag Look to rotate the camera; touch movement and action buttons are available on supported mobile devices.`
    : '';
};
const title = document.getElementById('title')!,
  systemHud = document.getElementById('game-hud')!,
  gameMenu = document.getElementById('game-menu')! as HTMLDetailsElement,
  authoredHud = document.getElementById('authored-hud')!,
  status = document.getElementById('status')!,
  variables = document.getElementById('variables')!,
  objectives = document.getElementById('objectives')!,
  inventory = document.getElementById('inventory')!,
  instructions = document.getElementById('instructions')!,
  progressStatus = document.getElementById('progress-status')!,
  multiplayerForm = document.getElementById('multiplayer-form')! as HTMLFormElement,
  multiplayerStatus = document.getElementById('multiplayer-status')!,
  multiplayerError = document.getElementById('multiplayer-error')!,
  multiplayerEndpoint = document.getElementById('multiplayer-endpoint')! as HTMLInputElement,
  multiplayerRoomId = document.getElementById('multiplayer-room-id')! as HTMLInputElement,
  multiplayerCredential = document.getElementById('multiplayer-credential')! as HTMLInputElement,
  multiplayerResumeAfterReload = document.getElementById(
    'multiplayer-resume-after-reload',
  )! as HTMLInputElement,
  multiplayerCredentialToggle = document.getElementById(
    'multiplayer-credential-toggle',
  )! as HTMLButtonElement,
  multiplayerJoin = document.getElementById('multiplayer-join')! as HTMLButtonElement,
  multiplayerLeave = document.getElementById('multiplayer-leave')! as HTMLButtonElement,
  performance = document.getElementById('performance')!,
  controlsGuide = document.getElementById('controls-guide')!,
  controls = document.getElementById('controls')!,
  constructionControls = document.getElementById('construction-controls')!,
  constructionPaint = document.getElementById('construction-paint')! as HTMLSelectElement,
  capFrameRate = document.getElementById('cap-frame-rate')! as HTMLInputElement,
  maxFpsTarget = document.getElementById('max-fps-target')! as HTMLSelectElement,
  framePacingStatus = document.getElementById('frame-pacing-status')!,
  progressFile = document.getElementById('progress-file')! as HTMLInputElement,
  touchControls = document.getElementById('touch-controls')!,
  touchStickWrap = document.getElementById('touch-stick-wrap')!,
  touchStick = document.getElementById('touch-stick')!,
  touchStickKnob = document.getElementById('touch-stick-knob')! as HTMLSpanElement,
  touchLook = document.getElementById('touch-look')!,
  touchJump = document.getElementById('touch-jump')! as HTMLButtonElement,
  touchPause = document.getElementById('touch-pause')! as HTMLButtonElement,
  touchInteract = document.getElementById('touch-interact')! as HTMLButtonElement,
  touchAttack = document.getElementById('touch-attack')! as HTMLButtonElement,
  touchUse = document.getElementById('touch-use')! as HTMLButtonElement,
  touchPlace = document.getElementById('touch-place')! as HTMLButtonElement,
  touchRemove = document.getElementById('touch-remove')! as HTMLButtonElement;
let constructionPaletteStamp = '';
let authoredHudStamp = '';
let activeHudTabs: Record<string, string> = {};
let latestHudState: ReturnType<GameSimulation['inspect']> | null = null;
let currentHudSceneId = '';
let objectivesStamp = '';
let joystickPointerId: number | null = null;
let lookPointerId: number | null = null,
  lookPointerX = 0,
  lookPointerY = 0;
const releaseJoystick = () => {
  const pointerId = joystickPointerId;
  joystickPointerId = null;
  viewport.setTouchMovement(0, 0);
  if (pointerId !== null && touchStick.hasPointerCapture(pointerId))
    touchStick.releasePointerCapture(pointerId);
  touchStickKnob.style.transform = 'translate(-50%, -50%)';
};
const updateJoystick = (event: PointerEvent) => {
  const rect = touchStick.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  let x = Math.max(-1, Math.min(1, ((event.clientX - rect.left) / rect.width) * 2 - 1)),
    y = Math.max(-1, Math.min(1, ((event.clientY - rect.top) / rect.height) * 2 - 1));
  const magnitude = Math.hypot(x, y);
  if (magnitude > 1) {
    x /= magnitude;
    y /= magnitude;
  }
  viewport.setTouchMovement(x, y);
  touchStickKnob.style.transform = `translate(calc(-50% + ${x * 28}px), calc(-50% + ${y * 28}px))`;
};
const releaseTouchLook = () => {
  const pointerId = lookPointerId;
  lookPointerId = null;
  if (pointerId !== null && touchLook.hasPointerCapture(pointerId))
    touchLook.releasePointerCapture(pointerId);
};
touchLook.addEventListener('pointerdown', (event: PointerEvent) => {
  if (lookPointerId !== null) return;
  event.preventDefault();
  lookPointerId = event.pointerId;
  lookPointerX = event.clientX;
  lookPointerY = event.clientY;
  touchLook.setPointerCapture(event.pointerId);
});
touchLook.addEventListener('pointermove', (event: PointerEvent) => {
  if (event.pointerId !== lookPointerId) return;
  event.preventDefault();
  const deltaX = event.clientX - lookPointerX,
    deltaY = event.clientY - lookPointerY;
  lookPointerX = event.clientX;
  lookPointerY = event.clientY;
  viewport.lookByTouch(deltaX, deltaY);
});
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'])
  touchLook.addEventListener(type, (event: PointerEvent) => {
    if (event.pointerId === lookPointerId) releaseTouchLook();
  });
touchStick.addEventListener('pointerdown', (event: PointerEvent) => {
  if (joystickPointerId !== null) return;
  event.preventDefault();
  joystickPointerId = event.pointerId;
  touchStick.setPointerCapture(event.pointerId);
  updateJoystick(event);
});
touchStick.addEventListener('pointermove', (event: PointerEvent) => {
  if (event.pointerId === joystickPointerId) updateJoystick(event);
});
touchStick.addEventListener('pointerup', (event: PointerEvent) => {
  if (event.pointerId === joystickPointerId) releaseJoystick();
});
touchStick.addEventListener('pointercancel', (event: PointerEvent) => {
  if (event.pointerId === joystickPointerId) releaseJoystick();
});
touchStick.addEventListener('lostpointercapture', (event: PointerEvent) => {
  if (event.pointerId === joystickPointerId) releaseJoystick();
});
for (const [button, action] of [
  [touchJump, 'jump'],
  [touchInteract, 'interact'],
  [touchAttack, 'attack'],
  [touchPlace, 'placeCell'],
  [touchRemove, 'removeCell'],
] as const)
  button.addEventListener('click', (event) => {
    event.preventDefault();
    viewport.triggerAction(action);
  });
touchUse.addEventListener('click', (event) => {
  event.preventDefault();
  viewport.triggerAction('useItem');
});
touchPause.addEventListener('click', (event) => {
  event.preventDefault();
  viewport.triggerAction('togglePause');
});
title.textContent = project.name;
instructions.textContent = instructionsForScene(scene);
controls.textContent = controlsForScene(scene);
controlsGuide.hidden = !controls.textContent;
let systemMenuUsesAuthoredHud = false;
viewport.onState = (state) => {
  if (!state) {
    activeHudTabs = {};
    latestHudState = null;
    currentHudSceneId = '';
    status.textContent = 'Stopped';
    variables.textContent = '';
    objectives.hidden = true;
    objectives.replaceChildren();
    objectivesStamp = '';
    inventory.hidden = true;
    authoredHud.replaceChildren();
    authoredHud.hidden = true;
    authoredHudStamp = '';
    constructionControls.hidden = true;
    touchControls.hidden = true;
    touchPause.hidden = true;
    touchUse.hidden = true;
    releaseJoystick();
    releaseTouchLook();
    return;
  }
  latestHudState = state;
  if (currentHudSceneId !== state.sceneId) {
    currentHudSceneId = state.sceneId;
    activeHudTabs = {};
  }
  const activeScene = project.scenes.find((candidate) => candidate.id === state.sceneId) ?? scene;
  const hudWidgets = activeScene.hud ?? [];
  const hudState = {
    ...state,
    activeTabs: gameHudActiveTabs(hudWidgets, activeHudTabs),
    inventory: state.inventory.map((stack) => {
      const item = activeScene.items.find((entry) => entry.id === stack.itemId);
      return {
        ...stack,
        usable: !!item?.use,
        actionLabel: item?.use?.type === 'equip' ? 'Equip' : 'Use',
      };
    }),
  };
  activeHudTabs = hudState.activeTabs;
  const hudTree = gameHudTree(hudWidgets, hudState);
  if (systemMenuUsesAuthoredHud !== hudTree.length > 0) {
    systemMenuUsesAuthoredHud = hudTree.length > 0;
    systemHud.setAttribute('data-authored', String(systemMenuUsesAuthoredHud));
    gameMenu.open = !systemMenuUsesAuthoredHud;
  }
  const nextHudStamp = gameHudStamp(hudWidgets, hudState);
  authoredHud.hidden = hudTree.length === 0;
  if (nextHudStamp !== authoredHudStamp) {
    authoredHudStamp = nextHudStamp;
    const createHudWidget = (widget: GameHudWidget, inFlow = false) => {
      const element = document.createElement(
        widget.type === 'button' || widget.type === 'event-button' || widget.type === 'tab-button'
          ? 'button'
          : 'div',
      );
      Object.assign(element.style, gameHudStyle(widget, inFlow));
      if (widget.type === 'text') element.textContent = widget.text;
      else if (widget.type === 'panel') {
        // Child layout and accessibility are applied by createHudTree.
      } else if (widget.type === 'value')
        element.textContent = `${widget.prefix}${formatGameHudValue(gameHudValue(widget, state))}${widget.suffix}`;
      else if (widget.type === 'bar') {
        const value = gameHudValue(widget, state);
        const percent = Math.max(0, Math.min(100, ((value - widget.min) / (widget.max - widget.min)) * 100));
        element.setAttribute('role', 'progressbar');
        element.setAttribute('aria-label', widget.label || widget.id);
        element.setAttribute('aria-valuemin', String(widget.min));
        element.setAttribute('aria-valuemax', String(widget.max));
        element.setAttribute('aria-valuenow', String(value));
        if (widget.label) element.textContent = `${widget.label} · ${formatGameHudValue(value)}`;
        const track = document.createElement('div');
        Object.assign(track.style, {
          height: '8px',
          marginTop: '5px',
          overflow: 'hidden',
          borderRadius: '999px',
          background: '#ffffff30',
        });
        const fill = document.createElement('span');
        Object.assign(fill.style, {
          display: 'block',
          width: `${percent}%`,
          height: '100%',
          borderRadius: 'inherit',
          background: widget.fillColor,
        });
        track.append(fill);
        element.append(track);
      } else if (widget.type === 'inventory') {
        element.setAttribute('role', 'group');
        element.setAttribute('aria-label', 'Inventory');
        element.style.display = 'grid';
        element.style.gridTemplateColumns = `repeat(${widget.columns}, minmax(0, 1fr))`;
        element.style.gap = '6px';
        const sortRow = document.createElement('div');
        sortRow.style.gridColumn = '1 / -1';
        sortRow.style.display = 'flex';
        sortRow.style.justifyContent = 'flex-end';
        const sortButton = document.createElement('button');
        (sortButton as HTMLButtonElement).type = 'button';
        sortButton.className = 'authored-hud-button';
        sortButton.style.pointerEvents = 'auto';
        sortButton.textContent = 'Sort';
        sortButton.setAttribute('aria-label', 'Sort inventory by name');
        sortButton.disabled = state.status !== 'playing';
        sortButton.addEventListener('click', (event) => {
          event.preventDefault();
          viewport.sortInventoryByName();
        });
        sortRow.append(sortButton);
        element.append(sortRow);
        const stacks = hudState.inventory.slice(0, widget.maxItems);
        if (stacks.length === 0) {
          const empty = document.createElement('span');
          empty.textContent = 'Inventory empty';
          element.append(empty);
        } else
          for (const [index, stack] of stacks.entries()) {
            const slot = document.createElement('div');
            slot.setAttribute('draggable', 'true');
            slot.draggable = true;
            Object.assign(slot.style, {
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '6px',
              minWidth: '0',
              pointerEvents: 'auto',
            });
            slot.addEventListener('dragstart', (event) => {
              if (event.dataTransfer) {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', String(index));
              }
            });
            slot.addEventListener('dragover', (event) => event.preventDefault());
            slot.addEventListener('drop', (event) => {
              event.preventDefault();
              const fromIndex = Number(event.dataTransfer?.getData('text/plain'));
              if (Number.isInteger(fromIndex)) viewport.moveInventoryStack(fromIndex, index);
            });
            const label = document.createElement('span');
            label.textContent = `${index + 1}. ${stack.name ?? stack.itemId} ×${stack.quantity}`;
            slot.append(label);
            const orderControls = document.createElement('span');
            const moveEarlier = document.createElement('button');
            moveEarlier.className = 'authored-hud-button';
            moveEarlier.style.pointerEvents = 'auto';
            moveEarlier.textContent = '↑';
            moveEarlier.setAttribute('aria-label', `Move ${stack.name ?? stack.itemId} earlier`);
            moveEarlier.disabled = index === 0 || state.status !== 'playing';
            moveEarlier.addEventListener('click', (event) => {
              event.preventDefault();
              viewport.moveInventoryStack(index, index - 1);
            });
            const moveLater = document.createElement('button');
            moveLater.className = 'authored-hud-button';
            moveLater.style.pointerEvents = 'auto';
            moveLater.textContent = '↓';
            moveLater.setAttribute('aria-label', `Move ${stack.name ?? stack.itemId} later`);
            moveLater.disabled = index === state.inventory.length - 1 || state.status !== 'playing';
            moveLater.addEventListener('click', (event) => {
              event.preventDefault();
              viewport.moveInventoryStack(index, index + 1);
            });
            orderControls.append(moveEarlier, moveLater);
            slot.append(orderControls);
            if (widget.showUseButtons && stack.usable) {
              const button = document.createElement('button');
              (button as HTMLButtonElement).type = 'button';
              button.className = 'authored-hud-button';
              button.style.pointerEvents = 'auto';
              button.textContent = stack.actionLabel ?? 'Use';
              button.setAttribute(
                'aria-label',
                `${stack.actionLabel ?? 'Use'} ${stack.name ?? stack.itemId}`,
              );
              button.disabled = state.paused === true || state.status !== 'playing';
              button.addEventListener('click', (event) => {
                event.preventDefault();
                viewport.triggerUseItem(stack.itemId);
              });
              slot.append(button);
            }
            element.append(slot);
          }
        if (state.inventory.length > widget.maxItems) {
          const remaining = document.createElement('span');
          remaining.textContent = `+${state.inventory.length - widget.maxItems} more`;
          element.append(remaining);
        }
      } else if (widget.type === 'button') {
        const text = widget.action === 'togglePause' && state.paused ? 'Resume' : widget.text;
        (element as HTMLButtonElement).type = 'button';
        element.textContent = text;
        element.setAttribute('aria-label', text);
        if (widget.action === 'togglePause')
          element.setAttribute('aria-pressed', String(state.paused === true));
        element.className = 'authored-hud-button';
        element.addEventListener('click', (event) => {
          event.preventDefault();
          viewport.triggerAction(widget.action);
        });
      } else if (widget.type === 'tab-button') {
        const active = hudState.activeTabs[widget.groupId] === widget.tabId;
        (element as HTMLButtonElement).type = 'button';
        element.textContent = widget.text;
        element.setAttribute('aria-label', widget.text);
        element.setAttribute('aria-pressed', String(active));
        element.style.backgroundColor = active ? widget.fillColor : widget.background;
        element.className = 'authored-hud-button';
        element.addEventListener('click', (event) => {
          event.preventDefault();
          activeHudTabs = { ...activeHudTabs, [widget.groupId]: widget.tabId };
          if (latestHudState) viewport.onState?.(latestHudState);
        });
      } else {
        (element as HTMLButtonElement).type = 'button';
        element.textContent = widget.text;
        element.setAttribute('aria-label', widget.text);
        element.className = 'authored-hud-button';
        element.addEventListener('click', (event) => {
          event.preventDefault();
          viewport.triggerHudEvent(widget.eventId);
        });
      }
      return element;
    };
    const createHudTree = (node: (typeof hudTree)[number], inFlow = false) => {
      const { widget, children } = node;
      const element = createHudWidget(widget, inFlow);
      if (widget.type === 'panel') {
        if (children.length === 0) element.setAttribute('aria-hidden', 'true');
        element.append(...children.map((child) => createHudTree(child, widget.layout !== 'free')));
      }
      return element;
    };
    authoredHud.replaceChildren(...hudTree.map((node) => createHudTree(node)));
  }
  const player = activeScene.nodes.find((node) => node.id === state.playerId),
    playerSettings = player?.components.find((component) => component.type === 'player'),
    playerConstruction = player?.components.find((component) => component.type === 'construction'),
    playing = state.status === 'playing',
    paused = state.paused === true;
  touchControls.hidden = !player || !playing;
  if (touchControls.hidden || paused) {
    releaseJoystick();
    releaseTouchLook();
  }
  const usableSlot = state.inventory.findIndex((stack) =>
    activeScene.items.some((item) => item.id === stack.itemId && item.use),
  );
  touchPause.hidden = !player || !playing;
  touchPause.textContent = paused ? 'Resume' : 'Pause';
  touchPause.title = paused ? 'Resume game' : 'Pause game';
  touchPause.setAttribute('aria-label', paused ? 'Resume game' : 'Pause game');
  touchPause.setAttribute('aria-pressed', String(paused));
  touchUse.hidden = !player || !playing || paused || usableSlot < 0;
  if (usableSlot >= 0) {
    const stack = state.inventory[usableSlot];
    touchUse.textContent = `Use ${stack.name}`;
    touchUse.title = `Use ${stack.name} from inventory slot ${usableSlot + 1}`;
    touchUse.setAttribute('aria-label', touchUse.title);
  }
  touchStickWrap.hidden = paused;
  touchLook.hidden = paused;
  touchJump.hidden = !playerSettings || playerSettings.jump <= 0 || !playing || paused;
  touchInteract.hidden = !player || !state.interactionTarget || !playing || paused;
  touchInteract.textContent = 'Interact';
  touchInteract.title = state.interactionTarget?.prompt ?? 'Interact';
  touchInteract.setAttribute(
    'aria-label',
    state.interactionTarget ? `Interact: ${state.interactionTarget.prompt}` : 'Interact',
  );
  touchAttack.hidden = !player || !playing || paused;
  touchPlace.hidden =
    !playerConstruction || !playerConstruction.place || !activeScene.worldId || !playing || paused;
  touchRemove.hidden =
    !playerConstruction || !playerConstruction.remove || !activeScene.worldId || !playing || paused;
  status.textContent =
    state.status === 'playing'
      ? [
          state.message,
          paused && 'Paused',
          state.interactionTarget && `Interact · ${state.interactionTarget.prompt}`,
        ]
          .filter(Boolean)
          .join(' · ')
      : state.message ||
        (state.status === 'won' ? 'You won!' : state.status === 'lost' ? 'Try again' : 'Stopped');
  variables.textContent = [
    ...Object.entries(state.variables).map(([k, v]) => `${k}: ${v}`),
    ...(state.playerId && state.health[state.playerId] !== undefined
      ? [`health: ${state.health[state.playerId]}`]
      : []),
  ].join(' · ');
  const objectiveStamp = JSON.stringify(state.objectives);
  objectives.hidden = !state.objectives.length;
  if (objectiveStamp !== objectivesStamp) {
    objectivesStamp = objectiveStamp;
    objectives.replaceChildren(
      ...state.objectives.map((objective) => {
        const entry = document.createElement('li');
        const stateLabel = objective.completed ? 'complete' : objective.available ? 'available' : 'locked';
        entry.textContent = `${objective.completed ? '✓' : objective.available ? '○' : '🔒'} ${objective.text} (${objective.current} ${objective.condition.op} ${objective.condition.value})${objective.available ? '' : ' · Locked'}`;
        entry.setAttribute('aria-label', `${objective.text}: ${stateLabel}`);
        return entry;
      }),
    );
  }
  inventory.hidden =
    activeScene.items.length === 0 || hudWidgets.some((widget) => widget.type === 'inventory');
  inventory.textContent = `Inventory: ${
    state.inventory.length
      ? state.inventory
          .slice(0, 9)
          .map((stack, index) => {
            const shortcut = activeScene.items.some((item) => item.id === stack.itemId && item.use)
              ? `[${index + 1}] `
              : '';
            return `${shortcut}${stack.name} ×${stack.quantity}`;
          })
          .join(' · ') + (state.inventory.length > 9 ? ` · +${state.inventory.length - 9} more` : '')
      : 'empty'
  }`;
  const construction = state.construction;
  constructionControls.hidden = !construction;
  if (construction) {
    const stamp = JSON.stringify(construction.palette);
    if (stamp !== constructionPaletteStamp) {
      constructionPaletteStamp = stamp;
      constructionPaint.replaceChildren(
        ...construction.palette.map((paint) => {
          const option = document.createElement('option');
          option.value = paint.id;
          option.textContent = `${paint.name} · ${paint.materialType.toLowerCase()}`;
          return option;
        }),
      );
    }
    constructionPaint.value = construction.selectedId;
    constructionPaint.disabled = !construction.enabled;
  }
  instructions.textContent = instructionsForScene(activeScene);
  controls.textContent = controlsForScene(activeScene);
  controlsGuide.hidden = !controls.textContent;
};
constructionPaint.addEventListener('change', () => viewport.selectConstructionPaint(constructionPaint.value));
const currentFramePacing = viewport.framePacingSettings();
capFrameRate.checked = currentFramePacing.capFrameRate;
maxFpsTarget.value = String(currentFramePacing.maxFpsTarget);
const applyFramePacing = (settings: unknown) => {
  const applied = viewport.setFramePacing(settings);
  capFrameRate.checked = applied.capFrameRate;
  maxFpsTarget.value = String(applied.maxFpsTarget);
  const saved = saveFramePacing(applied);
  framePacingStatus.textContent = saved
    ? 'Render-rate preference saved in this browser.'
    : 'Render-rate preference is active for this session; browser storage is unavailable.';
  return { settings: applied, saved };
};
const applyFramePacingControls = () =>
  applyFramePacing({
    capFrameRate: capFrameRate.checked,
    maxFpsTarget: Number(maxFpsTarget.value),
  });
capFrameRate.addEventListener('change', applyFramePacingControls);
maxFpsTarget.addEventListener('change', applyFramePacingControls);
viewport.onPerformance = ({ rendererCallsPerSecond, rendererCallMsPerCall, simulationHz }) => {
  const simulation =
    viewport.multiplayerInfo().state !== 'disconnected'
      ? 'hosted simulation'
      : simulationHz > 0
        ? `${Math.round(simulationHz)} simulation Hz`
        : 'simulation stopped';
  performance.textContent = `${Math.round(rendererCallsPerSecond)} renderer calls/s · ${rendererCallMsPerCall.toFixed(2)} ms main-thread/render · ${simulation}`;
};
const inspectMode = new URLSearchParams(location.search).get('voxshop-inspect') === '1';
let multiplayerJoining = false;
let multiplayerLeaving = false;
const multiplayerActive = () => viewport.multiplayerInfo().state !== 'disconnected';
const refreshMultiplayerControls = () => {
  const info = viewport.multiplayerInfo();
  const active = info.state !== 'disconnected';
  multiplayerStatus.textContent = describeMultiplayerConnection(info);
  multiplayerJoin.disabled = multiplayerJoining || multiplayerLeaving || active;
  multiplayerJoin.textContent = multiplayerJoining ? 'Joining…' : 'Join room';
  multiplayerLeave.disabled = multiplayerLeaving || !active;
  for (const id of ['save-progress', 'load-progress', 'export-progress', 'import-progress', 'restart'])
    (document.getElementById(id)! as HTMLButtonElement).disabled = active;
  progressFile.disabled = active;
};
const progressBlockedByRoom = () => {
  if (!multiplayerActive()) return false;
  progressStatus.textContent = 'Progress controls are disabled while playing in a multiplayer room.';
  return true;
};
multiplayerCredentialToggle.addEventListener('click', () => {
  const show = multiplayerCredential.type === 'password';
  multiplayerCredential.type = show ? 'text' : 'password';
  multiplayerCredentialToggle.textContent = show ? 'Hide' : 'Show';
  multiplayerCredentialToggle.setAttribute('aria-pressed', String(show));
});
multiplayerCredential.addEventListener('focus', () => multiplayerCredential.select());
multiplayerForm.addEventListener('submit', (event: SubmitEvent) => {
  event.preventDefault();
  multiplayerError.textContent = '';
  let options;
  try {
    options = validateMultiplayerRoomOptions({
      websocketUrl: multiplayerEndpoint.value,
      gameId: multiplayerRoomId.value,
      credential: multiplayerCredential.value,
      resumeAfterReload: multiplayerResumeAfterReload.checked,
    });
  } catch (cause) {
    multiplayerError.textContent = multiplayerErrorMessage(cause, 'Check the room details and try again.');
    return;
  }
  multiplayerJoining = true;
  refreshMultiplayerControls();
  void viewport
    .joinMultiplayerRoom(options)
    .then(() => {
      refreshMultiplayerControls();
      multiplayerCredential.value = '';
      multiplayerCredential.type = 'password';
      multiplayerCredentialToggle.textContent = 'Show';
      multiplayerCredentialToggle.setAttribute('aria-pressed', 'false');
    })
    .catch((cause) => {
      multiplayerError.textContent = multiplayerErrorMessage(cause, 'Could not join the multiplayer room.');
    })
    .finally(() => {
      multiplayerJoining = false;
      refreshMultiplayerControls();
    });
});
multiplayerLeave.addEventListener('click', () => {
  multiplayerError.textContent = '';
  multiplayerLeaving = true;
  refreshMultiplayerControls();
  void viewport
    .leaveMultiplayerRoom()
    .catch((cause) => {
      multiplayerError.textContent = multiplayerErrorMessage(cause, 'Could not leave the multiplayer room.');
    })
    .finally(() => {
      multiplayerLeaving = false;
      refreshMultiplayerControls();
    });
});
multiplayerStatus.textContent = describeMultiplayerConnection(viewport.multiplayerInfo());
const multiplayerPoll = setInterval(refreshMultiplayerControls, 500);
const saveProgress = () => {
  if (progressBlockedByRoom()) return 'blocked';
  const snapshot = viewport.campaignProgressSnapshot();
  if (!snapshot) {
    progressStatus.textContent = 'This run cannot be saved while the simulation is stopped.';
    return 'invalid';
  }
  const result = campaignStore.save(snapshot);
  progressStatus.textContent =
    result === 'saved'
      ? 'Progress saved in this browser.'
      : result === 'too-large'
        ? 'Progress is too large for the bounded local save.'
        : result === 'unavailable'
          ? 'Browser storage is unavailable; progress was not saved.'
          : 'Progress could not be serialized; progress was not saved.';
  return result;
};
const loadProgress = () => {
  if (progressBlockedByRoom()) return 'blocked';
  const result = savedProgress();
  if (result.status === 'loaded') {
    viewport.play(inspectMode, result.snapshot, project.activeSceneId);
    const activeSceneId =
      'activeSceneId' in result.snapshot ? result.snapshot.activeSceneId : result.snapshot.sceneId;
    if (viewport.progressRestoredSceneId === activeSceneId) {
      progressStatus.textContent = 'Saved progress loaded from this browser.';
      return 'loaded';
    }
    // Keep a structurally valid save if this build's content is incompatible with it.
    progressStatus.textContent = 'Saved progress did not match this game and was ignored.';
    return 'invalid';
  }
  if (result.status === 'invalid')
    progressStatus.textContent = 'Invalid or unsupported saved progress was ignored.';
  else if (result.status === 'unavailable')
    progressStatus.textContent = 'Browser storage is unavailable; this run started fresh.';
  else progressStatus.textContent = 'No saved progress exists for this game in this browser.';
  return result.status;
};
const exportProgress = () => {
  if (progressBlockedByRoom()) return 'blocked';
  const snapshot = viewport.campaignProgressSnapshot(),
    serialized = snapshot && serializeCampaignProgress(snapshot);
  if (!serialized) {
    progressStatus.textContent = 'This run cannot be exported as a bounded save file.';
    return 'invalid';
  }
  const url = URL.createObjectURL(new Blob([serialized], { type: 'application/json' })),
    link = document.createElement('a');
  link.href = url;
  link.download = `voxshop-${project.id}-progress.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  progressStatus.textContent = 'Progress exported to a save file.';
  return 'exported';
};
const compatibleCampaign = (snapshot: CampaignProgressSnapshot) => {
  let candidate: GameSession | undefined;
  try {
    candidate = new GameSession(project, project.activeSceneId, snapshot);
    return (
      candidate.simulation.scene.id === snapshot.activeSceneId &&
      candidate.progressWasRestored(snapshot.activeSceneId)
    );
  } catch {
    return false;
  } finally {
    if (candidate) {
      void candidate.ready.catch(() => undefined);
      candidate.dispose();
    }
  }
};
const importProgress = async () => {
  if (progressBlockedByRoom()) return 'blocked';
  const file = progressFile.files?.[0];
  if (!file) return 'empty';
  try {
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_CAMPAIGN_PROGRESS_BYTES) {
      progressStatus.textContent = 'Save file is too large or invalid; current progress was kept.';
      return 'invalid';
    }
    const snapshot = parseCampaignProgress(await file.text(), project.id, project.activeSceneId);
    if (!snapshot || !compatibleCampaign(snapshot)) {
      progressStatus.textContent =
        'Save file is invalid, belongs to another game, or no longer matches this game; current progress and browser save were kept.';
      return 'invalid';
    }
    const result = campaignStore.save(snapshot);
    if (result !== 'saved') {
      progressStatus.textContent =
        result === 'unavailable'
          ? 'Browser storage is unavailable; the save file was not imported.'
          : 'Save file could not be stored; the current run was kept.';
      return result;
    }
    viewport.play(inspectMode, snapshot, project.activeSceneId);
    progressStatus.textContent = 'Progress imported from the save file and saved in this browser.';
    return 'loaded';
  } catch {
    progressStatus.textContent = 'Save file could not be read; current progress and browser save were kept.';
    return 'invalid';
  } finally {
    progressFile.value = '';
  }
};
document.getElementById('save-progress')!.addEventListener('click', saveProgress);
document.getElementById('load-progress')!.addEventListener('click', loadProgress);
document.getElementById('export-progress')!.addEventListener('click', exportProgress);
document.getElementById('import-progress')!.addEventListener('click', () => progressFile.click());
progressFile.addEventListener('change', importProgress);
const restart = () => {
  if (progressBlockedByRoom()) return 'blocked';
  viewport.play(inspectMode);
  progressStatus.textContent = 'Restarted from the authored beginning; saved progress remains available.';
};
document.getElementById('restart')!.addEventListener('click', restart);
loadProgress();
if (!viewport.simulation) viewport.play(inspectMode);
creatorWalkthrough(viewport);
void viewport
  .resumeMultiplayerRoom()
  .then((resumed) => {
    if (resumed) multiplayerResumeAfterReload.checked = true;
  })
  .catch((cause) => {
    multiplayerError.textContent = multiplayerErrorMessage(
      cause,
      'Could not resume the saved multiplayer player.',
    );
  });
// Documented, bounded runtime inspection API for creators' external test harnesses.
Object.assign(window, {
  VoxShopGame: {
    apiVersion: 1,
    ready: () => viewport.ready,
    inspect: () => viewport.simulation!.inspect(),
    scenePath: () => viewport.scenePath,
    performance: () => viewport.performanceInfo(),
    measurePerformance: (durationMs = 5000) => viewport.measurePerformance(durationMs),
    framePacing: () => viewport.framePacingSettings(),
    setFramePacing: applyFramePacing,
    step: (input: any, frames = 1) => {
      if (!Number.isInteger(frames) || frames < 1 || frames > 18000)
        throw new Error('Frames must be 1..18000.');
      return viewport.step(input, frames);
    },
    saveProgress,
    loadProgress,
    restart,
  },
});
window.addEventListener(
  'pagehide',
  () => {
    clearInterval(multiplayerPoll);
    viewport.dispose();
  },
  { once: true },
);
