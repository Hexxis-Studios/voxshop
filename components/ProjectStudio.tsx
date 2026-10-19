import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { apiJson, localApi, watchProjects } from '../services/localApi';
import {
  assetSchema,
  identityTransform,
  type Asset,
  type ProjectDocument,
  type SceneNode,
} from '../services/projectDocument';
import { createModelDocument, type ModelDocument } from '../services/modelDocument';
import { readRecovery, writeRecovery, clearRecovery, type DraftRecovery } from '../services/recoveryStore';
import { GameViewport } from '../runtime/GameViewport';
import { NameDialog, type NameRequest } from './NameDialog';
import { NodeInspector, AssetInspector } from './StudioInspectors';
import { sculptedAsset } from '../services/assetAssembly';
import voxshopLogo from '../assets/voxshop_logo.png?url';
import './studio.css';
const SculptEditor = lazy(() => import('../App'));
const uid = () => crypto.randomUUID();
function download(data: Blob, name: string) {
  const url = URL.createObjectURL(data),
    a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function ProjectStudio() {
  const [project, setProject] = useState<ProjectDocument | null>(null),
    [projects, setProjects] = useState<any[]>([]),
    [loadErrors, setLoadErrors] = useState<any[]>([]);
  const [mode, setMode] = useState<'scene' | 'sculpt'>('scene'),
    [hasSculpt, setHasSculpt] = useState(false),
    [tab, setTab] = useState<'assets' | 'hierarchy'>('assets');
  const [selected, setSelected] = useState<string | null>(null),
    [assetId, setAssetId] = useState<string | null>(null),
    [search, setSearch] = useState('');
  const [notice, setNotice] = useState('Connecting to workspace…'),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [playing, setPlaying] = useState(false),
    [gameState, setGameState] = useState<any>(null);
  const [request, setRequest] = useState<NameRequest | null>(null),
    [generator, setGenerator] = useState(false),
    [agent, setAgent] = useState(false),
    [configuration, setConfiguration] = useState(''),
    [testsOpen, setTestsOpen] = useState(false),
    [activeJob, setActiveJob] = useState<string | null>(null);
  const [hosted, setHosted] = useState(false);
  const [draft, setDraft] = useState<ModelDocument | null>(null),
    [pendingRecovery, setPendingRecovery] = useState<DraftRecovery | null>(null);
  const viewportHost = useRef<HTMLDivElement>(null),
    viewport = useRef<GameViewport | null>(null),
    current = useRef(project),
    dirty = useRef<DraftRecovery | null>(null),
    saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null),
    saving = useRef<Promise<any>>(Promise.resolve()),
    file = useRef<HTMLInputElement>(null);
  current.current = project;
  const scene = project?.scenes.find((s) => s.id === project.activeSceneId),
    node = scene?.nodes.find((n) => n.id === selected),
    asset = project?.assets.find((a) => a.id === assetId),
    startingAsset = asset ?? project?.assets[0];
  const update = (p: ProjectDocument) => {
    if (current.current?.id === p.id && current.current.revision > p.revision) return;
    current.current = p;
    setProject(p);
    if (!dirty.current)
      setDraft(
        p.editorDraft ?? p.assets.find((a) => a.id === p.activeAssetId)?.model ?? createModelDocument([]),
      );
  };
  const refreshList = async () => {
    const list = await apiJson('/api/projects');
    setProjects(list.projects);
    setLoadErrors(list.errors);
    return list;
  };
  const run = async (action: () => Promise<any>) => {
    setBusy(true);
    setError('');
    try {
      return await action();
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  };
  const apply = async (operations: unknown[], label: string, revision?: number) => {
    await flushDraft();
    const p = current.current;
    if (!p) throw new Error('Open a project first.');
    const result = await apiJson(`/api/projects/${p.id}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ expectedRevision: revision ?? p.revision, requestId: uid(), label, operations }),
    });
    if (current.current?.id === p.id) {
      update(result.project);
      setNotice(`Saved · revision ${result.project.revision}`);
    }
    return result.project as ProjectDocument;
  };
  const openProject = async (id: string) => {
    await flushDraft();
    const p = await apiJson<ProjectDocument>(`/api/projects/${id}/activate`, { method: 'POST', body: '{}' });
    dirty.current = null;
    setPendingRecovery(null);
    setSelected(null);
    setAssetId(null);
    setPlaying(false);
    update(p);
    setNotice('Project opened. Changes save automatically.');
    const recovery = await readRecovery(id);
    if (recovery && JSON.stringify(recovery.document) !== JSON.stringify(p.editorDraft)) {
      setPendingRecovery(recovery);
      setNotice('Unsaved sculpt work is available for recovery.');
    }
  };
  async function flushDraft() {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const recovery = dirty.current;
    if (!recovery) return saving.current.catch(() => {});
    saving.current = saving.current
      .catch(() => {})
      .then(async () => {
        if (dirty.current !== recovery) return;
        const p = current.current;
        if (!p || p.id !== recovery.projectId) return;
        try {
          const activeAsset = p.assets.find((a) => a.id === recovery.assetId);
          const operations = [
            ...(activeAsset
              ? [{ type: 'asset.put', asset: sculptedAsset(activeAsset, recovery.document) }]
              : []),
            { type: 'editor.set', assetId: recovery.assetId, draft: recovery.document },
          ];
          const result = await apiJson(`/api/projects/${p.id}/transactions`, {
            method: 'POST',
            body: JSON.stringify({
              expectedRevision: recovery.baseRevision,
              requestId: `draft-${recovery.updatedAt}-${uid().slice(0, 8)}`,
              label: activeAsset ? 'Sculpt asset' : 'Save sculpt draft',
              operations,
            }),
          });
          if (dirty.current === recovery) {
            dirty.current = null;
            setPendingRecovery(null);
            await clearRecovery(p.id, recovery.updatedAt);
          } else if (dirty.current && dirty.current.projectId === p.id) {
            dirty.current.baseRevision = result.project.revision;
            void writeRecovery(dirty.current).catch(() => {});
          }
          if (current.current?.id === p.id) {
            update(result.project);
            setNotice(`Draft saved · revision ${result.project.revision}`);
          }
        } catch (e) {
          setPendingRecovery(recovery);
          setError(`Sculpt draft is retained in this browser. ${(e as Error).message}`);
          throw e;
        }
      });
    return saving.current;
  }
  const changedDraft = (document: ModelDocument) => {
    const p = current.current;
    if (!p) return;
    const recovery: DraftRecovery = {
      projectId: p.id,
      baseRevision: dirty.current?.baseRevision ?? p.revision,
      assetId: p.activeAssetId,
      document,
      updatedAt: Math.max(Date.now(), (dirty.current?.updatedAt ?? 0) + 1),
    };
    dirty.current = recovery;
    setDraft(document);
    setNotice('Saving sculpt draft…');
    void writeRecovery(recovery).catch((e) =>
      setError(`Browser recovery could not be written: ${e.message}. Save or download your model.`),
    );
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void flushDraft().catch(() => {}), 700);
  };
  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    const initialize = async () => {
      try {
        const list = await refreshList();
        if (disposed) return;
        const id =
          list.activeProjectId && list.projects.some((p: any) => p.id === list.activeProjectId)
            ? list.activeProjectId
            : list.projects[0]?.id;
        const p = id
          ? await apiJson<ProjectDocument>(`/api/projects/${id}`)
          : await apiJson<ProjectDocument>('/api/projects', {
              method: 'POST',
              body: JSON.stringify({ name: 'My first game' }),
            });
        if (disposed) return;
        update(p);
        setNotice('Ready. Generate an asset or open an example to begin.');
        const recovery = await readRecovery(p.id);
        if (recovery && JSON.stringify(recovery.document) !== JSON.stringify(p.editorDraft))
          setPendingRecovery(recovery);
        void migrateLegacy(p).catch((e) => setError(`Legacy library remains available. ${e.message}`));
        const session = await apiJson('/api/session');
        if (!disposed) {
          setHosted(!!session.hosted);
          setConfiguration(
            session.hosted
              ? `In ChatGPT or Codex, open Plugins → Personal → Created by you → VoxShop, then Install or Connect.\n\nYour agent can inspect projects, generate original assets, edit scenes, run playtests and build playable games.\n\nMCP endpoint: ${session.mcp.url}`
              : JSON.stringify({ mcpServers: { voxshop: session.mcp } }, null, 2),
          );
        }
      } catch (e) {
        if (!disposed) setError((e as Error).message);
      }
    };
    void initialize();
    void watchProjects((event) => {
      const p = current.current;
      if (!p) return;
      if (event.activated && event.projectId !== p.id) {
        void flushDraft()
          .catch(() => {})
          .then(async () => {
            const next = await apiJson<ProjectDocument>(`/api/projects/${event.projectId}`);
            if (disposed) return;
            dirty.current = null;
            setSelected(null);
            setAssetId(null);
            setPlaying(false);
            setMode('scene');
            update(next);
            setPendingRecovery((await readRecovery(next.id)) ?? null);
            await refreshList();
            setNotice('Project opened by your agent.');
          })
          .catch((e) => setError(e.message));
        return;
      }
      if (event.projectId !== p.id) return;
      void apiJson<ProjectDocument>(`/api/projects/${p.id}`)
        .then((next) => {
          if (disposed || current.current?.id !== next.id || next.revision <= current.current.revision)
            return;
          update(next);
        })
        .catch((e) => setError(e.message));
    }, controller.signal);
    return () => {
      disposed = true;
      controller.abort();
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);
  // One-time, reversible migration: old browser data remains intact and can be imported again explicitly.
  async function migrateLegacy(p: ProjectDocument) {
    if (localStorage.getItem('voxshop-project-migration-v1') || p.assets.length) return;
    const builds = JSON.parse(localStorage.getItem('voxelBuilderCustomBuilds') ?? '[]'),
      rebuilds = JSON.parse(localStorage.getItem('voxelBuilderCustomRebuilds') ?? '[]'),
      oldScene = JSON.parse(localStorage.getItem('voxelBuilderSceneObjects') ?? '[]');
    const assets: Asset[] = [];
    const nodes: SceneNode[] = [];
    let skipped = 0;
    for (const model of [...builds, ...rebuilds])
      try {
        const a = assetSchema.parse({
          id: uid(),
          name: model.name,
          model: createModelDocument(model.data, model.skeleton),
          voxelSize: 0.1,
          source: { kind: 'imported', description: 'Legacy browser library' },
        });
        assets.push(sculptedAsset(a, a.model));
      } catch {
        skipped++;
      }
    for (const object of oldScene)
      try {
        const a = assetSchema.parse({
          id: uid(),
          name: object.name,
          model: createModelDocument(object.data),
          voxelSize: 0.1,
        });
        assets.push(a);
        nodes.push({
          id: uid(),
          name: a.name,
          assetId: a.id,
          parentId: null,
          enabled: true,
          components: [],
          attachments: [],
          transform: {
            position: [object.offsetX * 0.1, 0, object.offsetZ * 0.1],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
          },
        });
      } catch {
        skipped++;
      }
    if (assets.length) {
      const result = await apiJson(`/api/projects/${p.id}/transactions`, {
        method: 'POST',
        body: JSON.stringify({
          expectedRevision: p.revision,
          requestId: uid(),
          label: 'Import legacy browser library',
          operations: [
            ...assets.map((a) => ({ type: 'asset.put', asset: a })),
            { type: 'scene.put', scene: { ...p.scenes[0], nodes } },
          ],
        }),
      });
      if (current.current?.id === p.id) {
        update(result.project);
        setNotice(
          `Imported ${result.project.assets.length} legacy assets.${skipped ? ` ${skipped} invalid entries stayed in the old library.` : ''}`,
        );
      }
    }
    localStorage.setItem('voxshop-project-migration-v1', p.id);
  }
  useEffect(() => {
    if (!project || !viewportHost.current) return;
    if (!viewport.current) {
      viewport.current = new GameViewport(viewportHost.current, project, (id) => {
        setSelected(id);
        setAssetId(null);
        setTab('hierarchy');
      });
      viewport.current.onState = setGameState;
    } else if (!playing) viewport.current.load(project);
    if (!playing) viewport.current.select(selected);
  }, [project, playing]);
  useEffect(() => {
    viewport.current?.select(playing ? null : selected);
  }, [selected, playing]);
  useEffect(
    () => () => {
      viewport.current?.dispose();
    },
    [],
  );
  const selectAsset = async (a: Asset, sculpt = false) => {
    await flushDraft();
    dirty.current = null;
    await apply([{ type: 'editor.set', assetId: a.id, draft: a.model }], 'Open asset');
    setAssetId(a.id);
    setSelected(null);
    if (sculpt) {
      setHasSculpt(true);
      setMode('sculpt');
    }
  };
  const saveAsset = async (name: string, model: ModelDocument) => {
    await flushDraft();
    const p = current.current!;
    const existing = p.assets.find((a) => a.id === p.activeAssetId),
      id = existing?.id ?? uid();
    await apply(
      [
        {
          type: 'asset.put',
          asset: {
            ...(existing ?? {
              voxelSize: 0.1,
              pivot: [0, 0, 0],
              rig: null,
              source: { kind: 'authored', description: '' },
            }),
            id,
            name,
            model,
          },
        },
        { type: 'editor.set', assetId: id, draft: model },
      ],
      'Save sculpted asset',
    );
    setAssetId(id);
  };
  const addNode = async (a: Asset) => {
    const id = uid();
    await apply(
      [
        {
          type: 'node.put',
          sceneId: current.current!.activeSceneId,
          node: { id, name: a.name, assetId: a.id, transform: identityTransform() },
        },
      ],
      'Place asset',
    );
    setSelected(id);
    setAssetId(null);
    setTab('hierarchy');
    setMode('scene');
  };
  const history = async (direction: 'undo' | 'redo') => {
    await flushDraft();
    const p = current.current!;
    const r = await apiJson(`/api/projects/${p.id}/${direction}`, {
      method: 'POST',
      body: JSON.stringify({ expectedRevision: p.revision, requestId: uid() }),
    });
    update(r.project);
    setNotice(`${direction === 'undo' ? 'Undid' : 'Redid'} project change · revision ${r.project.revision}`);
  };
  const example = async (kind: 'exploration' | 'arena') => {
    await flushDraft();
    dirty.current = null;
    const p = await apiJson<ProjectDocument>('/api/examples', {
      method: 'POST',
      body: JSON.stringify({ kind, id: uid() }),
    });
    update(p);
    setMode('scene');
    setPlaying(false);
    setSelected(null);
    setAssetId(null);
    await refreshList();
    setNotice('Example opened. Every asset, attachment and behavior is editable.');
  };
  const waitJob = async (job: any) => {
    setActiveJob(job.id);
    try {
      for (;;) {
        const state = await apiJson(`/api/jobs/${job.id}`);
        if (state.status === 'completed') return state.result;
        if (state.status === 'failed' || state.status === 'cancelled')
          throw new Error(state.error ?? 'Job cancelled.');
        setNotice(`${state.kind} · ${Math.round(state.progress * 100)}%`);
        await new Promise((r) => setTimeout(r, 250));
      }
    } finally {
      setActiveJob(null);
    }
  };
  const build = async () => {
    await flushDraft();
    const p = current.current!;
    const result = await waitJob(
      await apiJson(`/api/projects/${p.id}/build`, {
        method: 'POST',
        body: JSON.stringify({ sceneId: p.activeSceneId }),
      }),
    );
    const response = await localApi(`/api/games/${result.filename}`);
    if (!response.ok)
      throw new Error('Build succeeded but download failed. Retry Export game to download a fresh build.');
    download(await response.blob(), result.filename);
    setNotice(
      `Built ${result.filename} · ${result.assets} assets · ${(result.bytes / 1048576).toFixed(2)} MB`,
    );
  };
  const playtest = async (spec: any) => {
    await flushDraft();
    const p = current.current!;
    spec.sceneId = p.activeSceneId;
    const result = await waitJob(
      await apiJson(`/api/projects/${p.id}/playtest`, { method: 'POST', body: JSON.stringify(spec) }),
    );
    setNotice(
      `Playtest ${result.passed ? 'passed' : 'failed'} · ${result.assertions.filter((a: any) => a.passed).length}/${result.assertions.length} assertions`,
    );
    download(
      new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }),
      `${p.id}-playtest.json`,
    );
  };
  return (
    <div className="studio-shell">
      <header className="studio-header">
        <div className="studio-brand">
          <img className="studio-logo" src={voxshopLogo} alt="VoxShop" width="1015" height="203" />
          <small>CREATE · PLAY · EXPORT</small>
        </div>
        <select
          aria-label="Project"
          value={project?.id ?? ''}
          disabled={busy || playing}
          onFocus={() => void refreshList()}
          onChange={(e) => void run(() => openProject(e.target.value))}
        >
          {project && !projects.some((p) => p.id === project.id) && (
            <option value={project.id}>{project.name}</option>
          )}
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button
          disabled={busy || playing}
          onClick={() =>
            setRequest({
              title: 'New project',
              initialValue: 'My voxel game',
              confirmLabel: 'Create project',
              onConfirm: async (name) => {
                await flushDraft();
                const p = await apiJson('/api/projects', { method: 'POST', body: JSON.stringify({ name }) });
                dirty.current = null;
                update(p);
                setSelected(null);
                setAssetId(null);
                await refreshList();
              },
            })
          }
        >
          New
        </button>
        <button disabled={busy || playing} onClick={() => file.current?.click()}>
          Import
        </button>
        <input
          hidden
          ref={file}
          type="file"
          accept=".json,.voxshop"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f)
              void run(async () => {
                await flushDraft();
                const p = await apiJson('/api/projects/import', {
                  method: 'POST',
                  body: JSON.stringify({ project: JSON.parse(await f.text()) }),
                });
                dirty.current = null;
                update(p);
                await refreshList();
              });
          }}
        />
        <button
          disabled={!project || busy}
          onClick={() =>
            void run(async () => {
              await flushDraft();
              const p = await apiJson(`/api/projects/${current.current!.id}`);
              download(
                new Blob([JSON.stringify(p, null, 2)], { type: 'application/json' }),
                `${p.id}.voxshop.json`,
              );
              setNotice(`Downloaded project revision ${p.revision}`);
            })
          }
        >
          Save project
        </button>
        <div className="studio-spacer" />
        <button onClick={() => setAgent(!agent)} aria-expanded={agent}>
          Connect agent
        </button>
        <button className="studio-primary" disabled={!project || busy} onClick={() => void run(build)}>
          Export game
        </button>
      </header>
      <nav className="studio-toolbar" aria-label="Workspace">
        <button
          className={mode === 'scene' ? 'active' : ''}
          onClick={() => {
            setMode('scene');
            viewport.current?.resize();
          }}
        >
          Scene
        </button>
        <button
          className={mode === 'sculpt' ? 'active' : ''}
          disabled={playing}
          onClick={() => {
            setHasSculpt(true);
            setMode('sculpt');
          }}
        >
          Sculpt asset
        </button>
        <span className="studio-divider" />
        <button disabled={!project || busy || playing} onClick={() => void run(() => history('undo'))}>
          Undo
        </button>
        <button disabled={!project || busy || playing} onClick={() => void run(() => history('redo'))}>
          Redo
        </button>
        <div className="studio-spacer" />
        <button disabled={busy || playing} onClick={() => void run(() => example('exploration'))}>
          Crystal trail
        </button>
        <button disabled={busy || playing} onClick={() => void run(() => example('arena'))}>
          Arena
        </button>
        <button disabled={!project || busy || playing} onClick={() => setTestsOpen(true)}>
          Run playtest
        </button>
        <button
          className={playing ? 'studio-danger' : 'studio-play'}
          disabled={!project || mode === 'sculpt'}
          onClick={() => {
            if (playing) {
              viewport.current?.stop();
              setPlaying(false);
              setGameState(null);
              setNotice('Stopped. Authoring scene restored.');
            } else {
              viewport.current?.play();
              setPlaying(true);
              setNotice('Play mode · click the viewport for controls.');
            }
          }}
        >
          {playing ? '■ Stop' : '▶ Play'}
        </button>
      </nav>
      {agent && (
        <section className="studio-agent">
          <div>
            <strong>Let your agent build with VoxShop</strong>
            <p>
              {hosted ? (
                'Connect the VoxShop plugin in ChatGPT or Codex. Your agent can generate assets, equip characters, edit scenes, run playtests and export games. Speak through your agent’s voice interface.'
              ) : (
                <>
                  Run the local editor, build once with <code>npm run build</code>, then add this server to
                  your MCP client. Your agent can generate assets, equip characters, edit scenes, run
                  playtests and export games. Speak through your agent’s voice interface.
                </>
              )}
            </p>
            {!hosted && (
              <a
                href="https://modelcontextprotocol.io/docs/develop/connect-local-servers"
                target="_blank"
                rel="noreferrer"
              >
                MCP client setup guide ↗
              </a>
            )}
          </div>
          <textarea aria-label="VoxShop MCP configuration" readOnly value={configuration} />
          <button
            onClick={() =>
              void navigator.clipboard
                .writeText(configuration)
                .then(() => setNotice('MCP configuration copied.'))
                .catch(() => setError('Select and copy the configuration manually.'))
            }
          >
            {hosted ? 'Copy setup' : 'Copy config'}
          </button>
          <button onClick={() => setAgent(false)}>Close</button>
        </section>
      )}
      {pendingRecovery && (
        <section className="studio-recovery">
          <span>
            Recovered sculpt work is available. Keep it as a separate editable asset to preserve both
            versions.
          </span>
          <button
            onClick={() =>
              void run(async () => {
                const r = pendingRecovery,
                  p = current.current!;
                if (r.projectId !== p.id) throw new Error('Open the recovery’s original project first.');
                const id = uid();
                const original = p.assets.find((asset) => asset.id === r.assetId);
                const recovered = original
                  ? {
                      ...sculptedAsset(original, r.document),
                      id,
                      name: 'Recovered sculpt',
                      variantOf: original.id,
                    }
                  : { id, name: 'Recovered sculpt', model: r.document };
                const result = await apiJson(`/api/projects/${p.id}/transactions`, {
                  method: 'POST',
                  body: JSON.stringify({
                    expectedRevision: p.revision,
                    requestId: uid(),
                    label: 'Recover sculpt asset',
                    operations: [
                      { type: 'asset.put', asset: recovered },
                      { type: 'editor.set', assetId: id, draft: r.document },
                    ],
                  }),
                });
                dirty.current = null;
                update(result.project);
                setPendingRecovery(null);
                await clearRecovery(p.id);
                setAssetId(id);
                setNotice('Recovered work saved as a separate project asset.');
              })
            }
          >
            Keep recovered asset
          </button>
          <button
            onClick={() =>
              void run(async () => {
                dirty.current = null;
                await clearRecovery(pendingRecovery.projectId);
                setPendingRecovery(null);
                setDraft(current.current!.editorDraft);
                setNotice('Using the saved project draft.');
              })
            }
          >
            Use saved draft
          </button>
        </section>
      )}
      {loadErrors.length > 0 && (
        <section className="studio-recovery">
          {loadErrors.map((e) => (
            <span key={e.id}>
              {e.id}: cannot read saved project.{' '}
              <button
                onClick={() =>
                  void run(async () => {
                    await apiJson(`/api/projects/${e.id}/recover`, { method: 'POST', body: '{}' });
                    await refreshList();
                    await openProject(e.id);
                  })
                }
              >
                Recover previous save
              </button>
            </span>
          ))}
        </section>
      )}
      <main className={`studio-body ${mode === 'sculpt' ? 'sculpt-mode' : ''}`}>
        <aside className="studio-library">
          <div className="studio-pane-heading">
            <strong>{tab === 'assets' ? 'Asset library' : 'Scene hierarchy'}</strong>
            <button disabled={!project || playing} onClick={() => setGenerator(true)}>
              + Generate
            </button>
          </div>
          <div className="studio-tabs">
            <button className={tab === 'assets' ? 'active' : ''} onClick={() => setTab('assets')}>
              Assets
            </button>
            <button className={tab === 'hierarchy' ? 'active' : ''} onClick={() => setTab('hierarchy')}>
              Hierarchy
            </button>
          </div>
          <input
            aria-label="Search library"
            placeholder="Search assets and objects"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {tab === 'assets' ? (
            <div className="studio-items">
              {project?.assets
                .filter((a) => a.name.toLowerCase().includes(search.toLowerCase()))
                .map((a) => (
                  <button
                    className={`studio-asset ${assetId === a.id ? 'selected' : ''}`}
                    key={a.id}
                    onClick={() => {
                      setAssetId(a.id);
                      setSelected(null);
                    }}
                  >
                    <span
                      className="studio-asset-icon"
                      style={{
                        background:
                          '#' + (a.model.voxels[0]?.color ?? 0x334155).toString(16).padStart(6, '0'),
                      }}
                    >
                      ◇
                    </span>
                    <span>
                      <strong>{a.name}</strong>
                      <small>
                        {a.model.voxels.length.toLocaleString()} voxels{a.rig ? ` · ${a.rig.profile}` : ''}
                      </small>
                    </span>
                  </button>
                ))}
              {!project?.assets.length && (
                <div className="studio-empty">
                  <b>Your game starts here.</b>
                  <p>
                    Generate a character, prop or terrain. Place it in the scene, then give it a behavior.
                  </p>
                  <button onClick={() => setGenerator(true)}>Generate first asset</button>
                </div>
              )}
            </div>
          ) : (
            <div className="studio-items">
              <label className="studio-field">
                Scene
                <select
                  aria-label="Active scene"
                  value={project?.activeSceneId ?? ''}
                  disabled={playing}
                  onChange={(e) =>
                    void run(() => apply([{ type: 'editor.set', sceneId: e.target.value }], 'Change scene'))
                  }
                >
                  {project?.scenes.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                disabled={playing}
                onClick={() =>
                  setRequest({
                    title: 'New scene',
                    initialValue: 'New scene',
                    confirmLabel: 'Create scene',
                    onConfirm: async (name) => {
                      const id = uid();
                      await apply(
                        [
                          { type: 'scene.put', scene: { id, name } },
                          { type: 'editor.set', sceneId: id },
                        ],
                        'Create scene',
                      );
                    },
                  })
                }
              >
                + New scene
              </button>
              {scene?.nodes
                .filter((n) => n.name.toLowerCase().includes(search.toLowerCase()))
                .map((n) => {
                  let depth = 0,
                    parent = n.parentId;
                  while (parent && depth < 20) {
                    depth++;
                    parent = scene.nodes.find((p) => p.id === parent)?.parentId ?? null;
                  }
                  return (
                    <button
                      className={`studio-tree ${selected === n.id ? 'selected' : ''}`}
                      style={{ paddingLeft: 12 + depth * 16 }}
                      key={n.id}
                      onClick={() => {
                        setSelected(n.id);
                        setAssetId(null);
                      }}
                    >
                      {n.parentId ? '↳' : '◇'} {n.name}
                      <small>
                        {n.components
                          .map((c) => (c.type === 'player' ? 'Player' : c.type === 'enemy' ? 'Enemy' : ''))
                          .filter(Boolean)
                          .join(' ')}
                      </small>
                    </button>
                  );
                })}
              {!scene?.nodes.length && (
                <p className="studio-empty">Place an asset from the library to build this scene.</p>
              )}
            </div>
          )}
          <div className="studio-library-bottom">
            <button
              disabled={playing || !project}
              onClick={() =>
                void run(async () => {
                  await flushDraft();
                  await apply(
                    [{ type: 'editor.set', assetId: null, draft: createModelDocument([]) }],
                    'New sculpt',
                  );
                  setHasSculpt(true);
                  setMode('sculpt');
                })
              }
            >
              + Sculpt from blank
            </button>
            <small>
              {hosted ? 'Cloud workspace' : 'Local workspace'} · {project?.assets.length ?? 0} assets
            </small>
          </div>
        </aside>
        <section className="studio-workspace">
          <div
            ref={viewportHost}
            className="studio-viewport"
            style={{ display: mode === 'scene' ? 'block' : 'none' }}
          />
          {hasSculpt && (
            <div className="studio-sculpt" style={{ display: mode === 'sculpt' ? 'block' : 'none' }}>
              <Suspense fallback={<p>Loading sculpt tools…</p>}>
                <SculptEditor
                  documentOwner={`${project?.id}:${project?.activeAssetId ?? 'draft'}`}
                  embedded
                  active={mode === 'sculpt'}
                  initialDocument={draft}
                  onDocumentChange={changedDraft}
                  onSaveAsset={saveAsset}
                />
              </Suspense>
            </div>
          )}
          {mode === 'scene' && !scene?.nodes.length && (
            <div className="studio-onboarding">
              <span className="studio-eyebrow">YOUR VOXEL GAME STUDIO</span>
              <h1>{startingAsset ? 'Start your scene.' : 'Make something playable.'}</h1>
              <p>
                {startingAsset ? (
                  <>Place {startingAsset.name} in your world, then use the inspector to give it a behavior.</>
                ) : (
                  <>
                    Generate your own assets. Build a world.
                    <br />
                    Give it rules, then press Play.
                  </>
                )}
              </p>
              <div>
                <button
                  className="studio-primary"
                  disabled={busy || !project}
                  onClick={() =>
                    startingAsset ? void run(() => addNode(startingAsset)) : setGenerator(true)
                  }
                >
                  {startingAsset ? 'Place first asset' : 'Create an asset'}
                </button>
                <button onClick={() => void run(() => example('exploration'))}>Explore an example</button>
              </div>
              <small>Or connect your agent and describe the game you want to create.</small>
            </div>
          )}
          {playing && (
            <div className="studio-game-hud">
              <strong>
                {gameState?.status === 'won'
                  ? 'You won!'
                  : gameState?.status === 'lost'
                    ? 'Try again'
                    : scene?.name}
              </strong>
              <p>
                {Object.entries(gameState?.variables ?? {})
                  .map(([k, v]) => `${k}: ${v}`)
                  .join(' · ')}
                {gameState?.health.player !== undefined ? ` · health: ${gameState.health.player}` : ''}
              </p>
              <p>{gameState?.message}</p>
              <small>{scene?.instructions}</small>
            </div>
          )}
          {mode === 'scene' && (
            <div className="studio-viewport-caption">
              {playing
                ? 'PLAY MODE · Changes stay in the simulation'
                : 'Orbit: drag · Pan: right drag · Zoom: scroll · Select: click'}
            </div>
          )}
        </section>
        <aside className="studio-inspector">
          <div className="studio-pane-heading">
            <strong>Inspector</strong>
            <small>{node ? 'Scene object' : asset ? 'Asset' : 'Project'}</small>
          </div>
          {playing ? (
            <div className="studio-empty">
              <b>Game running</b>
              <p>Stop Play to resume authoring. Runtime changes do not alter the project.</p>
              <pre>
                {JSON.stringify(
                  { status: gameState?.status, variables: gameState?.variables, errors: gameState?.errors },
                  null,
                  2,
                )}
              </pre>
            </div>
          ) : node && project ? (
            <NodeInspector
              node={node}
              project={project}
              onApply={(n, rev) =>
                run(() =>
                  apply([{ type: 'node.put', sceneId: project.activeSceneId, node: n }], 'Edit object', rev),
                )
              }
              onDelete={() =>
                void run(() =>
                  apply(
                    [{ type: 'node.delete', sceneId: project.activeSceneId, id: node.id }],
                    'Delete object hierarchy',
                  ).then(() => setSelected(null)),
                )
              }
            />
          ) : asset && project ? (
            <AssetInspector
              asset={asset}
              project={project}
              onPlace={() => void run(() => addNode(asset))}
              onSculpt={() => void run(() => selectAsset(asset, true))}
              onApply={(a, rev) => run(() => apply([{ type: 'asset.put', asset: a }], 'Edit asset', rev))}
              onDelete={() =>
                void run(() =>
                  apply([{ type: 'asset.delete', id: asset.id }], 'Delete asset').then(() =>
                    setAssetId(null),
                  ),
                )
              }
              onVariant={() =>
                setRequest({
                  title: 'Create independent variant',
                  initialValue: asset.name + ' variant',
                  confirmLabel: 'Create variant',
                  onConfirm: async (name) => {
                    const id = uid();
                    await apply([{ type: 'asset.variant', sourceId: asset.id, id, name }], 'Create variant');
                    setAssetId(id);
                  },
                })
              }
              onFit={(kind) =>
                setRequest({
                  title: `Generate ${kind}`,
                  initialValue: `${asset.name} ${kind}`,
                  confirmLabel: 'Generate equipment',
                  onConfirm: async (name) => {
                    const id = uid();
                    await apply(
                      [{ type: 'equipment.fit', bodyId: asset.id, id, name, kind }],
                      'Fit equipment',
                    );
                    setAssetId(id);
                  },
                })
              }
            />
          ) : (
            <div className="studio-project-info">
              <span className="studio-eyebrow">WORKSPACE</span>
              <h2>{project?.name ?? 'VoxShop'}</h2>
              <p>
                Select an asset to edit or place it. Select a scene object to change its transform, equipment
                and gameplay.
              </p>
              <dl>
                <dt>Scene units</dt>
                <dd>Meters · Y up</dd>
                <dt>Saved revision</dt>
                <dd>{project?.revision ?? '—'}</dd>
                <dt>Agent access</dt>
                <dd>{hosted ? 'Site MCP' : 'Local MCP'}</dd>
              </dl>
              <button
                disabled={!project}
                onClick={() =>
                  setRequest({
                    title: 'Rename project',
                    initialValue: project!.name,
                    confirmLabel: 'Rename',
                    onConfirm: async (name) => {
                      await apply([{ type: 'project.rename', name }], 'Rename project');
                      await refreshList();
                    },
                  })
                }
              >
                Rename project
              </button>
              <details>
                <summary>Scene settings</summary>
                <SceneSettings
                  key={scene?.id}
                  scene={scene}
                  apply={(s) => run(() => apply([{ type: 'scene.put', scene: s }], 'Edit scene'))}
                />
              </details>
            </div>
          )}
        </aside>
      </main>
      <footer className="studio-status">
        <span role={error ? 'alert' : 'status'} className={error ? 'studio-error' : ''}>
          {error || notice}
        </span>
        {error && <button onClick={() => setError('')}>Dismiss</button>}
        {activeJob && (
          <button
            onClick={() =>
              void apiJson(`/api/jobs/${activeJob}/cancel`, { method: 'POST', body: '{}' }).catch((e) =>
                setError(e.message),
              )
            }
          >
            Cancel job
          </button>
        )}
        <div className="studio-spacer" />
        <small>{project ? `${project.name} · r${project.revision}` : 'Connecting to workspace'}</small>
      </footer>
      <NameDialog request={request} onClose={() => setRequest(null)} />
      {generator && project && (
        <Generator
          onClose={() => setGenerator(false)}
          onGenerate={async (operations, generatedId) => {
            await apply(operations, 'Generate asset');
            setGenerator(false);
            setSelected(null);
            setAssetId(generatedId);
            setSearch('');
            setTab('assets');
            setMode('scene');
            setNotice('Asset saved. Place it in your scene or open Sculpt to customize it.');
          }}
        />
      )}
      {testsOpen && scene && (
        <PlaytestDialog
          scene={scene}
          onClose={() => setTestsOpen(false)}
          onRun={async (spec) => {
            setTestsOpen(false);
            await run(() => playtest(spec));
          }}
        />
      )}
    </div>
  );
}
function SceneSettings({ scene, apply }: { scene: any; apply: (s: any) => Promise<any> }) {
  const [text, setText] = useState(scene?.instructions ?? '');
  return scene ? (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void apply({ ...scene, instructions: text });
      }}
    >
      <label className="studio-field">
        Player instructions
        <textarea value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <button>Save scene settings</button>
    </form>
  ) : null;
}
function Generator({
  onClose,
  onGenerate,
}: {
  onClose: () => void;
  onGenerate: (o: any[], assetId: string) => Promise<void>;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    [name, setName] = useState('New character'),
    [family, setFamily] = useState('quadruped'),
    [color, setColor] = useState('#d88747'),
    [detail, setDetail] = useState(24),
    [text, setText] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog ref={ref} className="studio-dialog" aria-labelledby="generator-title" onCancel={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            const id = uid(),
              rgb = parseInt(color.slice(1), 16);
            let op: any;
            if (['biped', 'quadruped', 'machine'].includes(family))
              op = {
                type: 'asset.character',
                id,
                name,
                profile: family,
                height: detail,
                width: Math.max(6, Math.round(detail * 0.4)),
                color: rgb,
              };
            else {
              const recipe =
                family === 'custom'
                  ? JSON.parse(text)
                  : {
                      version: 1,
                      seed: 1,
                      shapes: [
                        {
                          kind: family,
                          center: family === 'terrain' ? [0, 0, 0] : [0, detail / 2, 0],
                          size: family === 'terrain' ? [64, 12, 64] : [detail, detail, detail],
                          color: rgb,
                        },
                      ],
                    };
              op = { type: 'asset.generate', id, name, recipe };
            }
            await onGenerate([op], id);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <span className="studio-eyebrow">ORIGINAL · EDITABLE · PROCEDURAL</span>
        <h2 id="generator-title">Generate an asset</h2>
        <p>Start with a family or compose your own recipe. Every voxel stays editable.</p>
        <label className="studio-field">
          Name
          <input required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="studio-field">
          Generator
          <select value={family} onChange={(e) => setFamily(e.target.value)}>
            <option value="quadruped">Creature · quadruped rig</option>
            <option value="biped">Character · biped rig</option>
            <option value="machine">Machine · articulated rig</option>
            <option value="box">Prop · box</option>
            <option value="ellipsoid">Prop · ellipsoid</option>
            <option value="cylinder">Prop · cylinder</option>
            <option value="terrain">Terrain · seeded hills</option>
            <option value="custom">Custom shape recipe</option>
          </select>
        </label>
        <div className="studio-two">
          <label className="studio-field">
            Color
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
          </label>
          <label className="studio-field">
            Height / detail
            <input
              type="number"
              min={12}
              max={60}
              value={detail}
              onChange={(e) => setDetail(Number(e.target.value))}
            />
          </label>
        </div>
        {family === 'custom' && (
          <label className="studio-field">
            Recipe JSON
            <textarea
              required
              rows={10}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={
                '{"version":1,"shapes":[{"kind":"box","center":[0,5,0],"size":[10,10,10],"color":14493255}]}'
              }
            />
          </label>
        )}
        {error && (
          <p role="alert" className="studio-error">
            {error}
          </p>
        )}
        <div className="studio-dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="studio-primary" disabled={busy}>
            {busy ? 'Generating…' : 'Generate asset'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
function PlaytestDialog({
  scene,
  onClose,
  onRun,
}: {
  scene: any;
  onClose: () => void;
  onRun: (spec: any) => Promise<void>;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    [text, setText] = useState(
      JSON.stringify(
        { sceneId: scene.id, steps: [{ frames: 120, input: {} }], assertions: [{ type: 'no-errors' }] },
        null,
        2,
      ),
    ),
    [error, setError] = useState('');
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog ref={ref} className="studio-dialog" aria-labelledby="playtest-title" onCancel={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const spec = JSON.parse(text);
            if (!spec.steps || !spec.assertions) throw new Error('Include steps and assertions.');
            await onRun(spec);
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        <h2 id="playtest-title">Test gameplay</h2>
        <p>
          Run repeatable input and assertions on an isolated copy. This checks simulation; use Play to inspect
          visuals and controls.
        </p>
        <div className="studio-two">
          {(['exploration', 'arena'] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              onClick={() =>
                void apiJson(`/api/examples/${kind}/playtest`)
                  .then((spec) => {
                    spec.sceneId = scene.id;
                    setText(JSON.stringify(spec, null, 2));
                  })
                  .catch((e) => setError(e.message))
              }
            >
              {kind === 'arena' ? 'Arena scenario' : 'Crystal trail scenario'}
            </button>
          ))}
        </div>
        <label className="studio-field">
          Playtest JSON
          <textarea
            aria-label="Playtest JSON"
            rows={17}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        <p>
          Use status, variable, position, enabled and no-errors assertions. At most 18,000 fixed simulation
          frames per run.
        </p>
        {error && (
          <p className="studio-error" role="alert">
            {error}
          </p>
        )}
        <div className="studio-dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="studio-primary">Run scenario</button>
        </div>
      </form>
    </dialog>
  );
}
