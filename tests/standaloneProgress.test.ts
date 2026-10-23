import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import { GameSession } from '../runtime/GameSession';
import { describePlayerControls } from '../services/playerControls';
import { constructionProject } from './fixtures/constructionProject';
import { CampaignProgressStore, campaignProgressStorageKey } from '../runtime/campaignProgress';
import { GameProgressStore, gameProgressStorageKey, type ProgressStorageLike } from '../runtime/gameProgress';
import {
  MAX_CAMPAIGN_PROGRESS_BYTES,
  parseCampaignProgress,
  serializeCampaignProgress,
} from '../runtime/campaignProgress';
import { renderGameHtml } from '../runtime/gameExport';
import {
  describeMultiplayerConnection,
  multiplayerErrorMessage,
  presentMultiplayerError,
  validateMultiplayerRoomOptions,
} from '../runtime/multiplayerControls';
import { DEFAULT_FRAME_PACING, normalizeFramePacing } from '../runtime/framePacing';
import {
  formatGameHudValue,
  gameHudActiveTabs,
  gameHudStamp,
  gameHudStyle,
  gameHudTree,
  gameHudValue,
  gameHudVisible,
} from '../runtime/gameHud';
import {
  identityTransform,
  gameHudWidgetSchema,
  nodeSchema,
  newProject,
  validateProject,
  type ProjectDocument,
} from '../services/projectDocument';

const standaloneCode = transformSync(readFileSync('runtime/standalone.ts', 'utf8'), {
  loader: 'ts',
  format: 'cjs',
  target: 'es2022',
}).code;

function project() {
  const draft = newProject('standalone-campaign', 'Standalone campaign');
  draft.scenes = ['main', 'second'].map((id, index) => ({
    ...structuredClone(draft.scenes[0]),
    id,
    variables: { visits: 0 },
    items: [{ id: 'ticket', name: 'Ticket', description: '', maxStack: 10 }],
    nodes: [
      {
        id: 'gate',
        name: 'Gate',
        assetId: null,
        parentId: null,
        transform: identityTransform(),
        enabled: true,
        attachments: [],
        components: [
          {
            type: 'rules' as const,
            apiVersion: 1 as const,
            rules: [
              {
                event: 'tick' as const,
                once: true,
                interval: 1,
                actions: [
                  { type: 'inventory' as const, add: [{ itemId: 'ticket', quantity: 1 }], remove: [] },
                  { type: 'add' as const, variable: 'visits', value: 1 },
                  { type: 'transition' as const, sceneId: index === 0 ? 'second' : 'main' },
                ],
              },
            ],
          },
        ],
      },
    ],
  }));
  return validateProject(draft);
}

