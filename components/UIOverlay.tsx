import React, { useState, useEffect, useRef } from 'react';
import { AppState, SavedModel, SceneObject } from '../types';
import { Box, Wand2, Hammer, FolderOpen, ChevronUp, FileJson, FileCode, History, Play, Pause, Wrench, Loader2, Download, Save, FolderDown, X, Settings2, Image as ImageIcon, Type, Cpu, Code2, Grid3X3, RotateCcw, Crosshair, MapPin, Trash2, ChevronLeft, ChevronRight, ChevronDown, PlusSquare, Pencil, Layers } from 'lucide-react';

const VerticalToolButton: React.FC<{onClick: () => void, active: boolean, disabled: boolean, icon: React.ReactNode, label: string, color: 'blue' | 'amber' | 'rose'}> = ({ onClick, disabled, icon, label, color }) => {
    const colorMap = {
        blue: 'hover:bg-blue-500/20 text-blue-400 border-blue-500/30',
        amber: 'hover:bg-amber-500/20 text-amber-400 border-amber-500/30',
        rose: 'hover:bg-rose-500/20 text-rose-400 border-rose-500/30'
    };

    return (
        <button
            onClick={onClick}
            disabled={disabled}
            className={`
                flex flex-col items-center gap-2 p-3 rounded-xl border transition-all duration-200 bg-[#1a1d1f]/80 backdrop-blur-md shadow-lg
                ${disabled ? 'opacity-20 grayscale cursor-not-allowed' : colorMap[color]}
            `}
        >
            {icon}
            <span className="text-[9px] font-black uppercase tracking-widest">{label}</span>
        </button>
    );
}

interface TactileButtonProps {
  onClick: () => void;
  disabled?: boolean;
  icon: React.ReactNode;
  label?: string;
  color: 'dark' | 'blue' | 'rose' | 'emerald';
  compact?: boolean;
  title?: string;
}

const TactileButton: React.FC<TactileButtonProps> = ({ onClick, disabled, icon, label, color, compact, title }) => {
  const styles = {
    dark: 'bg-white/5 text-slate-300 hover:bg-white/10 hover:text-white border-white/5',
    blue: 'bg-blue-500/20 text-blue-400 border-blue-500/30 hover:bg-blue-500/30',
    rose: 'bg-rose-500/20 text-rose-400 border-rose-500/30 hover:bg-rose-500/30',
    emerald: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/30'
  };

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`
        flex items-center justify-center gap-2 rounded-lg font-bold text-xs transition-all duration-200 border
        ${compact ? 'p-2' : 'px-4 py-2'}
        ${disabled ? 'opacity-20 cursor-not-allowed' : styles[color]}
      `}
    >
      {icon}
      {label && !compact && <span>{label}</span>}
    </button>
  );
};

interface DropdownProps {
    icon: React.ReactNode;
    label: string;
    children: React.ReactNode;
    color: 'dark' | 'emerald';
    direction?: 'up' | 'down';
    align?: 'left' | 'right';
    big?: boolean;
}

const DropdownMenu: React.FC<DropdownProps> = ({ icon, label, children, color, direction = 'down', align = 'left', big }) => {
    const [isOpen, setIsOpen] = useState(false);
    const menuRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    return (
        <div className="relative" ref={menuRef}>
            <button 
                onClick={() => setIsOpen(!isOpen)}
                className={`
                    flex items-center gap-2 font-black uppercase tracking-widest text-xs transition-all rounded-lg border
                    ${color === 'dark' ? 'bg-white/5 text-white border-white/10 hover:bg-white/10' : 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/30'}
                    ${big ? 'px-8 py-4 text-sm' : 'px-4 py-2'}
                `}
            >
                {icon}
                {label}
                <ChevronUp size={14} className={`transition-transform duration-300 ${isOpen ? 'rotate-180' : ''} ${direction === 'down' ? 'rotate-180' : ''}`} />
            </button>

            {isOpen && (
                <div className={`
                    absolute ${direction === 'up' ? 'bottom-full mb-3' : 'top-full mt-2'}
                    ${direction === 'up' ? 'left-1/2 -translate-x-1/2' : align === 'right' ? 'right-0' : 'left-0'}
                    w-64 max-h-[70vh] overflow-y-auto bg-[#1a1d1f]/95 backdrop-blur-2xl rounded-xl shadow-[0_20px_50px_rgba(0,0,0,0.5)] border border-white/10 p-2 flex flex-col gap-1 animate-in fade-in zoom-in-95 duration-200 z-[100]
                `}>
                    {children}
                </div>
            )}
        </div>
    )
}

