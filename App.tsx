import React, { useState, useEffect, useRef, useMemo } from 'react';
import { VoxelEngine } from './services/VoxelEngine';
import { UIOverlay } from './components/UIOverlay';
import { RiggingOverlay } from './components/RiggingOverlay';
import { EditingOverlay } from './components/EditingOverlay';
import { PromptModal } from './components/PromptModal';
import { JsonModal } from './components/JsonModal';
import { NameDialog, type NameRequest } from './components/NameDialog';

import { SettingsOverlay, type SettingsData } from './components/SettingsOverlay';
import { RenderSettingsOverlay, RenderSettings, DEFAULT_RENDER_SETTINGS } from './components/RenderSettingsOverlay';
import { SplashScreen } from './components/SplashScreen';
import { DiagnosticsPanel } from './components/DiagnosticsPanel';
import { DiagnosticLogEntry, logger, normalizeExternalLog } from './services/logger';
import { AppState, VoxelData, SymmetryConfig, SavedModel, DetailLevel, Pose, VoxelMaterial, SceneObject } from './types';
import { SKELETONS } from './utils/riggingConstants';
import { normalizeVoxels, type ModelDocument } from './services/modelDocument';
import { localApi } from './services/localApi';

const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';
const getErrorMessage = (error: unknown, fallback = 'Something went wrong'): string =>
  error instanceof Error ? error.message : fallback;
const readPreference = (key: string): string | null => { try { return localStorage.getItem(key); } catch { return null; } };

const DEFAULT_SETTINGS: SettingsData = {
  apiType: 'proxy',
  apiKey: '',
  localUrl: 'http://localhost:4269/api/generate',
  apiEndpoint: 'https://api.openai.com/v1/chat/completions',
  modelName: 'gpt-4o',
  backgroundColor: '#0d1117',
  gridColor: '#3a4a60',
  diagnosticsEnabled: false,
  diagnosticsIncludePrompts: false,
  diagnosticsIncludeRawResponses: false
};

