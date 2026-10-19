import { validateProject, type ProjectDocument } from '../services/projectDocument';
export function exportProject(project: ProjectDocument, sceneId: string): ProjectDocument {
  const scene = project.scenes.find((s) => s.id === sceneId);
  if (!scene) throw new Error('Scene not found.');
  const used = new Set(
    scene.nodes.flatMap((n) => [...(n.assetId ? [n.assetId] : []), ...n.attachments.map((a) => a.assetId)]),
  );
  const assets = project.assets
    .filter((a) => used.has(a.id))
    .map((a) => {
      const { variantOf, recipe, equipment, ...selected } = a;
      return { ...selected, model: { ...a.model, skeleton: null } };
    });
  return validateProject({
    ...project,
    assets,
    scenes: [scene],
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
): string {
  const game = exportProject(project, sceneId);
  const data = JSON.stringify(game)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; font-src 'none';"><title>VoxShop game</title><style>html,body,#game{margin:0;width:100%;height:100%;overflow:hidden;background:#111827;color:#f1f5f9;font:15px system-ui}canvas{display:block;outline:none}.hud{position:absolute;top:16px;left:16px;right:16px;pointer-events:none;display:flex;justify-content:space-between;gap:20px}.panel{background:#111827dd;padding:16px;border:1px solid #ffffff25;border-radius:12px;max-width:550px}h1{font-size:18px;margin:0 0 8px}p{margin:6px 0;line-height:1.5}button{pointer-events:auto;align-self:start;background:#164e63;color:white;border:1px solid #67e8f9;padding:10px 16px;border-radius:8px;cursor:pointer}#status{color:#99f6e4;font-weight:bold}#instructions{color:#cbd5e1;font-size:13px}</style></head><body><main id="game"></main><div class="hud"><section class="panel"><h1 id="title"></h1><p id="variables"></p><p id="status" role="status"></p><p id="instructions"></p></section><button id="restart">Restart</button></div><script id="voxshop-project" type="application/json">${data}</script><script>${runtime.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
  const artifact = html.replace(
    '</body>',
    `<script type="text/plain" id="third-party-notices">Three.js\n${notices.replace(/</g, '&lt;')}</script></body>`,
  );
  return artifact;
}