const DropdownItem: React.FC<{ onClick: () => void, icon: React.ReactNode, label: string, highlight?: boolean, truncate?: boolean, onDelete?: (e: React.MouseEvent) => void }> = ({ onClick, icon, label, highlight, truncate, onDelete }) => {
    return (
        <div className="relative flex items-center group">
            <button 
                onClick={onClick}
                className={`
                    w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-xs font-bold transition-all text-left
                    ${highlight 
                        ? 'bg-blue-500/10 text-blue-400 hover:bg-blue-500/20' 
                        : 'text-slate-400 hover:bg-white/5 hover:text-white'}
                    ${onDelete ? 'pr-10' : ''}
                `}
            >
                <div className="shrink-0 opacity-50 group-hover:opacity-100">{icon}</div>
                <span className={truncate ? "truncate w-full" : ""}>{label}</span>
            </button>
            {onDelete && (
                <button 
                    onClick={onDelete}
                    className="absolute right-2 p-1.5 text-slate-600 hover:text-rose-500 hover:bg-rose-500/10 rounded-lg opacity-0 group-hover:opacity-100 transition-all"
                >
                    <X size={14} strokeWidth={3} />
                </button>
            )}
        </div>
    )
}

interface UIOverlayProps {
  voxelCount: number;
  appState: AppState;
  currentBaseModel: string;
  presets: SavedModel[];
  customBuilds: SavedModel[];
  customRebuilds: SavedModel[];
  isAutoRotate: boolean;
  showGrid: boolean;
  isGenerating: boolean;
  hasSnapshot: boolean;
  onDismantle: () => void;
  onNewEmptyScene: () => void;
  onRenameBuild: (model: SavedModel) => void;
  onSelectCustomBuild: (model: SavedModel) => void;
  onSelectCustomRebuild: (model: SavedModel) => void;
  onDeleteCustomBuild: (model: SavedModel) => void;
  onDeleteCustomRebuild: (model: SavedModel) => void;
  onSaveBuild: () => void;
  onSaveAsTemplate: () => void;
  onPromptCreate: () => void;
  onPromptMorph: () => void;
  onPromptRebuild: () => void;
  onShowJson: () => void;
  onImportJson: () => void;
  onExportGLTF: () => void;
  onExportGLTFStatic: () => void;
  onExportOBJ: () => void;
  onExportFBX: () => void;
  onExportPLY: () => void;
  onExportSTL: () => void;
  onExportVOX: () => void;
  onExportQB: () => void;
  onExportPNG: () => void;
  onExportMinecraft: (format: 'nbt' | 'schematic' | 'litematic') => void;
  onToggleRotation: () => void;
  onToggleGrid: () => void;
  onResetCamera: () => void;
  onEnterRigging: () => void;
  onEnterEditing: () => void;
  onOpenSettings: () => void;
  onOpenRenderSettings: () => void;
  onPlayTimeLapse: () => void;
  onRestoreSnapshot: () => void;
  onImportImage: (file: File) => void;
  onImportMesh: (file: File) => void;
  onImportVox: (file: File) => void;
  onImportQB: (file: File) => void;
  onImportMinecraft: (file: File) => void;
  onVoxelizeText: (text?: string) => void;
  onExportHistory: () => void;
  onGenerateSphere: () => void;
  onGenerateTerrain: () => void;
  onGenerateNoise: () => void;
  sceneObjects: SceneObject[];
  onPlaceInScene: (model: SavedModel) => void;
  onRemoveFromScene: (id: string) => void;
  onMoveSceneObject: (id: string, dx: number, dz: number) => void;
  onClearScene: () => void;
}