class MemoryStorage implements ProgressStorageLike {
  values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

// Execute the real standalone module with WebGL replaced by a session-backed viewport.
// This checks startup and Save/Load orchestration; it provides no rendering evidence.
function boot(
  document: ProjectDocument,
  storage: ProgressStorageLike,
  embeddedWorkers?: { terrain?: string; voxel?: string },
) {
  class Element {
    tagName = 'div';
    textContent = '';
    title = '';
    hidden = false;
    open = true;
    checked = false;
    value = '';
    disabled = false;
    style: Record<string, string> = {};
    attributes = new Map<string, string>();
    files: { size: number; text(): Promise<string> }[] = [];
    href = '';
    download = '';
    clicks = 0;
    pointerCapture: number | null = null;
    dispatched: { type: string; code?: string }[] = [];
    children: Element[] = [];
    listeners = new Map<string, (...args: any[]) => any>();
    addEventListener(type: string, listener: (...args: any[]) => any) {
      this.listeners.set(type, listener);
    }
    dispatchEvent(event: any) {
      this.dispatched.push({ type: event.type, code: event.code });
      this.listeners.get(event.type)?.(event);
      return !event.defaultPrevented;
    }
    replaceChildren(...children: Element[]) {
      this.children = children;
    }
    setAttribute(name: string, value: string) {
      this.attributes.set(name, value);
    }
    appendChild(child: Element) {
      this.children.push(child);
      return child;
    }
    append(...children: Element[]) {
      this.children.push(...children);
    }
    querySelector(selector: string) {
      return selector === 'canvas'
        ? (this.children.find((child) => child.tagName === 'canvas') ?? null)
        : null;
    }
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 100, height: 100 };
    }
    setPointerCapture(pointerId: number) {
      this.pointerCapture = pointerId;
    }
    hasPointerCapture(pointerId: number) {
      return this.pointerCapture === pointerId;
    }
    releasePointerCapture(pointerId: number) {
      if (this.pointerCapture === pointerId) this.pointerCapture = null;
    }
    click() {
      this.clicks++;
      if (this.download) downloads.push({ href: this.href, download: this.download });
      this.dispatchEvent({ type: 'click', preventDefault() {} });
    }
    select() {}
  }
  const downloads: { href: string; download: string }[] = [],
    exportedBlobs: { text(): Promise<string>; type?: string }[] = [],
    createdWorkers: { url: string; terminated: boolean }[] = [];
  class BrowserBlob {
    readonly type: string;
    constructor(parts: string[], options?: { type?: string }) {
      this.type = options?.type ?? '';
      exportedBlobs.push(this);
      this.content = parts.join('');
    }
    private content: string;
    async text() {
      return this.content;
    }
  }
  const elements = new Map<string, Element>();
  const element = (id: string) => {
    let selected = elements.get(id);
    if (!selected) elements.set(id, (selected = new Element()));
    return selected;
  };
  element('voxshop-project').textContent = JSON.stringify(document);
  element('voxshop-workers').textContent = embeddedWorkers ? JSON.stringify(embeddedWorkers) : '';
  const viewports: Viewport[] = [];
  class Viewport {
    session: GameSession | null = null;
    progressRestoredSceneId: string | null = null;
    cameraLook: [number, number][] = [];
    touchMovement: [number, number] = [0, 0];
    touchMovementSamples: [number, number][] = [];
    triggeredActions: string[] = [];
    triggeredItems: string[] = [];
    multiplayer: {
      state: 'connected' | 'connecting' | 'reconnecting' | 'disconnected';
      playerId?: string;
      gameId?: string;
      error?: string;
    } = { state: 'disconnected' };
    joinRequests: { websocketUrl: string; gameId: string; credential: string }[] = [];
    leaveRequests = 0;
    onState?: (state: ReturnType<GameSession['simulation']['inspect']>) => void;
    agentDriven = false;
    options: Record<string, unknown>;
    framePacing: ReturnType<typeof normalizeFramePacing>;
    constructor(
      _container: unknown,
      _project: unknown,
      _onSelect: unknown,
      options: Record<string, unknown>,
    ) {
      viewports.push(this);
      this.options = options;
      this.framePacing = normalizeFramePacing(options.framePacing ?? DEFAULT_FRAME_PACING);
      const canvas = new Element();
      canvas.tagName = 'canvas';
      element('game').appendChild(canvas);
      this.canvas = canvas;
    }
    canvas: Element;
    get simulation() {
      return this.session?.simulation ?? null;
    }
    get ready() {
      return this.session?.ready ?? Promise.resolve();
    }
    get scenePath() {
      return this.session?.scenePath ?? [];
    }
    framePacingSettings() {
      return { ...this.framePacing };
    }
    setFramePacing(settings: unknown) {
      this.framePacing = normalizeFramePacing(settings);
      return this.framePacingSettings();
    }
    multiplayerInfo() {
      return { ...this.multiplayer };
    }
    joinMultiplayerRoom(options: { websocketUrl: string; gameId: string; credential: string }) {
      this.joinRequests.push({ ...options });
      this.multiplayer = { state: 'connected', playerId: 'player-1', gameId: options.gameId };
      return Promise.resolve();
    }
    leaveMultiplayerRoom() {
      this.leaveRequests++;
      this.multiplayer = { state: 'disconnected' };
      return Promise.resolve();
    }
    play(agentDriven = false, progress?: unknown, sceneId = document.activeSceneId) {
      this.session?.dispose();
      this.agentDriven = agentDriven;
      this.session = new GameSession(document, sceneId, progress);
      const active = this.simulation!.scene.id;
      this.progressRestoredSceneId = this.session.progressWasRestored(active) ? active : null;
      this.onState?.(this.simulation!.inspect());
    }
    campaignProgressSnapshot() {
      return this.session?.progressSnapshot() ?? null;
    }
    selectConstructionPaint(id: string) {
      const selected = this.simulation!.selectConstructionPaint(id);
      this.onState?.(this.simulation!.inspect());
      return selected;
    }
    lookByTouch(deltaX: number, deltaY: number) {
      this.cameraLook.push([deltaX, deltaY]);
      return true;
    }
    setTouchMovement(moveX: number, moveZ: number) {
      this.touchMovement = [moveX, moveZ];
      this.touchMovementSamples.push(this.touchMovement);
    }
    triggerAction(action: string) {
      this.triggeredActions.push(action);
      return true;
    }
    triggerUseItem(itemId: string) {
      this.triggeredItems.push(itemId);
      if (!this.session) return false;
      this.session.step({ useItem: itemId });
      this.onState?.(this.session.simulation.inspect());
      return true;
    }
    moveInventoryStack(fromIndex: number, toIndex: number) {
      const simulation = this.session?.simulation;
      if (!simulation?.moveInventoryStack(fromIndex, toIndex)) return false;
      this.onState?.(simulation.inspect());
      return true;
    }
    sortInventoryByName() {
      const simulation = this.session?.simulation;
      if (!simulation?.sortInventoryByName()) return false;
      this.onState?.(simulation.inspect());
      return true;
    }
    step(input = {}, frames = 1) {
      for (let frame = 0; frame < frames; frame++) this.session!.step(input);
      return this.simulation!.inspect();
    }
    dispose() {
      this.session?.dispose();
    }
  }
  class BrowserWorker {
    readonly record: { url: string; terminated: boolean };
    constructor(url: string) {
      this.record = { url, terminated: false };
      createdWorkers.push(this.record);
    }
    postMessage() {}
    terminate() {
      this.record.terminated = true;
    }
  }
  const browser: Record<string, any> = { addEventListener() {} };
  runInNewContext(standaloneCode, {
    require(name: string) {
      if (name === './GameViewport') return { GameViewport: Viewport };
      if (name === './creatorWalkthrough') return { creatorWalkthrough() {} };
      if (name === './GameSession') return { GameSession };
      if (name === './multiplayerControls')
        return {
          describeMultiplayerConnection,
          multiplayerErrorMessage,
          presentMultiplayerError,
          validateMultiplayerRoomOptions,
        };
      if (name === './framePacing') return { DEFAULT_FRAME_PACING, normalizeFramePacing };
      if (name === './gameHud')
        return {
          formatGameHudValue,
          gameHudActiveTabs,
          gameHudStamp,
          gameHudStyle,
          gameHudTree,
          gameHudValue,
          gameHudVisible,
        };
      if (name === '../services/playerControls') return { describePlayerControls };
      if (name === './gameProgress')
        return {
          GameProgressStore: class extends GameProgressStore {
            constructor(projectId: string, sceneId: string) {
              super(projectId, sceneId, () => storage);
            }
          },
        };
      if (name === './campaignProgress')
        return {
          CampaignProgressStore: class extends CampaignProgressStore {
            constructor(projectId: string, sceneId: string) {
              super(projectId, sceneId, () => storage);
            }
          },
          MAX_CAMPAIGN_PROGRESS_BYTES,
          parseCampaignProgress,
          serializeCampaignProgress,
        };
      throw new Error(`Unexpected standalone dependency: ${name}`);
    },
    window: browser,
    document: {
      getElementById: element,
      querySelector: (selector: string) =>
        selector === '#game canvas' ? element('game').querySelector('canvas') : null,
      createElement: () => new Element(),
    },
    location: { search: '?voxshop-inspect=1' },
    KeyboardEvent: class {
      defaultPrevented = false;
      constructor(
        readonly type: string,
        readonly options: { code: string; bubbles?: boolean; cancelable?: boolean },
      ) {
        this.code = options.code;
      }
      readonly code: string;
      preventDefault() {
        this.defaultPrevented = true;
      }
    },
    URLSearchParams,
    localStorage: storage,
    Blob: BrowserBlob,
    Worker: BrowserWorker,
    URL: {
      createObjectURL: () => `blob:save-${exportedBlobs.length}`,
      revokeObjectURL() {},
    },
    setTimeout: (callback: () => void) => callback(),
    setInterval: () => 1,
    clearInterval() {},
  });
  return {
    api: browser.VoxShopGame as {
      saveProgress(): string;
      loadProgress(): string;
      exportProgress(): string;
      importProgress(): Promise<string>;
      restart(): void;
      step(input: object, frames?: number): unknown;
      framePacing(): ReturnType<typeof normalizeFramePacing>;
      setFramePacing(settings: unknown): {
        settings: ReturnType<typeof normalizeFramePacing>;
        saved: boolean;
      };
      joinMultiplayerRoom(options: {
        websocketUrl: string;
        gameId: string;
        credential: string;
      }): Promise<void>;
      leaveMultiplayerRoom(): Promise<void>;
    },
    viewport: viewports[0],
    element,
    downloads,
    exportedBlobs,
    createdWorkers,
    viewports,
  };
}

