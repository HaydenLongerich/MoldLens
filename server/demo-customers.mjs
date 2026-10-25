import { randomBytes, createHash } from 'node:crypto';
import { HttpError } from './validation.mjs';
import { demoLocations } from './demo-companies.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
export function registerDemoCustomers(app, { auth, mutate, records, devOnly, route }) {
  const current = req => records().demoCustomers?.[auth.getCustomerHash(req)] || null;
  const publicView = profile => ({ customer: profile ? { username: profile.username, email: profile.email || null } : null, locations: demoLocations.map(({ city, postalCode }) => ({ city, postalCode })) });
  function activateExamples(state) {
    for (const company of state.companies.filter(c => c.example && !c.retired)) {
      company.subscription = 'active';
      if (company.membership?.status !== 'paid_demo' || Date.parse(company.membership.periodEnd) <= Date.now()) {
        company.subscription = 'active';
        company.membership = { status: 'paid_demo', amount: 100, currency: 'CAD', interval: 'month', simulated: true, paidAt: new Date().toISOString(), periodEnd: new Date(Date.now() + 30 * 86400000).toISOString(), receiptId: `DEMO-${company.id.toUpperCase()}` };
      }
    }
  }
  function newProfile(state) {
    const ownerHash = hash(randomBytes(32));
    (state.demoCustomers ||= {})[ownerHash] = { ownerHash, username: `Guest-${randomBytes(2).toString('hex').toUpperCase()}`, email: null, createdAt: new Date().toISOString() };
    return state.demoCustomers[ownerHash];
  }
  function bindSession(state, ownerHash, token) {
    const sessions = state.demoCustomerSessions ||= {};
    for (const [key, item] of Object.entries(sessions)) if (Date.parse(item.expiresAt) <= Date.now()) delete sessions[key];
    sessions[hash(token)] = { ownerHash, expiresAt: new Date(Date.now() + 7 * 86400000).toISOString() };
  }
  const limits = new Map();
  function local(req) {
    devOnly(req);
    const entry = limits.get(req.ip) || { until: Date.now() + 60000, count: 0 };
    if (entry.until < Date.now()) { entry.until = Date.now() + 60000; entry.count = 0; }
    if (++entry.count > 30) throw new HttpError(429, 'Please wait a minute before restarting the demo again.');
    if (limits.size > 1000) limits.clear(); limits.set(req.ip, entry);
  }
  app.get('/api/marketplace/demo-customer', route((req, res) => { devOnly(req); res.json(publicView(current(req))); }));
  app.post('/api/marketplace/demo-customer/start', route(async (req, res) => {
    local(req); const token = randomBytes(32).toString('hex');
    const profile = await mutate(state => { activateExamples(state); const profile = newProfile(state); bindSession(state, profile.ownerHash, token); return profile; });
    auth.saveDemoSession(req, res, token); res.json(publicView(profile));
  }));
  app.post('/api/marketplace/demo-customer/continue', route(async (req, res) => {
    local(req);
    const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter an email to save or continue your local demo.');
    const token = randomBytes(32).toString('hex');
    const owner = current(req);
    const profile = await mutate(state => {
      activateExamples(state);
      const saved = (state.demoCustomerEmails ||= {})[hash(email)];
      const profile = saved && state.demoCustomers?.[saved] || owner && !owner.email && state.demoCustomers?.[owner.ownerHash] || newProfile(state);
      profile.email = email;
      state.demoCustomerEmails[hash(email)] = profile.ownerHash;
      bindSession(state, profile.ownerHash, token); return profile;
    });
    auth.saveDemoSession(req, res, token); res.json(publicView(profile));
  }));
  app.post('/api/marketplace/demo-customer/exit', route(async (req, res) => {
    local(req); const key = auth.getDemoSessionHash(req);
    await mutate(state => { if (key) delete (state.demoCustomerSessions ||= {})[key]; });
    auth.clearDemoSession(req, res); res.json(publicView(null));
  }));
  app.post('/api/marketplace/demo-customer/name', route(async (req, res) => {
    local(req); const profile = current(req);
    if (!profile) throw new HttpError(409, 'Start a customer demo first.');
    const name = typeof req.body.username === 'string' ? req.body.username.trim() : '';
    if (!name || name.length > 60 || /[\u0000-\u001f]/.test(name)) throw new HttpError(400, 'Enter a demo name of up to 60 characters.');
    res.json(publicView(await mutate(state => { state.demoCustomers[profile.ownerHash].username = name; return state.demoCustomers[profile.ownerHash]; })));
  }));
  return { rememberEmail(state, ownerHash, email) {
    const profile = state.demoCustomers?.[ownerHash];
    if (!profile) return;
    // Never search real customer contacts or map an email-only demo to a real owner.
    const emails = state.demoCustomerEmails ||= {};
    if (!emails[hash(email)] && !profile.email) { emails[hash(email)] = ownerHash; profile.email = email; }
  } };
}