interface SculptProps { initialDocument?: ModelDocument | null; onDocumentChange?: (document: ModelDocument) => void; onSaveAsset?: (name: string, document: ModelDocument) => Promise<void>; embedded?: boolean; active?: boolean; documentOwner?: string }
const App: React.FC<SculptProps> = ({ initialDocument, onDocumentChange, onSaveAsset, embedded = false, active = true, documentOwner }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<VoxelEngine | null>(null);
  const externalLoad = useRef(false);
  const loadedOwner = useRef<string | undefined>(undefined);
  const generationAbort = useRef<AbortController | null>(null);
  const changeCallback = useRef(onDocumentChange); changeCallback.current = onDocumentChange;

  const [appState, setAppState] = useState<AppState>(AppState.STABLE);
  const [voxelCount, setVoxelCount] = useState<number>(0);

  const [isJsonModalOpen, setIsJsonModalOpen] = useState(false);
  const [jsonModalMode, setJsonModalMode] = useState<'view' | 'import'>('view');

  const [isPromptModalOpen, setIsPromptModalOpen] = useState(false);
  const [promptMode, setPromptMode] = useState<'create' | 'morph' | 'rebuild'>('create');

  const [isGenerating, setIsGenerating] = useState(false);
  const [nameRequest, setNameRequest] = useState<NameRequest | null>(null);
  const [saveNotice, setSaveNotice] = useState('');

  const [jsonData, setJsonData] = useState('');
  const [isAutoRotate, setIsAutoRotate] = useState(() => {
    try { const s = localStorage.getItem('voxelBuilderAutoRotate'); return s !== null ? JSON.parse(s) : true; }
    catch { return true; }
  });
  const [showGrid, setShowGrid] = useState(() => {
    try { const s = localStorage.getItem('voxelBuilderShowGrid'); return s !== null ? JSON.parse(s) : false; }
    catch { return false; }
  });

  const [symmetry, setSymmetry] = useState<SymmetryConfig>({ x: false, y: false, z: false });
  const [brushType, setBrushType] = useState<'single' | 'sphere' | 'box'>('single');
  const [brushSize, setBrushSize] = useState<number>(1);
  const [currentMaterial, setCurrentMaterial] = useState<VoxelMaterial>(VoxelMaterial.STANDARD);

  const [currentBaseModel, setCurrentBaseModel] = useState<string>('My Model');
  const [presets, setPresets] = useState<SavedModel[]>([]);
  const [customBuilds, setCustomBuilds] = useState<SavedModel[]>(() => {
    try { const s = localStorage.getItem('voxelBuilderCustomBuilds'); return s ? JSON.parse(s) : []; }
    catch { return []; }
  });
  const [customRebuilds, setCustomRebuilds] = useState<SavedModel[]>(() => {
    try { const s = localStorage.getItem('voxelBuilderCustomRebuilds'); return s ? JSON.parse(s) : []; }
    catch { return []; }
  });
  const [promptHistory, setPromptHistory] = useState<{timestamp: number, prompt: string, snapshot: any}[]>(() => {
    try { const s = localStorage.getItem('voxelBuilderPromptHistory'); return s ? JSON.parse(s) : []; }
    catch { return []; }
  });

  const [sceneObjects, setSceneObjects] = useState<SceneObject[]>(() => {
    try { const s = localStorage.getItem('voxelBuilderSceneObjects'); return s ? JSON.parse(s) : []; }
    catch { return []; }
  });

  const [settings, setSettings] = useState(() => {
    const saved = readPreference('voxelBuilderSettings');
    if (saved) {
      try {
        return { ...DEFAULT_SETTINGS, ...JSON.parse(saved), apiKey: '' };
      } catch (e) {
        logger.error('settings.parse.failed', { error: e instanceof Error ? e.message : String(e) });
      }
    }
    return DEFAULT_SETTINGS;
  });
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isDiagnosticsOpen, setIsDiagnosticsOpen] = useState(false);
  const [isRenderSettingsOpen, setIsRenderSettingsOpen] = useState(false);
  const [renderSettings, setRenderSettings] = useState<RenderSettings>(DEFAULT_RENDER_SETTINGS);
  const [showSplash, setShowSplash] = useState(!embedded);
  const [clientLogs, setClientLogs] = useState(logger.getEntries());
  const [serverLogs, setServerLogs] = useState<DiagnosticLogEntry[]>([]);

  const relevantRebuilds = useMemo(() => {
      return customRebuilds.filter(r => r.baseModel === currentBaseModel);
  }, [customRebuilds, currentBaseModel]);

  useEffect(() => {
    if (!containerRef.current) return;

    const engine = new VoxelEngine(
      containerRef.current,
      (newState) => setAppState(newState),
      (count) => setVoxelCount(count)
    );

    engineRef.current = engine;
    engine.onDocumentChange = document => { if (!externalLoad.current) changeCallback.current?.(document); };


    const savedSettings = readPreference('voxelBuilderSettings');
    if (savedSettings) {
      try {
        const s = JSON.parse(savedSettings);
        if (s.backgroundColor) engine.setBackgroundColor(s.backgroundColor);
        if (s.gridColor) engine.setGridColor(s.gridColor);
      } catch { /* ignore */ }
    }

    const savedScene = embedded ? null : readPreference('voxelBuilderSceneObjects');
    if (savedScene) {
      try {
        const objs: SceneObject[] = JSON.parse(savedScene);
        objs.forEach(obj => engine.placeInScene(obj));
      } catch { /* ignore */ }
    }

    localApi('/api/presets')
      .then(r => r.json())
      .then(data => { if (Array.isArray(data)) setPresets(data); })
      .catch(() => {});

    const handleResize = () => engine.handleResize();
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      engine.cleanup();
    };
  }, []);

  useEffect(() => {
    if (!initialDocument || !engineRef.current) return;
    if (loadedOwner.current===documentOwner && JSON.stringify(engineRef.current.getModelDocument()) === JSON.stringify(initialDocument)) return;
    loadedOwner.current=documentOwner;
    generationAbort.current?.abort();
    externalLoad.current = true;
    try { engineRef.current.loadInitialModel(initialDocument.voxels, initialDocument.skeleton); }
    finally { externalLoad.current = false; }
  }, [initialDocument, documentOwner]);
  useEffect(()=>()=>{generationAbort.current?.abort();},[]);
  useEffect(() => { if (engineRef.current) { engineRef.current.active = active; if(active)engineRef.current.handleResize(); } }, [active]);

  const persistPreference = (key: string, value: unknown) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { setSaveNotice('Browser preferences could not be saved. Project files and downloaded models remain available.'); } };
  useEffect(() => { if (!embedded) persistPreference('voxelBuilderCustomBuilds', customBuilds); }, [customBuilds]);
  useEffect(() => { if (!embedded) persistPreference('voxelBuilderCustomRebuilds', customRebuilds); }, [customRebuilds]);
  useEffect(() => { persistPreference('voxelBuilderPromptHistory', promptHistory.slice(-30)); }, [promptHistory]);
  useEffect(() => { persistPreference('voxelBuilderAutoRotate', isAutoRotate); }, [isAutoRotate]);
  useEffect(() => { persistPreference('voxelBuilderShowGrid', showGrid); }, [showGrid]);
  useEffect(() => { if (!embedded) persistPreference('voxelBuilderSceneObjects', sceneObjects); }, [sceneObjects]);
  useEffect(() => { persistPreference('voxelBuilderSettings', { ...settings, apiKey: '' }); }, [settings]);

  useEffect(() => logger.subscribe(setClientLogs), []);

  useEffect(() => {
    logger.setDiagnosticsEnabled(!!settings.diagnosticsEnabled);
    if (!settings.diagnosticsEnabled) {
      setServerLogs([]);
      setIsDiagnosticsOpen(false);
    }
  }, [settings.diagnosticsEnabled]);

  useEffect(() => {
    if (!settings.diagnosticsEnabled || !isDiagnosticsOpen) return;
    const localUrl = settings.localUrl || 'http://localhost:4269/api/generate';
    let diagnosticsUrl = '';
    try {
      diagnosticsUrl = `${new URL(localUrl).origin}/api/diagnostics/logs`;
    } catch {
      logger.warn('diagnostics.server.invalid_url', { localUrl });
      setServerLogs([]);
      return;
    }
    let cancelled = false;
    const pullServerLogs = async () => {
      try {
        const res = await localApi(diagnosticsUrl);
        if (!res.ok) return;
        const payload = await res.json() as { logs?: unknown[] };
        if (cancelled || !Array.isArray(payload.logs)) return;
        const normalized = payload.logs.map((log: any) => normalizeExternalLog({ ...log, source: 'server' }));
        setServerLogs(normalized);
      } catch (error) {
        logger.warn('diagnostics.server.fetch_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    pullServerLogs();
    const id = window.setInterval(pullServerLogs, 2500);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [settings.diagnosticsEnabled, isDiagnosticsOpen, settings.localUrl]);

  const mergedDiagnosticsLogs = useMemo(() => {
    return [...clientLogs, ...serverLogs].sort((a, b) => b.timestamp - a.timestamp).slice(0, 200);
  }, [clientLogs, serverLogs]);

  const handleClearDiagnostics = () => {
    logger.clear();
    setServerLogs([]);
    const localUrl = settings.localUrl || 'http://localhost:4269/api/generate';
    let clearUrl = '';
    try {
      clearUrl = `${new URL(localUrl).origin}/api/diagnostics/clear`;
    } catch {
      logger.warn('diagnostics.server.invalid_url', { localUrl });
      return;
    }
    void localApi(clearUrl, { method: 'POST' }).catch((error) => {
      const errorMessage = getErrorMessage(error, 'Failed to clear server diagnostics');
      logger.warn('diagnostics.server.clear_failed', { error: errorMessage });
      setSaveNotice(`Failed to clear diagnostics: ${errorMessage}`);
    });
  };

  const handleNewEmptyScene = () => {
    engineRef.current?.loadInitialModel([]);
    setCurrentBaseModel('New Scene');
  };

  const handleRenameBuild = (model: SavedModel) => {
    setNameRequest({ title: 'Rename model', initialValue: model.name, confirmLabel: 'Rename', onConfirm: name => {
      const updated = customBuilds.map(build => build === model ? { ...build, name } : build);
      localStorage.setItem('voxelBuilderCustomBuilds', JSON.stringify(updated));
      setCustomBuilds(updated);
    } });
  };

  const handleSelectCustomBuild = (model: SavedModel) => {
      if (engineRef.current) {
          engineRef.current.loadInitialModel(model.data, model.skeleton ?? null);
          setCurrentBaseModel(model.name);
      }
  };

  const handleSelectCustomRebuild = (model: SavedModel) => {
      if (engineRef.current) {
          engineRef.current.rebuild(model.data);
      }
  };

  const handleDeleteCustomBuild = (model: SavedModel) => {
      setCustomBuilds(prev => prev.filter(m => m.name !== model.name));
  };

  const handleDeleteCustomRebuild = (model: SavedModel) => {
      setCustomRebuilds(prev => prev.filter(m => m.name !== model.name));
  };

  const handlePlaceInScene = (model: SavedModel) => {
      const id = `scene-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const offsetX = (sceneObjects.length + 1) * 30;
      const newObj: SceneObject = { id, name: model.name, data: model.data, offsetX, offsetZ: 0 };
      engineRef.current?.placeInScene(newObj);
      setSceneObjects(prev => [...prev, newObj]);
  };

  const handleRemoveFromScene = (id: string) => {
      engineRef.current?.removeFromScene(id);
      setSceneObjects(prev => prev.filter(o => o.id !== id));
  };

  const handleMoveSceneObject = (id: string, dx: number, dz: number) => {
      setSceneObjects(prev => {
          const updated = prev.map(o => {
              if (o.id !== id) return o;
              const moved = { ...o, offsetX: o.offsetX + dx, offsetZ: o.offsetZ + dz };
              engineRef.current?.placeInScene(moved);
              return moved;
          });
          return updated;
      });
  };

  const handleClearScene = () => {
      engineRef.current?.clearScene();
      setSceneObjects([]);
  };

  const handleSaveBuild = () => {
      setNameRequest({ title: embedded ? 'Save project asset' : 'Save model', initialValue: currentBaseModel, confirmLabel: 'Save model', onConfirm: async name => {
          if (!engineRef.current) throw new Error('The editor is not ready yet.');
          const document = engineRef.current.getModelDocument();
          if (onSaveAsset) { await onSaveAsset(name, document); setSaveNotice(`Saved "${name}" in this project.`); return; }
          const updated = [...customBuilds, { name, data: document.voxels, skeleton: document.skeleton }];
          try {
              localStorage.setItem('voxelBuilderCustomBuilds', JSON.stringify(updated));
          } catch {
              throw new Error('Browser storage is full or unavailable. Download the model JSON to keep a copy.');
          }
          setCustomBuilds(updated);
          setSaveNotice(`Saved "${name}" in this browser.`);
      } });
  };

  const handleSaveAsTemplate = () => {
      setNameRequest({ title: 'Save template', initialValue: currentBaseModel, confirmLabel: 'Save template', onConfirm: saveTemplate });
  };

  const saveTemplate = (name: string) => {
      if (!engineRef.current) return;
      const { voxels: data, skeleton } = engineRef.current.getModelDocument();
      localApi('/api/presets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, data, skeleton }),
      })
      .then(r => { if (!r.ok) throw new Error('Template save failed'); return r.json(); })
      .then(() => {
          setPresets(prev => {
              const filtered = prev.filter(p => p.name !== name);
              return [...filtered, { name, data, skeleton }];
          });
          setSaveNotice(`Template "${name}" saved to the presets folder.`);
      })
      .catch(() => setSaveNotice('Template save failed. Check that the bridge server is running.'));
  };

  const handleShowJson = () => {
    if (engineRef.current) {
      setJsonData(engineRef.current.getJsonData());
      setJsonModalMode('view');
      setIsJsonModalOpen(true);
    }
  };

  const handleImportClick = () => {
    setJsonData('');
    setJsonModalMode('import');
    setIsJsonModalOpen(true);
  };

  const handleJsonImport = (rawJson: string) => {
    if (!engineRef.current) throw new Error('The editor is not ready yet.');
    engineRef.current.importJsonData(rawJson);
    setCurrentBaseModel('Imported Model');
  };

  const handleExportGLTF = (includeAnimations: boolean = true) => {
    if (engineRef.current) {
      engineRef.current.exportGLTF(includeAnimations);
    }
  };

  const handleExportOBJ = () => {
    if (engineRef.current) {
      engineRef.current.exportOBJ();
    }
  };

  const handleToggleRotation = () => {
    setIsAutoRotate(!isAutoRotate);
    if (engineRef.current) {
      engineRef.current.setAutoRotate(!isAutoRotate);
    }
  };

  const handleToggleGrid = () => {
    setShowGrid(!showGrid);
    if (engineRef.current) {
      engineRef.current.setGridVisible(!showGrid);
    }
  };

  const handleEnterRigging = () => {
      if (engineRef.current) {
          engineRef.current.enterRiggingMode();
      }
  };

  const handleExitRigging = () => {
      if (engineRef.current) {
          engineRef.current.exitRiggingMode();
      }
  };

  const handleEnterEditing = () => {
      if (engineRef.current) {
          engineRef.current.enterEditingMode();
      }
  };

  const handleExitEditing = () => {
      if (engineRef.current) {
          engineRef.current.exitEditingMode();
      }
  };

  const handleSetSymmetry = (config: SymmetryConfig) => {
      setSymmetry(config);
      engineRef.current?.setSymmetry(config.x, config.y, config.z);
  };

  const handleSetBrushType = (type: 'single' | 'sphere' | 'box') => {
      setBrushType(type);
      engineRef.current?.setBrushType(type);
  };

  const handleSetBrushSize = (size: number) => {
      setBrushSize(size);
      engineRef.current?.setBrushSize(size);
  };

  const handleSetMaterial = (material: VoxelMaterial) => {
      setCurrentMaterial(material);
      engineRef.current?.setEditMaterial(material);
  };

  const handleUndo = () => engineRef.current?.undo();
  const handleRedo = () => engineRef.current?.redo();

  const openPrompt = (mode: 'create' | 'morph' | 'rebuild') => {
      setPromptMode(mode);
      setIsPromptModalOpen(true);
  };

  const handlePromptSubmit = async (prompt: string, detail: DetailLevel, pose: Pose) => {
    const checkOwner = captureImportOwner();
    generationAbort.current?.abort();
    const controller = new AbortController(); generationAbort.current=controller;
    setIsGenerating(true);
    try {
        const systemMessage = `You are a professional 3D voxel architect. You output ONLY a raw JSON array. Your entire response must start with [ and end with ]. No markdown, no code fences, no backticks, no explanation, no text before or after the array. If you include anything other than the JSON array your output is unusable.`;

        let systemContext = `- Use realistic PBR materials (Metal for weapons/armor, Glass for eyes/gems, Emissive for magic/light).
        - Apply color gradients to simulate realistic lighting and depth.`;

        let targetVoxels = detail === DetailLevel.LOW ? "1 to 500" : detail === DetailLevel.MEDIUM ? "500 to 1000" : "1000 to 2000";
        let poseInstruction = "";
        
        switch (pose) {
            case Pose.NEUTRAL_STAND:
                poseInstruction = "Ensure the subject is in a neutral standing posture.";
                break;
            case Pose.WINGS_SPREAD:
                poseInstruction = "Ensure the subject is in a Wings-Spread Glide pose (Bird/Dragon/Bat standard) with wings fully extended horizontally.";
                break;
            case Pose.TORPEDO:
                poseInstruction = "Ensure the subject is in an I-Pose/Torpedo posture (Fish/Snake/Whale standard), perfectly straight and streamlined.";
                break;
            case Pose.STAR_POSE:
                poseInstruction = "Ensure the subject is in a Star-Pose (Spider/Octopus/Insects) with all limbs splayed out evenly from the center.";
                break;
            case Pose.MOUTH_OPEN:
                poseInstruction = "Ensure the subject has its mouth wide open or jaw dropped (Head/Face standard) to allow for internal detail.";
                break;
        }

        if (promptMode === 'create') {
            systemContext += `\nCONTEXT: You are creating a brand new voxel art scene from scratch. You MUST produce between ${targetVoxels} voxels. Hit the minimum for this detail level — do not under-produce. Geometry density is the priority, not token efficiency. A subject that warrants more voxels must use more voxels.`;
        } else if (promptMode === 'rebuild') {
            systemContext += `\nCONTEXT: You are generating the TARGET of a voxel reconstruction animation. The current model will fly apart and reassemble into your output. Generate a complete, detailed new form. You MUST produce between ${targetVoxels} voxels — do not under-produce.`;
        } else {
            let morphVoxels = detail === DetailLevel.LOW ? "500" : detail === DetailLevel.MEDIUM ? "1200" : "2000";
            systemContext += `\nCONTEXT: You are modifying an existing voxel model. Perform "Voxel-Wise Diffing" to only change requested parts while respecting the existing structure and locked flags. Add up to ${morphVoxels} additional voxels for increased detail.`;
        }

        const currentGrid = promptMode === 'morph' ? engineRef.current?.getVoxelDataForSave() : null;
        const fullPrompt = `${systemContext}\nTask: Generate voxel model of: "${prompt}".\nRules: Scale within 32x32x32. ${poseInstruction}\nDO NOT write scripts or code to generate the voxels. You must output the RAW JSON array directly.\nReturn ONLY JSON array of {x, y, z, color, materialType}.${settings.apiType === 'direct' && currentGrid ? `\nCurrent model (preserve locked voxels): ${JSON.stringify(currentGrid)}` : ''}`;
        if (settings.diagnosticsEnabled && settings.diagnosticsIncludePrompts) {
            logger.info('ai.prompt.submitted', { mode: promptMode, detail, pose, prompt: fullPrompt });
        } else {
            logger.info('ai.prompt.submitted', { mode: promptMode, detail, pose });
        }

        let rawData: any[] = [];

        if (settings.apiType === 'direct') {
            const endpoint = settings.apiEndpoint || 'https://api.openai.com/v1/chat/completions';
            const model = settings.modelName || 'gpt-4o';
            let activeSystemMessage = systemMessage;
            try {
                const skillRes = await localApi('/api/skill');
                if (skillRes.ok) {
                    const skillData = await skillRes.json() as { content?: string };
                    if (skillData.content) activeSystemMessage = skillData.content;
                }
            } catch { /* fall back to default system message if skill unavailable */ }
            const apiResponse = await localApi('/api/proxy', {
                signal:controller.signal,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    endpoint,
                    apiKey: settings.apiKey,
                    model,
                    messages: [{ role: 'system', content: activeSystemMessage }, { role: 'user', content: fullPrompt }],
                    max_tokens: 8192,
                    temperature: 0.7
                })
            });
            if (!apiResponse.ok) {
                const errText = await apiResponse.text();
                throw new Error(`API error ${apiResponse.status}: ${errText.substring(0, 300)}`);
            }
            const apiData = await apiResponse.json() as { choices?: Array<{message?: {content?: string}}> };
            let text = apiData.choices?.[0]?.message?.content || '';
            if (settings.diagnosticsEnabled && settings.diagnosticsIncludeRawResponses) {
                logger.debug('ai.response.raw', { response: text });
            } else {
                logger.debug('ai.response.received', { length: typeof text === 'string' ? text.length : 0 });
            }
            // Strip markdown fences and // comments
            text = text.replace(/^```(?:json)?\s*$/gim, '').replace(/^```\s*$/gim, '').trim();
            text = text.replace(/\/\/[^\n]*/g, '');
            let si = text.indexOf('['), ei = text.lastIndexOf(']');
            // If truncated (no closing ]), recover by closing at last complete object
            if (si !== -1 && ei === -1) {
                const lastBrace = text.lastIndexOf('}');
                if (lastBrace > si) text = text.substring(si, lastBrace + 1) + ']';
                si = 0; ei = text.length - 1;
            }
            if (si === -1 || ei === -1 || ei <= si) {
                const objMatch = text.match(/"(?:voxels?|data|array|result|objects?)":\s*(\[[\s\S]*\])/i);
                if (objMatch) {
                    rawData = JSON.parse(objMatch[1]);
                } else {
                    throw new Error(`Model did not return a JSON array. Got: "${text.substring(0, 300)}"`);
                }
            } else {
                rawData = JSON.parse(text.substring(si, ei + 1));
            }
        } else {
            const url = settings.localUrl || 'http://localhost:4269/api/generate';
            const response = await localApi(url, {
                signal:controller.signal,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    prompt: fullPrompt,
                    currentGrid: currentGrid ? JSON.stringify(currentGrid) : null
                })
            });
            if (!response.ok) {
                let errorMsg = `Server responded with ${response.status}`;
                try {
                    const errData = await response.json() as { error?: string; details?: string };
                    if (errData.error) errorMsg = errData.error;
                    if (errData.details) errorMsg += ': ' + errData.details;
                } catch { /* ignore json parse error on error response */ }
                throw new Error(errorMsg);
            }
            rawData = await response.json();
            logger.info('bridge.response.received', { isArray: Array.isArray(rawData), voxels: Array.isArray(rawData) ? rawData.length : undefined });
        }

        if (!Array.isArray(rawData)) {
            throw new Error("Invalid response format: Expected a JSON array.");
        }

        const voxelData = normalizeVoxels(rawData);
        checkOwner();

        if (engineRef.current) {
            const snapshot = JSON.parse(engineRef.current.getJsonData());
            setPromptHistory(prev => [...prev, {
                timestamp: Date.now(),
                prompt: prompt,
                snapshot: snapshot
            }]);

            if (promptMode === 'create') {
                engineRef.current.loadInitialModel(voxelData);
                setCustomBuilds(prev => [...prev, { name: prompt, data: voxelData }]);
                setCurrentBaseModel(prompt);
            } else if (promptMode === 'rebuild') {
                engineRef.current.rebuild(voxelData);
                setCustomRebuilds(prev => [...prev, {
                    name: prompt,
                    data: voxelData,
                    baseModel: currentBaseModel
                }]);
            } else {
                engineRef.current.mergeAIGeneratedModel(voxelData);
                setCustomRebuilds(prev => [...prev, {
                    name: prompt,
                    data: voxelData,
                    baseModel: currentBaseModel
                }]);
            }
        }
        logger.info('ai.generation.applied', { mode: promptMode, voxels: voxelData.length });
    } catch (err: unknown) {
        const errorMsg = getErrorMessage(err);
        logger.error('ai.generation.failed', { message: errorMsg });
        setSaveNotice(`Generation failed: ${errorMsg}`);
    } finally {
        setIsGenerating(false);
    }
  };

  const handleSaveSettings = (newSettings: SettingsData) => {
      setSettings(newSettings);
      persistPreference('voxelBuilderSettings', { ...newSettings, apiKey: '' });
      if (newSettings.backgroundColor) engineRef.current?.setBackgroundColor(newSettings.backgroundColor);
      if (newSettings.gridColor) engineRef.current?.setGridColor(newSettings.gridColor);
      setIsSettingsOpen(false);
  };

  const handleRenderSettingsChange = (s: RenderSettings) => {
      setRenderSettings(s);
      if (!engineRef.current) return;
      if (s.solidPreview !== renderSettings.solidPreview) engineRef.current.setSolidPreview(s.solidPreview);
      engineRef.current.setBloom(s.bloomEnabled, s.bloomStrength);
      engineRef.current.setToneMapping(s.toneMapping);
      engineRef.current.setBakedAO(s.bakedAO, s.bakedAOStrength);
  };

  const handleResample = (scale: number) => {
      engineRef.current?.resample(scale);
  };

  const handleDismantle = () => {
      engineRef.current?.dismantle();
  };

  const handleRestoreFromSnapshot = () => {
      engineRef.current?.restoreFromSnapshot();
  };

  const handleImageImport = async (file: File) => {
      if (engineRef.current) {
          try {
          await engineRef.current.voxelizeImage(file);
          setCurrentBaseModel(file.name);
          } catch(e) {setSaveNotice(getErrorMessage(e,'Image import failed.'));}
      }
  };

  function captureImportOwner() {
    const engine = engineRef.current;
    if(!engine)throw new Error('The sculpt editor is not ready.');
    const revision = engine.documentRevision;
    return () => { if(engineRef.current!==engine||engine.documentRevision!==revision)throw new Error('Operation cancelled because the active model changed. Start it again for the current model.'); };
  }

  const handleMeshImport = async (file: File) => {
      if (!engineRef.current) return;
      const checkOwner=captureImportOwner();
      const choice = await new Promise<string | null>(resolve=>setNameRequest({title:'Import 3D mesh',inputLabel:'Voxel resolution · auto, or 8–128',initialValue:'auto',confirmLabel:'Import mesh',onCancel:()=>resolve(null),onConfirm:value=>{
        if(value.toLowerCase()!=='auto'&&(!/^\d+$/.test(value)||Number(value)<8||Number(value)>128))throw new Error('Enter auto or a whole number from 8 to 128.');
        resolve(value);
      }}));
      if (choice === null) return;
      const resolution: number | null = (choice.trim().toLowerCase() === 'auto')
        ? null
        : Math.max(8, Math.min(128, parseInt(choice) || 32));

      try {
          checkOwner();
          const name = file.name.toLowerCase();
          const isSTL = name.endsWith('.stl');
          const isGLTF = name.endsWith('.glb') || name.endsWith('.gltf');
          const isPLY = name.endsWith('.ply');
          const isFBX = name.endsWith('.fbx');

          if (isSTL) {
              const { STLLoader } = await import('three/addons/loaders/STLLoader.js');
              const loader = new STLLoader();
              const geometry = loader.parse(await file.arrayBuffer());
              const THREE = await import('three');
              const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
              checkOwner(); await engineRef.current.voxelizeMesh(mesh, resolution);
          } else if (isPLY) {
              const { PLYLoader } = await import('three/addons/loaders/PLYLoader.js');
              const loader = new PLYLoader();
              const geometry = loader.parse(await file.arrayBuffer());
              const THREE = await import('three');
              const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
              checkOwner(); await engineRef.current.voxelizeMesh(mesh, resolution);
          } else if (isFBX) {
              const { FBXLoader } = await import('three/addons/loaders/FBXLoader.js');
              const loader = new FBXLoader();
              const url = URL.createObjectURL(file);
              try {
                  const object = await new Promise<any>((resolve, reject) => {
                      loader.load(url, resolve, undefined, reject);
                  });
                  checkOwner(); await engineRef.current.voxelizeMesh(object, resolution);
              } finally {
                  URL.revokeObjectURL(url);
              }
          } else {
              const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
              const { OBJLoader } = await import('three/addons/loaders/OBJLoader.js');
              const loader = isGLTF ? new GLTFLoader() : new OBJLoader();
              const url = URL.createObjectURL(file);
              try {
                  const result = await new Promise<any>((resolve, reject) => {
                      loader.load(url, resolve, undefined, reject);
                  });
                  if (isGLTF) {
                      let embeddedRaw: any[] | null = null;
                      let embeddedSkeleton = null;
                      const scene = result.scene;
                      if (scene) {
                          if (Array.isArray(scene.userData?.voxelData)) {
                              embeddedRaw = scene.userData.voxelData;
                              embeddedSkeleton = scene.userData.voxshopSkeleton ?? null;
                          } else {
                              scene.traverse((child: any) => {
                                  if (!embeddedRaw && Array.isArray(child.userData?.voxelData)) {
                                      embeddedRaw = child.userData.voxelData;
                                      embeddedSkeleton = child.userData.voxshopSkeleton ?? null;
                                  }
                              });
                          }
                      }
                      if (embeddedRaw) {
                          checkOwner();
                          engineRef.current.loadInitialModel(normalizeVoxels(embeddedRaw), embeddedSkeleton);
                          setCurrentBaseModel(file.name);
                          return;
                      }
                  }
                  const object = result.scene || result;
                  checkOwner(); await engineRef.current.voxelizeMesh(object, resolution);
              } finally {
                  URL.revokeObjectURL(url);
              }
      }
          setCurrentBaseModel(file.name);
      } catch (e) {
          logger.error('mesh.import.failed', { error: e instanceof Error ? e.message : String(e) });
          setSaveNotice(`Mesh import failed: ${getErrorMessage(e)}`);
      }
  };

  const handleVoxImport = async (file: File) => {
      if (!engineRef.current) return;
      const checkOwner=captureImportOwner();
      try {
          const data = engineRef.current.importVOX(await file.arrayBuffer());
          checkOwner();
          engineRef.current.loadInitialModel(data);
          setCurrentBaseModel(file.name);
      } catch (e: unknown) {
          setSaveNotice('VOX import failed: ' + getErrorMessage(e));
      }
  };

  const handleQBImport = async (file: File) => {
      if (!engineRef.current) return;
      const checkOwner=captureImportOwner();
      try {
          const data = engineRef.current.importQB(await file.arrayBuffer());
          checkOwner();
          engineRef.current.loadInitialModel(data);
          setCurrentBaseModel(file.name);
      } catch (e: unknown) {
          setSaveNotice('QB import failed: ' + getErrorMessage(e));
      }
  };

  const handleMinecraftImport = async (file: File) => {
      if (!engineRef.current) return;
      const checkOwner=captureImportOwner();
      try {
          const data = await engineRef.current.importMinecraft(await file.arrayBuffer());
          checkOwner();
          engineRef.current.loadInitialModel(data);
          setCurrentBaseModel(file.name);
      } catch (e: unknown) {
          setSaveNotice('Minecraft import failed: ' + getErrorMessage(e));
      }
  };

  const handleTextVoxelize = (text?: string) => {
      if(text===undefined){setNameRequest({title:'Text to voxels',inputLabel:'Text',initialValue:'VoxShop',confirmLabel:'Create text',onConfirm:value=>handleTextVoxelize(value)});return;}
      try { engineRef.current?.voxelizeText(text); } catch(e) {setSaveNotice(getErrorMessage(e));}
  };

  const handleExportHistory = () => {
      if (promptHistory.length === 0) {
          setSaveNotice('No history to export yet.');
          return;
      }
      const data = JSON.stringify(promptHistory, null, 2);
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
      link.download = 'voxel-prompt-history.json';
      link.click();
  };

  const isRigging = appState === AppState.RIGGING;
  const isEditing = appState === AppState.EDITING;

  return (
    <div className={`relative w-full ${embedded ? 'h-full' : 'h-screen'} bg-[#0d1117] overflow-hidden`}>
      {showSplash && <SplashScreen onEnter={() => setShowSplash(false)} />}
      <div ref={containerRef} className="absolute inset-0" />

      <div className="absolute inset-0 pointer-events-none">
        {!isRigging && !isEditing && (
            <UIOverlay
              voxelCount={voxelCount}
              appState={appState}
              currentBaseModel={currentBaseModel}
              presets={presets}
              customBuilds={embedded ? [] : customBuilds}
              customRebuilds={embedded ? [] : relevantRebuilds}
              isAutoRotate={isAutoRotate}
              showGrid={showGrid}
              isGenerating={isGenerating}
              hasSnapshot={engineRef.current?.hasSnapshot || false}
              onDismantle={handleDismantle}
              onNewEmptyScene={handleNewEmptyScene}
              onRenameBuild={handleRenameBuild}
              onSelectCustomBuild={handleSelectCustomBuild}
              onSelectCustomRebuild={handleSelectCustomRebuild}
              onDeleteCustomBuild={handleDeleteCustomBuild}
              onDeleteCustomRebuild={handleDeleteCustomRebuild}
              onSaveBuild={handleSaveBuild}
              onSaveAsTemplate={handleSaveAsTemplate}
              onPromptCreate={() => openPrompt('create')}
              onPromptMorph={() => openPrompt('morph')}
              onPromptRebuild={() => openPrompt('rebuild')}
              onShowJson={handleShowJson}
              onImportJson={handleImportClick}
              onExportGLTF={() => handleExportGLTF(false)}
              onExportGLTFStatic={() => handleExportGLTF(false)}
              onExportOBJ={handleExportOBJ}
              onExportFBX={() => handleExportGLTF(true)}
              onExportPLY={() => engineRef.current?.exportPLY()}
              onExportSTL={() => engineRef.current?.exportSTL()}
              onExportVOX={() => void engineRef.current?.exportVOX().catch(e=>setSaveNotice(e.message))}
              onExportQB={() => void engineRef.current?.exportQB().catch(e=>setSaveNotice(e.message))}
              onExportPNG={() => engineRef.current?.exportPNG()}
              onExportMinecraft={(fmt) => void engineRef.current?.exportMinecraft(fmt).catch(e=>setSaveNotice(e.message))}
              onToggleRotation={handleToggleRotation}
              onToggleGrid={handleToggleGrid}
              onResetCamera={() => engineRef.current?.resetCamera()}
              onEnterRigging={handleEnterRigging}
              onEnterEditing={handleEnterEditing}
              onOpenSettings={() => setIsSettingsOpen(true)}
              onOpenRenderSettings={() => setIsRenderSettingsOpen(v => !v)}
              onPlayTimeLapse={() => engineRef.current?.playTimeLapse()}
              onRestoreSnapshot={handleRestoreFromSnapshot}
              onImportImage={handleImageImport}
              onImportMesh={handleMeshImport}
              onImportVox={handleVoxImport}
              onImportQB={handleQBImport}
              onImportMinecraft={handleMinecraftImport}
              onVoxelizeText={handleTextVoxelize}
              onExportHistory={handleExportHistory}
              onGenerateSphere={() => engineRef.current?.generateSphere()}
              onGenerateTerrain={() => engineRef.current?.generateTerrain()}
              onGenerateNoise={() => engineRef.current?.generateNoiseBlob()}
              sceneObjects={sceneObjects}
              onPlaceInScene={handlePlaceInScene}
              onRemoveFromScene={handleRemoveFromScene}
              onMoveSceneObject={handleMoveSceneObject}
              onClearScene={handleClearScene}
              />
              )}

              {isRigging && (
              <RiggingOverlay
                initialSkeleton={engineRef.current?.currentSkeletonDef ?? null}
                hasRigData={engineRef.current?.hasRigData || false}
                onClose={handleExitRigging}
                onEnablePaint={(bone, color) => engineRef.current?.enablePainting(bone, color)}
                onDisablePaint={() => engineRef.current?.disablePainting()}
                onAutoRig={(skel) => {
                    engineRef.current?.autoRig(skel);
                    engineRef.current?.buildRigAndPreview(skel);
                }}
                onBuildRig={(skel) => engineRef.current?.buildRigAndPreview(skel)}
                onPlayAnimation={(skel, anim, loop) => {
                    if (engineRef.current?.hasSnapshot) engineRef.current?.restoreFromSnapshot();
                    engineRef.current?.playAnimation(skel, anim, loop);
                }}
                onStopAnimation={() => {
                    if (engineRef.current?.hasSnapshot) engineRef.current?.restoreFromSnapshot();
                    engineRef.current?.exitAnimationPreview();
                }}
                onExplodeRig={() => engineRef.current?.explodeFromRig()}
              />
              )}

              {isEditing && (
              <EditingOverlay
                onClose={handleExitEditing}
                onSetEditColor={(color) => engineRef.current?.setEditColor(color)}
                onSetEditMode={(mode) => engineRef.current?.setEditMode(mode)}
                symmetry={symmetry}
                onSetSymmetry={handleSetSymmetry}
                brushType={brushType}
                onSetBrushType={handleSetBrushType}
                brushSize={brushSize}
                onSetBrushSize={handleSetBrushSize}
                currentMaterial={currentMaterial}
                onSetMaterial={handleSetMaterial}
                onUndo={handleUndo}
                onRedo={handleRedo}
                dynamicColors={engineRef.current?.getUniqueColors() || []}
                onFlipModel={(axis) => engineRef.current?.flipModel(axis)}
                onRotateModel={(dir) => engineRef.current?.rotateModel90(dir)}
              />
              )}

      </div>

      <div className="z-[100]">
          <NameDialog request={nameRequest} onClose={() => setNameRequest(null)} />
          {saveNotice && <div role="status" className="fixed bottom-4 left-4 z-[100] flex max-w-sm items-center gap-3 rounded-xl border border-white/10 bg-slate-900 px-4 py-3 text-sm text-white shadow-xl">
              <span>{saveNotice}</span>
              <button aria-label="Dismiss save message" onClick={() => setSaveNotice('')} className="rounded px-2 py-1 hover:bg-white/10">×</button>
          </div>}
          <RenderSettingsOverlay
            isOpen={isRenderSettingsOpen}
            onClose={() => setIsRenderSettingsOpen(false)}
            settings={renderSettings}
            onChange={handleRenderSettingsChange}
          />

          <SettingsOverlay
            isOpen={isSettingsOpen}
            onClose={() => setIsSettingsOpen(false)}
            onSave={handleSaveSettings}
            initialSettings={settings}
            onResample={handleResample}
            onOpenDiagnostics={() => setIsDiagnosticsOpen(true)}
          />

          <DiagnosticsPanel
            isOpen={isDiagnosticsOpen && settings.diagnosticsEnabled}
            onClose={() => setIsDiagnosticsOpen(false)}
            logs={mergedDiagnosticsLogs}
            onClear={handleClearDiagnostics}
            appVersion={APP_VERSION}
            settingsSummary={{
              render: { ...renderSettings },
              ai: {
                mode: settings.apiType,
                model: settings.modelName || 'unknown',
                endpointHost: (() => {
                  const candidate = settings.apiType === 'direct'
                    ? (settings.apiEndpoint || 'https://api.openai.com/v1/chat/completions')
                    : (settings.localUrl || 'http://localhost:4269/api/generate');
                  try {
                    return new URL(candidate).host;
                  } catch {
                    return 'invalid-url';
                  }
                })()
              }
            }}
            voxelStateSummary={{ voxelCount, appState }}
          />

          <JsonModal
            isOpen={isJsonModalOpen}
            onClose={() => setIsJsonModalOpen(false)}
            data={jsonData}
            isImport={jsonModalMode === 'import'}
            onImport={handleJsonImport}
          />

          <PromptModal
            isOpen={isPromptModalOpen}
            mode={promptMode}
            onClose={() => setIsPromptModalOpen(false)}
            onSubmit={handlePromptSubmit}
          />
      </div>
    </div>
  );
};

export default App;
