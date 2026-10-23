import AgentConnection from './AgentConnection';
import AssetGenerator from './AssetGenerator';
import PlaytestDialog from './PlaytestDialog';
import SceneSettings from './SceneSettings';
import GameHud from './GameHud';
import MultiplayerRooms from './MultiplayerRooms';
import MultiplayerJoin from './MultiplayerJoin';
import TerrainEditToolbar from './TerrainEditToolbar';
import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { apiJson, localApi, watchProjects } from '../services/localApi';
import {
  identityTransform,
  type Asset,
  type Prefab,
  type ProjectDocument,
} from '../services/projectDocument';
import { createModelDocument, type ModelDocument } from '../services/modelDocument';
import { readRecovery, writeRecovery, clearRecovery, type DraftRecovery } from '../services/recoveryStore';
import { migrateLegacyProject } from '../services/legacyProjectMigration';
import type { ExampleKind } from '../services/examples';
import type { GameSimulation } from '../runtime/GameSimulation';
import type {
  GameViewport,
  TerrainBrushSize,
  TerrainBrushShape,
  TerrainInspection,
  TerrainPaletteLayer,
  TerrainPaint,
  TerrainToolMode,
} from '../runtime/GameViewport';
import type { WorldEdit } from '../services/worldDocument';
import { NameDialog, type NameRequest } from './NameDialog';
import { NodeInspector } from './NodeInspector';
import { AssetInspector } from './StudioInspectors';
import SceneCatalogEditor from './SceneCatalogEditor';
import { SceneScatterEditor } from './SceneScatterEditor';
import PrefabLibrary from './PrefabLibrary';
import { createPrefabFromInstance, createPrefabFromSubtree } from '../services/prefabAuthoring';
import { sculptedAsset } from '../services/assetAssembly';
import voxshopLogo from '../assets/voxshop_logo.png?url';
import { APP_VERSION, APP_PUBLISHER } from '../services/appMetadata';
import {
  DEFAULT_FRAME_PACING,
  FRAME_RATE_TARGETS,
  normalizeFramePacing,
  type FramePacingSettings,
} from '../runtime/framePacing';
import './studio.css';
const SculptEditor = lazy(() => import('../App'));
const uid = () => crypto.randomUUID();
const FRAME_PACING_PREFERENCE_KEY = 'voxshop:editor-frame-pacing:v1';

