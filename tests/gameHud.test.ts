import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import GameHud from '../components/GameHud';
import HudEditor from '../components/HudEditor';
import {
  gameHudWidgetSchema,
  identityTransform,
  newProject,
  nodeSchema,
  validateProject,
} from '../services/projectDocument';
import {
  formatGameHudValue,
  gameHudActiveTabs,
  selectGameHudTab,
  gameHudVisible,
  gameHudStamp,
  gameHudStyle,
  gameHudTree,
  gameHudValue,
  type GameHudState,
} from '../runtime/gameHud';
import { renderGameHtml } from '../runtime/gameExport';
import { GameSimulation } from '../runtime/GameSimulation';
import { runPlaytest } from '../runtime/playtest';

const state: GameHudState = {
  variables: { score: 12.5 },
  playerId: 'player',
  health: { player: 72 },
  inventory: [{ itemId: 'wood', quantity: 4 }],
};

test('HUD values read variable, player-health and inventory bindings', () => {
  const variable = gameHudWidgetSchema.parse({
    id: 'score',
    type: 'value',
    binding: { kind: 'variable', id: 'score' },
  });
  const health = gameHudWidgetSchema.parse({ id: 'health', type: 'bar', binding: { kind: 'health' } });
  const inventory = gameHudWidgetSchema.parse({
    id: 'wood',
    type: 'value',
    binding: { kind: 'inventory', itemId: 'wood' },
  });
  assert.equal(gameHudValue(variable as Extract<typeof variable, { type: 'value' }>, state), 12.5);
  assert.equal(gameHudValue(health as Extract<typeof health, { type: 'bar' }>, state), 72);
  assert.equal(
    gameHudValue(inventory as Extract<typeof inventory, { type: 'value' }>, {
      ...state,
      inventory: [...state.inventory, { itemId: 'wood', quantity: 3 }],
    }),
    7,
  );
  assert.equal(formatGameHudValue(12.5), '12.5');
  assert.equal(formatGameHudValue(12), '12');
});

test('HUD values and visibility can read campaign variables and the editor exposes both scopes', () => {
  const project = newProject('campaign-hud', 'Campaign HUD');
  const widget = gameHudWidgetSchema.parse({
    id: 'quest-progress',
    type: 'value',
    binding: { kind: 'variable', id: 'chapter', scope: 'campaign' },
    visibleWhen: { variable: 'chapter', scope: 'campaign', op: '>=', value: 1 },
  });
  const scopedState: GameHudState = { ...state, campaignVariables: { chapter: 3 } };
  assert.equal(gameHudValue(widget as Extract<typeof widget, { type: 'value' }>, scopedState), 3);
  assert.equal(gameHudVisible(widget, scopedState), true);
  assert.equal(gameHudVisible(widget, { ...scopedState, campaignVariables: {} }), false);

  const scene = { ...project.scenes[0]!, hud: [widget] };
  const editor = renderToStaticMarkup(
    createElement(HudEditor, { scene, widgets: scene.hud!, onChange: () => undefined }),
  );
  assert.match(editor, /Campaign variable/);
  assert.match(editor, /Variable scope/);
  assert.match(editor, /Whole campaign/);
});

test('editor HUD renders safe text, live bars and action buttons', () => {
  const widgets = [
    gameHudWidgetSchema.parse({ id: 'note', type: 'text', text: '<script>unsafe</script>' }),
    gameHudWidgetSchema.parse({ id: 'menu-panel', type: 'panel', height: 240, width: 360 }),
    gameHudWidgetSchema.parse({ id: 'health', type: 'bar', binding: { kind: 'health' }, label: 'Health' }),
    gameHudWidgetSchema.parse({ id: 'continue', type: 'button', text: 'Continue', action: 'interact' }),
    gameHudWidgetSchema.parse({ id: 'menu', type: 'event-button', text: 'Start', eventId: 'start-game' }),
  ];
  const markup = renderToStaticMarkup(
    createElement(GameHud, { widgets, state, onAction: () => undefined, onEvent: () => undefined }),
  );
  assert.match(markup, /&lt;script&gt;unsafe&lt;\/script&gt;/);
  assert.match(markup, /role="progressbar"/);
  assert.match(markup, /height:240px/);
  assert.match(markup, /aria-valuenow="72"/);
  assert.match(markup, /Continue/);
  assert.match(markup, /Start/);
  assert.doesNotMatch(markup, /<script>/);
});

