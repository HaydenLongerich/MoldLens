import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

// Live sessions are short-lived and hold no customer data beyond the owner hash,
// so they stay in memory. Only accepted snapshots are written to disk.
const digest = (value) => createHash('sha256').update(value).digest();

export function createRegistry({ now = Date.now, pairingMs = 10 * 60_000, idleMs = 20 * 60_000, onEnd = () => {} } = {}) {
  const sessions = new Map();

  function create(ownerHash) {
    const id = randomUUID();
    const token = randomBytes(24).toString('base64url');
    const session = {
      id, ownerHash, tokenHash: digest(token), claimed: false, phone: null, desktops: new Set(),
      snapshots: [], streak: 0, guidance: null, queue: Promise.resolve(), createdAt: now(), expiresAt: now() + pairingMs,
    };
    sessions.set(id, session);
    return { session, token };
  }

  function live(id) {
    const session = sessions.get(id);
    if (!session) return null;
    if (session.expiresAt <= now()) { end(id); return null; }
    return session;
  }

  function verify(session, token) {
    return typeof token === 'string' && token.length < 256 && timingSafeEqual(digest(token), session.tokenHash);
  }

  // The first valid phone claims the session. Later reconnects by the same phone
  // use the same token until the session ends.
  function claim(id, token) {
    const session = live(id);
    if (!session || !verify(session, token)) return null;
    session.claimed = true;
    touch(session);
    return session;
  }

  function touch(session) {
    session.expiresAt = now() + (session.claimed ? idleMs : pairingMs);
  }

  function end(id) {
    const session = sessions.get(id);
    if (!session) return false;
    sessions.delete(id);
    onEnd(session);
    return true;
  }

  function endOwned(ownerHash) {
    for (const session of [...sessions.values()]) if (session.ownerHash === ownerHash) end(session.id);
  }

  function sweep() {
    for (const session of [...sessions.values()]) if (session.expiresAt <= now()) end(session.id);
  }

  return { create, get: live, claim, verify, touch, end, endOwned, sweep, all: () => [...sessions.values()], size: () => sessions.size };
}
