import { invoke, isTauri } from '@tauri-apps/api/core';
import { localServiceUrl } from './serviceUrl';

const status = document.querySelector<HTMLElement>('#status')!;
const error = document.querySelector<HTMLElement>('#error')!;
const retry = document.querySelector<HTMLButtonElement>('#retry')!;
let starting = false;

async function start() {
  if (starting) return;
  starting = true;
  retry.hidden = true;
  error.hidden = true;
  status.textContent = 'Starting VoxShop…';
  try {
    if (!isTauri()) throw new Error('Open VoxShop from its desktop app to start the local service.');
    const url = localServiceUrl(await invoke<string>('start_service'));
    window.location.replace(url);
  } catch (cause) {
    status.textContent = 'VoxShop could not start.';
    error.textContent = cause instanceof Error ? cause.message : String(cause);
    error.hidden = false;
    retry.hidden = false;
    retry.focus();
    starting = false;
  }
}

retry.addEventListener('click', () => void start());
void start();