test('pause HUD buttons become resume buttons when the game is paused', () => {
  const pause = gameHudWidgetSchema.parse({
    id: 'pause',
    type: 'button',
    text: 'Pause',
    action: 'togglePause',
  });
  const render = (paused: boolean) =>
    renderToStaticMarkup(
      createElement(GameHud, {
        widgets: [pause],
        state: { ...state, paused },
        onAction: () => undefined,
        onEvent: () => undefined,
      }),
    );
  const activeMarkup = render(false);
  const pausedMarkup = render(true);
  assert.match(activeMarkup, />Pause<\/button>/);
  assert.match(pausedMarkup, /aria-label="Resume"/);
  assert.match(pausedMarkup, /aria-pressed="true"/);
  assert.match(pausedMarkup, />Resume<\/button>/);
  assert.notEqual(
    gameHudStamp([pause], { ...state, paused: false }),
    gameHudStamp([pause], { ...state, paused: true }),
  );
});

test('menu widgets follow shared variable and inventory conditions', () => {
  const variableWidget = gameHudWidgetSchema.parse({
    id: 'pause-menu',
    type: 'text',
    text: 'Paused',
    visibleWhen: { variable: 'paused', op: '==', value: 1 },
  });
  const inventoryWidget = gameHudWidgetSchema.parse({
    id: 'key-hint',
    type: 'text',
    text: 'Use the key',
    visibleWhen: { itemId: 'key', op: '>=', value: 2 },
  });
  assert.equal(gameHudVisible(variableWidget, state), false);
  assert.equal(
    gameHudVisible(variableWidget, { ...state, variables: { ...state.variables, paused: 1 } }),
    true,
  );
  assert.equal(
    gameHudVisible(inventoryWidget, { ...state, inventory: [{ itemId: 'key', quantity: 2 }] }),
    true,
  );
  const markup = renderToStaticMarkup(
    createElement(GameHud, {
      widgets: [variableWidget, inventoryWidget],
      state,
      onAction: () => undefined,
      onEvent: () => undefined,
    }),
  );
  assert.doesNotMatch(markup, /Paused/);
  assert.doesNotMatch(markup, /Use the key/);
  assert.notEqual(
    gameHudStamp([variableWidget], state),
    gameHudStamp([variableWidget], {
      ...state,
      variables: { ...state.variables, paused: 1 },
    }),
  );
});

test('HUD panels group children into bounded row and column menu layouts', () => {
  const panel = gameHudWidgetSchema.parse({
    id: 'main-menu',
    type: 'panel',
    anchor: 'center',
    layout: 'column',
    gap: 14,
    padding: 20,
  });
  const start = gameHudWidgetSchema.parse({
    id: 'start',
    type: 'event-button',
    parentId: panel.id,
    text: 'Start game',
    eventId: 'start-game',
    visibleWhen: { variable: 'unlocked', op: '==', value: 1 },
  });
  const settings = gameHudWidgetSchema.parse({
    id: 'settings',
    type: 'button',
    parentId: panel.id,
    text: 'Settings',
    action: 'togglePause',
  });
  const project = newProject('hud-layout', 'HUD layout');
  project.scenes[0]!.variables.unlocked = 1;
  project.scenes[0]!.hud = [panel, start, settings];
  const saved = validateProject(project);
  const menuState = { ...state, variables: { ...state.variables, unlocked: 1 } };
  const tree = gameHudTree(saved.scenes[0]!.hud!, menuState);
  assert.equal(tree.length, 1);
  assert.deepEqual(
    tree[0]!.children.map((node) => node.widget.id),
    ['start', 'settings'],
  );
  const style = gameHudStyle(panel);
  assert.equal(style.display, 'flex');
  assert.equal(style.flexDirection, 'column');
  assert.equal(style.gap, '14px');
  assert.equal(style.padding, '20px');
  assert.equal(gameHudStyle(start, true).position, 'relative');

  const markup = renderToStaticMarkup(
    createElement(GameHud, {
      widgets: saved.scenes[0]!.hud!,
      state: menuState,
      onAction: () => undefined,
      onEvent: () => undefined,
    }),
  );
  assert.match(markup, /aria-label="Game interface"/);
  assert.match(markup, /display:flex;flex-direction:column;gap:14px/);
  assert.match(markup, /padding:20px/);
  assert.match(markup, /Start game/);
  assert.match(markup, /Settings/);

  const html = renderGameHtml(saved, saved.activeSceneId, '', '');
  assert.match(html, /"parentId":"main-menu"/);
  assert.match(html, /"layout":"column"/);

  const editor = renderToStaticMarkup(
    createElement(HudEditor, {
      scene: saved.scenes[0]!,
      widgets: saved.scenes[0]!.hud!,
      onChange: () => undefined,
    }),
  );
  assert.match(editor, /Place inside panel/);
  assert.match(editor, /Vertical stack/);
  assert.match(editor, /Inner padding/);
});

