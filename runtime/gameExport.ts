import { validateProject, type GameScene, type ProjectDocument } from '../services/projectDocument';
import { RAPIER_LICENSE } from './rapierLicense';
import { describePlayerControls } from '../services/playerControls';
import { FRAME_RATE_TARGETS } from './framePacing';
import { APP_LICENSE_URL, APP_PUBLISHER, APP_VERSION } from '../services/appMetadata';

export function sceneHasRigidBodies(scene: GameScene | ProjectDocument): boolean {
  return 'scenes' in scene
    ? scene.scenes.some((candidate) => sceneHasRigidBodies(candidate))
    : scene.nodes.some((node) => node.components.some((component) => component.type === 'rigid-body'));
}

function reachableScenes(project: ProjectDocument, startSceneId: string) {
  const scenes = new Map(project.scenes.map((scene) => [scene.id, scene]));
  const prefabs = new Map(project.prefabs.map((prefab) => [prefab.id, prefab]));
  const reachable = new Set<string>();
  const visitedPrefabs = new Set<string>();
  const pendingScenes = [startSceneId];
  const pendingPrefabs: string[] = [];
  while (pendingScenes.length || pendingPrefabs.length) {
    const sceneId = pendingScenes.pop();
    if (sceneId) {
      if (reachable.has(sceneId)) continue;
      reachable.add(sceneId);
      const scene = scenes.get(sceneId);
      if (!scene) continue;
      for (const node of scene.nodes)
        for (const component of node.components)
          if (component.type === 'rules')
            for (const rule of component.rules)
              for (const action of rule.actions) {
                if (action.type === 'transition' && !reachable.has(action.sceneId))
                  pendingScenes.push(action.sceneId);
                if (action.type === 'spawn' && !visitedPrefabs.has(action.prefabId))
                  pendingPrefabs.push(action.prefabId);
              }
      continue;
    }
    const prefabId = pendingPrefabs.pop()!;
    if (visitedPrefabs.has(prefabId)) continue;
    visitedPrefabs.add(prefabId);
    const prefab = prefabs.get(prefabId);
    if (!prefab) continue;
    for (const node of prefab.nodes)
      for (const component of node.components)
        if (component.type === 'rules')
          for (const rule of component.rules)
            for (const action of rule.actions) {
              if (action.type === 'transition' && !reachable.has(action.sceneId))
                pendingScenes.push(action.sceneId);
              if (action.type === 'spawn' && !visitedPrefabs.has(action.prefabId))
                pendingPrefabs.push(action.prefabId);
            }
  }
  return project.scenes.filter((scene) => reachable.has(scene.id));
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

export function exportProject(project: ProjectDocument, sceneId: string): ProjectDocument {
  const scene = project.scenes.find((s) => s.id === sceneId);
  if (!scene) throw new Error('Scene not found.');
  const scenes = reachableScenes(project, sceneId).map((reachable) => ({
    ...reachable,
    nodes: reachable.nodes.map((node) => {
      const playableNode = structuredClone(node);
      delete playableNode.prefabLink;
      return playableNode;
    }),
  }));
  const prefabById = new Map(project.prefabs.map((prefab) => [prefab.id, prefab]));
  const prefabIds = new Set<string>();
  const pendingPrefabs = scenes.flatMap((reachable) =>
    reachable.nodes.flatMap((node) =>
      node.components.flatMap((component) =>
        component.type === 'rules'
          ? component.rules.flatMap((rule) =>
              rule.actions.flatMap((action) => (action.type === 'spawn' ? [action.prefabId] : [])),
            )
          : [],
      ),
    ),
  );
  while (pendingPrefabs.length) {
    const id = pendingPrefabs.pop()!;
    if (prefabIds.has(id)) continue;
    const prefab = prefabById.get(id);
    if (!prefab) continue;
    prefabIds.add(id);
    for (const node of prefab.nodes)
      for (const component of node.components)
        if (component.type === 'rules')
          for (const rule of component.rules)
            for (const action of rule.actions)
              if (action.type === 'spawn' && !prefabIds.has(action.prefabId))
                pendingPrefabs.push(action.prefabId);
  }
  const prefabs = project.prefabs.filter((prefab) => prefabIds.has(prefab.id));
  const used = new Set(
    scenes
      .flatMap((reachable) => [
        ...(reachable.scatterGroups ?? []).map((group) => group.assetId),
        ...reachable.nodes.flatMap((n) => [
          ...(n.assetId ? [n.assetId] : []),
          ...n.attachments.map((a) => a.assetId),
        ]),
        ...reachable.items.flatMap((item) => (item.use?.type === 'equip' ? [item.use.assetId] : [])),
      ])
      .concat(
        prefabs.flatMap((prefab) =>
          prefab.nodes.flatMap((node) => [
            ...(node.assetId ? [node.assetId] : []),
            ...node.attachments.map((attachment) => attachment.assetId),
          ]),
        ),
      ),
  );
  const assets = project.assets
    .filter((a) => used.has(a.id))
    .map((a) => {
      const { variantOf, recipe, ...selected } = a;
      return { ...selected, model: { ...a.model, skeleton: null } };
    });
  const audioIds = new Set(
    scenes.flatMap((reachable) => [
      ...(reachable.music ? [reachable.music.clipId] : []),
      ...reachable.nodes.flatMap((node) =>
        node.components.flatMap((component) =>
          component.type === 'rules'
            ? component.rules.flatMap((rule) =>
                rule.actions.flatMap((action) => (action.type === 'audio' ? [action.clipId] : [])),
              )
            : [],
        ),
      ),
    ]),
  );
  for (const prefab of prefabs)
    for (const node of prefab.nodes)
      for (const component of node.components)
        if (component.type === 'rules')
          for (const rule of component.rules)
            for (const action of rule.actions) if (action.type === 'audio') audioIds.add(action.clipId);
  return validateProject({
    ...project,
    prefabs,
    assets,
    audioClips: project.audioClips.filter((clip) => audioIds.has(clip.id)),
    worlds: project.worlds.filter((world) => scenes.some((reachable) => reachable.worldId === world.id)),
    scenes,
    activeSceneId: sceneId,
    activeAssetId: null,
    editorDraft: null,
  });
}

export function renderGameHtml(
  project: ProjectDocument,
  sceneId: string,
  runtime: string,
  notices: string,
  workerSources: { terrain?: string; voxel?: string } = {},
): string {
  const game = exportProject(project, sceneId);
  const jsonForScript = (value: unknown) =>
    JSON.stringify(value)
      .replace(/</g, '\\u003c')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029');
  const data = jsonForScript(game);
  const workers = jsonForScript(workerSources);
  const startingScene = game.scenes.find((scene) => scene.id === game.activeSceneId)!;
  const player = startingScene.nodes
    .flatMap((node) => node.components)
    .find((component) => component.type === 'player');
  const instructions = [
    startingScene.instructions,
    startingScene.worldId ? 'Use the configured Place and Remove actions to edit one terrain cell.' : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const controls = player
    ? `Controls: ${describePlayerControls(player.controls)}. Drag Look to rotate the camera; touch controls are available on supported mobile devices.`
    : '';
  const frameRateOptions = FRAME_RATE_TARGETS.map(
    (target) =>
      `<option value="${target}"${target === 144 ? ' selected' : ''}>${target} render calls/s</option>`,
  ).join('');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval'; worker-src blob:; style-src 'unsafe-inline'; img-src data: blob:; media-src data:; connect-src wss: ws://localhost:* ws://127.0.0.1:* ws://[::1]:*; font-src 'none';"><title>VoxShop game</title><style>
    html,body,#game{margin:0;width:100%;height:100%;height:100dvh;overflow:hidden;background:#111827;color:#f1f5f9;font:15px system-ui}canvas{display:block;outline:none}.hud{position:absolute;top:16px;left:16px;right:16px;pointer-events:none;display:flex;justify-content:space-between;gap:20px}#authored-hud{position:absolute;inset:0;z-index:1;pointer-events:none}#authored-hud[hidden]{display:none}.authored-hud-button{pointer-events:auto!important;align-self:initial!important;padding:8px 10px!important;border:1px solid #ffffff50!important;border-radius:7px!important;box-shadow:0 2px 8px #0008;text-align:center}.panel{background:#111827dd;padding:16px;border:1px solid #ffffff25;border-radius:12px;max-width:550px;min-width:0}h1{font-size:18px;margin:0 0 8px}p{margin:6px 0;line-height:1.5}button{pointer-events:auto;align-self:start;background:#164e63;color:white;border:1px solid #67e8f9;padding:10px 16px;border-radius:8px;cursor:pointer}button:disabled{opacity:.55;cursor:not-allowed}.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}#construction-paint,#max-fps-target{display:block;pointer-events:auto;max-width:100%;width:100%;padding:8px;margin:6px 0;background:#172e3d;color:#f1f5f9;border:1px solid #ffffff50;border-radius:6px}#status{color:#99f6e4;font-weight:bold}#objectives{margin:8px 0;padding-left:22px;font-size:13px}#objectives li{margin:4px 0}#progress-status,#multiplayer-status,#multiplayer-error,#performance,#instructions,#controls,#frame-pacing-status{color:#cbd5e1;font-size:13px}#multiplayer-status{color:#99f6e4}#multiplayer-error{color:#fca5a5}#performance{font-variant-numeric:tabular-nums}#controls-guide,#frame-pacing-guide,#multiplayer-controls{pointer-events:auto;margin-top:6px;font-size:13px}#controls-guide summary,#frame-pacing-guide summary,#multiplayer-controls summary{cursor:pointer;color:#bae6fd}#controls,#frame-pacing-guide p,#multiplayer-controls p{margin:6px 0 0}#frame-pacing-guide label,#multiplayer-form label{display:block;margin-top:7px}#multiplayer-form input{display:block;box-sizing:border-box;max-width:100%;width:100%;padding:7px;margin-top:4px;background:#172e3d;color:#f1f5f9;border:1px solid #ffffff50;border-radius:6px}#multiplayer-form button{margin:8px 6px 0 0}#multiplayer-credential-row{display:flex;gap:6px}#multiplayer-credential-row input{flex:1;min-width:0}#multiplayer-credential-toggle{flex:none}#cap-frame-rate{margin-right:6px;vertical-align:middle}
    #touch-controls{display:none;position:absolute;z-index:2;inset:auto 0 0;align-items:end;justify-content:space-between;padding:16px max(18px,env(safe-area-inset-right)) max(18px,env(safe-area-inset-bottom)) max(18px,env(safe-area-inset-left));pointer-events:none;touch-action:none;user-select:none;-webkit-user-select:none}
    #touch-controls[hidden]{display:none}
    .touch-stick-wrap,.touch-actions,.touch-look{pointer-events:auto}
    .touch-stick-wrap{display:grid;justify-items:center;gap:5px;color:#e2e8f0;font-size:12px;text-shadow:0 1px 3px #000}
    .touch-stick{position:relative;width:136px;height:136px;border:1px solid #e2e8f080;border-radius:50%;background:#0f172acc;box-shadow:0 3px 12px #0008;touch-action:none}
    .touch-stick::before{content:"";position:absolute;inset:22%;border:1px solid #e2e8f040;border-radius:50%}
    #touch-stick-knob{position:absolute;left:50%;top:50%;width:54px;height:54px;border:1px solid #a5f3fc;background:#164e63e8;border-radius:50%;box-shadow:0 2px 8px #0009;transform:translate(-50%,-50%);pointer-events:none}
    .touch-look{position:relative;display:grid;place-items:center;flex:none;width:72px;height:72px;border:1px solid #e2e8f080;border-radius:50%;background:#0f172acc;color:#e2e8f0;font-size:12px;font-weight:650;text-shadow:0 1px 3px #000;box-shadow:0 3px 12px #0008;touch-action:none;user-select:none;-webkit-user-select:none}
    .touch-look::before{content:"";position:absolute;inset:10px;border:1px solid #e2e8f040;border-radius:50%;pointer-events:none}
    .touch-actions{display:grid;grid-template-columns:repeat(2,minmax(68px,82px));gap:9px;justify-items:stretch;align-items:end}
    .touch-action{min-height:58px;padding:8px 6px;border-radius:18px;background:#0f172ae8;border:1px solid #a5f3fc;color:#f8fafc;font-size:13px;font-weight:650;line-height:1.15;box-shadow:0 3px 10px #0009;touch-action:manipulation;overflow-wrap:anywhere}
    .touch-action[hidden]{display:none}
    @media (pointer:coarse),(hover:none),(max-width:800px){#touch-controls:not([hidden]){display:flex}.hud{top:max(8px,env(safe-area-inset-top));left:8px;right:8px;gap:8px}.panel{box-sizing:border-box;pointer-events:auto;max-width:min(100%,550px);max-height:42vh;max-height:42dvh;overflow:auto;padding:10px;background:#111827e8}h1{font-size:16px;margin-bottom:5px}.actions{gap:6px;margin-top:7px}.actions button{padding:8px 10px;font-size:13px}}
    #game-menu>summary{pointer-events:auto;cursor:pointer;color:#bae6fd;margin-bottom:8px}#game-menu:not([open])>summary{margin:0}.hud[data-authored="true"]{justify-content:flex-end;z-index:3}.hud[data-authored="true"]>.panel{pointer-events:auto;max-height:45vh;overflow:auto}
    @media (max-width:430px){.touch-stick{width:116px;height:116px}.touch-look{width:62px;height:62px}.touch-actions{grid-template-columns:repeat(2,minmax(62px,72px));gap:7px}.touch-action{min-height:54px;font-size:12px}.panel{max-width:100%}}
    @media (max-width:380px){#touch-controls{padding-left:max(8px,env(safe-area-inset-left));padding-right:max(8px,env(safe-area-inset-right))}.touch-stick{width:92px;height:92px}.touch-look{width:56px;height:56px}.touch-actions{grid-template-columns:repeat(2,minmax(48px,58px));gap:6px}.touch-action{min-height:48px;padding:6px 4px}}

    @media (max-width:800px){.panel>.actions{position:sticky;bottom:-10px;z-index:1;background:#111827f2;padding-top:8px}}
    </style></head><body><main id="game"></main><div id="authored-hud" aria-label="Game interface" hidden></div><div class="hud" id="game-hud"><details class="panel" id="game-menu" open><summary>Game menu</summary><h1 id="title"></h1><p id="variables"></p><ol id="objectives" aria-label="Objectives" hidden></ol><p id="inventory" aria-label="Inventory"></p><p id="status" role="status"></p><p id="progress-status" role="status" aria-live="polite"></p><p id="multiplayer-status" role="status" aria-live="polite">Offline. Multiplayer is optional.</p><details id="multiplayer-controls"><summary>Join multiplayer room</summary><p>Enter the room address, ID and credential from your host. Details are kept in this page's memory only.</p><form id="multiplayer-form" method="post"><label for="multiplayer-endpoint">WebSocket address</label><input id="multiplayer-endpoint" type="text" maxlength="2048" required autocomplete="off" spellcheck="false" placeholder="wss://host.example/multiplayer"><label for="multiplayer-room-id">Room ID</label><input id="multiplayer-room-id" type="text" maxlength="64" required autocomplete="off" spellcheck="false"><label for="multiplayer-credential">Room credential</label><span id="multiplayer-credential-row"><input id="multiplayer-credential" type="password" maxlength="43" required autocomplete="off" spellcheck="false"><button id="multiplayer-credential-toggle" type="button" aria-pressed="false">Show</button></span><button id="multiplayer-join" type="submit">Join room</button><button id="multiplayer-leave" type="button" disabled>Leave room</button></form><p id="multiplayer-error" role="alert" aria-live="assertive"></p></details><p id="performance" title="Render calls per second, average main-thread wall time inside each renderer.render call, and simulation steps per second. These are not GPU-completed or display-presented frames."></p><p id="instructions">${escapeHtml(instructions)}</p><details id="controls-guide"${controls ? '' : ' hidden'}><summary>Controls &amp; help</summary><p id="controls">${escapeHtml(controls)}</p></details><details id="frame-pacing-guide"><summary>Frame pacing</summary><label><input id="cap-frame-rate" type="checkbox">Limit render rate</label><label for="max-fps-target">Maximum render rate<select id="max-fps-target" aria-label="Maximum render rate">${frameRateOptions}</select></label><p>Off by default. The optional cap uses timing deadlines to schedule render work and affects rendering only; the fixed-step simulation remains separate. The browser and display control presentation, so the selected rate is a target, not a guarantee.</p><p id="frame-pacing-status" role="status" aria-live="polite"></p></details><label id="construction-controls" hidden>Construction paint · Q to cycle<select id="construction-paint" aria-label="Construction paint"></select></label><div class="actions"><button id="save-progress" title="Save this game's progress in this browser">Save</button><button id="load-progress" title="Load this game's saved progress">Load</button><button id="export-progress" title="Download the current campaign save as a file">Export save</button><button id="import-progress" title="Choose a campaign save file to import">Import save</button><button id="restart" title="Start from the authored beginning; saved progress remains available">Restart fresh</button><input id="progress-file" type="file" accept=".json,application/json" hidden></div></details></div><div id="touch-controls" hidden aria-label="Touch gameplay controls"><div id="touch-stick-wrap" class="touch-stick-wrap"><div id="touch-stick" class="touch-stick" role="group" aria-label="Move character"><span id="touch-stick-knob" aria-hidden="true"></span></div><span aria-hidden="true">Move</span></div><div id="touch-look" class="touch-look" role="group" aria-label="Look around" title="Drag to rotate camera">Look</div><div class="touch-actions"><button id="touch-pause" class="touch-action" type="button" hidden>Pause</button><button id="touch-jump" class="touch-action" type="button" hidden>Jump</button><button id="touch-interact" class="touch-action" type="button" hidden>Interact</button><button id="touch-attack" class="touch-action" type="button" hidden>Attack</button><button id="touch-use" class="touch-action" type="button" hidden>Use item</button><button id="touch-place" class="touch-action" type="button" hidden>Place</button><button id="touch-remove" class="touch-action" type="button" hidden>Remove</button></div></div><script id="voxshop-project" type="application/json">${data}</script><script id="voxshop-workers" type="application/json">${workers}</script><script>${runtime.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
  const physicsNotice = sceneHasRigidBodies(game)
    ? `\n\nRapier 3D compatibility build 0.21.0 (Apache-2.0)\n${RAPIER_LICENSE.replace(/</g, '&lt;')}`
    : '';
  const artifact = html.replace(
    '</body>',
    `<script type="text/plain" id="voxshop-runtime-notice">VoxShop ${APP_VERSION}\nRequired Notice: Copyright 2025-2026 ${APP_PUBLISHER}\n${APP_LICENSE_URL}\nThe Game Output Permission allows commercial games and assets without engine royalties or mandatory game branding. Engine/editor resale and paid hosting require separate permission.</script><script type="text/plain" id="third-party-notices">Three.js\n${notices.replace(/</g, '&lt;')}${physicsNotice}</script></body>`,
  );
  return artifact;
}
