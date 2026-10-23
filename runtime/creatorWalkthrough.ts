import type { GameViewport } from './GameViewport';

/** Optional creator controls for visually checking an exported game without its editor or broker. */
export function creatorWalkthrough(viewport: GameViewport) {
  if (new URLSearchParams(location.search).get('voxshop-inspect') !== '1') return;
  const panel = document.createElement('details');
  panel.open = true;
  panel.style.cssText =
    'position:fixed;bottom:12px;left:12px;max-width:500px;padding:12px;background:#111827ee;color:white;border:1px solid #67e8f9;border-radius:8px;font:13px system-ui;z-index:2';
  panel.innerHTML = `<summary>Creator walkthrough</summary><p>Play pauses between steps. Inspect the rendered game after each step. Each step can place or remove one terrain cell.</p><form style="display:flex;gap:8px;flex-wrap:wrap;align-items:end"><label>Frames <input name="frames" aria-label="Walkthrough frames" type="number" min="1" max="600" value="60" required style="width:65px"></label><label>Move X <input name="moveX" aria-label="Walkthrough move X" type="number" min="-1" max="1" step="0.1" value="0" required style="width:50px"></label><label>Move Z <input name="moveZ" aria-label="Walkthrough move Z" type="number" min="-1" max="1" step="0.1" value="0" required style="width:50px"></label><label><input name="sprint" type="checkbox" aria-label="Walkthrough sprint">Sprint</label><label><input name="attack" type="checkbox" aria-label="Walkthrough attack">Attack</label><label><input name="jump" type="checkbox" aria-label="Walkthrough jump">Jump</label><label><input name="interact" type="checkbox" aria-label="Walkthrough interact">Interact</label><label><input name="placeCell" type="checkbox" aria-label="Walkthrough place cell">Place cell</label><label><input name="removeCell" type="checkbox" aria-label="Walkthrough remove cell">Remove cell</label><button type="submit">Advance game</button><button type="button">Reset walkthrough</button><button type="button">Measure frames</button><button type="button">Frame scene</button></form><p role="status" aria-label="Walkthrough result">Paused at frame 0.</p>`;
  const form = panel.querySelector('form')!;
  const field = (name: string) => form.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
  const result = panel.querySelector('[role=status]')!;
  const initialState = viewport.simulation?.inspect();
  if (initialState) result.textContent = `Frame ${initialState.frame} · ${initialState.status}`;
  const buttons = [...panel.querySelectorAll('button')];
  let busy = false;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;
    const frames = Number(field('frames').value),
      moveX = Number(field('moveX').value),
      moveZ = Number(field('moveZ').value),
      placeCell = field('placeCell').checked,
      removeCell = field('removeCell').checked;
    if (
      !Number.isInteger(frames) ||
      frames < 1 ||
      frames > 600 ||
      ![moveX, moveZ].every((n) => Number.isFinite(n) && Math.abs(n) <= 1)
    ) {
      result.textContent = 'Use 1–600 frames and movement axes between -1 and 1.';
      return;
    }
    if (placeCell && removeCell) {
      result.textContent = 'Choose place or remove for a step, not both.';
      return;
    }
    busy = true;
    buttons.forEach((button) => (button.disabled = true));
    try {
      const observation = await viewport.observe({
        type: 'step',
        frames,
        input: {
          moveX,
          moveZ,
          sprint: field('sprint').checked,
          attack: field('attack').checked,
          jump: field('jump').checked,
          interact: field('interact').checked,
          placeCell,
          removeCell,
        },
      });
      const state = observation.observation.state!;
      result.textContent = `Frame ${state.frame} · ${state.status} · ${observation.observation.render.calls} draw calls${state.errors.length ? ' · ' + state.errors.join('; ') : ''}`;
    } catch (error) {
      result.textContent = (error as Error).message;
    } finally {
      busy = false;
      buttons.forEach((button) => (button.disabled = false));
    }
  });
  buttons[1].addEventListener('click', () => {
    viewport.play(true);
    result.textContent = 'Paused at frame 0.';
  });
  document.getElementById('restart')?.addEventListener('click', () => {
    result.textContent = 'Paused at frame 0.';
  });
  buttons[2].addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    buttons.forEach((button) => (button.disabled = true));
    result.textContent = 'Sampling 120 animation-frame intervals...';
    try {
      const { observation } = await viewport.observe({ type: 'benchmark', frames: 120 });
      const measured = observation.benchmark!;
      result.textContent = `${Number(measured.animationFrameCallbacksPerSecond).toFixed(1)} animation-frame callbacks/s  |  p95 interval ${Number(measured.p95Ms).toFixed(2)} ms  |  ${observation.width}x${observation.height}  |  ${observation.render.calls} draw calls  |  ${String(measured.renderer)}. Refresh and scheduling limits apply.`;
    } catch (error) {
      result.textContent = (error as Error).message;
    } finally {
      busy = false;
      buttons.forEach((button) => (button.disabled = false));
    }
  });
  buttons[3].addEventListener('click', () => {
    try {
      viewport.frameAll();
    } catch (error) {
      result.textContent = (error as Error).message;
    }
  });
  document.body.appendChild(panel);
}