test('HUD panels nest to a bounded depth and reject missing, non-panel, cyclic and over-deep parents', () => {
  const project = newProject('hud-bad-layout', 'HUD bad layout');
  const child = gameHudWidgetSchema.parse({ id: 'child', type: 'text', text: 'Child', parentId: 'missing' });
  project.scenes[0]!.hud = [child];
  assert.throws(() => validateProject(project), /Invalid HUD panel parent/);

  const outer = gameHudWidgetSchema.parse({ id: 'outer', type: 'panel', layout: 'row' });
  const nested = gameHudWidgetSchema.parse({
    id: 'nested',
    type: 'panel',
    parentId: 'outer',
    layout: 'column',
  });
  const deepText = gameHudWidgetSchema.parse({
    id: 'deep-text',
    type: 'text',
    text: 'Nested',
    parentId: 'nested',
  });
  project.scenes[0]!.hud = [outer, nested, deepText];
  assert.doesNotThrow(() => validateProject(project));

  project.scenes[0]!.hud = [
    gameHudWidgetSchema.parse({ id: 'label', type: 'text', text: 'Label' }),
    gameHudWidgetSchema.parse({ id: 'child', type: 'text', text: 'Child', parentId: 'label' }),
  ];
  assert.throws(() => validateProject(project), /Invalid HUD panel parent/);

  project.scenes[0]!.hud = [
    gameHudWidgetSchema.parse({ id: 'outer', type: 'panel', parentId: 'nested' }),
    nested,
  ];
  assert.throws(() => validateProject(project), /Invalid HUD panel parent/);

  project.scenes[0]!.hud = [
    gameHudWidgetSchema.parse({ id: 'p0', type: 'panel' }),
    gameHudWidgetSchema.parse({ id: 'p1', type: 'panel', parentId: 'p0' }),
    gameHudWidgetSchema.parse({ id: 'p2', type: 'panel', parentId: 'p1' }),
    gameHudWidgetSchema.parse({ id: 'p3', type: 'panel', parentId: 'p2' }),
    gameHudWidgetSchema.parse({ id: 'p4', type: 'panel', parentId: 'p3' }),
    gameHudWidgetSchema.parse({ id: 'too-deep', type: 'text', text: 'Too deep', parentId: 'p4' }),
  ];
  assert.throws(() => validateProject(project), /Invalid HUD panel parent/);
});

