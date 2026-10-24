import type { Contractor, CustomerRequest, InspectionRequest } from './types';
import { offlineApi } from './offline';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event('moldlens:unauthorized'));
    throw new Error(data.error || 'Something went wrong. Please try again.');
  }
  return data as T;
}

const httpApi = {
  getRequests: () => request<InspectionRequest[]>('/api/requests'),
  getMyRequests: () => request<CustomerRequest[]>('/api/my-requests'),
  createRequest: (form: FormData) => request<CustomerRequest>('/api/requests', { method: 'POST', body: form }),
  updateRequest: (id: string, updates: Partial<InspectionRequest>) => request<InspectionRequest>(`/api/requests/${encodeURIComponent(id)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updates),
  }),
  addNote: (id: string, text: string) => request<InspectionRequest>(`/api/requests/${encodeURIComponent(id)}/notes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
  }),
  getContractors: () => request<Contractor[]>('/api/contractors'),
};

export const api = window.location.protocol === 'file:' ? offlineApi : httpApi;
