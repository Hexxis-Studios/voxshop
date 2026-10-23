import React, { useState, useEffect } from 'react';
import { SkeletonDef, SKELETONS } from '../utils/riggingConstants';
import { X, Paintbrush, Play, Square, ChevronRight, Wand2, Hammer, Zap, Cpu } from 'lucide-react';
import type { VoxelData } from '../types';

const SectionLabel: React.FC<{icon: React.ReactNode, label: string}> = ({ icon, label }) => (
    <div className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em] flex items-center gap-2">
        <span className="text-blue-500/50">{icon}</span>
        {label}
    </div>
);


interface RiggingOverlayProps {
    initialSkeleton: SkeletonDef | null;
    hasRigData: boolean;
    selectedVoxel: VoxelData | null;
    onClose: () => void;
    onEnablePaint: (boneName: string, color: string, influence: number) => void;
    onDisablePaint: () => void;
    onSetSelectedWeight: (boneName: string, influence: number) => void;
    onAutoRig: (skeleton: SkeletonDef) => void;
    onBuildRig: (skeleton: SkeletonDef) => void;
    onPlayAnimation: (skeleton: SkeletonDef, animName: string, loop: boolean) => void;
    onStopAnimation: () => void;
    onExplodeRig: () => void;
}

export const RiggingOverlay: React.FC<RiggingOverlayProps> = ({
    initialSkeleton,
    hasRigData,
    selectedVoxel,
    onClose,
    onEnablePaint,
    onDisablePaint,
    onSetSelectedWeight,
    onAutoRig,
    onBuildRig,
    onPlayAnimation,
    onStopAnimation,
    onExplodeRig,
}) => {
    const [selectedSkeleton, setSelectedSkeleton] = useState<SkeletonDef>(initialSkeleton || SKELETONS[0]);
    const [activeBone, setActiveBone] = useState<string | null>(null);
    const [paintInfluence, setPaintInfluence] = useState(100);
    const [isPlaying, setIsPlaying] = useState(false);
    const [activeAnim, setActiveAnim] = useState<string | null>(null);
    const selectedWeights = selectedVoxel?.weights?.length
        ? selectedVoxel.weights
        : selectedVoxel?.bone
            ? [{ bone: selectedVoxel.bone, weight: 1 }]
            : [];

    const handleBoneClick = (boneName: string, color: string) => {
        if (activeBone === boneName) {
            setActiveBone(null);
            onDisablePaint();
        } else {
            setActiveBone(boneName);
            onEnablePaint(boneName, color, paintInfluence / 100);
        }
    };

    const handlePlayAnim = (animName: string) => {
        setIsPlaying(true);
        setActiveAnim(animName);
        onPlayAnimation(selectedSkeleton, animName, animName !== 'Death');
    };

    const handleStopAnim = () => {
        setIsPlaying(false);
        setActiveAnim(null);
        onStopAnimation();
    };

    return (
        <div className="absolute top-0 right-0 w-80 h-full bg-[#1a1d1f]/95 backdrop-blur-2xl border-l border-white/5 shadow-2xl flex flex-col animate-in slide-in-from-right-full duration-300 pointer-events-auto z-50">
            
            <div className="flex items-center justify-between p-5 border-b border-white/5">
                <div>
                    <h2 className="text-sm font-black text-white uppercase tracking-[0.2em]">Kinematics Engine</h2>
                    <div className="text-[10px] font-bold text-blue-500 uppercase tracking-widest opacity-80">Rigging Pipeline</div>
                </div>
                <button onClick={onClose} className="p-2 text-slate-500 hover:text-white hover:bg-white/5 rounded-lg transition-all">
                    <X size={18} />
                </button>
            </div>

            <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-8 custom-scrollbar">
                
                <div className="flex flex-col gap-3">
                    <SectionLabel icon={<Wand2 size={12} />} label="Skeleton Profile" />
                    <div className="grid grid-cols-1 gap-2">
                        {SKELETONS.map(skel => (
                            <button
                                key={skel.id}
                                onClick={() => { setSelectedSkeleton(skel); handleStopAnim(); }}
                                className={`flex items-center justify-between px-4 py-3 rounded-xl border transition-all ${
                                    selectedSkeleton.id === skel.id ? 'bg-blue-500/10 border-blue-500/50 text-blue-400' : 'bg-white/5 border-white/5 text-slate-500 hover:bg-white/10'
                                }`}
                            >
                                <span className="text-xs font-bold uppercase tracking-widest">{skel.name}</span>
                                {selectedSkeleton.id === skel.id && <ChevronRight size={14} />}
                            </button>
                        ))}
                    </div>
                </div>

                <div className="flex flex-col gap-3">
                    <SectionLabel icon={<Cpu size={12} />} label="Automation" />
                    <button 
                        onClick={() => onAutoRig(selectedSkeleton)}
                        className="w-full py-3 rounded-xl font-black text-[10px] uppercase tracking-[0.2em] text-white bg-blue-600 hover:bg-blue-500 transition-all shadow-lg shadow-blue-900/20"
                    >
                        Solve Initial Weights
                    </button>
                </div>

                <div className="flex flex-col gap-3">
                    <SectionLabel icon={<Paintbrush size={12} />} label="Weight Painting" />
                    <div role="status" aria-live="polite" className="rounded-lg border border-white/10 bg-white/5 p-3 text-[10px] text-slate-300">
                        <div className="font-bold uppercase tracking-wider text-slate-400">Selected voxel weights</div>
                        {selectedVoxel ? (
                            <>
                                <div className="mt-1 text-slate-400">({selectedVoxel.x}, {selectedVoxel.y}, {selectedVoxel.z})</div>
                                {selectedWeights.length ? selectedWeights.map(weight => (
                                    <div key={weight.bone} className="mt-1 flex justify-between gap-3">
                                        <span>{weight.bone}</span>
                                        <span>{(weight.weight * 100).toFixed(1)}%</span>
                                    </div>
                                )) : <div className="mt-1">Unrigged</div>}
                            </>
                        ) : <div className="mt-1">Turn painting off, then click a voxel to inspect its influences.</div>}
                    </div>
                    <div className="grid grid-cols-1 gap-1.5 max-h-48 overflow-y-auto pr-2 custom-scrollbar">
                        {selectedSkeleton.bones.map(bone => (
                            <button
                                key={bone.name}
                                onClick={() => handleBoneClick(bone.name, bone.color)}
                                className={`flex items-center gap-3 px-3 py-2 rounded-lg border transition-all ${
                                    activeBone === bone.name ? 'bg-white/10 border-white/20' : 'bg-white/5 border-transparent opacity-60 hover:opacity-100'
                                }`}
                            >
                                <div className="w-3 h-3 rounded-full shadow-sm" style={{ backgroundColor: bone.color }} />
                                <span className="text-[10px] font-bold text-slate-300 uppercase tracking-wider">{bone.name}</span>
                                {activeBone === bone.name && <div className="ml-auto w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />}
                            </button>
                        ))}
                    </div>
                    <label className="flex flex-col gap-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                        <span className="flex items-center justify-between">
                            Joint influence
                            <output className="text-blue-300">{paintInfluence}%</output>
                        </span>
                        <input
                            aria-label="Painted joint influence"
                            type="range"
                            min="1"
                            max="100"
                            step="1"
                            value={paintInfluence}
                            onChange={(event) => {
                                const value = Number(event.currentTarget.value);
                                setPaintInfluence(value);
                                if (!activeBone) return;
                                const bone = selectedSkeleton.bones.find((item) => item.name === activeBone);
                                if (bone) onEnablePaint(bone.name, bone.color, value / 100);
                            }}
                        />
                        Remaining weight is shared across the voxel’s current joint influences.
                    </label>
                    <button
                        type="button"
                        aria-label="Apply influence to selected voxel"
                        disabled={!selectedVoxel || selectedVoxel.isLocked || !activeBone}
                        onClick={() => activeBone && onSetSelectedWeight(activeBone, paintInfluence / 100)}
                        className="w-full rounded-lg border border-blue-500/30 bg-blue-500/10 px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-blue-200 enabled:hover:bg-blue-500/20 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                        Apply to selected voxel
                    </button>
                    {selectedVoxel?.isLocked && (
                        <div role="status" className="text-[10px] text-amber-300">
                            This voxel is locked and its weights cannot be changed.
                        </div>
                    )}
                    <button 
                        onClick={() => onBuildRig(selectedSkeleton)}
                        className="w-full py-3 mt-2 rounded-xl font-black text-[10px] uppercase tracking-[0.2em] text-white bg-emerald-600 hover:bg-emerald-500 transition-all shadow-lg shadow-emerald-900/20"
                    >
                        Compile Manual Edits
                    </button>
                </div>

                <div className="flex flex-col gap-3">
                    <SectionLabel icon={<Play size={12} />} label="Sequencer" />
                    <div className="grid grid-cols-2 gap-2">
                        {selectedSkeleton.animations.map(anim => (
                            <button
                                key={anim.name}
                                onClick={() => handlePlayAnim(anim.name)}
                                className={`flex items-center justify-center gap-2 py-2.5 rounded-lg border text-[10px] font-black tracking-widest transition-all ${
                                    activeAnim === anim.name ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-400' : 'bg-white/5 border-white/5 text-slate-500 hover:bg-white/10'
                                }`}
                            >
                                <Play size={12} fill={activeAnim === anim.name ? 'currentColor' : 'none'} />
                                {anim.name.toUpperCase()}
                            </button>
                        ))}
                    </div>
                    <div className="grid grid-cols-1 gap-2 mt-1">
                        {isPlaying && (
                            <button 
                                onClick={handleStopAnim}
                                className="flex items-center justify-center gap-2 py-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-400 font-black text-[10px] tracking-widest hover:bg-rose-500/20 transition-all"
                            >
                                <Square size={12} fill="currentColor" /> STOP SEQUENCER
                            </button>
                        )}
                        <button 
                            onClick={onExplodeRig}
                            className="flex items-center justify-center gap-2 py-3 rounded-xl bg-orange-500/10 border border-orange-500/30 text-orange-400 font-black text-[10px] tracking-widest hover:bg-orange-500/20 transition-all"
                        >
                            <Zap size={12} fill="currentColor" /> SHATTER PREVIEW (PHYSICS)
                        </button>
                    </div>
                </div>


            </div>

            <div className="p-5 border-t border-white/5 bg-white/[0.02]">
                <button 
                    onClick={onClose}
                    className="w-full flex items-center justify-center gap-2 py-4 rounded-xl font-black text-[11px] uppercase tracking-[0.2em] text-white bg-slate-700 hover:bg-slate-600 transition-all"
                >
                    Exit Kinematics
                </button>
            </div>

        </div>
    );
};
