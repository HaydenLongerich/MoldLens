import { randomBytes, randomUUID, createHash, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, link, unlink } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { HttpError } from './validation.mjs';

const scrypt = promisify(scryptCallback);
const STAFF_COOKIE = 'moldlens_staff';
const CUSTOMER_COOKIE = 'moldlens_customer';
const SESSION_MS = 8 * 60 * 60 * 1000;
const CUSTOMER_MS = 90 * 24 * 60 * 60 * 1000;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const SCRYPT_OPTIONS = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const hash = (value) => createHash('sha256').update(value).digest('hex');
const equal = (left, right) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

function cookieToken(request, name) {
  const values = (request.headers.cookie || '').split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  if (values.length !== 1) return null;
  const token = values[0].slice(name.length + 1);
  return /^[a-f0-9]{64}$/.test(token) ? token : null;
}

function cookieOptions(request, maxAge) {
  return { httpOnly: true, sameSite: 'strict', secure: request.secure, path: '/', maxAge };
}

function credentials(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Please enter your email and password.');
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Please enter a valid staff email address.');
  if (typeof body.password !== 'string' || body.password.length < 12 || body.password.length > 128) throw new HttpError(400, 'Use a password between 12 and 128 characters.');
  return { email, password: body.password };
}

export async function createAuth(dataDirectory, { setupCode: suppliedSetupCode, now = Date.now } = {}) {
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const accountsFile = path.join(dataDirectory, 'staff-accounts.json');
  const setupFile = path.join(dataDirectory, 'staff-setup-code');
  let account = null;
  let setupCode;
  const sessions = new Map();
  const attempts = new Map();
  let setupQueue = Promise.resolve();

  async function readAccount() {
    if (account) return account;
    try {
      const stored = JSON.parse(await readFile(accountsFile, 'utf8'));
      if (!stored || stored.version !== 1 || typeof stored.email !== 'string' || stored.role !== 'admin' || !/^[a-f0-9]{32}$/.test(stored.salt) || !/^[a-f0-9]{128}$/.test(stored.passwordHash)) throw new Error('The staff account store is invalid.');
      account = stored;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return account;
  }

  await readAccount();
  if (!account) {
    try { setupCode = (await readFile(setupFile, 'utf8')).trim(); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const generated = suppliedSetupCode ?? randomBytes(32).toString('hex');
      if (typeof generated !== 'string' || generated.length < 12 || generated.length > 128) throw new Error('The staff setup code must be between 12 and 128 characters.');
      try { await writeFile(setupFile, `${generated}\n`, { flag: 'wx', mode: 0o600 }); setupCode = generated; }
      catch (writeError) {
        if (writeError.code !== 'EEXIST') throw writeError;
        setupCode = (await readFile(setupFile, 'utf8')).trim();
      }
    }
    if (!setupCode) throw new Error('The staff setup code is empty.');
  } else await unlink(setupFile).catch((error) => { if (error.code !== 'ENOENT') throw error; });

  function throttle(request, action) {
    const current = now();
    for (const [key, entry] of attempts) if (entry.until <= current) attempts.delete(key);
    const key = `${action}:${request.socket.remoteAddress || 'local'}`;
    const entry = attempts.get(key) || { count: 0, until: current + ATTEMPT_WINDOW_MS };
    if (entry.count >= MAX_ATTEMPTS) {
      const error = new HttpError(429, 'Too many sign-in attempts. Please try again in 15 minutes.');
      error.retryAfter = Math.max(1, Math.ceil((entry.until - current) / 1000));
      throw error;
    }
    entry.count += 1;
    attempts.set(key, entry);
    return () => attempts.delete(key);
  }

  const publicUser = (staff) => staff ? { email: staff.email, role: 'admin' } : null;

  function userForRequest(request) {
    const token = cookieToken(request, STAFF_COOKIE);
    if (!token) return null;
    const key = hash(token);
    const session = sessions.get(key);
    if (!session || session.expiresAt <= now()) {
      sessions.delete(key);
      return null;
    }
    return publicUser(account);
  }

  function revoke(request) {
    const token = cookieToken(request, STAFF_COOKIE);
    if (token) sessions.delete(hash(token));
  }

  function startSession(request, response) {
    revoke(request);
    for (const [key, value] of sessions) if (value.expiresAt <= now()) sessions.delete(key);
    const token = randomBytes(32).toString('hex');
    sessions.set(hash(token), { expiresAt: now() + SESSION_MS });
    response.cookie(STAFF_COOKIE, token, cookieOptions(request, SESSION_MS));
    return { user: publicUser(account), setupRequired: false };
  }

  async function state(request) {
    await readAccount();
    return { user: userForRequest(request), setupRequired: !account };
  }

  async function setup(request, response) {
    const clearAttempts = throttle(request, 'setup');
    const task = setupQueue.then(async () => {
      if (await readAccount()) throw new HttpError(409, 'A staff account already exists. Please sign in.');
      const candidate = request.body?.setupCode;
      if (typeof candidate !== 'string' || candidate.length > 128 || !equal(hash(candidate.trim()), hash(setupCode))) throw new HttpError(403, 'The setup code is incorrect. Use the code shown in the server terminal.');
      const { email, password } = credentials(request.body);
      const salt = randomBytes(16).toString('hex');
      const passwordHash = (await scrypt(password, salt, 64, SCRYPT_OPTIONS)).toString('hex');
      const next = { version: 1, id: randomUUID(), email, role: 'admin', salt, passwordHash, createdAt: new Date(now()).toISOString() };
      const temporary = `${accountsFile}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
        // Linking an already-written file makes first-account creation atomic and
        // refuses replacement, even if two server processes receive setup calls.
        await link(temporary, accountsFile);
        account = next;
      } catch (error) {
        if (error.code === 'EEXIST') {
          await readAccount();
          throw new HttpError(409, 'A staff account already exists. Please sign in.');
        }
        throw error;
      } finally { await unlink(temporary).catch(() => {}); }
      await unlink(setupFile).catch((error) => { if (error.code !== 'ENOENT') throw error; });
      setupCode = undefined;
      clearAttempts();
      return startSession(request, response);
    });
    setupQueue = task.catch(() => {});
    return task;
  }

  async function login(request, response) {
    const clearAttempts = throttle(request, 'login');
    let input;
    try { input = credentials(request.body); }
    catch { throw new HttpError(401, 'The email or password is incorrect.'); }
    await readAccount();
    // Unknown emails use the same expensive derivation as valid accounts.
    const salt = account?.salt ?? '00000000000000000000000000000000';
    const candidate = await scrypt(input.password, salt, 64, SCRYPT_OPTIONS);
    const expected = Buffer.from(account?.passwordHash ?? '0'.repeat(128), 'hex');
    const matches = timingSafeEqual(candidate, expected);
    if (!account || input.email !== account.email || !matches) throw new HttpError(401, 'The email or password is incorrect.');
    clearAttempts();
    return startSession(request, response);
  }

  function customerHash(request) {
    const token = cookieToken(request, CUSTOMER_COOKIE);
    return token ? hash(token) : null;
  }

  function owns(request, record) {
    const owner = customerHash(request);
    return Boolean(owner && typeof record.customerOwnerHash === 'string' && equal(owner, record.customerOwnerHash));
  }

  return {
    state, setup, login, userForRequest, owns,
    async getSetupCode() { return await readAccount() ? null : setupCode; },
    requireStaff(request, _response, next) {
      if (!userForRequest(request)) return next(new HttpError(401, 'Please sign in to access the staff dashboard.'));
      next();
    },
    logout(request, response) {
      revoke(request);
      response.clearCookie(STAFF_COOKIE, cookieOptions(request, undefined));
      return { user: null, setupRequired: !account };
    },
    customerIdentity(request) {
      const token = cookieToken(request, CUSTOMER_COOKIE) ?? randomBytes(32).toString('hex');
      return {
        hash: hash(token),
        save(response) { response.cookie(CUSTOMER_COOKIE, token, cookieOptions(request, CUSTOMER_MS)); },
      };
    },
  };
}

export function staffRecord(record) {
  const { customerOwnerHash: _owner, ...safe } = record;
  return safe;
}

export function customerRecord(record) {
  const allowed = ['id', 'name', 'email', 'phone', 'address', 'postalCode', 'propertyType', 'area', 'size', 'duration', 'description', 'signs', 'contactPreference', 'consent', 'status', 'createdAt', 'updatedAt', 'assignee', 'scheduledAt', 'attachments', 'isDemo', 'relationship'];
  return { ...Object.fromEntries(allowed.filter((key) => Object.hasOwn(record, key)).map((key) => [key, record[key]])), notes: [] };
}
