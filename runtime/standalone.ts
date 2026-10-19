import { GameViewport } from './GameViewport';
import type { ProjectDocument } from '../services/projectDocument';
const project = JSON.parse(document.getElementById('voxshop-project')!.textContent!) as ProjectDocument;
const viewport = new GameViewport(document.getElementById('game')!, project);
const title = document.getElementById('title')!,
  status = document.getElementById('status')!,
  variables = document.getElementById('variables')!,
  instructions = document.getElementById('instructions')!;
title.textContent = project.name;
instructions.textContent = project.scenes[0].instructions;
viewport.onState = (state) => {
  status.textContent =
    state.status === 'playing'
      ? state.message
      : state.message ||
        (state.status === 'won' ? 'You won!' : state.status === 'lost' ? 'Try again' : 'Stopped');
  variables.textContent =
    Object.entries(state.variables)
      .map(([k, v]) => `${k}: ${v}`)
      .join(' · ') + (state.health.player !== undefined ? ` · health: ${state.health.player}` : '');
};
document.getElementById('restart')!.addEventListener('click', () => viewport.play());
viewport.play();
// Documented, bounded runtime inspection API for creators' external test harnesses.
Object.assign(window, {
  VoxShopGame: {
    apiVersion: 1,
    inspect: () => viewport.simulation!.inspect(),
    step: (input: any, frames = 1) => {
      if (!Number.isInteger(frames) || frames < 1 || frames > 18000)
        throw new Error('Frames must be 1..18000.');
      for (let i = 0; i < frames; i++) viewport.simulation!.step(input);
      return viewport.simulation!.inspect();
    },
    restart: () => viewport.play(),
  },
});
window.addEventListener('pagehide', () => viewport.dispose(), { once: true });