test('editor HUD renders visible descendants through nested panels', () => {
  const project = newProject('hud-nested', 'Nested HUD');
  project.scenes[0]!.hud = [
    gameHudWidgetSchema.parse({ id: 'root', type: 'panel', layout: 'row' }),
    gameHudWidgetSchema.parse({ id: 'nested', type: 'panel', parentId: 'root', layout: 'column' }),
    gameHudWidgetSchema.parse({
      id: 'deep-button',
      type: 'event-button',
      parentId: 'nested',
      text: 'Open',
      eventId: 'open',
    }),
  ];
  const saved = validateProject(project);
  const tree = gameHudTree(saved.scenes[0]!.hud!, state);
  assert.equal(tree[0]!.children[0]!.widget.id, 'nested');
  assert.equal(tree[0]!.children[0]!.children[0]!.widget.id, 'deep-button');
  const markup = renderToStaticMarkup(
    createElement(GameHud, {
      widgets: saved.scenes[0]!.hud!,
      state,
      onAction: () => undefined,
      onEvent: () => undefined,
    }),
  );
  assert.match(markup, /Open/);
  assert.match(markup, /display:flex;flex-direction:row/);
  assert.match(markup, /display:flex;flex-direction:column/);
  const editor = renderToStaticMarkup(
    createElement(HudEditor, {
      scene: saved.scenes[0]!,
      widgets: saved.scenes[0]!.hud!,
      onChange: () => undefined,
    }),
  );
  assert.match(editor, /value="nested"[^>]*>nested<\/option>/);
});

test('HUD tab groups select visible pages and reject missing or duplicate tab references', () => {
  const project = newProject('hud-tabs', 'Tabbed HUD');
  project.scenes[0]!.hud = [
    gameHudWidgetSchema.parse({
      id: 'home-tab',
      type: 'tab-button',
      text: 'Home',
      groupId: 'menu',
      tabId: 'home',
    }),
    gameHudWidgetSchema.parse({
      id: 'settings-tab',
      type: 'tab-button',
      text: 'Settings',
      groupId: 'menu',
      tabId: 'settings',
    }),
    gameHudWidgetSchema.parse({
      id: 'home-page',
      type: 'text',
      text: 'Home page',
      visibleWhenTab: { groupId: 'menu', tabId: 'home' },
    }),
    gameHudWidgetSchema.parse({
      id: 'settings-page',
      type: 'text',
      text: 'Settings page',
      visibleWhenTab: { groupId: 'menu', tabId: 'settings' },
    }),
  ];
  const saved = validateProject(project);
  const widgets = saved.scenes[0]!.hud!;
  assert.deepEqual(gameHudActiveTabs(widgets), { menu: 'home' });
  assert.deepEqual(gameHudActiveTabs(widgets, { menu: 'missing' }), { menu: 'home' });
  assert.deepEqual(selectGameHudTab(widgets, {}, 'menu', 'settings'), { menu: 'settings' });
  assert.equal(selectGameHudTab(widgets, {}, 'missing', 'settings'), null);
  assert.deepEqual(
    gameHudTree(widgets, { ...state, activeTabs: { menu: 'settings' } }).map((node) => node.widget.id),
    ['home-tab', 'settings-tab', 'settings-page'],
  );
  assert.equal(gameHudVisible(widgets[2]!, { ...state, activeTabs: { menu: 'settings' } }), false);

  const markup = renderToStaticMarkup(
    createElement(GameHud, { widgets, state, onAction: () => undefined, onEvent: () => undefined }),
  );
  assert.match(markup, /aria-pressed="true"[^>]*>Home<\/button>/);
  assert.match(markup, /Home page/);
  assert.doesNotMatch(markup, /Settings page/);

  const editor = renderToStaticMarkup(
    createElement(HudEditor, { scene: saved.scenes[0]!, widgets, onChange: () => undefined }),
  );
  assert.match(editor, /Tab button/);
  assert.match(editor, /Tab group ID/);
  assert.match(editor, /Show this widget on tab/);
  assert.match(editor, /Tab page/);

  project.scenes[0]!.hud = [
    gameHudWidgetSchema.parse({
      id: 'tab',
      type: 'tab-button',
      text: 'Home',
      groupId: 'menu',
      tabId: 'home',
    }),
    gameHudWidgetSchema.parse({
      id: 'orphan',
      type: 'text',
      text: 'Orphan',
      visibleWhenTab: { groupId: 'other', tabId: 'home' },
    }),
  ];
  assert.throws(() => validateProject(project), /Invalid HUD tab visibility/);
  project.scenes[0]!.hud = [
    gameHudWidgetSchema.parse({
      id: 'tab-one',
      type: 'tab-button',
      text: 'One',
      groupId: 'menu',
      tabId: 'home',
    }),
    gameHudWidgetSchema.parse({
      id: 'tab-two',
      type: 'tab-button',
      text: 'Two',
      groupId: 'menu',
      tabId: 'home',
    }),
  ];
  assert.throws(() => validateProject(project), /Duplicate HUD tab/);
});

