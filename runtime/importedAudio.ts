import type { AudioClipDocument } from '../services/projectDocument';

const MAX_PENDING = 8;
const MAX_VOICES = 8;

/** Lightweight HTMLMediaElement playback for portable project audio and looping scene music. */
export class ImportedAudioPlayer {
  private readonly clips: Map<string, AudioClipDocument>;
  private readonly pending: { clipId: string; volume: number }[] = [];
  private readonly voices: HTMLAudioElement[] = [];
  private music: HTMLAudioElement | null = null;
  private musicClipId: string | null = null;
  private unlocked = false;
  private disposed = false;

  constructor(
    clips: AudioClipDocument[],
    private readonly createAudio: (source: string) => HTMLAudioElement = (source) => {
      const audio = new Audio();
      audio.preload = 'none';
      audio.src = source;
      return audio;
    },
  ) {
    this.clips = new Map(clips.map((clip) => [clip.id, clip]));
  }

  unlock() {
    if (this.disposed) return;
    this.unlocked = true;
    if (this.music) void this.music.play().catch(() => {});
    for (const cue of this.pending.splice(0)) this.playNow(cue.clipId, cue.volume);
  }

  setMusic(track?: { clipId: string; volume: number }) {
    if (this.disposed) return;
    if (!track) {
      this.stopMusic();
      return;
    }
    if (this.musicClipId === track.clipId && this.music) {
      this.music.volume = track.volume;
      if (this.unlocked) void this.music.play().catch(() => {});
      return;
    }
    this.stopMusic();
    const clip = this.clips.get(track.clipId);
    if (!clip) return;
    try {
      this.music = this.createAudio(clip.dataUrl);
      this.music.preload = 'none';
      this.music.loop = true;
      this.music.volume = track.volume;
      this.musicClipId = track.clipId;
      if (this.unlocked) void this.music.play().catch(() => {});
    } catch {
      this.stopMusic();
    }
  }

  play(clipId: string, volume = 1) {
    if (this.disposed || volume <= 0 || !this.clips.has(clipId)) return;
    if (!this.unlocked) {
      if (this.pending.length === MAX_PENDING) this.pending.shift();
      this.pending.push({ clipId, volume });
      return;
    }
    this.playNow(clipId, volume);
  }

  stop() {
    this.pending.length = 0;
    this.stopMusic();
    for (const voice of this.voices.splice(0)) this.release(voice);
  }

  dispose() {
    this.stop();
    this.disposed = true;
  }

  private playNow(clipId: string, volume: number) {
    const clip = this.clips.get(clipId);
    if (!clip) return;
    if (this.voices.length >= MAX_VOICES) this.release(this.voices.shift()!);
    try {
      const voice = this.createAudio(clip.dataUrl);
      voice.preload = 'none';
      voice.loop = false;
      voice.volume = volume;
      voice.onended = () => this.removeVoice(voice);
      voice.onerror = () => this.removeVoice(voice);
      this.voices.push(voice);
      void voice.play().catch(() => this.removeVoice(voice));
    } catch {
      // Missing codecs or output devices do not affect gameplay.
    }
  }

  private removeVoice(voice: HTMLAudioElement) {
    const index = this.voices.indexOf(voice);
    if (index >= 0) this.voices.splice(index, 1);
    this.release(voice);
  }

  private stopMusic() {
    if (this.music) this.release(this.music);
    this.music = null;
    this.musicClipId = null;
  }

  private release(audio: HTMLAudioElement) {
    try {
      audio.pause();
      audio.onended = null;
      audio.onerror = null;
      audio.removeAttribute('src');
      audio.load();
    } catch {
      // Cleanup must not interrupt gameplay if a media implementation is unavailable.
    }
  }
}
