import type { ViewportRequest } from './viewportProtocol';
let session: Promise<{ token: string }> | null = null;
async function openSession(): Promise<{ token: string }> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch('/api/session');
      if (!response.ok) {
        if (attempt < 3 && [500, 502, 503, 504].includes(response.status)) {
          await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
          continue;
        }
        throw Error(
          `VoxShop could not connect to this workspace (${response.status}). ${response.status === 401 || response.status === 403 ? 'Sign in to the workspace and refresh.' : 'Keep the workspace service running and refresh to reconnect.'}`,
        );
      }
      return (await response.json()) as { token: string };
    } catch (error) {
      if (error instanceof TypeError && attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
        continue;
      }
      throw error;
    }
  }
}
export async function localApi(url: string, init: RequestInit = {}): Promise<Response> {
  const parsed = new URL(url, window.location.href);
  // Keep custom external worker URLs explicit; never send the local token to them.
  const local =
    parsed.origin === window.location.origin ||
    ['http://localhost:4269', 'http://127.0.0.1:4269'].includes(parsed.origin);
  if (!local) return fetch(url, init);
  if (!session)
    session = openSession().catch((e) => {
      session = null;
      throw e;
    });
  const credentials = await session;
  const headers = new Headers(init.headers);
  headers.set('X-VoxShop-Token', credentials.token);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(parsed.pathname + parsed.search, { ...init, headers });
  if (response.status === 401) {
    session = null;
    throw new Error('Your workspace session changed. Refresh this page to reconnect.');
  }
  return response;
}
export async function apiJson<T = any>(url: string, init?: RequestInit): Promise<T> {
  const response = await localApi(url, init);
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status}).`);
  return body;
}
export async function watchProjects(
  onChange: (event: { projectId: string; revision: number; activated?: boolean }) => void,
  signal: AbortSignal,
  onViewport?: (request: ViewportRequest) => void,
) {
  const clientId = crypto.randomUUID();
  while (!signal.aborted) {
    try {
      const res = await localApi(
        `/api/events?clientId=${clientId}&clientOrigin=${encodeURIComponent(window.location.origin)}`,
        { signal },
      );
      const reader = res.body!.getReader(),
        decoder = new TextDecoder();
      let text = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        let end: number;
        while ((end = text.indexOf('\n\n')) >= 0) {
          const entry = text.slice(0, end);
          text = text.slice(end + 2);
          if (entry.startsWith('event: change\n'))
            onChange(JSON.parse(entry.slice(entry.indexOf('data: ') + 6)));
          else if (entry.startsWith('event: viewport\n'))
            onViewport?.(JSON.parse(entry.slice(entry.indexOf('data: ') + 6)));
        }
      }
    } catch {
      if (signal.aborted) return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, 2000);
      function done() {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      }
      signal.addEventListener('abort', done, { once: true });
    });
  }
}
