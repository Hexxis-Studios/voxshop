import type { Action } from '../services/projectDocument';

export type ProceduralSoundCue = Extract<Action, { type: 'sound' }>;

const MAX_PENDING_CUES = 8;
const MAX_ACTIVE_VOICES = 4;

/** Small Web Audio adapter for bounded, project-authored one-shot tones. */
export class ProceduralAudioPlayer {
  private context: AudioContext | null = null;
  private readonly pending: ProceduralSoundCue[] = [];
  private activeVoices = 0;

  constructor(private readonly createContext: () => AudioContext = () => new AudioContext()) {}

  unlock() {
    const context = this.getContext();
    if (!context) return;
    if (context.state === 'running') {
      this.flushPending();
      return;
    }
    try {
      void context
        .resume()
        .then(() => this.flushPending())
        .catch(() => {});
    } catch {
      // A denied or unavailable output device must not affect simulation.
    }
  }

  play(cue: ProceduralSoundCue) {
    const context = this.getContext();
    if (!context) return;
    if (context.state !== 'running') {
      if (this.pending.length === MAX_PENDING_CUES) this.pending.shift();
      this.pending.push(cue);
      return;
    }
    this.schedule(context, cue);
  }

  clearPending() {
    this.pending.length = 0;
  }

  dispose() {
    this.clearPending();
    if (this.context && this.context.state !== 'closed') void this.context.close().catch(() => {});
    this.context = null;
    this.activeVoices = 0;
  }

  private getContext() {
    if (this.context) return this.context;
    try {
      this.context = this.createContext();
    } catch {
      // Audio is optional on headless and unsupported browser runtimes.
    }
    return this.context;
  }

  private flushPending() {
    const context = this.context;
    if (!context || context.state !== 'running') return;
    for (const cue of this.pending.splice(0)) this.schedule(context, cue);
  }

  private schedule(context: AudioContext, cue: ProceduralSoundCue) {
    if (this.activeVoices >= MAX_ACTIVE_VOICES || cue.volume === 0) return;
    let oscillator: OscillatorNode | undefined;
    let envelope: GainNode | undefined;
    let counted = false;
    try {
      oscillator = context.createOscillator();
      envelope = context.createGain();
      const now = context.currentTime;
      const attack = Math.min(0.01, cue.duration * 0.2);
      const release = Math.min(0.02, cue.duration * 0.4);
      oscillator.type = cue.waveform;
      oscillator.frequency.setValueAtTime(cue.frequency, now);
      oscillator.frequency.linearRampToValueAtTime(cue.endFrequency ?? cue.frequency, now + cue.duration);
      envelope.gain.setValueAtTime(0, now);
      envelope.gain.linearRampToValueAtTime(cue.volume * 0.25, now + attack);
      envelope.gain.linearRampToValueAtTime(0, now + cue.duration - release);
      envelope.gain.linearRampToValueAtTime(0, now + cue.duration);
      oscillator.connect(envelope);
      envelope.connect(context.destination);
      this.activeVoices++;
      counted = true;
      oscillator.onended = () => {
        oscillator!.disconnect();
        envelope!.disconnect();
        this.activeVoices = Math.max(0, this.activeVoices - 1);
      };
      oscillator.start(now);
      oscillator.stop(now + cue.duration);
    } catch {
      oscillator?.disconnect();
      envelope?.disconnect();
      if (counted) this.activeVoices = Math.max(0, this.activeVoices - 1);
    }
  }
}