const LOADING_MESSAGES = [
    "Synthesizing voxel grid...",
    "Calculating spatial transforms...",
    "Applying PBR materials...",
    "Optimizing geometry buffer...",
    "Finalizing workstation state..."
];

export const UIOverlay: React.FC<UIOverlayProps> = ({
  voxelCount,
  appState,
  currentBaseModel,
  presets,
  customBuilds,
  customRebuilds,
  isAutoRotate,
  showGrid,
  isGenerating,
  hasSnapshot,
  onDismantle,
  onNewEmptyScene,
  onRenameBuild,
  onSelectCustomBuild,
  onSelectCustomRebuild,
  onDeleteCustomBuild,
  onDeleteCustomRebuild,
  onSaveBuild,
  onSaveAsTemplate,
  onPromptCreate,
  onPromptMorph,
  onPromptRebuild,
  onShowJson,
  onImportJson,
  onExportGLTF,
  onExportGLTFStatic,
  onExportOBJ,
  onExportFBX,
  onExportPLY,
  onExportSTL,
  onExportVOX,
  onExportQB,
  onExportPNG,
  onExportMinecraft,
  onToggleRotation,
  onToggleGrid,
  onResetCamera,
  onEnterRigging,
  onEnterEditing,
  onOpenSettings,
  onOpenRenderSettings,
  onPlayTimeLapse,
  onRestoreSnapshot,
  onImportImage,
  onImportMesh,
  onImportVox,
  onImportQB,
  onImportMinecraft,
  onVoxelizeText,
  onExportHistory,
  onGenerateSphere,
  onGenerateTerrain,
  onGenerateNoise,
  sceneObjects,
  onPlaceInScene,
  onRemoveFromScene,
  onMoveSceneObject,
  onClearScene,
}) => {
  const isStable = appState === AppState.STABLE;
  const isDismantling = appState === AppState.DISMANTLING;
  
  const [loadingMsgIndex, setLoadingMsgIndex] = useState(0);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const glbInputRef = useRef<HTMLInputElement>(null);
  const objInputRef = useRef<HTMLInputElement>(null);
  const stlInputRef = useRef<HTMLInputElement>(null);
  const plyInputRef = useRef<HTMLInputElement>(null);
  const fbxInputRef = useRef<HTMLInputElement>(null);
  const voxInputRef = useRef<HTMLInputElement>(null);
  const qbInputRef = useRef<HTMLInputElement>(null);
  const mcInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isGenerating) {
        const interval = setInterval(() => {
            setLoadingMsgIndex((prev) => (prev + 1) % LOADING_MESSAGES.length);
        }, 2500);
        return () => clearInterval(interval);
    } else {
        setLoadingMsgIndex(0);
    }
  }, [isGenerating]);
  
  return (
    <div className="absolute inset-0 pointer-events-none select-none flex flex-col font-sans">
      
      <div className="p-4 flex justify-between items-start relative z-10">
        <div className="pointer-events-auto flex flex-col gap-2">
            <div className="flex gap-1.5 p-1.5 bg-[#1a1d1f]/80 backdrop-blur-md rounded-xl border border-white/5 shadow-2xl">
                <DropdownMenu
                    icon={<FolderOpen size={18} />}
                    label="CREATE"
                    color="dark"
                >
                    <div className="px-3 py-2 text-[10px] font-black text-slate-500 uppercase tracking-[0.2em]">Asset Pipeline</div>
                    <DropdownItem onClick={onNewEmptyScene} icon={<PlusSquare size={16}/>} label="New Empty Scene" />
                    <DropdownItem onClick={onPromptCreate} icon={<Wand2 size={16}/>} label="AI Generation" highlight />
                    <div className="h-px bg-white/5 my-1" />

                    <div className="px-3 py-2 text-[10px] font-black text-slate-500 uppercase tracking-[0.2em]">Converters</div>
                    <DropdownItem onClick={() => imageInputRef.current?.click()} icon={<ImageIcon size={16}/>} label="Image to Voxel" />
                    <DropdownItem onClick={() => onVoxelizeText()} icon={<Type size={16}/>} label="Text to Voxel" />

                    <div className="h-px bg-white/5 my-1" />
                    <div className="px-3 py-2 text-[10px] font-black text-slate-500 uppercase tracking-[0.2em]">Procedural</div>
                    <DropdownItem onClick={onGenerateSphere} icon={<Box size={16}/>} label="Sphere" />
                    <DropdownItem onClick={onGenerateTerrain} icon={<Box size={16}/>} label="Terrain" />
                    <DropdownItem onClick={onGenerateNoise} icon={<Box size={16}/>} label="Noise Blob" />

                    <div className="h-px bg-white/5 my-1" />
                    <div className="px-3 py-2 text-[10px] font-black text-slate-500 uppercase tracking-[0.2em]">Import — Native Voxel</div>
                    <DropdownItem onClick={onImportJson} icon={<FileJson size={16}/>} label="Voxel Studio JSON (.json)" />
                    <DropdownItem onClick={() => voxInputRef.current?.click()} icon={<FileCode size={16}/>} label="MagicaVoxel (.vox)" />
                    <DropdownItem onClick={() => qbInputRef.current?.click()} icon={<FileCode size={16}/>} label="Qubicle (.qb)" />
                    <DropdownItem onClick={() => mcInputRef.current?.click()} icon={<FileCode size={16}/>} label="Minecraft NBT (.nbt)" />
                    <DropdownItem onClick={() => mcInputRef.current?.click()} icon={<FileCode size={16}/>} label="Minecraft Schematic (.schematic)" />
                    <DropdownItem onClick={() => mcInputRef.current?.click()} icon={<FileCode size={16}/>} label="Minecraft Litematic (.litematic)" />

                    <div className="h-px bg-white/5 my-1" />
                    <div className="px-3 py-2 text-[10px] font-black text-slate-500 uppercase tracking-[0.2em]">Import — 3D Mesh (Voxelized)</div>
                    <DropdownItem onClick={() => glbInputRef.current?.click()} icon={<Box size={16}/>} label="Game-Ready GLB (.glb / .gltf)" />
                    <DropdownItem onClick={() => objInputRef.current?.click()} icon={<Box size={16}/>} label="Wavefront OBJ (.obj)" />
                    <DropdownItem onClick={() => stlInputRef.current?.click()} icon={<Box size={16}/>} label="3D Print STL (.stl)" />
                    <DropdownItem onClick={() => plyInputRef.current?.click()} icon={<Box size={16}/>} label="Point Cloud PLY (.ply)" />
                    <DropdownItem onClick={() => fbxInputRef.current?.click()} icon={<Box size={16}/>} label="3D Animation FBX (.fbx)" />

                    {presets.length > 0 && (
                        <>
                            <div className="h-px bg-white/5 my-1" />
                            <div className="px-3 py-2 text-[10px] font-black text-slate-500 uppercase tracking-[0.2em]">Templates</div>
                            {presets.map((model, idx) => (
                                <div key={`preset-${idx}`} className="flex items-center gap-1 px-2 py-1 hover:bg-white/5 rounded-lg group">
                                    <button
                                        onClick={() => onSelectCustomBuild(model)}
                                        className="flex-1 flex items-center gap-2 text-left"
                                    >
                                        <Box size={14} className="text-blue-500/60 shrink-0" />
                                        <span className="text-xs text-slate-300 truncate max-w-[120px]">{model.name}</span>
                                    </button>
                                </div>
                            ))}
                        </>
                    )}

                    {customBuilds.length > 0 && (
                        <>
                            <div className="h-px bg-white/5 my-1" />
                            <div className="px-3 py-2 text-[10px] font-black text-slate-500 uppercase tracking-[0.2em]">Saved Library</div>
                            {customBuilds.map((model, idx) => (
                                <div key={`lib-${idx}`} className="flex items-center gap-1 px-2 py-1 hover:bg-white/5 rounded-lg group">
                                    <button
                                        onClick={() => onSelectCustomBuild(model)}
                                        className="flex-1 flex items-center gap-2 text-left"
                                    >
                                        <Box size={14} className="text-slate-500 shrink-0" />
                                        <span className="text-xs text-slate-300 truncate max-w-[120px]">{model.name}</span>
                                    </button>
                                    <button
                                        onClick={(e) => { e.stopPropagation(); onRenameBuild(model); }}
                                        title="Rename"
                                        className="p-1 rounded text-slate-600 hover:text-blue-400 hover:bg-blue-500/10 transition-colors opacity-0 group-hover:opacity-100"
                                    >
                                        <Pencil size={12} />
                                    </button>
                                    <button
                                        onClick={(e) => { e.stopPropagation(); onPlaceInScene(model); }}
                                        title="Place in scene"
                                        className="p-1 rounded text-slate-600 hover:text-emerald-400 hover:bg-emerald-500/10 transition-colors opacity-0 group-hover:opacity-100"
                                    >
                                        <MapPin size={12} />
                                    </button>
                                    <button
                                        onClick={(e) => { e.stopPropagation(); onDeleteCustomBuild(model); }}
                                        title="Delete"
                                        className="p-1 rounded text-slate-600 hover:text-rose-400 hover:bg-rose-500/10 transition-colors opacity-0 group-hover:opacity-100"
                                    >
                                        <X size={12} />
                                    </button>
                                </div>
                            ))}
                        </>
                    )}
                </DropdownMenu>

                <div className="w-px h-6 bg-white/5 self-center mx-1" />

                <TactileButton
                    onClick={onSaveBuild}
                    color="dark"
                    icon={<Save size={18} />}
                    label="Save"
                    title="Save current workstation state"
                />
                <TactileButton
                    onClick={onSaveAsTemplate}
                    color="dark"
                    icon={<FolderDown size={18} />}
                    label="Template"
                    title="Save as a template preset for all users"
                />
            </div>

            <div className="flex items-center gap-3 px-4 py-2 bg-[#1a1d1f]/80 backdrop-blur-md shadow-xl rounded-xl border border-white/5 text-slate-400 font-mono w-fit text-xs">
                <Cpu size={14} className="text-blue-500" />
                <div className="flex flex-col leading-tight">
                    <span className="text-[9px] uppercase tracking-[0.2em] opacity-50 font-sans font-bold">Grid Count</span>
                    <span className="text-white font-bold">{voxelCount.toLocaleString()} <span className="opacity-30 text-[10px]">VX</span></span>
                </div>
            </div>
        </div>

        <div className="pointer-events-auto flex gap-1.5 p-1.5 bg-[#1a1d1f]/80 backdrop-blur-md rounded-xl border border-white/5 shadow-2xl">
            <TactileButton
                onClick={onPlayTimeLapse}
                color="dark"
                icon={<History size={18} />}
                compact
                title="Replay Construction History"
            />
            <TactileButton
                onClick={onToggleGrid}
                color={showGrid ? 'blue' : 'dark'}
                icon={<Grid3X3 size={18} />}
                compact
                title="Toggle Floor Grid"
            />
            <TactileButton
                onClick={onResetCamera}
                color="dark"
                icon={<Crosshair size={18} />}
                compact
                title="Reset Camera"
            />
            <TactileButton
                onClick={onOpenSettings}
                color="dark"
                icon={<Settings2 size={18} />}
                compact
                title="Workstation Configuration"
            />
            <TactileButton
                onClick={onToggleRotation}
                color={isAutoRotate ? 'blue' : 'dark'}
                icon={isAutoRotate ? <Pause size={18} /> : <Play size={18} />}
                compact
                title="Camera Rotation"
            />
            
            <div className="w-px h-6 bg-white/5 self-center mx-1" />

            <DropdownMenu icon={<Download size={18} />} label="EXPORT" color="dark" align="right">
                <DropdownItem onClick={onExportGLTF} icon={<Box size={16}/>} label="Game-Ready (.glb)" highlight />
                <DropdownItem onClick={onExportFBX} icon={<Box size={16}/>} label="3D Animation (.glb)" />
                <DropdownItem onClick={onExportGLTFStatic} icon={<Box size={16}/>} label="Rigged Only (.glb)" />
                <DropdownItem onClick={onExportOBJ} icon={<Box size={16}/>} label="Static Mesh (.obj)" />
                <DropdownItem onClick={onExportPLY} icon={<Box size={16}/>} label="Point Cloud (.ply)" />
                <DropdownItem onClick={onExportSTL} icon={<Box size={16}/>} label="3D Printing (.stl)" />
                <div className="h-px bg-white/5 my-1" />
                <DropdownItem onClick={onExportVOX} icon={<FileCode size={16}/>} label="MagicaVoxel (.vox)" />
                <DropdownItem onClick={onExportQB} icon={<FileCode size={16}/>} label="Qubicle (.qb)" />
                <div className="h-px bg-white/5 my-1" />
                <div className="px-3 py-1">
                    <p className="text-[8px] text-slate-500 uppercase tracking-widest font-black mb-1.5">Minecraft</p>
                    <div className="grid grid-cols-3 gap-1">
                        <button onClick={() => onExportMinecraft('nbt')} className="py-1.5 rounded-md bg-emerald-900/20 border border-emerald-500/20 text-emerald-400 font-black text-[8px] uppercase hover:bg-emerald-900/40">.NBT</button>
                        <button onClick={() => onExportMinecraft('schematic')} className="py-1.5 rounded-md bg-emerald-900/20 border border-emerald-500/20 text-emerald-400 font-black text-[8px] uppercase hover:bg-emerald-900/40">.SCHEM</button>
                        <button onClick={() => onExportMinecraft('litematic')} className="py-1.5 rounded-md bg-emerald-900/20 border border-emerald-500/20 text-emerald-400 font-black text-[8px] uppercase hover:bg-emerald-900/40">.LITE</button>
                    </div>
                </div>
                <div className="h-px bg-white/5 my-1" />
                <DropdownItem onClick={onExportPNG} icon={<ImageIcon size={16}/>} label="2D Snapshot (.png)" />
                <div className="h-px bg-white/5 my-1" />
                <DropdownItem onClick={onShowJson} icon={<Code2 size={16}/>} label="Workstation Data (JSON)" />
                <DropdownItem onClick={onExportHistory} icon={<History size={16}/>} label="Prompt History Log" />
            </DropdownMenu>
        </div>
      </div>

      <div className="flex-1 relative">
          {isGenerating && (
              <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-auto">
                  <div className="bg-[#1a1d1f]/95 backdrop-blur-2xl border border-white/10 px-10 py-8 rounded-2xl shadow-[0_30px_100px_rgba(0,0,0,0.8)] flex flex-col items-center gap-6 min-w-[320px] animate-in zoom-in-95 duration-300">
                      <div className="relative">
                          <div className="absolute inset-0 bg-blue-500/20 rounded-full animate-ping"></div>
                          <Loader2 size={48} className="text-blue-500 animate-spin" strokeWidth={3} />
                      </div>
                      <div className="text-center space-y-1">
                          <h3 className="text-sm font-black text-white uppercase tracking-[0.3em]">AI Engine Active</h3>
                          <p className="text-slate-500 font-medium text-xs tracking-wide">
                              {LOADING_MESSAGES[loadingMsgIndex]}
                          </p>
                      </div>
                  </div>
              </div>
          )}

          <div className="absolute right-4 top-1/2 -translate-y-1/2 pointer-events-auto flex flex-col gap-2">
                <VerticalToolButton
                    onClick={onEnterEditing}
                    active={false}
                    disabled={isGenerating || !isStable}
                    icon={<Hammer size={20} />}
                    label="SCULPT"
                    color="amber"
                />
                <VerticalToolButton
                    onClick={onEnterRigging}
                    active={false}
                    disabled={isGenerating || !isStable}
                    icon={<Wand2 size={20} />}
                    label="RIGGING"
                    color="blue"
                />
                <VerticalToolButton
                    onClick={onOpenRenderSettings}
                    active={false}
                    disabled={false}
                    icon={<Layers size={20} />}
                    label="RENDER"
                    color="blue"
                />
                <div className="h-px w-8 bg-white/5 my-2 self-center" />
                <VerticalToolButton
                    onClick={onPromptMorph}
                    active={false}
                    disabled={isGenerating || !isStable}
                    icon={<Cpu size={20} />}
                    label="ITERATE"
                    color="blue"
                />
                <VerticalToolButton
                    onClick={onDismantle}
                    active={false}
                    disabled={isGenerating || !isStable}
                    icon={<X size={20} />}
                    label="DISMANTLE"
                    color="rose"
                />
          </div>
      </div>

      <input type="file" ref={imageInputRef} className="hidden" accept="image/*" onChange={(e) => { const file = e.target.files?.[0]; if (file) onImportImage(file); e.target.value = ''; }} />
      <input type="file" ref={glbInputRef} className="hidden" accept=".glb,.gltf" onChange={(e) => { const file = e.target.files?.[0]; if (file) onImportMesh(file); e.target.value = ''; }} />
      <input type="file" ref={objInputRef} className="hidden" accept=".obj" onChange={(e) => { const file = e.target.files?.[0]; if (file) onImportMesh(file); e.target.value = ''; }} />
      <input type="file" ref={stlInputRef} className="hidden" accept=".stl" onChange={(e) => { const file = e.target.files?.[0]; if (file) onImportMesh(file); e.target.value = ''; }} />
      <input type="file" ref={plyInputRef} className="hidden" accept=".ply" onChange={(e) => { const file = e.target.files?.[0]; if (file) onImportMesh(file); e.target.value = ''; }} />
      <input type="file" ref={fbxInputRef} className="hidden" accept=".fbx" onChange={(e) => { const file = e.target.files?.[0]; if (file) onImportMesh(file); e.target.value = ''; }} />
      <input type="file" ref={voxInputRef} className="hidden" accept=".vox" onChange={(e) => { const file = e.target.files?.[0]; if (file) onImportVox(file); e.target.value = ''; }} />
      <input type="file" ref={qbInputRef} className="hidden" accept=".qb" onChange={(e) => { const file = e.target.files?.[0]; if (file) onImportQB(file); e.target.value = ''; }} />
      <input type="file" ref={mcInputRef} className="hidden" accept=".nbt,.schematic,.litematic" onChange={(e) => { const file = e.target.files?.[0]; if (file) onImportMinecraft(file); e.target.value = ''; }} />

      {sceneObjects.length > 0 && (
          <div className="absolute left-4 bottom-20 pointer-events-auto animate-in slide-in-from-left-4 duration-300">
              <div className="bg-[#1a1d1f]/90 backdrop-blur-md border border-white/10 rounded-2xl shadow-2xl overflow-hidden w-64">
                  <div className="flex items-center justify-between px-4 py-3 border-b border-white/5 bg-white/[0.02]">
                      <div className="flex items-center gap-2">
                          <MapPin size={13} className="text-emerald-400" />
                          <span className="text-[10px] font-black text-white uppercase tracking-[0.2em]">Scene Objects</span>
                          <span className="text-[9px] text-slate-500 font-bold">({sceneObjects.length})</span>
                      </div>
                      <button
                          onClick={onClearScene}
                          title="Clear all scene objects"
                          className="p-1 text-slate-600 hover:text-rose-400 transition-colors"
                      >
                          <Trash2 size={13} />
                      </button>
                  </div>
                  <div className="max-h-64 overflow-y-auto custom-scrollbar">
                      {sceneObjects.map(obj => (
                          <div key={obj.id} className="px-3 py-2.5 border-b border-white/5 last:border-0 hover:bg-white/[0.03]">
                              <div className="flex items-center justify-between mb-2">
                                  <span className="text-[11px] text-slate-300 font-bold truncate max-w-[140px]">{obj.name}</span>
                                  <button
                                      onClick={() => onRemoveFromScene(obj.id)}
                                      className="p-1 text-slate-600 hover:text-rose-400 transition-colors shrink-0"
                                  >
                                      <X size={12} />
                                  </button>
                              </div>
                              <div className="flex items-center gap-1">
                                  <span className="text-[8px] text-slate-600 uppercase tracking-widest font-black w-6">POS</span>
                                  <div className="flex gap-0.5">
                                      <button onClick={() => onMoveSceneObject(obj.id, -5, 0)} className="p-1 rounded bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white transition-colors"><ChevronLeft size={10} /></button>
                                      <button onClick={() => onMoveSceneObject(obj.id, 5, 0)} className="p-1 rounded bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white transition-colors"><ChevronRight size={10} /></button>
                                      <div className="w-px bg-white/5 mx-0.5" />
                                      <button onClick={() => onMoveSceneObject(obj.id, 0, -5)} className="p-1 rounded bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white transition-colors"><ChevronUp size={10} /></button>
                                      <button onClick={() => onMoveSceneObject(obj.id, 0, 5)} className="p-1 rounded bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white transition-colors"><ChevronDown size={10} /></button>
                                  </div>
                                  <span className="text-[8px] text-slate-600 font-mono ml-1">{obj.offsetX},{obj.offsetZ}</span>
                              </div>
                          </div>
                      ))}
                  </div>
              </div>
          </div>
      )}

      <div className="p-4 flex justify-center pointer-events-none">
            {(isDismantling || hasSnapshot) && !isGenerating && (
                <div className="pointer-events-auto animate-in slide-in-from-bottom-8 duration-500 flex gap-4">
                     {hasSnapshot && (
                        <TactileButton
                            onClick={onRestoreSnapshot}
                            color="emerald"
                            icon={<RotateCcw size={20} />}
                            label="RESTORE RIGGED MODEL"
                        />
                     )}
                     
                     <DropdownMenu 
                        icon={<Wrench size={20} />}
                        label="REBUILD OPTIONS"
                        color="emerald"
                        direction="up"
                     >
                        <div className="px-3 py-2 text-[10px] font-black text-slate-500 uppercase tracking-[0.2em]">Geometry Reconstruction</div>
                        {customRebuilds.length > 0 && (
                            <>
                                <div className="h-px bg-white/5 my-1" />
                                {customRebuilds.map((model, idx) => (
                                    <DropdownItem 
                                        key={`rebuild-${idx}`} 
                                        onClick={() => onSelectCustomRebuild(model)} 
                                        onDelete={(e) => { e.stopPropagation(); onDeleteCustomRebuild(model); }}
                                        icon={<History size={18}/>} 
                                        label={model.name}
                                        truncate 
                                    />
                                ))}
                            </>
                        )}
                        <div className="h-px bg-white/5 my-1" />
                        <DropdownItem onClick={onPromptRebuild} icon={<Wand2 size={18}/>} label="AI Reconstruction" highlight />
                     </DropdownMenu>
                </div>
            )}
      </div>
    </div>
  );
};