function loadFramePacingPreference(): FramePacingSettings {
  try {
    const saved = localStorage.getItem(FRAME_PACING_PREFERENCE_KEY);
    return saved ? normalizeFramePacing(JSON.parse(saved)) : { ...DEFAULT_FRAME_PACING };
  } catch {
    return { ...DEFAULT_FRAME_PACING };
  }
}

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
  const [terrainMode, setTerrainMode] = useState<TerrainToolMode | null>(null),
    [terrainInspection, setTerrainInspection] = useState<TerrainInspection | null>(null);
  const [terrainBrushSize, setTerrainBrushSize] = useState<TerrainBrushSize>(1);
  const [terrainBrushShape, setTerrainBrushShape] = useState<TerrainBrushShape>('brush');
  const [terrainPaletteLayer, setTerrainPaletteLayer] = useState<TerrainPaletteLayer>('surface');
  const [gameHudTabs, setGameHudTabs] = useState<Record<string, string>>({});
  const [framePacing, setFramePacing] = useState<FramePacingSettings>(loadFramePacingPreference);
  const [terrainCustomPaint, setTerrainCustomPaint] = useState<TerrainPaint | null>(null);
  const [notice, setNotice] = useState('Connecting to workspace…'),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [playing, setPlaying] = useState(false),
    [gameState, setGameState] = useState<ReturnType<GameSimulation['inspect']> | null>(null);
  const [request, setRequest] = useState<NameRequest | null>(null),
    [generator, setGenerator] = useState(false),
    [catalogOpen, setCatalogOpen] = useState(false),
    [agent, setAgent] = useState(false),
    [multiplayerRoomsOpen, setMultiplayerRoomsOpen] = useState(false),
    [configuration, setConfiguration] = useState(''),
    [testsOpen, setTestsOpen] = useState(false),
    [activeJob, setActiveJob] = useState<string | null>(null);
  const [hosted, setHosted] = useState(false);
  const [draft, setDraft] = useState<ModelDocument | null>(null),
    [pendingRecovery, setPendingRecovery] = useState<DraftRecovery | null>(null);
  const viewportHost = useRef<HTMLDivElement>(null),
    viewport = useRef<GameViewport | null>(null),
    terrainEditQueue = useRef(Promise.resolve()),
    projectActivation = useRef(0),
    current = useRef(project),
    dirty = useRef<DraftRecovery | null>(null),
    saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null),
    saving = useRef<Promise<any>>(Promise.resolve()),
    file = useRef<HTMLInputElement>(null);
  const framePacingRef = useRef(framePacing);
  framePacingRef.current = framePacing;
  const framePacingChangedRef = useRef(false);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  current.current = project;
  const scene = project?.scenes.find((s) => s.id === project.activeSceneId),
    world = scene?.worldId ? project?.worlds.find((candidate) => candidate.id === scene.worldId) : undefined,
    customPaint = terrainCustomPaint ?? {
      color: world?.generator.palette.surface ?? 0x55aa44,
      materialType: world?.generator.palette.materialType ?? 'STANDARD',
    },
    node = scene?.nodes.find((n) => n.id === selected),
    linkedInstanceRootId = node?.prefabLink?.instanceId,
    linkedPrefab = project?.prefabs.find((prefab) => prefab.id === node?.prefabLink?.prefabId),
    asset = project?.assets.find((a) => a.id === assetId),
    startingAsset = asset ?? project?.assets[0];
  const gameScene = project?.scenes.find((candidate) => candidate.id === gameState?.sceneId) ?? scene;
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
  const changeFramePacing = (next: FramePacingSettings) => {
    const normalized = normalizeFramePacing(next);
    framePacingChangedRef.current = true;
    setFramePacing(normalized);
    viewport.current?.setFramePacing(normalized);
    try {
      localStorage.setItem(FRAME_PACING_PREFERENCE_KEY, JSON.stringify(normalized));
    } catch {
      setNotice('Frame pacing applies for this session, but the preference could not be saved.');
    }
    void apiJson('/api/preferences/frame-pacing', {
      method: 'PUT',
      body: JSON.stringify(normalized),
    }).catch(() => {});
  };
  const apply = async (
    operations: unknown[],
    label: string,
    revision?: number,
    terrainContext?: { projectId: string; worldId: string },
  ) => {
    await flushDraft();
    const p = current.current;
    if (!p) throw new Error('Open a project first.');
    if (terrainContext) {
      if (p.id !== terrainContext.projectId)
        throw new Error('Project changed while the terrain stroke was waiting to save.');
      if (p.scenes.find((candidate) => candidate.id === p.activeSceneId)?.worldId !== terrainContext.worldId)
        throw new Error('Active terrain world changed while the stroke was waiting to save.');
    }
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
    const activation = ++projectActivation.current;
    await flushDraft();
    if (activation !== projectActivation.current) return;
    const p = await apiJson<ProjectDocument>(`/api/projects/${id}/activate`, { method: 'POST', body: '{}' });
    if (activation !== projectActivation.current) return;
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
        void migrateLegacyProject(p)
          .then((migration) => {
            if (!migration || current.current?.id !== p.id) return;
            if (!migration.project) {
              setNotice(
                `No valid legacy entries were imported. ${migration.skipped} invalid entries remain in the original browser library.`,
              );
              return;
            }
            update(migration.project);
            setNotice(
              `Imported ${migration.importedCount} legacy assets.${migration.skipped ? ` ${migration.skipped} invalid entries stayed in the old library.` : ''}`,
            );
          })
          .catch((e) => setError(`Legacy library remains available. ${e.message}`));
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
    void watchProjects(
      (event) => {
        const p = current.current;
        if (!p) return;
        const activation = event.activated ? ++projectActivation.current : projectActivation.current;
        if (event.activated && event.projectId !== p.id) {
          void flushDraft()
            .catch(() => {})
            .then(async () => {
              const next = await apiJson<ProjectDocument>(`/api/projects/${event.projectId}`);
              if (disposed || activation !== projectActivation.current) return;
              dirty.current = null;
              setSelected(null);
              setAssetId(null);
              setPlaying(false);
              setMode('scene');
              update(next);
              setPendingRecovery((await readRecovery(next.id)) ?? null);
              await refreshList();
              // A write can commit while the activation event is still opening this project.
              // Its change event may arrive before `current` points at the new ID and be ignored;
              // reread after the switch so the viewport cannot remain on the stale revision.
              const latest = await apiJson<ProjectDocument>(`/api/projects/${next.id}`);
              if (disposed || activation !== projectActivation.current) return;
              if (current.current?.id === latest.id && current.current.revision < latest.revision)
                update(latest);
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
      },
      controller.signal,
      async (request) => {
        let result: Record<string, unknown>;
        try {
          if (
            current.current?.id !== request.projectId ||
            current.current?.revision !== request.expectedRevision
          )
            throw new Error(
              `The open editor (${current.current?.id ?? 'loading'} r${current.current?.revision ?? '?'}) does not match ${request.projectId} r${request.expectedRevision}. Activate the project and retry.`,
            );
          if (dirty.current) throw new Error('Finish saving the manual sculpt before an agent walkthrough.');
          if (!viewport.current) throw new Error('The viewport is still opening.');
          setMode('scene');
          result = await viewport.current.observe(request.command, {
            id: request.projectId,
            revision: request.expectedRevision,
          });
          if (
            current.current?.id !== request.projectId ||
            current.current?.revision !== request.expectedRevision
          )
            throw new Error('Project changed during capture. Inspect and retry on the new revision.');
          setPlaying(!!viewport.current.simulation);
        } catch (error) {
          result = { error: (error as Error).message };
        }
        void apiJson('/api/viewport/result', {
          method: 'POST',
          body: JSON.stringify({
            id: request.id,
            clientId: request.clientId,
            projectId: request.projectId,
            revision: request.expectedRevision,
            ...result,
          }),
        }).catch((error) => setError(error.message));
      },
    );
    return () => {
      disposed = true;
      controller.abort();
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);
  useEffect(() => {
    if (!project || !viewportHost.current) return;
    let cancelled = false;
    void import('../runtime/GameViewport')
      .then(({ GameViewport }) => {
        if (cancelled || !viewportHost.current) return;
        if (!viewport.current) {
          viewport.current = new GameViewport(
            viewportHost.current,
            project,
            (id) => {
              setSelected(id);
              setAssetId(null);
              setTab('hierarchy');
            },
            {
              renderLoop: 'unlocked',
              framePacing: framePacingRef.current,
              asyncTerrainTiles: true,
              createTerrainWorker: () =>
                new Worker(new URL('../runtime/worldStream.worker.ts', import.meta.url), { type: 'module' }),
              asyncVoxelChunks: true,
              createVoxelWorker: () =>
                new Worker(new URL('../runtime/worldVoxel.worker.ts', import.meta.url), { type: 'module' }),
            },
          );
          viewport.current.onState = (state) => {
            setGameState(state);
            setPlaying(!!state);
            if (state) setMode('scene');
          };
          viewport.current.onHudTab = setGameHudTabs;
          const activeScene = project.scenes.find((candidate) => candidate.id === project.activeSceneId),
            activeWorld = activeScene?.worldId
              ? project.worlds.find((candidate) => candidate.id === activeScene.worldId)
              : undefined;
          viewport.current.setTerrainCustomPaint(
            terrainCustomPaint ?? {
              color: activeWorld?.generator.palette.surface ?? 0x55aa44,
              materialType: activeWorld?.generator.palette.materialType ?? 'STANDARD',
            },
          );
        } else if (!playing) viewport.current.load(project);
        viewport.current.onTerrainEdit = (projectId, worldId, edits) => {
          terrainEditQueue.current = terrainEditQueue.current.then(async () => {
            await run(() =>
              apply(
                [{ type: 'world.edit', worldId, edits }],
                edits[0].value ? 'Place terrain stroke' : 'Remove terrain stroke',
                undefined,
                { projectId, worldId },
              ),
            );
          });
        };
        viewport.current.onTerrainEditError = setError;
        viewport.current.onTerrainInspect = setTerrainInspection;
        if (!playing) viewport.current.select(selectedRef.current);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [project, playing]);
  useEffect(() => {
    let active = true;
    void apiJson<{ settings: unknown; saved: boolean }>('/api/preferences/frame-pacing')
      .then(({ settings, saved }) => {
        if (!active || !saved || framePacingChangedRef.current) return;
        const normalized = normalizeFramePacing(settings);
        setFramePacing(normalized);
        viewport.current?.setFramePacing(normalized);
        try {
          localStorage.setItem(FRAME_PACING_PREFERENCE_KEY, JSON.stringify(normalized));
        } catch {
          // The workspace file remains the durable preference when browser storage is unavailable.
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    viewport.current?.setTerrainMode(world && !playing ? terrainMode : null);
  }, [terrainMode, world, playing]);
  useEffect(() => {
    viewport.current?.setTerrainBrushSize(terrainBrushSize);
  }, [terrainBrushSize]);
  useEffect(() => {
    viewport.current?.setTerrainBrushShape(terrainBrushShape);
  }, [terrainBrushShape]);
  useEffect(() => {
    viewport.current?.setTerrainPaletteLayer(terrainPaletteLayer);
  }, [terrainPaletteLayer]);
  useEffect(() => {
    viewport.current?.setTerrainCustomPaint(customPaint);
  }, [customPaint, world]);
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
  const example = async (kind: ExampleKind) => {
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
          className="studio-new-project"
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
        <button
          className="studio-import-project"
          disabled={busy || playing}
          onClick={() => file.current?.click()}
        >
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
          className="studio-save-project"
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
        <button className="studio-connect-agent" onClick={() => setAgent(!agent)} aria-expanded={agent}>
          Connect agent
        </button>
        <button
          className="studio-primary studio-export-game"
          disabled={!project || busy}
          onClick={() => void run(build)}
        >
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
        <button
          disabled={!selected || playing || mode !== 'scene'}
          onClick={() => {
            try {
              viewport.current?.focus(selected!);
            } catch (error) {
              setError((error as Error).message);
            }
          }}
          title="Frame the selected object · F in viewport"
        >
          Focus selection
        </button>
        <button
          disabled={!project || !scene || busy || playing || mode !== 'scene'}
          onClick={() =>
            void run(async () => {
              await flushDraft();
              setCatalogOpen(true);
            })
          }
        >
          Items & recipes
        </button>
        <button
          onClick={() => setMultiplayerRoomsOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={multiplayerRoomsOpen}
        >
          Multiplayer rooms
        </button>
        <div className="studio-spacer" />
        <button disabled={busy || playing} onClick={() => void run(() => example('exploration'))}>
          Crystal trail
        </button>
        <button disabled={busy || playing} onClick={() => void run(() => example('arena'))}>
          Arena
        </button>
        <button disabled={busy || playing} onClick={() => void run(() => example('survival'))}>
          Survival crafting
        </button>
        <button disabled={busy || playing} onClick={() => void run(() => example('construction'))}>
          Construction
        </button>
        <button disabled={!project || busy || playing} onClick={() => setTestsOpen(true)}>
          Run playtest
        </button>
        <div
          className="studio-frame-pacing"
          title="Controls preview render-loop calls. Simulation stays fixed at 60 Hz; the browser or desktop WebView controls display presentation."
        >
          <label>
            <input
              type="checkbox"
              checked={framePacing.capFrameRate}
              aria-label="Cap preview render rate"
              onChange={(event) => changeFramePacing({ ...framePacing, capFrameRate: event.target.checked })}
            />
            <span>Frame cap</span>
          </label>
          <select
            value={framePacing.maxFpsTarget}
            aria-label="Preview frame-rate cap"
            disabled={!framePacing.capFrameRate}
            onChange={(event) =>
              changeFramePacing({ ...framePacing, maxFpsTarget: Number(event.target.value) })
            }
          >
            {FRAME_RATE_TARGETS.map((fps) => (
              <option key={fps} value={fps}>
                {fps} FPS
              </option>
            ))}
          </select>
        </div>
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
              setNotice(
                'Play mode · click for keyboard. Move and act with the selected player’s bindings; right-drag to look.',
              );
            }
          }}
        >
          {playing ? '■ Stop' : '▶ Play'}
        </button>
      </nav>
      {agent && (
        <AgentConnection
          hosted={hosted}
          configuration={configuration}
          onNotice={setNotice}
          onError={setError}
          onClose={() => setAgent(false)}
        />
      )}
      {multiplayerRoomsOpen && (
        <MultiplayerRooms
          projectBinding={
            project
              ? { projectId: project.id, revision: project.revision, sceneId: project.activeSceneId }
              : undefined
          }
          onClose={() => setMultiplayerRoomsOpen(false)}
          onPlayCreated={(room) =>
            void run(async () => {
              await flushDraft();
              if (!viewport.current) throw Error('The viewport is still opening.');
              await viewport.current.joinMultiplayerRoom(room);
              setMultiplayerRoomsOpen(false);
            })
          }
        >
          {viewport.current && <MultiplayerJoin viewport={viewport.current} />}
        </MultiplayerRooms>
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
              <PrefabLibrary
                prefabs={project?.prefabs ?? []}
                selectedNode={node ?? null}
                linkedInstance={
                  linkedPrefab && linkedInstanceRootId
                    ? { prefab: linkedPrefab, rootId: linkedInstanceRootId }
                    : null
                }
                disabled={playing}
                busy={busy}
                search={search}
                onSave={() => {
                  if (!node || !scene) return;
                  const selectedNode = node,
                    sourceScene = scene;
                  setRequest({
                    title: 'Save selected subtree as prefab',
                    initialValue: selectedNode.name,
                    confirmLabel: 'Save prefab',
                    onConfirm: async (name) => {
                      await apply(
                        [
                          {
                            type: 'prefab.put',
                            prefab: createPrefabFromSubtree(sourceScene.nodes, selectedNode.id, uid(), name),
                          },
                        ],
                        'Save reusable prefab',
                      );
                    },
                  });
                }}
                onUpdateSource={(prefab, rootId) => {
                  if (!scene) return;
                  void run(() => {
                    const source = createPrefabFromInstance(scene.nodes, rootId, prefab);
                    return apply(
                      [
                        {
                          type: 'prefab.put',
                          prefab: source.prefab,
                          sourceInstanceRootId: rootId,
                          sourceInstanceNodeIds: source.sourceInstanceNodeIds,
                        },
                      ],
                      `Update ${prefab.name}`,
                    );
                  });
                }}
                onResetInstance={(prefab, rootId) => {
                  if (!scene) return;
                  void run(() =>
                    apply(
                      [{ type: 'prefab.reset', sceneId: scene.id, instanceRootId: rootId }],
                      `Reset ${prefab.name} instance`,
                    ),
                  );
                }}
                onPlace={(prefab) => {
                  if (!scene) return;
                  const targetScene = scene;
                  void run(async () => {
                    const nodeIds = prefab.nodes.map(() => uid());
                    const rootIndex = prefab.nodes.findIndex((candidate) => candidate.id === prefab.rootId);
                    const root = prefab.nodes[rootIndex];
                    await apply(
                      [
                        {
                          type: 'prefab.instantiate',
                          prefabId: prefab.id,
                          sceneId: targetScene.id,
                          nodeIds,
                          position: [
                            root.transform.position[0] + 2,
                            root.transform.position[1],
                            root.transform.position[2],
                          ],
                        },
                      ],
                      `Place ${prefab.name}`,
                    );
                    setSelected(nodeIds[rootIndex]);
                    setAssetId(null);
                  });
                }}
                onDelete={(prefab) =>
                  void run(() => apply([{ type: 'prefab.delete', id: prefab.id }], 'Delete prefab'))
                }
              />
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
          {mode === 'scene' && playing && (
            <GameHud
              key={`${project?.id ?? ''}:${gameState?.sceneId ?? ''}`}
              widgets={gameScene?.hud ?? []}
              state={
                gameState
                  ? {
                      ...gameState,
                      activeTabs: gameHudTabs,
                      inventory: gameState.inventory.map((stack) => {
                        const item = gameScene?.items.find((entry) => entry.id === stack.itemId);
                        return {
                          ...stack,
                          usable: !!item?.use,
                          actionLabel: item?.use?.type === 'equip' ? 'Equip' : 'Use',
                        };
                      }),
                    }
                  : null
              }
              onAction={(action) => viewport.current?.triggerAction(action)}
              onEvent={(eventId) => viewport.current?.triggerHudEvent(eventId)}
              onTab={(groupId, tabId) => viewport.current?.selectHudTab(groupId, tabId)}
              onUseItem={(itemId) => viewport.current?.triggerUseItem(itemId)}
              onMoveItem={(fromIndex, toIndex) => viewport.current?.moveInventoryStack(fromIndex, toIndex)}
              onSortInventory={() => viewport.current?.sortInventoryByName()}
            />
          )}
          {mode === 'scene' && world && !playing && (
            <TerrainEditToolbar
              mode={terrainMode}
              inspection={terrainInspection}
              brushSize={terrainBrushSize}
              brushShape={terrainBrushShape}
              palette={world.generator.palette}
              paletteLayer={terrainPaletteLayer}
              customPaint={customPaint}
              disabled={busy}
              onModeChange={setTerrainMode}
              onBrushSizeChange={setTerrainBrushSize}
              onBrushShapeChange={setTerrainBrushShape}
              onPaletteLayerChange={setTerrainPaletteLayer}
              onCustomPaintChange={setTerrainCustomPaint}
            />
          )}
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
          {mode === 'scene' && !scene?.nodes.length && !scene?.worldId && (
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
                <button onClick={() => void run(() => example('survival'))}>Try crafting example</button>
                <button onClick={() => void run(() => example('construction'))}>Try construction</button>
              </div>
              <small>Or connect your agent and describe the game you want to create.</small>
            </div>
          )}
          {playing && (
            <details
              key={gameScene?.id}
              className={`studio-game-hud${gameScene?.hud?.length ? ' has-authored-hud' : ''}`}
              open={!gameScene?.hud?.length}
            >
              <summary>Play status</summary>
              <strong>
                {gameState?.status === 'won'
                  ? 'You won!'
                  : gameState?.status === 'lost'
                    ? 'Try again'
                    : gameScene?.name}
              </strong>
              <p>
                {Object.entries(gameState?.variables ?? {})
                  .map(([k, v]) => `${k}: ${v}`)
                  .join(' · ')}
                {gameState?.playerId && gameState.health[gameState.playerId] !== undefined
                  ? ` · health: ${gameState.health[gameState.playerId]}`
                  : ''}
              </p>
              {!!gameState?.objectives.length && (
                <ol className="studio-objective-list" aria-label="Objectives">
                  {gameState.objectives.map((objective) => (
                    <li
                      key={objective.id}
                      aria-label={`${objective.text}: ${objective.completed ? 'complete' : objective.available ? 'available' : 'locked'}`}
                    >
                      <span aria-hidden="true">
                        {objective.completed ? '✓' : objective.available ? '○' : '🔒'}
                      </span>{' '}
                      {objective.text}{' '}
                      <small>
                        ({objective.current} {objective.condition.op} {objective.condition.value})
                      </small>
                      {!objective.available && <small> Locked until prerequisites are complete.</small>}
                    </li>
                  ))}
                </ol>
              )}
              {gameScene?.items.length ? (
                <p aria-label="Inventory">
                  Inventory:{' '}
                  {gameState?.inventory.length
                    ? gameState.inventory
                        .slice(0, 8)
                        .map((stack) => `${stack.name} ×${stack.quantity}`)
                        .join(' · ') +
                      (gameState.inventory.length > 8 ? ` · +${gameState.inventory.length - 8} more` : '')
                    : 'empty'}
                </p>
              ) : null}
              <p>{gameState?.message}</p>
              {gameState?.interactionTarget && (
                <small className="studio-interaction-prompt">
                  <kbd>E</kbd> · {gameState.interactionTarget.prompt}
                </small>
              )}
              {gameScene?.worldId && (
                <small className="studio-interaction-prompt">
                  <kbd>B</kbd> place cell · <kbd>X</kbd> remove cell
                </small>
              )}
              {gameState?.construction && (
                <label className="studio-field studio-construction-paint">
                  Construction paint · Q to cycle
                  <select
                    aria-label="Construction paint"
                    value={gameState.construction.selectedId}
                    disabled={!gameState.construction.enabled}
                    onChange={(event) => viewport.current?.selectConstructionPaint(event.target.value)}
                  >
                    {gameState.construction.palette.map((paint) => (
                      <option key={paint.id} value={paint.id}>
                        {paint.name} · {paint.materialType.toLowerCase()}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <small>{gameScene?.instructions}</small>
            </details>
          )}
          {mode === 'scene' && (
            <div className="studio-viewport-caption">
              {playing
                ? 'PLAY MODE · Changes stay in the simulation'
                : terrainMode === 'inspect'
                  ? 'TERRAIN INSPECT · Click a visible cell to read its logical and physical position'
                  : terrainMode
                    ? `TERRAIN ${terrainMode.toUpperCase()} · Click or drag to paint · release to save`
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
                  key={`${project?.id ?? ''}:${scene?.id ?? ''}`}
                  scene={scene}
                  worlds={project?.worlds ?? []}
                  audioClips={project?.audioClips ?? []}
                  addAudioClip={(clip) =>
                    run(() => apply([{ type: 'audio.put', clip }], `Import audio · ${clip.name}`))
                  }
                  deleteAudioClip={(id) =>
                    run(() => apply([{ type: 'audio.delete', id }], 'Delete audio clip'))
                  }
                  apply={(s) => run(() => apply([{ type: 'scene.put', scene: s }], 'Edit scene'))}
                  createWorld={(world, updatedScene) =>
                    run(() =>
                      apply([world, { type: 'scene.put', scene: updatedScene }], 'Create terrain world'),
                    )
                  }
                  updateWorld={(world, updatedScene) =>
                    run(() =>
                      apply([world, { type: 'scene.put', scene: updatedScene }], 'Update terrain world'),
                    )
                  }
                />
              </details>
              {scene && project && (
                <details>
                  <summary>Scatter assets</summary>
                  <SceneScatterEditor
                    assets={project.assets}
                    scene={scene}
                    world={world ?? null}
                    busy={busy || playing}
                    onCreate={(operation) => run(() => apply([operation], 'Scatter scene assets'))}
                    onDelete={(id) =>
                      run(() =>
                        apply(
                          [{ type: 'scene.scatter.delete', sceneId: scene.id, id }],
                          'Delete scatter group',
                        ),
                      )
                    }
                  />
                </details>
              )}
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
        <small title={`${APP_PUBLISHER} · VoxShop ${APP_VERSION}`}>
          {project ? `${project.name} · r${project.revision}` : 'Connecting to workspace'} · v{APP_VERSION}
        </small>
      </footer>
      <NameDialog request={request} onClose={() => setRequest(null)} />
      {catalogOpen && project && scene && (
        <SceneCatalogEditor
          project={project}
          scene={scene}
          onClose={() => setCatalogOpen(false)}
          onSave={async (updatedScene, revision) => {
            await apply(
              [{ type: 'scene.put', scene: updatedScene }],
              'Edit scene item and recipe catalog',
              revision,
            );
          }}
        />
      )}
      {generator && project && (
        <AssetGenerator
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