test('HUD inventory grids bind live named stacks and show usable item actions', () => {
  const widget = gameHudWidgetSchema.parse({
    id: 'bag',
    type: 'inventory',
    maxItems: 4,
    columns: 2,
    showUseButtons: true,
  });
  assert.equal(widget.type, 'inventory');
  if (widget.type !== 'inventory') throw new Error('Expected an inventory widget.');
  assert.equal(widget.maxItems, 4);
  assert.equal(gameHudStyle(widget).gridTemplateColumns, 'repeat(2, minmax(0, 1fr))');
  const inventoryState = {
    ...state,
    status: 'playing',
    inventory: [{ itemId: 'potion', name: 'Healing potion', quantity: 2, usable: true }],
  };
  const markup = renderToStaticMarkup(
    createElement(GameHud, {
      widgets: [widget],
      state: inventoryState,
      onAction: () => undefined,
      onEvent: () => undefined,
      onUseItem: () => undefined,
      onMoveItem: () => undefined,
      onSortInventory: () => undefined,
    }),
  );
  assert.match(markup, /Healing potion ×2/);
  assert.match(markup, /aria-label="Use Healing potion"/);
  assert.match(markup, />Use<\/button>/);
  assert.match(markup, /aria-label="Sort inventory by name"/);
  assert.match(markup, /draggable="true"/);
  assert.match(markup, /aria-label="Move Healing potion later"/);
  assert.notEqual(
    gameHudStamp([widget], inventoryState),
    gameHudStamp([widget], { ...inventoryState, inventory: [] }),
  );
  const editor = renderToStaticMarkup(
    createElement(HudEditor, {
      scene: newProject('inventory-hud', 'Inventory HUD').scenes[0]!,
      widgets: [widget],
      onChange: () => undefined,
    }),
  );
  assert.match(editor, /Inventory grid/);
  assert.match(editor, /Maximum stacks/);
  assert.match(editor, /Show use\/equip buttons/);
  assert.throws(() => gameHudWidgetSchema.parse({ id: 'bag', type: 'inventory', maxItems: 33 }));
});

test('HUD visibility can target playing or paused state and the editor exposes both choices', () => {
  const pausedWidget = gameHudWidgetSchema.parse({
    id: 'pause-menu',
    type: 'text',
    text: 'Paused',
    visibleWhenPaused: true,
  });
  const playingWidget = gameHudWidgetSchema.parse({
    id: 'game-hud',
    type: 'text',
    text: 'Playing',
    visibleWhenPaused: false,
  });
  assert.equal(gameHudVisible(pausedWidget, { ...state, paused: false }), false);
  assert.equal(gameHudVisible(pausedWidget, { ...state, paused: true }), true);
  assert.equal(gameHudVisible(playingWidget, { ...state, paused: false }), true);
  assert.equal(gameHudVisible(playingWidget, { ...state, paused: true }), false);
  assert.notEqual(
    gameHudStamp([pausedWidget], { ...state, paused: false }),
    gameHudStamp([pausedWidget], { ...state, paused: true }),
  );

  const project = newProject('hud-pause-visibility', 'HUD pause visibility');
  project.scenes[0]!.hud = [pausedWidget, playingWidget];
  const saved = validateProject(project);
  assert.deepEqual(
    saved.scenes[0]!.hud?.map((widget) => widget.visibleWhenPaused),
    [true, false],
  );
  const exported = renderGameHtml(saved, saved.activeSceneId, '', '');
  assert.match(exported, /"visibleWhenPaused":true/);
  assert.match(exported, /"visibleWhenPaused":false/);
  const markup = renderToStaticMarkup(
    createElement(HudEditor, {
      scene: project.scenes[0]!,
      widgets: [pausedWidget],
      onChange: () => undefined,
    }),
  );
  assert.match(markup, /Game state/);
  assert.match(markup, /<option value="playing">While playing<\/option>/);
  assert.match(markup, /<option value="paused"(?: selected="")?>While paused<\/option>/);
});

