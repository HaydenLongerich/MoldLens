export interface StaffUser { email: string; role: 'admin'; }
export interface AuthSession { user: StaffUser | null; setupRequired: boolean; }

export const isOfflinePreview = window.location.protocol === 'file:';
export const AUTH_STORAGE_SIGNAL = 'moldlens-auth-changed';

export class AuthError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

async function authRequest(path: string, body?: Record<string, string>): Promise<AuthSession> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`/api/auth/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const fallback = response.status === 404
        ? 'Staff sign-in is unavailable. Restart the app server and try again.'
        : 'We couldn’t complete that request. Please try again.';
      throw new AuthError(response.status === 404 ? fallback : typeof data?.error === 'string' ? data.error : fallback, response.status);
    }
    if (!data || typeof data.setupRequired !== 'boolean' ||
      (data.user !== null && (!data.user || data.user.role !== 'admin' || typeof data.user.email !== 'string'))) {
      throw new AuthError('Staff sign-in is unavailable. Restart the app server and try again.', 503);
    }
    return data as AuthSession;
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError('We couldn’t connect to staff sign-in. Check that the app server is running and try again.', 0);
  } finally { window.clearTimeout(timeout); }
}

export function signalAuthChange() {
  // A notification only: credentials and session tokens are never stored here.
  try { localStorage.setItem(AUTH_STORAGE_SIGNAL, `${Date.now()}-${Math.random()}`); } catch { /* Storage can be disabled. */ }
}

export const getSession = (): Promise<AuthSession> => isOfflinePreview
  ? Promise.resolve({ user: null, setupRequired: false }) : authRequest('session');
export const signIn = (email: string, password: string) => authRequest('login', { email, password });
export const createStaffAccount = (email: string, password: string, setupCode: string) => authRequest('setup', { email, password, setupCode });
export const signOut = () => authRequest('logout', {});