test('standalone frame pacing defaults uncapped and persists UI and agent preferences per project', () => {
  const authored = project(),
    storage = new MemoryStorage(),
    first = boot(authored, storage);
  try {
    assert.deepEqual(first.viewport.framePacingSettings(), { capFrameRate: false, maxFpsTarget: 144 });
    assert.equal(first.element('cap-frame-rate').checked, false);
    assert.equal(first.element('max-fps-target').value, '144');

    first.element('cap-frame-rate').checked = true;
    first.element('max-fps-target').value = '60';
    first.element('max-fps-target').dispatchEvent({ type: 'change' });
    assert.deepEqual(first.viewport.framePacingSettings(), { capFrameRate: true, maxFpsTarget: 60 });
    assert.equal(
      first.element('frame-pacing-status').textContent,
      'Render-rate preference saved in this browser.',
    );

    assert.deepEqual(
      JSON.parse(JSON.stringify(first.api.setFramePacing({ capFrameRate: true, maxFpsTarget: 240 }))),
      {
        settings: { capFrameRate: true, maxFpsTarget: 240 },
        saved: true,
      },
    );
    assert.equal(first.element('max-fps-target').value, '240');
    assert.deepEqual(first.api.framePacing(), { capFrameRate: true, maxFpsTarget: 240 });
  } finally {
    first.viewport.dispose();
  }

  const reloaded = boot(authored, storage);
  try {
    assert.deepEqual(reloaded.viewport.framePacingSettings(), { capFrameRate: true, maxFpsTarget: 240 });
  } finally {
    reloaded.viewport.dispose();
  }
});

