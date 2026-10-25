import type { Screening, ScreeningConfig, ScreeningDetails, ScreeningQuestions, ScreeningReportResponse, ScreeningUpload } from './screening-types';

export const screeningOffline = window.location.protocol === 'file:';
export class ScreeningApiError extends Error {
  constructor(message: string, public status: number, public data: Record<string, unknown> = {}) { super(message); }
}

async function request<T>(path: string, options: RequestInit = {}, allowConflict = false): Promise<T> {
  if (screeningOffline) throw new ScreeningApiError('AI screening is available in the running MoldLens app.', 0);
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const timeout = window.setTimeout(abort, options.method === 'PUT' ? 120_000 : 30_000);
  try {
    const response = await fetch(path, {
      credentials: 'same-origin', cache: 'no-store', ...options, signal: controller.signal,
      headers: { Accept: 'application/json', ...(typeof options.body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
    });
    const data = await response.json().catch(() => {
      throw new ScreeningApiError('Screening is unavailable. Restart the app server to load the screening backend.', response.status);
    });
    if (!response.ok && !(allowConflict && response.status === 409 && typeof data.receivedBytes === 'number')) {
      const message = response.status === 404 && (path === '/api/screenings' || path === '/api/screening-config')
        ? 'Screening is unavailable. Restart the app server to load the screening backend.'
        : typeof data.error === 'string' ? data.error : 'This screening request could not be completed. Please try again.';
      throw new ScreeningApiError(message, response.status, data);
    }
    return data as T;
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (error instanceof ScreeningApiError) throw error;
    throw new ScreeningApiError(controller.signal.aborted ? 'The connection timed out. Please try again.' : 'We couldn’t reach the server. Your saved screening will be here when you reconnect.', 0);
  } finally {
    window.clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
  }
}
const endpoint = (id: string) => `/api/screenings/${encodeURIComponent(id)}`;
export const screeningApi = {
  config: (signal?: AbortSignal) => request<ScreeningConfig>('/api/screening-config', { signal }),
  list: (signal?: AbortSignal) => request<Screening[]>('/api/screenings', { signal }),
  create: () => request<Screening>('/api/screenings', { method: 'POST', body: JSON.stringify({ consentAiProcessing: true, consentMediaStorage: true }) }),
  get: (id: string, signal?: AbortSignal) => request<Screening>(endpoint(id), { signal }),
  save: (id: string, details: ScreeningDetails) => request<Screening>(endpoint(id), { method: 'PATCH', body: JSON.stringify(details) }),
  beginUpload: (id: string, data: { fingerprint: string; name: string; mime: string; size: number }, signal?: AbortSignal) => request<ScreeningUpload>(`${endpoint(id)}/uploads`, { method: 'POST', body: JSON.stringify(data), signal }),
  uploadChunk: (id: string, offset: number, body: Blob, signal?: AbortSignal) => request<{ receivedBytes: number; conflict?: boolean }>(`/api/screening-uploads/${encodeURIComponent(id)}?offset=${offset}`, { method: 'PUT', body, signal, headers: { 'Content-Type': 'application/octet-stream' } }, true),
  finishUpload: (id: string, signal?: AbortSignal) => request<{ assetId: string }>(`/api/screening-uploads/${encodeURIComponent(id)}/complete`, { method: 'POST', signal }),
  cancelUpload: (id: string) => request<{ ok: true }>(`/api/screening-uploads/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  removeMedia: (id: string) => request<{ ok: true }>(`/api/screening-assets/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  submit: (id: string, contractorSharing = false) => request<Screening>(`${endpoint(id)}/submit`, { method: 'POST', body: JSON.stringify({ contractorSharing }) }),
  retry: (id: string) => request<Screening>(`${endpoint(id)}/retry`, { method: 'POST' }),
  questions: (id: string, signal?: AbortSignal) => request<ScreeningQuestions>(`${endpoint(id)}/questions`, { signal }),
  answers: (id: string, answers: { questionId: string; value: string | string[] }[]) => request<{ done: boolean; remaining: number }>(`${endpoint(id)}/answers`, { method: 'POST', body: JSON.stringify({ answers, finish: true }) }),
  report: (id: string, signal?: AbortSignal) => request<ScreeningReportResponse>(`${endpoint(id)}/report`, { signal }),
};
