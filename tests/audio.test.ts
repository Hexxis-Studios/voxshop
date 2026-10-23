import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RuleEditor } from '../components/RuleEditor';
import {
  actionSchema,
  applyProjectOperations,
  audioClipSchema,
  projectAuthoringView,
  projectSummary,
  identityTransform,
  newProject,
  sceneSchema,
  validateProject,
  type Action,
} from '../services/projectDocument';
import type { RuntimeEvent } from '../runtime/GameSimulation';
import { GameSession } from '../runtime/GameSession';
import { exportProject, renderGameHtml } from '../runtime/gameExport';
import { ProceduralAudioPlayer } from '../runtime/proceduralAudio';
import { ImportedAudioPlayer } from '../runtime/importedAudio';

const cue = {
  type: 'sound' as const,
  waveform: 'triangle' as const,
  frequency: 660,
  endFrequency: 330,
  duration: 0.24,
  volume: 0.6,
};
const importedClip = audioClipSchema.parse({
  id: 'theme',
  name: 'Theme loop',
  mimeType: 'audio/mpeg',
  dataUrl: 'data:audio/mpeg;base64,AQIDBA==',
});

function projectWithSoundAction(action: Action = cue) {
  const project = newProject('procedural-audio', 'Procedural audio');
  project.scenes[0].nodes.push({
    id: 'emitter',
    name: 'Emitter',
    assetId: null,
    parentId: null,
    transform: identityTransform(),
    enabled: true,
    components: [
      {
        type: 'rules',
        apiVersion: 1,
        rules: [{ event: 'start', interval: 1, once: false, actions: [action] }],
      },
    ],
    attachments: [],
  });
  return project;
}

function fakeAudioContext(initialState: AudioContextState = 'running') {
  const oscillators: {
      type: OscillatorType;
      frequencies: number[];
      startAt?: number;
      stopAt?: number;
      onended: (() => void) | null;
    }[] = [],
    gains: { values: number[] }[] = [];
  let state = initialState;
  const context = {
    get state() {
      return state;
    },
    currentTime: 2,
    destination: {},
    createOscillator() {
      const record: (typeof oscillators)[number] = {
        type: 'sine',
        frequencies: [],
        onended: null,
      };
      oscillators.push(record);
      return {
        get type() {
          return record.type;
        },
        set type(type: OscillatorType) {
          record.type = type;
        },
        frequency: {
          setValueAtTime: (value: number) => record.frequencies.push(value),
          linearRampToValueAtTime: (value: number) => record.frequencies.push(value),
        },
        connect() {},
        disconnect() {},
        start: (time: number) => (record.startAt = time),
        stop: (time: number) => (record.stopAt = time),
        get onended() {
          return record.onended;
        },
        set onended(handler: (() => void) | null) {
          record.onended = handler;
        },
      };
    },
    createGain() {
      const record = { values: [] as number[] };
      gains.push(record);
      return {
        gain: {
          setValueAtTime: (value: number) => record.values.push(value),
          linearRampToValueAtTime: (value: number) => record.values.push(value),
        },
        connect() {},
        disconnect() {},
      };
    },
    resume: async () => {
      state = 'running';
    },
    close: async () => {
      state = 'closed';
    },
  } as unknown as AudioContext;
  return { context, oscillators, gains };
}

test('sound action schema and project transaction preserve bounded portable cue data', () => {
  assert.deepEqual(actionSchema.parse({ type: 'sound' }), {
    type: 'sound',
    waveform: 'sine',
    frequency: 440,
    duration: 0.15,
    volume: 0.5,
  });
  for (const invalid of [
    { ...cue, frequency: 19 },
    { ...cue, endFrequency: 4001 },
    { ...cue, duration: 2.01 },
    { ...cue, volume: -0.1 },
    { ...cue, waveform: 'noise' },
  ])
    assert.equal(actionSchema.safeParse(invalid).success, false);

  const original = newProject('transaction-audio', 'Transaction audio');
  const scene = structuredClone(projectWithSoundAction().scenes[0]);
  const updated = applyProjectOperations(original, [{ type: 'scene.put', scene }]);
  const savedRules = updated.scenes[0].nodes[0].components.find((component) => component.type === 'rules');
  assert.deepEqual(savedRules?.rules[0].actions[0], cue);
  assert.equal(original.scenes[0].nodes.length, 0);
  const invalidScene = structuredClone(scene);
  const invalidRules = invalidScene.nodes[0].components.find((component) => component.type === 'rules');
  assert.ok(invalidRules);
  (invalidRules.rules[0].actions as unknown[])[0] = { ...cue, duration: 3 };
  assert.throws(() => applyProjectOperations(original, [{ type: 'scene.put', scene: invalidScene }]));
  assert.equal(original.scenes[0].nodes.length, 0);
});