test('standalone multiplayer join is opt-in, keeps credentials in memory, and protects offline saves', async () => {
  const storage = new MemoryStorage();
  const app = boot(validateProject(project()), storage);
  const credential = 'B'.repeat(43);
  try {
    assert.equal(app.element('multiplayer-status').textContent, 'Offline. Multiplayer is optional.');
    app.element('multiplayer-endpoint').value = 'ws://remote.example/multiplayer';
    app.element('multiplayer-room-id').value = 'room_1';
    app.element('multiplayer-credential').value = credential;
    app.element('multiplayer-form').dispatchEvent({
      type: 'submit',
      preventDefault() {},
    });
    assert.match(app.element('multiplayer-error').textContent, /secure wss|local ws/);
    assert.equal(app.viewport.joinRequests.length, 0);

    app.element('multiplayer-endpoint').value = 'wss://rooms.example.test/multiplayer';
    app.element('multiplayer-form').dispatchEvent({
      type: 'submit',
      preventDefault() {},
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(app.viewport.joinRequests, [
      {
        websocketUrl: 'wss://rooms.example.test/multiplayer',
        gameId: 'room_1',
        credential,
      },
    ]);
    assert.equal(app.element('multiplayer-credential').value, '');
    assert.match(app.element('multiplayer-status').textContent, /Connected as player-1 · room room_1/);
    for (const id of ['save-progress', 'load-progress', 'export-progress', 'import-progress', 'restart'])
      assert.equal(app.element(id).disabled, true, `${id} disabled while host controls the game`);

    const savedBeforeAttempt = [...storage.values];
    assert.equal(app.api.saveProgress(), 'blocked');
    assert.deepEqual([...storage.values], savedBeforeAttempt);
    assert.ok([...storage.values.values()].every((value) => !value.includes(credential)));

    app.element('multiplayer-leave').dispatchEvent({ type: 'click' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(app.viewport.leaveRequests, 1);
    assert.equal(app.element('multiplayer-status').textContent, 'Offline. Multiplayer is optional.');
    for (const id of ['save-progress', 'load-progress', 'export-progress', 'import-progress', 'restart'])
      assert.equal(app.element(id).disabled, false, `${id} available again after leaving`);
  } finally {
    app.viewport.dispose();
  }
});

test('standalone runtime places authored HUD widgets inside a flow panel', () => {
  const authored = project();
  authored.scenes[0]!.variables.unlocked = 1;
  authored.scenes[0]!.hud = [
    gameHudWidgetSchema.parse({ id: 'menu', type: 'panel', layout: 'column', gap: 10, padding: 16 }),
    gameHudWidgetSchema.parse({
      id: 'title',
      type: 'text',
      text: 'Pause menu',
      parentId: 'menu',
    }),
    gameHudWidgetSchema.parse({
      id: 'resume',
      type: 'button',
      text: 'Resume',
      action: 'togglePause',
      parentId: 'actions',
    }),
    gameHudWidgetSchema.parse({
      id: 'actions',
      type: 'panel',
      parentId: 'menu',
      layout: 'row',
      gap: 6,
    }),
  ];
  const app = boot(validateProject(authored), new MemoryStorage());
  try {
    const hud = app.element('authored-hud'),
      panel = hud.children[0]!;
    assert.equal(hud.hidden, false);
    assert.equal(panel.style.display, 'flex');
    assert.equal(panel.style.flexDirection, 'column');
    assert.equal(panel.style.gap, '10px');
    assert.equal(panel.style.padding, '16px');
    assert.equal(panel.children.length, 2);
    assert.equal(panel.children[0]!.textContent, 'Pause menu');
    assert.equal(panel.children[0]!.style.position, 'relative');
    assert.equal(panel.children[1]!.style.display, 'flex');
    assert.equal(panel.children[1]!.style.flexDirection, 'row');
    assert.equal(panel.children[1]!.children[0]!.textContent, 'Resume');
    assert.equal(panel.children[1]!.children[0]!.style.position, 'relative');
  } finally {
    app.viewport.dispose();
  }
});

test('standalone HUD tab buttons switch between authored pages', () => {
  const authored = project();
  authored.scenes[0]!.hud = [
    gameHudWidgetSchema.parse({ id: 'tabs', type: 'panel', layout: 'row' }),
    gameHudWidgetSchema.parse({
      id: 'home-tab',
      type: 'tab-button',
      text: 'Home',
      groupId: 'menu',
      tabId: 'home',
      parentId: 'tabs',
    }),
    gameHudWidgetSchema.parse({
      id: 'settings-tab',
      type: 'tab-button',
      text: 'Settings',
      groupId: 'menu',
      tabId: 'settings',
      parentId: 'tabs',
    }),
    gameHudWidgetSchema.parse({
      id: 'home-page',
      type: 'panel',
      visibleWhenTab: { groupId: 'menu', tabId: 'home' },
    }),
    gameHudWidgetSchema.parse({ id: 'home-copy', type: 'text', text: 'Home page', parentId: 'home-page' }),
    gameHudWidgetSchema.parse({
      id: 'settings-page',
      type: 'panel',
      visibleWhenTab: { groupId: 'menu', tabId: 'settings' },
    }),
    gameHudWidgetSchema.parse({
      id: 'settings-copy',
      type: 'text',
      text: 'Settings page',
      parentId: 'settings-page',
    }),
  ];
  const app = boot(validateProject(authored), new MemoryStorage());
  try {
    const hud = app.element('authored-hud');
    assert.equal(app.element('game-menu').open, false, 'Authored UI starts with the system menu collapsed.');
    assert.equal(app.element('game-hud').attributes.get('data-authored'), 'true');
    app.element('game-menu').open = true;
    assert.equal(hud.children.length, 2);
    assert.equal(hud.children[0]!.children[0]!.attributes.get('aria-pressed'), 'true');
    assert.equal(hud.children[1]!.children[0]!.textContent, 'Home page');
    assert.equal(
      hud.children.some((child) => child.children[0]?.textContent === 'Settings page'),
      false,
    );

    hud.children[0]!.children[1]!.dispatchEvent({ type: 'click', preventDefault() {} });
    assert.equal(app.element('game-menu').open, true, 'State updates retain a manually opened menu.');
    assert.equal(hud.children.length, 2);
    assert.equal(hud.children[0]!.children[0]!.attributes.get('aria-pressed'), 'false');
    assert.equal(hud.children[0]!.children[1]!.attributes.get('aria-pressed'), 'true');
    assert.equal(hud.children[1]!.children[0]!.textContent, 'Settings page');
    assert.equal(
      hud.children.some((child) => child.children[0]?.textContent === 'Home page'),
      false,
    );
  } finally {
    app.viewport.dispose();
  }
});

test('standalone authored inventory grid replaces the summary and uses the selected usable stack', () => {
  const authored = constructionProject();
  authored.scenes[0]!.items.push({
    id: 'potion',
    name: 'Healing potion',
    description: '',
    maxStack: 10,
    use: { type: 'heal', amount: 25 },
  });
  authored.scenes[0]!.items.push({ id: 'antidote', name: 'Antidote', description: '', maxStack: 10 });
  authored.scenes[0]!.nodes[0]!.components.push({ type: 'health', maximum: 100 });
  authored.scenes[0]!.hud = [
    gameHudWidgetSchema.parse({ id: 'bag', type: 'inventory', maxItems: 6, columns: 2 }),
  ];
  const app = boot(validateProject(authored), new MemoryStorage());
  try {
    const simulation = app.viewport.simulation!;
    simulation.health.player = 50;
    simulation.inventory = [
      { itemId: 'potion', quantity: 1 },
      { itemId: 'antidote', quantity: 1 },
    ];
    app.viewport.onState!(simulation.inspect());
    const hud = app.element('authored-hud'),
      inventoryGrid = hud.children[0]!;
    assert.equal(app.element('inventory').hidden, true);
    assert.equal(inventoryGrid.style.gridTemplateColumns, 'repeat(2, minmax(0, 1fr))');
    inventoryGrid.children[0]!.children[0]!.dispatchEvent({ type: 'click', preventDefault() {} });
    assert.deepEqual(
      simulation.inventory.map((stack) => stack.itemId),
      ['antidote', 'potion'],
    );
    let grid = app.element('authored-hud').children[0]!;
    assert.equal(grid.children[1]!.children[0]!.textContent, '1. Antidote ×1');
    assert.equal(grid.children[2]!.children[0]!.textContent, '2. Healing potion ×1');
    const transfer = {
      value: '',
      setData(_type: string, value: string) {
        this.value = value;
      },
      getData() {
        return this.value;
      },
    };
    grid.children[2]!.dispatchEvent({ type: 'dragstart', dataTransfer: transfer });
    grid.children[1]!.dispatchEvent({ type: 'drop', dataTransfer: transfer, preventDefault() {} });
    assert.deepEqual(
      simulation.inventory.map((stack) => stack.itemId),
      ['potion', 'antidote'],
    );
    grid = app.element('authored-hud').children[0]!;
    assert.equal(grid.children[1]!.children[0]!.textContent, '1. Healing potion ×1');
    const use = grid.children[1]!.children[2]!;
    assert.equal(use.attributes.get('aria-label'), 'Use Healing potion');
    use.dispatchEvent({ type: 'click', preventDefault() {} });
    assert.equal(simulation.health.player, 75);
    assert.deepEqual(simulation.inventory, [{ itemId: 'antidote', quantity: 1 }]);
    assert.deepEqual(app.viewport.triggeredItems, ['potion']);
  } finally {
    app.viewport.dispose();
  }
});

test('standalone enables embedded terrain workers and keeps the synchronous fallback when unavailable', () => {
  const authored = project();
  const app = boot(authored, new MemoryStorage(), {
    terrain: 'self.onmessage = () => {};',
    voxel: 'self.onmessage = () => {};',
  });
  const options = app.viewport.options as {
    asyncTerrainTiles: boolean;
    asyncVoxelChunks: boolean;
    createTerrainWorker: () => { record: { url: string } };
    createVoxelWorker: () => { record: { url: string } };
  };
  assert.equal(options.asyncTerrainTiles, true);
  assert.equal(options.asyncVoxelChunks, true);
  const firstTerrain = options.createTerrainWorker();
  const secondTerrain = options.createTerrainWorker();
  const voxel = options.createVoxelWorker();
  assert.equal(
    firstTerrain.record.url,
    secondTerrain.record.url,
    'A worker source URL is reused across scene visits.',
  );
  assert.notEqual(firstTerrain.record.url, voxel.record.url);
  assert.equal(app.createdWorkers.length, 3);

  const fallback = boot(authored, new MemoryStorage());
  const fallbackOptions = fallback.viewport.options as {
    asyncTerrainTiles: boolean;
    asyncVoxelChunks: boolean;
    createTerrainWorker?: () => unknown;
    createVoxelWorker?: () => unknown;
  };
  assert.equal(fallbackOptions.asyncTerrainTiles, false);
  assert.equal(fallbackOptions.asyncVoxelChunks, false);
  assert.equal(fallbackOptions.createTerrainWorker, undefined);
  assert.equal(fallbackOptions.createVoxelWorker, undefined);
  app.viewport.dispose();
  fallback.viewport.dispose();
});

test('standalone Save, reload, fresh restart and Load retain a whole multi-scene campaign', () => {
  const authored = project(),
    storage = new MemoryStorage(),
    first = boot(authored, storage);
  assert.equal(first.viewport.simulation!.scene.id, 'main');
  first.api.step({});
  assert.equal(first.viewport.simulation!.scene.id, 'second');
  assert.deepEqual(first.viewport.simulation!.inventory, [{ itemId: 'ticket', quantity: 1 }]);
  assert.equal(first.api.saveProgress(), 'saved');
  first.viewport.dispose();

  const reloaded = boot(authored, storage);
  assert.equal(reloaded.viewport.simulation!.scene.id, 'second');
  assert.equal(reloaded.viewport.progressRestoredSceneId, 'second');
  assert.match(reloaded.element('progress-status').textContent, /loaded/i);
  reloaded.api.step({});
  assert.equal(reloaded.viewport.simulation!.scene.id, 'main');
  assert.equal(reloaded.viewport.simulation!.variables.visits, 1);
  assert.deepEqual(reloaded.viewport.simulation!.inventory, [{ itemId: 'ticket', quantity: 2 }]);
  reloaded.api.step({});
  assert.equal(reloaded.viewport.simulation!.scene.id, 'main', 'A completed once rule stays completed.');
  assert.deepEqual(
    reloaded.viewport.simulation!.inventory,
    [{ itemId: 'ticket', quantity: 2 }],
    'Resume/re-entry cannot duplicate a once-only inventory reward.',
  );

  reloaded.api.restart();
  assert.equal(reloaded.viewport.simulation!.scene.id, 'main');
  assert.equal(reloaded.viewport.simulation!.variables.visits, 0);
  assert.equal(reloaded.viewport.agentDriven, true, 'API restart preserves creator inspection mode.');
  assert.match(reloaded.element('progress-status').textContent, /Restarted/);
  assert.equal(reloaded.api.loadProgress(), 'loaded');
  assert.equal(reloaded.viewport.simulation!.scene.id, 'second');
  reloaded.viewport.dispose();
});

test('standalone reads legacy entry saves, writes a separate campaign key and preserves the legacy data', () => {
  const authored = project(),
    storage = new MemoryStorage();
  const original = new GameSession(authored, 'main');
  original.simulation.variables.visits = 7;
  const legacy = new GameProgressStore(authored.id, 'main', () => storage);
  assert.equal(legacy.save(original.simulation.progressSnapshot()!), 'saved');
  original.dispose();
  const prior = storage.getItem(gameProgressStorageKey(authored.id, 'main'));
  const app = boot(authored, storage);
  assert.equal(app.viewport.simulation!.variables.visits, 7);
  assert.equal(app.api.saveProgress(), 'saved');
  assert.ok(storage.getItem(campaignProgressStorageKey(authored.id, 'main')));
  assert.equal(storage.getItem(legacy.key), prior);
  app.viewport.dispose();
  storage.setItem(campaignProgressStorageKey(authored.id, 'main'), '{ malformed');
  const recovered = boot(authored, storage);
  assert.equal(
    recovered.viewport.simulation!.variables.visits,
    7,
    'An intact legacy save recovers immediately when campaign data is malformed.',
  );
  assert.match(recovered.element('progress-status').textContent, /loaded/i);
  recovered.viewport.dispose();
});

test('standalone rejects incompatible campaigns atomically and survives unavailable browser storage', () => {
  const authored = project(),
    storage = new MemoryStorage(),
    original = new GameSession(authored, 'main');
  original.step();
  const saved = original.progressSnapshot()!;
  saved.scenes[0].nodes.missing = { enabled: false };
  new CampaignProgressStore(authored.id, 'main', () => storage).save(saved);
  original.dispose();
  const invalid = boot(authored, storage);
  assert.equal(invalid.viewport.simulation!.scene.id, 'main');
  assert.equal(invalid.viewport.simulation!.variables.visits, 0);
  assert.match(invalid.element('progress-status').textContent, /did not match/);
  assert.ok(
    storage.getItem(campaignProgressStorageKey(authored.id, 'main')),
    'Incompatible game content must not erase the saved checkpoint.',
  );
  invalid.viewport.dispose();
  const denied: ProgressStorageLike = {
    getItem() {
      throw Error('blocked');
    },
    setItem() {
      throw Error('blocked');
    },
    removeItem() {
      throw Error('blocked');
    },
  };
  const unavailable = boot(authored, denied);
  assert.equal(unavailable.viewport.simulation!.scene.id, 'main');
  assert.equal(unavailable.api.saveProgress(), 'unavailable');
  assert.match(unavailable.element('progress-status').textContent, /storage is unavailable/);
  unavailable.viewport.dispose();
});

test('standalone Save/Load and page reload preserve moving body momentum and combat cooldowns', async () => {
  const draft = newProject('standalone-motion', 'Standalone motion');
  draft.scenes[0].nodes = [
    {
      id: 'player',
      name: 'Player',
      assetId: null,
      parentId: null,
      enabled: true,
      attachments: [],
      transform: identityTransform(),
      components: [
        { type: 'player', style: 'top-down', speed: 3, jump: 6 },
        { type: 'collider', size: [0.5, 1, 0.5], offset: [0, 0.5, 0], solid: true },
      ],
    },
    {
      id: 'body',
      name: 'Body',
      assetId: null,
      parentId: null,
      enabled: true,
      attachments: [],
      transform: { ...identityTransform(), position: [8, 20, 0] },
      components: [
        { type: 'collider', size: [1, 1, 1], offset: [0, 0, 0], solid: true },
        {
          type: 'rigid-body',
          gravity: 18,
          linearDamping: 0.2,
          restitution: 0,
          velocity: [1, 0, 0],
          angularVelocity: [0, 0.5, 0],
          canSleep: false,
        },
      ],
    },
  ];
  const authored = validateProject(draft),
    storage = new MemoryStorage(),
    app = boot(authored, storage);
  let reloaded: ReturnType<typeof boot> | undefined;
  try {
    await app.viewport.ready;
    app.api.step({}, 20);
    app.api.step({ attack: true });
    const saved = app.viewport.simulation!.progressSnapshot()!;
    assert.ok(saved.motion!.bodies.body.linearVelocity[1] < -5);
    assert.equal(saved.behavior!.cooldowns.attack, 0.35);
    assert.equal(app.api.saveProgress(), 'saved');
    app.api.step({}, 10);
    const continuedPosition = app.viewport.simulation!.nodes.get('body')!.transform.position;
    app.api.restart();
    await app.viewport.ready;
    assert.deepEqual(app.viewport.simulation!.nodes.get('body')!.transform.position, [8, 20, 0]);
    assert.equal(app.api.loadProgress(), 'loaded');
    await app.viewport.ready;
    assert.deepEqual(app.viewport.simulation!.progressSnapshot()!.motion, saved.motion);
    assert.deepEqual(app.viewport.simulation!.progressSnapshot()!.behavior, saved.behavior);
    app.api.step({}, 10);
    const resumedPosition = app.viewport.simulation!.nodes.get('body')!.transform.position;
    assert.ok(resumedPosition.every((value, index) => Math.abs(value - continuedPosition[index]) < 1e-4));
    reloaded = boot(authored, storage);
    assert.equal(reloaded.api.saveProgress(), 'saved', 'an immediate re-save during startup retains motion');
    await reloaded.viewport.ready;
    assert.deepEqual(reloaded.viewport.simulation!.progressSnapshot()!.motion, saved.motion);
    assert.deepEqual(reloaded.viewport.simulation!.progressSnapshot()!.behavior, saved.behavior);
  } finally {
    app.viewport.dispose();
    reloaded?.viewport.dispose();
  }
});

test('standalone native palette selection stays synchronized through save, restart and load', () => {
  const authored = constructionProject({
      palette: [
        { id: 'timber', name: 'Timber', color: 0x995533, materialType: 'STANDARD' },
        { id: 'lamp', name: '<Lamp>', color: 0xffcc77, materialType: 'EMISSIVE' },
      ],
    }),
    storage = new MemoryStorage(),
    app = boot(authored, storage);
  try {
    const select = app.element('construction-paint'),
      controls = app.element('construction-controls');
    assert.equal(controls.hidden, false);
    assert.equal(select.value, 'timber');
    assert.deepEqual(
      select.children.map((option) => option.value),
      ['timber', 'lamp'],
    );
    assert.equal(
      select.children[1].textContent,
      '<Lamp> · emissive',
      'names are assigned as text, never HTML',
    );
    const options = select.children;
    select.value = 'lamp';
    select.listeners.get('change')!();
    assert.equal(app.viewport.simulation!.constructionState()!.selectedId, 'lamp');
    assert.equal(select.children, options, 'state updates reuse unchanged native options');
    assert.equal(app.api.saveProgress(), 'saved');
    app.api.restart();
    assert.equal(select.value, 'timber');
    assert.equal(app.api.loadProgress(), 'loaded');
    assert.equal(select.value, 'lamp');
    select.value = 'missing';
    select.listeners.get('change')!();
    assert.equal(select.value, 'lamp');
    app.viewport.simulation!.status = 'won';
    app.viewport.onState!(app.viewport.simulation!.inspect());
    assert.equal(select.disabled, true);
  } finally {
    app.viewport.dispose();
  }
});

test('standalone HUD keeps authored guidance visible and puts the full control map behind a disclosure', () => {
  const authored = constructionProject();
  authored.scenes[0].instructions = 'Start with 64 building blocks.';
  const app = boot(authored, new MemoryStorage());
  try {
    assert.match(app.element('instructions').textContent, /Start with 64 building blocks/);
    assert.doesNotMatch(app.element('instructions').textContent, /Controls:|gamepad left stick/);
    assert.match(app.element('controls').textContent, /gamepad left stick move/);
    assert.match(app.element('controls').textContent, /inventory 1\/2\/3\/4\/5\/6\/7\/8\/9/);
    assert.equal(app.element('controls-guide').hidden, false);

    const html = renderGameHtml(authored, 'main', '', '');
    assert.match(html, /<details id="controls-guide"><summary>Controls &amp; help<\/summary>/);
    assert.doesNotMatch(html, /<details id="controls-guide"[^>]*open/);
    assert.match(html, /#controls-guide,#frame-pacing-guide,#multiplayer-controls\{pointer-events:auto/);
  } finally {
    app.viewport.dispose();
  }
});

test('standalone inventory labels number-key shortcuts on usable item stacks', () => {
  const authored = constructionProject(),
    potion = {
      id: 'potion',
      name: 'Potion',
      description: '',
      maxStack: 10,
      use: { type: 'heal' as const, amount: 25 },
    };
  authored.scenes[0].items.unshift(potion);
  const app = boot(authored, new MemoryStorage());
  try {
    app.viewport.simulation!.inventory = [
      { itemId: 'potion', quantity: 1 },
      { itemId: 'stone', quantity: 2 },
    ];
    app.viewport.onState!(app.viewport.simulation!.inspect());
    assert.match(app.element('inventory').textContent, /\[1\] Potion ×1/);
    assert.match(app.element('inventory').textContent, /Stone block ×2/);
    assert.doesNotMatch(app.element('inventory').textContent, /\[2\] Stone block/);
    assert.match(app.element('controls').textContent, /inventory 1\/2\/3\/4\/5\/6\/7\/8\/9/);
  } finally {
    app.viewport.dispose();
  }
});

test('standalone HUD renders authored objective progress from live variables and inventory', () => {
  const authored = project();
  authored.scenes[0].objectives = [
    { id: 'visits-goal', text: 'Visit the next area', condition: { variable: 'visits', op: '>=', value: 1 } },
    {
      id: 'ticket-goal',
      text: 'Collect two tickets',
      condition: { itemId: 'ticket', op: '>=', value: 2 },
      requires: ['visits-goal'],
    },
  ];
  const app = boot(validateProject(authored), new MemoryStorage());
  try {
    app.viewport.simulation!.inventory = [{ itemId: 'ticket', quantity: 2 }];
    app.viewport.onState!(app.viewport.simulation!.inspect());
    const objectives = app.element('objectives');
    assert.equal(objectives.hidden, false);
    assert.equal(objectives.children.length, 2);
    assert.match(objectives.children[0]!.textContent, /○ Visit the next area \(0 >= 1\)/);
    assert.match(objectives.children[1]!.textContent, /🔒 Collect two tickets \(2 >= 2\) · Locked/);
    assert.equal(objectives.children[1]!.attributes.get('aria-label'), 'Collect two tickets: locked');

    app.viewport.simulation!.variables.visits = 1;
    app.viewport.onState!(app.viewport.simulation!.inspect());
    assert.match(objectives.children[0]!.textContent, /✓ Visit the next area \(1 >= 1\)/);
    assert.match(objectives.children[1]!.textContent, /✓ Collect two tickets \(2 >= 2\)/);
    assert.match(objectives.children[1]!.attributes.get('aria-label')!, /complete/);
  } finally {
    app.viewport.dispose();
  }
});

test('exported games provide native campaign save file controls alongside local save controls', () => {
  const html = renderGameHtml(project(), 'main', '', '');
  assert.match(html, /<details id="controls-guide" hidden>/);
  assert.match(html, /id="export-progress"[^>]*>Export save<\/button>/);
  assert.match(html, /id="import-progress"[^>]*>Import save<\/button>/);
  assert.match(html, /id="progress-file" type="file" accept="\.json,application\/json" hidden/);
  assert.match(html, /id="save-progress"/);
  assert.match(html, /id="load-progress"/);
  assert.match(html, /id="restart"/);
  assert.match(html, /id="touch-controls" hidden aria-label="Touch gameplay controls"/);
  assert.match(html, /id="touch-stick-wrap" class="touch-stick-wrap"/);
  assert.match(html, /id="touch-pause" class="touch-action" type="button" hidden>Pause<\/button>/);
  assert.match(html, /id="touch-stick" class="touch-stick" role="group" aria-label="Move character"/);
  assert.match(
    html,
    /id="touch-look" class="touch-look" role="group" aria-label="Look around" title="Drag to rotate camera"/,
  );
  assert.match(html, /id="touch-jump" class="touch-action" type="button" hidden>Jump<\/button>/);
  assert.match(html, /id="touch-interact" class="touch-action" type="button" hidden>Interact<\/button>/);
  assert.match(html, /id="touch-attack" class="touch-action" type="button" hidden>Attack<\/button>/);
  assert.match(html, /id="touch-use" class="touch-action" type="button" hidden>Use item<\/button>/);
  assert.match(html, /id="touch-place" class="touch-action" type="button" hidden>Place<\/button>/);
  assert.match(html, /id="touch-remove" class="touch-action" type="button" hidden>Remove<\/button>/);
  assert.match(html, /@media \(pointer:coarse\),\(hover:none\),\(max-width:800px\)/);
  assert.match(html, /html,body,#game\{[^}]*height:100%;height:100dvh;/);
  assert.match(
    html,
    /\.panel\{[^}]*box-sizing:border-box;pointer-events:auto;max-width:min\(100%,550px\);max-height:42vh;max-height:42dvh;/,
  );
  assert.match(html, /\.panel>\.actions\{position:sticky;bottom:-10px;z-index:1;/);
});

test('standalone touch controls send movement vectors and semantic gameplay actions', () => {
  const authored = constructionProject({ place: false, remove: true }),
    player = authored.scenes[0].nodes[0],
    storage = new MemoryStorage();
  authored.scenes[0].items.push({
    id: 'potion',
    name: 'Health potion',
    description: '',
    maxStack: 10,
    use: { type: 'heal', amount: 25 },
  });
  authored.scenes[0].nodes.push(
    nodeSchema.parse({
      id: 'switch',
      name: 'Gate switch',
      transform: { position: [0, 4, 1] },
      components: [
        { type: 'collider', size: [1, 1, 1], offset: [0, 0, 0] },
        { type: 'interactable', prompt: 'Open gate', range: 3 },
      ],
    }),
  );
  assert.equal(player.id, 'player');
  authored.scenes[0].hud = [
    gameHudWidgetSchema.parse({ id: 'pause', type: 'button', text: 'Pause', action: 'togglePause' }),
  ];
  const app = boot(authored, storage);
  try {
    const controls = app.element('touch-controls'),
      jump = app.element('touch-jump'),
      interact = app.element('touch-interact'),
      attack = app.element('touch-attack'),
      use = app.element('touch-use'),
      place = app.element('touch-place'),
      remove = app.element('touch-remove'),
      pause = app.element('touch-pause'),
      stick = app.element('touch-stick'),
      stickWrap = app.element('touch-stick-wrap'),
      look = app.element('touch-look');
    assert.equal(controls.hidden, false);
    assert.equal(pause.hidden, false);
    assert.equal(pause.textContent, 'Pause');
    assert.equal(app.element('authored-hud').children[0]!.textContent, 'Pause');
    assert.equal(jump.hidden, false);
    assert.equal(attack.hidden, false);
    assert.equal(place.hidden, true, 'authored construction permissions hide placing');
    assert.equal(remove.hidden, false);

    app.viewport.simulation!.inventory = [
      { itemId: 'stone', quantity: 2 },
      { itemId: 'potion', quantity: 1 },
    ];
    app.api.step({});
    app.viewport.onState!(app.viewport.simulation!.inspect());
    assert.match(app.element('controls').textContent, /gamepad left stick move/);
    assert.match(app.element('controls').textContent, /Drag Look to rotate the camera/);
    assert.equal(interact.hidden, false);
    assert.equal(interact.textContent, 'Interact');
    assert.equal(interact.attributes.get('aria-label'), 'Interact: Open gate');
    assert.equal(interact.title, 'Open gate');
    assert.equal(use.hidden, false);
    assert.equal(use.textContent, 'Use Health potion');
    assert.equal(use.attributes.get('aria-label'), 'Use Health potion from inventory slot 2');

    look.listeners.get('pointerdown')!({
      pointerId: 9,
      clientX: 10,
      clientY: 20,
      preventDefault() {},
    });
    look.listeners.get('pointermove')!({ pointerId: 9, clientX: 26, clientY: 11, preventDefault() {} });
    look.listeners.get('pointermove')!({ pointerId: 9, clientX: 34, clientY: 15, preventDefault() {} });
    look.listeners.get('pointerup')!({ pointerId: 9 });
    assert.deepEqual(app.viewport.cameraLook, [
      [16, -9],
      [8, 4],
    ]);
    assert.equal(look.pointerCapture, null);
    assert.deepEqual(app.viewport.touchMovement, [0, 0]);

    stick.listeners.get('pointerdown')!({
      pointerId: 4,
      isPrimary: false,
      clientX: 50,
      clientY: 50,
      preventDefault() {},
    });
    stick.listeners.get('pointermove')!({ pointerId: 4, clientX: 80, clientY: 20 });
    stick.listeners.get('pointermove')!({ pointerId: 4, clientX: 80, clientY: 50 });
    stick.listeners.get('pointerup')!({ pointerId: 4 });
    jump.click();
    interact.click();
    attack.click();
    remove.click();
    use.click();
    assert.ok(
      app.viewport.touchMovementSamples.some(
        ([x, z]) => Math.abs(x - 0.6) < 1e-9 && Math.abs(z + 0.6) < 1e-9,
      ),
    );
    assert.deepEqual(app.viewport.triggeredActions, ['jump', 'interact', 'attack', 'removeCell', 'useItem']);
    assert.deepEqual(app.element('game').querySelector('canvas')!.dispatched, []);
    assert.equal(stick.pointerCapture, null);

    app.viewport.simulation!.setPaused(true);
    app.viewport.onState!(app.viewport.simulation!.inspect());
    assert.equal(pause.textContent, 'Resume');
    assert.equal(pause.attributes.get('aria-pressed'), 'true');
    assert.equal(app.element('authored-hud').children[0]!.textContent, 'Resume');
    assert.equal(jump.hidden, true);
    assert.equal(use.hidden, true);
    assert.equal(stickWrap.hidden, true);
    assert.equal(look.hidden, true);
    assert.match(app.element('status').textContent, /Paused/);
    pause.click();
    assert.deepEqual(app.viewport.triggeredActions, [
      'jump',
      'interact',
      'attack',
      'removeCell',
      'useItem',
      'togglePause',
    ]);

    app.viewport.simulation!.setPaused(false);
    app.viewport.onState!(app.viewport.simulation!.inspect());
    assert.equal(pause.textContent, 'Pause');
    assert.equal(stickWrap.hidden, false);
  } finally {
    app.viewport.dispose();
  }
});

test('standalone touch item button exposes a usable stack after the ninth inventory slot', () => {
  const authored = constructionProject({}, { slots: 16 }),
    storage = new MemoryStorage();
  authored.scenes[0].items.push(
    ...Array.from({ length: 9 }, (_, index) => ({
      id: `filler-${index}`,
      name: `Filler ${index + 1}`,
      description: '',
      maxStack: 99,
    })),
    {
      id: 'potion',
      name: 'Health potion',
      description: '',
      maxStack: 10,
      use: { type: 'heal', amount: 25 },
    },
  );
  const app = boot(authored, storage);
  try {
    app.viewport.simulation!.inventory = [
      ...Array.from({ length: 9 }, (_, index) => ({ itemId: `filler-${index}`, quantity: 1 })),
      { itemId: 'potion', quantity: 1 },
    ];
    app.viewport.onState!(app.viewport.simulation!.inspect());

    const use = app.element('touch-use');
    assert.equal(use.hidden, false);
    assert.equal(use.textContent, 'Use Health potion');
    assert.equal(use.attributes.get('aria-label'), 'Use Health potion from inventory slot 10');
    use.click();
    assert.deepEqual(app.viewport.triggeredActions, ['useItem']);
  } finally {
    app.viewport.dispose();
  }
});

test('a user-exported campaign save transfers into another browser profile and becomes its local save', async () => {
  const authored = project(),
    source = boot(authored, new MemoryStorage());
  source.api.step({});
  assert.equal(source.viewport.simulation!.scene.id, 'second');
  source.element('export-progress').listeners.get('click')!();
  assert.equal(source.downloads[0].download, `voxshop-${authored.id}-progress.json`);
  const serialized = await source.exportedBlobs[0].text(),
    parsed = parseCampaignProgress(serialized, authored.id, 'main');
  assert.ok(parsed);
  assert.equal(parsed.activeSceneId, 'second');

  const targetStorage = new MemoryStorage(),
    target = boot(authored, targetStorage),
    fileInput = target.element('progress-file');
  target.element('import-progress').listeners.get('click')!();
  assert.equal(fileInput.clicks, 1, 'the import button opens the native file picker');
  fileInput.files = [{ size: new TextEncoder().encode(serialized).length, text: async () => serialized }];
  assert.equal(await fileInput.listeners.get('change')!(), 'loaded');
  assert.equal(target.viewport.simulation!.scene.id, 'second');
  assert.equal(target.viewport.progressRestoredSceneId, 'second');
  assert.deepEqual(target.viewport.simulation!.inventory, source.viewport.simulation!.inventory);
  const saved = targetStorage.getItem(campaignProgressStorageKey(authored.id, 'main'));
  assert.ok(saved);
  assert.deepEqual(parseCampaignProgress(saved, authored.id, 'main'), parsed);
  assert.match(target.element('progress-status').textContent, /imported from the save file/i);
  source.viewport.dispose();
  target.viewport.dispose();
});

test('invalid campaign files never replace the active run or the existing browser save', async () => {
  const authored = project(),
    storage = new MemoryStorage(),
    checkpointSession = new GameSession(authored, 'main');
  checkpointSession.simulation.variables.visits = 7;
  const existing = checkpointSession.progressSnapshot()!,
    store = new CampaignProgressStore(authored.id, 'main', () => storage);
  assert.equal(store.save(existing), 'saved');
  checkpointSession.dispose();

  const app = boot(authored, storage),
    input = app.element('progress-file'),
    originalRun = app.viewport.session,
    originalSave = storage.getItem(store.key)!;
  app.viewport.simulation!.variables.visits = 29;

  const makeFile = (text: string) => ({
    size: new TextEncoder().encode(text).length,
    text: async () => text,
  });
  const incompatible = structuredClone(existing);
  incompatible.scenes.find((scene) => scene.sceneId === 'main')!.nodes.missing = { enabled: false };
  const rejected = [
    makeFile('{ malformed'),
    makeFile(JSON.stringify({ ...existing, projectId: 'different-game' })),
    {
      size: MAX_CAMPAIGN_PROGRESS_BYTES + 1,
      text: async () => {
        assert.fail('oversized files must be rejected before reading their contents');
      },
    },
    makeFile(serializeCampaignProgress(incompatible)!),
  ];
  for (const file of rejected) {
    input.files = [file];
    assert.equal(await input.listeners.get('change')!(), 'invalid');
    assert.equal(app.viewport.session, originalRun);
    assert.equal(app.viewport.simulation!.variables.visits, 29);
    assert.equal(storage.getItem(store.key), originalSave);
  }
  assert.equal(input.value, '');
  app.viewport.dispose();
});
