import React, { useState, useEffect } from 'react';
import { X, Save, Server, Key, Cpu, Monitor, Activity } from 'lucide-react';

export type ApiType = 'proxy' | 'direct';

export interface SettingsData {
  apiType: ApiType;
  apiKey: string;
  localUrl: string;
  apiEndpoint: string;
  modelName: string;
  backgroundColor: string;
  gridColor: string;
  diagnosticsEnabled: boolean;
  diagnosticsIncludePrompts: boolean;
  diagnosticsIncludeRawResponses: boolean;
}

interface SettingsOverlayProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (settings: SettingsData) => void;
  initialSettings: SettingsData;
  onResample: (scale: number) => void;
  onOpenDiagnostics: () => void;
}

export const SettingsOverlay: React.FC<SettingsOverlayProps> = ({ isOpen, onClose, onSave, initialSettings, onResample, onOpenDiagnostics }) => {
  const [settings, setSettings] = useState<SettingsData>(initialSettings);

  useEffect(() => {
    setSettings(initialSettings);
  }, [initialSettings]);

  if (!isOpen) return null;

  const handleSave = () => {
    onSave(settings);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-6 select-none animate-in fade-in duration-200">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md bg-[#1a1d1f] border border-white/10 rounded-2xl shadow-[0_30px_100px_rgba(0,0,0,0.8)] overflow-hidden flex flex-col animate-in zoom-in-95 duration-300">
        <div className="flex items-center justify-between p-5 border-b border-white/5 bg-white/[0.02]">
          <div className="flex items-center gap-3">
            <Settings2Icon size={18} className="text-blue-500" />
            <h2 className="text-sm font-black text-white uppercase tracking-[0.2em]">Workstation Config</h2>
          </div>
          <button onClick={onClose} className="p-2 text-slate-500 hover:text-white transition-colors">
            <X size={20} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-8 custom-scrollbar">
          <div className="space-y-4">
            <div className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em] flex items-center gap-2">
                <Cpu size={12} className="text-blue-500/50" />
                Asset Pipeline
            </div>
            
            <div className="grid grid-cols-2 gap-2 p-1 bg-black/20 rounded-xl border border-white/5">
              <button
                onClick={() => setSettings({ ...settings, apiType: 'proxy' })}
                className={`flex flex-col items-center gap-1 py-2.5 rounded-lg transition-all ${
                  settings.apiType === 'proxy' 
                  ? 'bg-blue-600 text-white shadow-lg' 
                  : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                <Server size={14} />
                <span className="text-[10px] font-bold uppercase tracking-widest">Local Worker</span>
              </button>
              <button
                onClick={() => setSettings({ ...settings, apiType: 'direct' })}
                className={`flex flex-col items-center gap-1 py-2.5 rounded-lg transition-all ${
                  settings.apiType === 'direct' 
                  ? 'bg-blue-600 text-white shadow-lg' 
                  : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                <Key size={14} />
                <span className="text-[10px] font-bold uppercase tracking-widest">Direct API</span>
              </button>
            </div>

            <div className="space-y-4 pt-2">
              {settings.apiType === 'proxy' ? (
                <div className="space-y-2 animate-in fade-in slide-in-from-top-2">
                  <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1 text-xs">Bridge Endpoint</label>
                  <input
                    type="text"
                    value={settings.localUrl}
                    onChange={(e) => setSettings({ ...settings, localUrl: e.target.value })}
                    className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-sm text-blue-400 focus:outline-none focus:border-blue-500 transition-colors font-mono"
                    placeholder="http://localhost:4269/api/generate"
                  />
                  <div className="text-[9px] text-slate-500 font-medium leading-relaxed px-1">
                    Connects to your terminal-based CLI session via the filesystem bridge.
                  </div>
                  <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-3 flex gap-3 mt-1">
                    <div className="text-blue-400 pt-0.5 shrink-0"><InfoIcon size={14} /></div>
                    <div className="text-[9px] text-blue-200/70 font-medium leading-relaxed space-y-1.5">
                      <p className="font-black text-blue-300/90 uppercase tracking-wider">CLI Worker Setup</p>
                      <p>1. Right-click the project folder → <span className="text-white/60">Open in Terminal</span></p>
                      <p>2. Start your AI CLI: <span className="text-white/60">claude</span>, <span className="text-white/60">gemini --yolo</span>, copilot, etc.</p>
                      <p>3. Tell it: <span className="text-white/60">"Activate the skill in ./skills/VOXEL_SKILL.md"</span></p>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="space-y-3 animate-in fade-in slide-in-from-top-2">
                  <div className="space-y-1">
                    <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">API Endpoint URL</label>
                    <input
                      type="text"
                      value={settings.apiEndpoint || ''}
                      onChange={(e) => setSettings({ ...settings, apiEndpoint: e.target.value })}
                      className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-sm text-blue-400 focus:outline-none focus:border-blue-500 transition-colors font-mono"
                      placeholder="https://api.openai.com/v1/chat/completions"
                    />
                    <p className="text-[9px] text-slate-500 px-1">OpenAI-compatible endpoint. Works with OpenAI, Groq, Mistral, Together, and others.</p>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">Model Name</label>
                    <input
                      type="text"
                      value={settings.modelName || ''}
                      onChange={(e) => setSettings({ ...settings, modelName: e.target.value })}
                      className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-sm text-blue-400 focus:outline-none focus:border-blue-500 transition-colors font-mono"
                      placeholder="gpt-4o"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">API Key · this session only</label>
                    <input
                      type="password"
                      value={settings.apiKey || ''}
                      onChange={(e) => setSettings({ ...settings, apiKey: e.target.value })}
                      className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-sm text-blue-400 focus:outline-none focus:border-blue-500 transition-colors"
                      placeholder="Enter your API key..."
                    />
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="space-y-4 pt-4 border-t border-white/5">
            <div className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em] flex items-center gap-2">
                <WrenchIcon size={12} className="text-blue-500/50" />
                Kernel Optimizations
            </div>
            <div className="space-y-3">
                <div className="grid grid-cols-2 gap-2">
                    <button 
                        onClick={() => onResample(0.5)}
                        className="py-3 px-3 bg-white/5 hover:bg-white/10 text-slate-300 font-black rounded-xl text-[9px] uppercase tracking-widest border border-white/5 transition-all"
                    >
                        Half Res (0.5x)
                    </button>
                    <button 
                        onClick={() => onResample(2.0)}
                        className="py-3 px-3 bg-white/5 hover:bg-white/10 text-slate-300 font-black rounded-xl text-[9px] uppercase tracking-widest border border-white/5 transition-all"
                    >
                        Double Res (2.0x)
                    </button>
                </div>
                <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-3 flex gap-3">
                    <div className="text-amber-500 pt-0.5"><AlertIcon size={14} /></div>
                    <p className="text-[9px] text-amber-200/70 font-medium leading-relaxed">
                        High resolution sampling (Double Res) significantly increases GPU memory usage and may cause latency.
                    </p>
                </div>
            </div>
          </div>

          <div className="space-y-4 pt-4 border-t border-white/5">
            <div className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em] flex items-center gap-2">
              <Monitor size={12} className="text-blue-500/50" />
              Viewport Colors
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">Background</label>
                <div className="flex items-center gap-2 bg-black/40 border border-white/10 rounded-xl px-3 py-2.5">
                  <input
                    type="color"
                    value={settings.backgroundColor || '#0d1117'}
                    onChange={(e) => setSettings({ ...settings, backgroundColor: e.target.value })}
                    className="w-5 h-5 rounded cursor-pointer bg-transparent border-0 p-0 shrink-0"
                  />
                  <span className="text-[10px] text-slate-400 font-mono">{settings.backgroundColor || '#0d1117'}</span>
                </div>
              </div>
              <div className="space-y-1.5">
                <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">Grid Lines</label>
                <div className="flex items-center gap-2 bg-black/40 border border-white/10 rounded-xl px-3 py-2.5">
                  <input
                    type="color"
                    value={settings.gridColor || '#3a4a60'}
                    onChange={(e) => setSettings({ ...settings, gridColor: e.target.value })}
                    className="w-5 h-5 rounded cursor-pointer bg-transparent border-0 p-0 shrink-0"
                  />
                  <span className="text-[10px] text-slate-400 font-mono">{settings.gridColor || '#3a4a60'}</span>
                </div>
              </div>
            </div>
          </div>

          <div className="space-y-4 pt-4 border-t border-white/5">
            <div className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em] flex items-center gap-2">
              <Activity size={12} className="text-blue-500/50" />
              Developer
            </div>
            <div className="space-y-3">
              <ToggleRow
                label="Enable Diagnostics"
                value={settings.diagnosticsEnabled}
                onToggle={(value) => setSettings({ ...settings, diagnosticsEnabled: value })}
              />
              <ToggleRow
                label="Include prompts"
                value={settings.diagnosticsIncludePrompts}
                onToggle={(value) => setSettings({ ...settings, diagnosticsIncludePrompts: value })}
              />
              <ToggleRow
                label="Include raw AI responses"
                value={settings.diagnosticsIncludeRawResponses}
                onToggle={(value) => setSettings({ ...settings, diagnosticsIncludeRawResponses: value })}
              />
              <button
                onClick={() => {
                  onSave(settings);
                  onOpenDiagnostics();
                }}
                disabled={!settings.diagnosticsEnabled}
                className="w-full py-3 px-4 rounded-xl text-[10px] uppercase tracking-widest font-black bg-white/10 hover:bg-white/15 border border-white/10 text-white disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Open Diagnostics panel
              </button>
            </div>
          </div>
        </div>

        <div className="p-5 border-t border-white/5 bg-white/[0.02]">
          <button
            onClick={handleSave}
            className="w-full bg-blue-600 hover:bg-blue-500 text-white font-black text-[11px] uppercase tracking-[0.2em] py-4 rounded-xl shadow-xl shadow-blue-900/20 active:scale-95 transition-all flex items-center justify-center gap-2"
          >
            <Save size={16} />
            Commit Configuration
          </button>
        </div>
      </div>
    </div>
  );
};

const Settings2Icon = ({ size, className }: { size: number, className?: string }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className={className}><path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/></svg>
);

const WrenchIcon = ({ size, className }: { size: number, className?: string }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className={className}><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
);

const AlertIcon = ({ size }: { size: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
);

const InfoIcon = ({ size }: { size: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
);

const ToggleRow = ({ label, value, onToggle }: { label: string; value: boolean; onToggle: (value: boolean) => void }) => (
  <div className="flex items-center justify-between gap-4 rounded-xl border border-white/10 bg-black/30 px-4 py-3">
    <span className="text-[11px] text-slate-200 font-bold">{label}</span>
    <button
      type="button"
      onClick={() => onToggle(!value)}
      role="switch"
      aria-checked={value}
      aria-label={label}
      className={`w-11 h-6 rounded-full transition-colors p-0.5 ${value ? 'bg-blue-600' : 'bg-slate-600'}`}
    >
      <span className={`block h-5 w-5 rounded-full bg-white transition-transform ${value ? 'translate-x-5' : 'translate-x-0'}`} />
    </button>
  </div>
);