test('imported audio stays portable, bounded, reference-checked and absent from agent summaries', () => {
  const base = newProject('imported-audio', 'Imported audio');
  const project = applyProjectOperations(base, [{ type: 'audio.put', clip: importedClip }]);
  const scene = sceneSchema.parse({
    id: 'main',
    name: 'Main scene',
    music: { clipId: 'theme', volume: 0.4 },
    nodes: [
      {
        id: 'speaker',
        name: 'Speaker',
        transform: identityTransform(),
        components: [
          {
            type: 'rules',
            apiVersion: 1,
            rules: [
              { event: 'start', interval: 1, once: true, actions: [{ type: 'audio', clipId: 'theme' }] },
            ],
          },
        ],
      },
    ],
  });
  const saved = applyProjectOperations(project, [{ type: 'scene.put', scene }]);
  assert.equal(saved.scenes[0].music?.volume, 0.4);
  assert.deepEqual(actionSchema.parse({ type: 'audio', clipId: 'theme' }), {
    type: 'audio',
    clipId: 'theme',
    volume: 1,
  });
  assert.equal('dataUrl' in projectSummary(saved).audioClips[0], false);
  assert.equal('dataUrl' in projectAuthoringView(saved).audioClips[0], false);
  assert.throws(() => applyProjectOperations(saved, [{ type: 'audio.delete', id: 'theme' }]));
  assert.throws(() =>
    validateProject({
      ...saved,
      scenes: [{ ...saved.scenes[0], music: { clipId: 'missing', volume: 0.5 } }],
    }),
  );

  const unused = audioClipSchema.parse({ ...importedClip, id: 'unused', name: 'Unused' });
  const withUnused = applyProjectOperations(saved, [{ type: 'audio.put', clip: unused }]);
  const playable = exportProject(withUnused, 'main');
  assert.deepEqual(
    playable.audioClips.map((clip) => clip.id),
    ['theme'],
  );
  const runtime = 'function play(){}';
  const html = renderGameHtml(playable, 'main', runtime, '');
  assert.match(html, /media-src data:/);
  assert.match(html, /data:audio\/mpeg;base64,AQIDBA==/);

  assert.equal(
    audioClipSchema.safeParse({ ...importedClip, dataUrl: 'data:text/html;base64,PHNjcmlwdD4=' }).success,
    false,
  );
});

test('start rules retain and forward sound events, including across scene transitions', () => {
  const project = projectWithSoundAction();
  project.scenes.push(sceneSchema.parse({ id: 'next', name: 'Next scene' }));
  const firstRules = project.scenes[0].nodes[0].components.find((component) => component.type === 'rules');
  assert.ok(firstRules);
  firstRules.rules[0].actions.push({ type: 'transition', sceneId: 'next' });
  const nextNode = structuredClone(projectWithSoundAction().scenes[0].nodes[0]);
  nextNode.id = 'next-emitter';
  project.scenes[1].nodes.push(nextNode);
  const delivered: RuntimeEvent[] = [];
  const session = new GameSession(validateProject(project), 'main', undefined, undefined, (event) =>
    delivered.push(event),
  );
  assert.equal(session.simulation.scene.id, 'next');
  assert.deepEqual(
    session.simulation.events.filter((event) => event.type === 'sound').map((event) => event.data),
    [cue],
  );
  assert.equal(delivered.filter((event) => event.type === 'sound').length, 2);
  session.dispose();
});

test('rules emit imported clip cues through the same scene and prefab event dispatch', () => {
  const clip = { type: 'audio' as const, clipId: importedClip.id, volume: 0.4 };
  const project = projectWithSoundAction(clip);
  project.audioClips.push(importedClip);
  const delivered: RuntimeEvent[] = [];
  const session = new GameSession(validateProject(project), 'main', undefined, undefined, (event) =>
    delivered.push(event),
  );
  assert.deepEqual(
    session.simulation.events.filter((event) => event.type === 'audio').map((event) => event.data),
    [clip],
  );
  assert.equal(delivered.filter((event) => event.type === 'audio').length, 1);
  session.dispose();
});

