export interface LiveDetector { ready: boolean; reason: string | null; classes: string[] }
export interface LiveGuidance { code: string; message: string }
export interface LiveSnapshot { id: string; createdAt: string; bytes: number }
export interface LiveSession { id: string; token: string; expiresAt: string; publicOrigin: string | null; detector: LiveDetector; limit: number }
export interface LiveState {
  id: string; phoneConnected: boolean; claimed: boolean; expiresAt: string;
  guidance: LiveGuidance | null; snapshots: LiveSnapshot[]; limit: number; detector: LiveDetector;
}
export interface LiveBox { x: number; y: number; width: number; height: number }
export interface LiveDetection { classId: number; score: number; box: LiveBox; clipped: boolean }
export interface LiveAnalysis extends LiveGuidance {
  streak: number; autoCapture: boolean; metrics: { brightness: number; sharpness: number }; detections: LiveDetection[];
}

export class LiveApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

async function call<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin', cache: 'no-store', ...options,
    headers: { Accept: 'application/json', ...(options.headers || {}) },
  });
  if (response.status === 204) return undefined as T;
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new LiveApiError(typeof data.error === 'string' ? data.error : 'The live camera is unavailable. Please try again.', response.status);
  }
  return response.json() as Promise<T>;
}

export const liveApi = {
  create: () => call<LiveSession>('/api/live/sessions', { method: 'POST' }),
  state: (id: string) => call<LiveState>(`/api/live/sessions/${encodeURIComponent(id)}`),
  end: (id: string) => call<void>(`/api/live/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  async photo(id: string, snapshotId: string): Promise<Blob> {
    const response = await fetch(`/api/live/sessions/${encodeURIComponent(id)}/snapshots/${encodeURIComponent(snapshotId)}`, { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new LiveApiError('This photo could not be loaded.', response.status);
    return response.blob();
  },
  // The phone posts photos with its pairing token, not a customer cookie.
  savePhoto: (id: string, token: string, photo: Blob) => call<{ id: string; count: number; limit: number }>(`/api/live/sessions/${encodeURIComponent(id)}/snapshots`, {
    method: 'POST', headers: { 'Content-Type': 'image/jpeg', 'X-Live-Token': token }, body: photo,
  }),
};

// Desktop and phone sockets share one endpoint; the query string says which role connects.
export function liveSocketUrl(sessionId: string, role: 'desktop' | 'phone') {
  const url = new URL('/api/live/socket', window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.search = `?session=${encodeURIComponent(sessionId)}&role=${role}`;
  return url.toString();
}