test('HUD widgets validate their saved bounds and render anchor offsets', () => {
  assert.equal(newProject('hud-legacy', 'Legacy HUD').scenes[0].hud, undefined);
  const project = newProject('hud-test', 'HUD test');
  const scene = project.scenes[0];
  scene.hud = [
    gameHudWidgetSchema.parse({ id: 'score', type: 'value', binding: { kind: 'variable', id: 'score' } }),
    gameHudWidgetSchema.parse({ id: 'confirm', type: 'button', text: 'Continue', action: 'interact' }),
    gameHudWidgetSchema.parse({ id: 'menu-panel', type: 'panel', height: 240 }),
    gameHudWidgetSchema.parse({
      id: 'menu',
      type: 'event-button',
      text: 'Start',
      eventId: 'start-game',
    }),
  ];
  assert.equal(validateProject(project).scenes[0].hud?.length, 4);
  const centered = gameHudWidgetSchema.parse({
    id: 'centered',
    type: 'text',
    text: 'Ready',
    anchor: 'center',
    offsetX: 12,
    offsetY: -8,
  });
  const style = gameHudStyle(centered);
  assert.equal(style.left, 'calc(50% + 12px)');
  assert.equal(style.top, 'calc(50% - 8px)');
  assert.equal(style.transform, 'translate(-50%, -50%)');
  const html = renderGameHtml(project, scene.id, '', '');
  assert.match(html, /id="authored-hud"/);
  assert.match(html, /"type":"event-button","text":"Start","eventId":"start-game"/);
  const stamp = gameHudStamp(scene.hud!, state);
  assert.notEqual(stamp, gameHudStamp(scene.hud!, { ...state, variables: { score: 13 } }));
  assert.throws(() =>
    validateProject({
      ...project,
      scenes: [
        {
          ...scene,
          hud: [
            gameHudWidgetSchema.parse({
              id: 'bad-bar',
              type: 'bar',
              binding: { kind: 'health' },
              min: 5,
              max: 5,
            }),
          ],
        },
      ],
    }),
  );
  assert.throws(() =>
    validateProject({
      ...project,
      scenes: [
        {
          ...scene,
          hud: [
            gameHudWidgetSchema.parse({
              id: 'missing-item',
              type: 'value',
              binding: { kind: 'inventory', itemId: 'not-in-catalog' },
            }),
          ],
        },
      ],
    }),
  );
  assert.throws(() =>
    validateProject({
      ...project,
      scenes: [
        {
          ...scene,
          hud: [
            gameHudWidgetSchema.parse({
              id: 'missing-item-condition',
              type: 'text',
              text: 'Missing key',
              visibleWhen: { itemId: 'not-in-catalog', op: '>=', value: 1 },
            }),
          ],
        },
      ],
    }),
  );
});

test('HUD rule-event buttons dispatch matching rules and playtest can exercise them', async () => {
  const project = newProject('hud-event-test', 'HUD event test');
  project.scenes[0].nodes = [
    nodeSchema.parse({
      id: 'listener',
      name: 'UI event listener',
      transform: identityTransform(),
      components: [
        {
          type: 'rules',
          apiVersion: 1,
          rules: [
            {
              event: 'ui',
              eventId: 'start-game',
              once: true,
              actions: [{ type: 'set', variable: 'started', value: 1 }],
            },
          ],
        },
      ],
    }),
  ];
  const validProject = validateProject(project);
  const simulation = new GameSimulation(validProject);
  simulation.step({ uiEventId: 'start-game' });
  assert.equal(simulation.inspect().variables.started, 1);
  assert.deepEqual(simulation.events.find((event) => event.type === 'ui')?.data, { eventId: 'start-game' });
  const result = await runPlaytest(validProject, {
    sceneId: validProject.activeSceneId,
    steps: [{ frames: 3, input: { uiEventId: 'start-game' } }],
    assertions: [{ type: 'variable', name: 'started', minimum: 1 }],
  });
  assert.ok(result.assertions.every((assertion) => assertion.passed));
});