test('procedural audio adapter schedules bounded oscillator envelopes and resumes queued sounds', async () => {
  const running = fakeAudioContext();
  const player = new ProceduralAudioPlayer(() => running.context);
  for (let i = 0; i < 5; i++) player.play(cue);
  assert.equal(running.oscillators.length, 4);
  assert.equal(running.oscillators[0].type, 'triangle');
  assert.deepEqual(running.oscillators[0].frequencies, [660, 330]);
  assert.equal(running.oscillators[0].startAt, 2);
  assert.equal(running.oscillators[0].stopAt, 2.24);
  assert.ok(running.gains[0].values.includes(0.15));
  running.oscillators[0].onended?.();
  player.play(cue);
  assert.equal(running.oscillators.length, 5);
  player.dispose();

  const suspended = fakeAudioContext('suspended');
  const waiting = new ProceduralAudioPlayer(() => suspended.context);
  waiting.play(cue);
  assert.equal(suspended.oscillators.length, 0);
  waiting.unlock();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(suspended.oscillators.length, 1);
  waiting.dispose();

  const stopped = fakeAudioContext('suspended');
  const stoppedPlayer = new ProceduralAudioPlayer(() => stopped.context);
  stoppedPlayer.play(cue);
  stoppedPlayer.clearPending();
  stoppedPlayer.unlock();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(stopped.oscillators.length, 0);
  stoppedPlayer.dispose();
});

test('imported audio player loops scene music, queues autoplay-blocked clips and bounds active voices', () => {
  const records: {
    source: string;
    loop: boolean;
    volume: number;
    preload: string;
    plays: number;
    pauses: number;
    onended: (() => void) | null;
    onerror: (() => void) | null;
  }[] = [];
  const player = new ImportedAudioPlayer([importedClip], (source) => {
    const record = {
      source,
      loop: false,
      volume: 1,
      preload: 'auto',
      plays: 0,
      pauses: 0,
      onended: null as (() => void) | null,
      onerror: null as (() => void) | null,
    };
    records.push(record);
    return {
      get loop() {
        return record.loop;
      },
      set loop(value: boolean) {
        record.loop = value;
      },
      get volume() {
        return record.volume;
      },
      set volume(value: number) {
        record.volume = value;
      },
      get preload() {
        return record.preload;
      },
      set preload(value: string) {
        record.preload = value;
      },
      play: async () => {
        record.plays++;
      },
      pause: () => {
        record.pauses++;
      },
      removeAttribute() {},
      load() {},
      set onended(handler: (() => void) | null) {
        record.onended = handler;
      },
      get onended() {
        return record.onended;
      },
      set onerror(handler: (() => void) | null) {
        record.onerror = handler;
      },
      get onerror() {
        return record.onerror;
      },
    } as unknown as HTMLAudioElement;
  });

  player.setMusic({ clipId: 'theme', volume: 0.4 });
  player.play('theme', 0.6);
  assert.equal(records.length, 1);
  assert.equal(records[0].loop, true);
  assert.equal(records[0].plays, 0);
  player.unlock();
  assert.equal(records[0].plays, 1);
  assert.equal(records[0].volume, 0.4);
  assert.equal(records.length, 2);
  assert.equal(records[1].loop, false);
  assert.equal(records[1].volume, 0.6);

  for (let i = 0; i < 9; i++) player.play('theme');
  assert.equal(records.length, 11);
  assert.equal(records[1].pauses, 1);
  player.setMusic(undefined);
  assert.equal(records[0].pauses, 1);
  player.stop();
  assert.ok(records.slice(2).every((record) => record.pauses >= 1));
  player.dispose();
});

test('rule editor exposes the sound cue parameters and browser export embeds the cue runtime', async () => {
  const editor = renderToStaticMarkup(
    React.createElement(RuleEditor, {
      rules: [{ event: 'start', interval: 1, once: false, actions: [cue] }],
      recipes: [],
      nodes: [],
      scenes: [{ id: 'main', name: 'Main' }],
      sceneId: 'main',
      onChange: () => {},
    }),
  );
  assert.match(editor, /Waveform/);
  assert.match(editor, /Start pitch · Hz/);
  assert.match(editor, /Duration · seconds/);
  assert.match(editor, /Volume · 0–1/);

  const runtime = await fs.readFile(path.join(process.cwd(), 'dist/runtime-lite.js'), 'utf8');
  const html = renderGameHtml(validateProject(projectWithSoundAction()), 'main', runtime, '');
  assert.match(html, /"type":"sound"/);
  assert.match(html, /createOscillator/);
  assert.match(runtime, /new AudioContext/);

  const importedAction = renderToStaticMarkup(
    React.createElement(RuleEditor, {
      rules: [
        {
          event: 'start',
          interval: 1,
          once: false,
          actions: [{ type: 'audio', clipId: 'theme', volume: 0.8 }],
        },
      ],
      recipes: [],
      nodes: [],
      scenes: [{ id: 'main', name: 'Main' }],
      sceneId: 'main',
      audioClips: [importedClip],
      onChange: () => {},
    }),
  );
  assert.match(importedAction, /Imported audio clip/);
  assert.match(importedAction, /Theme loop/);
});
