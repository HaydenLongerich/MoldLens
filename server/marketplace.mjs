import { randomBytes, randomUUID, createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from './validation.mjs';
import { validateProposal, proposalExpired } from './project-proposals.mjs';
import { createDirectory, postalCode, withinRadius, distanceKm } from './contractor-directory.mjs';
import { createInvitationSender, enqueueInvitations, invitationContent } from './quote-invitations.mjs';

import { exampleCompanies, demoLocations } from './demo-companies.mjs';
export { exampleCompanies };
import { registerDemoCustomers } from './demo-customers.mjs';
import { retireGeneratedSamples } from './generated-samples.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const text = (value, label, max = 2000) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new HttpError(400, `Enter ${label} (up to ${max} characters).`);
  return value.trim();
};
const active = company => company && company.subscription === 'active' && company.membership?.status === 'paid_demo' && Date.parse(company.membership.periodEnd) > Date.now();
const proposalSnapshot = quote => { const { revisions, ...snapshot } = quote; return structuredClone(snapshot); };
const areaId = label => ({ 'laundry-area': 'laundry', 'living-area': 'living', 'vents-ductwork': 'hvac_vents', 'windows-sills': 'windows', 'exterior-foundation': 'exterior' }[label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')] || label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
const projectAreas = report => report.projectAreas?.length ? report.projectAreas : (report.area || 'Property').split(',').map(label => label.trim()).filter(Boolean).map(label => ({ id: areaId(label), label, description: '', findings: [] }));
const coversProject = (report, quote) => {
  const areas = projectAreas(report);
  if (!quote.coveredAreaIds) return areas.length === 1;
  return quote.coveredAreaIds.length === areas.length && new Set(quote.coveredAreaIds).size === areas.length && areas.every(area => quote.coveredAreaIds.includes(area.id));
};
function projectCoverage(report, body) {
  const areas = projectAreas(report);
  const coveredAreaIds = body.coveredAreaIds ?? (areas.length === 1 ? [areas[0].id] : []);
  if (!Array.isArray(coveredAreaIds) || !coversProject(report, { coveredAreaIds })) throw new HttpError(400, 'A project quote must cover every area in the screening.');
  const breakdown = body.breakdown ?? [];
  if (!Array.isArray(breakdown)) throw new HttpError(400, 'Provide a valid area breakdown.');
  if (breakdown.length) {
    if (breakdown.length !== areas.length || new Set(breakdown.map(item => item?.areaId)).size !== areas.length || breakdown.some(item => !item || !areas.some(area => area.id === item.areaId) || typeof item.amount !== 'number' || !Number.isFinite(item.amount) || item.amount < 0 || item.amount > 100000 || Math.abs(Math.round(item.amount * 100) - item.amount * 100) > 0.00001)) throw new HttpError(400, 'The breakdown must include every area once, with valid CAD amounts.');
    if (breakdown.reduce((sum, item) => sum + Math.round(item.amount * 100), 0) !== Math.round(body.amount * 100)) throw new HttpError(400, 'The area breakdown must add up to the project total.');
  }
  return { quoteType: 'project', coveredAreaIds: areas.map(area => area.id), breakdown: breakdown.map(item => ({ areaId: item.areaId, amount: item.amount })) };
}

export async function registerMarketplace(app, { dataDirectory, auth, ownsScreening = () => false, directoryOptions = {}, emailOptions = {} }) {
  app.use('/api/marketplace', (req, _res, next) => {
    if (req.method === 'POST' && (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))) return next(new HttpError(400, 'Please provide a JSON object.'));
    next();
  });
  const directory = createDirectory({ dataDirectory, ...directoryOptions });
  const sender = createInvitationSender(emailOptions);
  const filename = path.join(dataDirectory, 'marketplace.json');
  let state;
  try { state = JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; state = { companies: exampleCompanies, accounts: [], reports: [], quotes: [], messages: [] }; }
  let queue = Promise.resolve();
  const mutate = action => {
    const task = queue.then(async () => {
      const next = structuredClone(state);
      const result = action(next);
      const temp = `${filename}.${randomUUID()}.tmp`;
      try { await writeFile(temp, JSON.stringify(next), { mode: 0o600 }); await rename(temp, filename); }
      catch (error) { await unlink(temp).catch(() => {}); throw error; }
      state = next;
      return structuredClone(result);
    });
    queue = task.catch(() => {});
    return task;
  };
  // Persist the seed once; later starts never replace user data.
  await mutate(records => { for (const company of records.companies) if (!company.membership) { company.membership = { status: 'pending', amount: 100, currency: 'CAD', interval: 'month', simulated: true }; company.subscription = company.subscription === 'paused' ? 'paused' : 'pending'; company.trialEndsAt = null; } });
  await mutate(records => {
    retireGeneratedSamples(records);
    for (const old of records.companies) if (old.example && ['aro', 'desa'].includes(old.id)) { old.retired = true; old.subscription = 'paused'; }
    for (const seed of exampleCompanies) {
      const current = records.companies.find(c => c.id === seed.id);
      if (current) { const { membership, subscription, ...metadata } = seed; Object.assign(current, metadata); }
      else records.companies.push(structuredClone(seed));
    }
  });
  const sampleRecipients = (records, report) => records.companies.filter(c => active(c) && c.example && !c.retired && withinRadius(report.demoLocation, c.demoLocation)).map(c => c.id);
  const sessions = new Map();
  const attempts = new Map();
  const cookie = 'moldlens_partner';
  auth.setDemoCustomerResolver(key => { const session = key && state.demoCustomerSessions?.[key]; return session && Date.parse(session.expiresAt) > Date.now() && state.demoCustomers?.[session.ownerHash] ? session.ownerHash : null; });
  const tokenFor = req => {
    const tokens = (req.headers.cookie || '').split(';').map(item => item.trim()).filter(item => item.startsWith(`${cookie}=`));
    return tokens.length === 1 ? tokens[0].slice(cookie.length + 1) : '';
  };
  const partner = req => {
    const session = sessions.get(digest(tokenFor(req)));
    if (!session || session.expires < Date.now()) return null;
    return state.companies.find(company => company.id === session.companyId) || null;
  };
  const requirePartner = req => { const company = partner(req); if (!company) throw new HttpError(401, 'Sign in to your contractor workspace.'); return company; };
  const requireMember = req => { const company = requirePartner(req); if (!active(company)) throw new HttpError(403, 'Activate your $100 CAD/month demo membership first.'); return company; };
  const startSession = (req, res, companyId) => {
    for (const [key, session] of sessions) if (session.expires < Date.now()) sessions.delete(key);
    sessions.delete(digest(tokenFor(req)));
    const token = randomBytes(32).toString('hex');
    sessions.set(digest(token), { companyId, expires: Date.now() + 8 * 60 * 60 * 1000 });
    res.cookie(cookie, token, { httpOnly: true, sameSite: 'strict', secure: req.secure, path: '/', maxAge: 8 * 60 * 60 * 1000 });
    return state.companies.find(company => company.id === companyId);
  };
  const route = handler => (req, res, next) => Promise.resolve().then(() => handler(req, res)).catch(next);
  const findReport = (records, id) => { const report = records.reports.find(item => item.id === id); if (!report) throw new HttpError(404, 'Report not found.'); return report; };
  const owns = (req, report) => auth.owns(req, report);
  const access = (req, report, company) => {
    if (company ? report.recipientIds.includes(company.id) : owns(req, report)) return;
    throw new HttpError(404, 'Report not found.');
  };
  const view = (records, report, company = null) => {
    const { customerOwnerHash, contractorResponses, preliminarySelection, ...safe } = report;
    const quotes = records.quotes.filter(item => item.reportId === report.id && (!company || item.companyId === company.id)).map(item => {
      const { customerArchivedAt, contractorArchivedAt, ...quote } = item;
      const revisions = quote.revisions?.map(revision => { const { customerArchivedAt, contractorArchivedAt, ...safe } = revision; return safe; });
      return { ...quote, revisions, archivedAt: (company ? contractorArchivedAt : customerArchivedAt) || null };
    });
    const contact = records.customerContacts?.[report.customerOwnerHash] || null;
    const contactRequired = !company && !contact;
    const chosenCompany = records.quotes.find(item => item.id === report.selectedQuoteId)?.companyId;
    const canSeeSelection = !company || preliminarySelection?.companyId === company.id;
    const demoPoint = report.demoLocation || (report.demoProject && demoLocations.find(l => l.postalCode === report.postalCode));
    const demoMatches = demoPoint && records.companies.filter(c => c.example && !c.retired).map(c => ({ companyId: c.id, name: c.name, city: c.city, distanceKm: Math.round(distanceKm(demoPoint, c.demoLocation) * 10) / 10, inRange: withinRadius(demoPoint, c.demoLocation), received: report.recipientIds.includes(c.id) }));
    return { ...safe, demoMatches, preliminarySelection: canSeeSelection && !contactRequired ? preliminarySelection || null : null, contactRequired, customerContact: !company || chosenCompany === company.id || preliminarySelection?.companyId === company.id ? contact : null, quoteCount: quotes.filter(quote => !quote.declinedAt && !quote.withdrawnAt && !quote.archivedAt && !proposalExpired(quote)).length, response: company ? contractorResponses?.[company.id] || {} : undefined, projectAreas: projectAreas(report), quotes: contactRequired ? [] : quotes, messages: records.messages.filter(item => item.reportId === report.id && (!company || item.companyId === company.id)), recipients: report.recipientIds.map(id => publicCompany(records.companies.find(item => item.id === id))).filter(Boolean) };
  };
  const publicCompany = company => company && ({ id: company.id, googlePlaceId: company.googlePlaceId || null, name: company.name, initials: company.initials, city: company.city, services: company.services, phone: company.phone, website: company.website, sourceUrl: company.sourceUrl, description: company.description, example: company.example, subscription: company.subscription, trialEndsAt: null, membership: { status: company.membership.status, amount: 100, currency: 'CAD', interval: 'month', simulated: true } });
  const devOnly = req => {
    if (process.env.NODE_ENV === 'production' || !['127.0.0.1', 'localhost', '[::1]'].includes(req.hostname)) throw new HttpError(404, 'Testing tools are only available locally.');
  };
  const customerDemo = registerDemoCustomers(app, { auth, mutate, records: () => state, devOnly, route });
  app.get('/api/marketplace/companies', route(async (_req, res) => { await queue; res.json(state.companies.filter(c => !c.retired).map(publicCompany)); }));
  app.get('/api/marketplace/session', route(async (req, res) => { await queue; const company = partner(req); res.json({ company: company && { ...company, notificationEmail: state.accounts.find(a => a.companyId === company.id)?.email || null }, demoAvailable: process.env.NODE_ENV !== 'production', directoryConfigured: directory.googleConfigured, emailMode: sender.mode, emailReady: sender.ready }); }));
  app.get('/api/marketplace/customer-contact', route(async (req, res) => {
    await queue; res.json({ contact: state.customerContacts?.[auth.getCustomerHash(req)] || null });
  }));
  app.post('/api/marketplace/customer-contact', route(async (req, res) => {
    const owner = auth.customerIdentity(req);
    const email = text(req.body.email, 'your email address', 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter a valid email address.');
    const rawPhone = text(req.body.phone, 'your phone number', 40);
    const digits = rawPhone.replace(/\D/g, '');
    if (!/^\+?[\d\s().-]+$/.test(rawPhone) || !(/^\d{10}$/.test(digits) || /^1\d{10}$/.test(digits) || rawPhone.startsWith('+') && /^\d{10,15}$/.test(digits))) throw new HttpError(400, 'Enter a valid phone number, including the country code if outside Canada.');
    const phone = rawPhone.startsWith('+') || digits.length !== 10 ? `+${digits}` : `+1${digits}`;
    const contact = await mutate(records => { const contact = { email, phone }; (records.customerContacts ||= {})[owner.hash] = contact; customerDemo.rememberEmail(records, owner.hash, email); return contact; });
    owner.save(res); res.json(contact);
  }));
  const removedFor = (records, req) => (records.removedScreenings || []).filter(item => item.ownerHash === auth.getCustomerHash(req)).map(({ key, removedAt }) => ({ key, removedAt }));
  app.get('/api/marketplace/removed-screenings', route(async (req, res) => { await queue; res.json(removedFor(state, req)); }));
  app.post('/api/marketplace/screenings/:id/removal', route(async (req, res) => {
    if (typeof req.body.removed !== 'boolean') throw new HttpError(400, 'Choose remove or restore.');
    await queue;
    let key = req.params.id;
    const report = state.reports.find(item => item.id === key || item.screening?.id === key);
    if (report) access(req, report, null);
    else if (!await ownsScreening(req, key)) throw new HttpError(404, 'Screening not found.');
    if (report) key = report.screening?.id || report.id;
    res.json(await mutate(records => {
      const ownerHash = auth.getCustomerHash(req);
      records.removedScreenings = (records.removedScreenings || []).filter(item => item.key !== key || item.ownerHash !== ownerHash);
      if (req.body.removed) records.removedScreenings.push({ ownerHash, key, removedAt: now() });
      return removedFor(records, req);
    }));
  }));
  app.post('/api/marketplace/demo-login', route(async (req, res) => {
    devOnly(req); await queue;
    const company = state.companies.find(item => item.id === req.body.companyId && item.example && !item.retired);
    if (!company) throw new HttpError(400, 'Choose an example company.');
    res.json({ company: startSession(req, res, company.id) });
  }));
  app.post('/api/marketplace/register', route(async (req, res) => {
    const name = text(req.body.name, 'your company name', 100);
    const email = text(req.body.email, 'an email address', 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter a valid email address.');
    const servicePostalCode = postalCode(req.body.postalCode);
    if (req.body.notificationsEnabled !== true) throw new HttpError(400, 'Confirm that you want screening invitations at your signup email.');
    const password = text(req.body.password, 'a password', 128);
    if (password.length < 12) throw new HttpError(400, 'Use a password with at least 12 characters.');
    const salt = randomBytes(16).toString('hex');
    const passwordHash = scryptSync(password, salt, 64).toString('hex');
    const company = await mutate(records => {
      if (records.accounts.some(account => account.email === email)) throw new HttpError(409, 'This email already has an account. Sign in instead.');
      const company = { id: randomUUID(), name, initials: name.split(/\s+/).map(word => word[0]).join('').slice(0, 2).toUpperCase(), city: 'Ontario', postalCode: servicePostalCode, notificationsEnabled: true, services: ['Mold removal'], phone: '', website: '', sourceUrl: '', description: 'Independent Ontario contractor.', example: false, subscription: 'pending', trialEndsAt: null, membership: { status: 'pending', amount: 100, currency: 'CAD', interval: 'month', simulated: true } };
      records.companies.push(company);
      records.accounts.push({ email, passwordHash, salt, companyId: company.id });
      return company;
    });
    res.status(201).json({ company: startSession(req, res, company.id) });
  }));
  app.post('/api/marketplace/login', route(async (req, res) => {
    const key = req.ip;
    const attempt = attempts.get(key) || { count: 0, until: Date.now() + 900000 };
    if (attempt.until < Date.now()) { attempt.count = 0; attempt.until = Date.now() + 900000; }
    if (++attempt.count > 10) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
    attempts.set(key, attempt);
    const email = text(req.body.email, 'your email', 254).toLowerCase();
    const password = text(req.body.password, 'your password', 128);
    await queue;
    const account = state.accounts.find(item => item.email === email);
    const candidate = scryptSync(password, account?.salt || 'not-an-account', 64);
    if (!account || !timingSafeEqual(candidate, Buffer.from(account.passwordHash, 'hex'))) throw new HttpError(401, 'The email or password is incorrect.');
    attempts.delete(key);
    res.json({ company: startSession(req, res, account.companyId) });
  }));
  app.post('/api/marketplace/logout', route((req, res) => {
    sessions.delete(digest(tokenFor(req))); res.clearCookie(cookie, { path: '/' }); res.json({ company: null });
  }));
  app.post('/api/marketplace/subscription', route(async (req, res) => {
    const company = requirePartner(req);
    devOnly(req);
    if (!['active', 'paused'].includes(req.body.status)) throw new HttpError(400, 'Choose active or paused.');
    if (req.body.status === 'active' && company.membership?.status !== 'paid_demo') throw new HttpError(409, 'Complete the demo checkout to activate membership.');
    const updated = await mutate(records => { const item = records.companies.find(item => item.id === company.id); item.subscription = req.body.status; return item; });
    res.json({ company: updated });
  }));
  app.post('/api/marketplace/membership/demo-pay', route(async (req, res) => {
    const company = requirePartner(req); devOnly(req);
    if (req.body.confirm !== true) throw new HttpError(400, 'Confirm the simulated $100 CAD/month membership.');
    const updated = await mutate(records => {
      const item = records.companies.find(item => item.id === company.id);
      if (!active(item)) {
        const paidAt = new Date(); const periodEnd = new Date(paidAt);
        const day = periodEnd.getUTCDate(); periodEnd.setUTCDate(1); periodEnd.setUTCMonth(periodEnd.getUTCMonth() + 1);
        const lastDay = new Date(Date.UTC(periodEnd.getUTCFullYear(), periodEnd.getUTCMonth() + 1, 0)).getUTCDate(); periodEnd.setUTCDate(Math.min(day, lastDay));
        item.subscription = 'active';
        item.membership = { status: 'paid_demo', amount: 100, currency: 'CAD', interval: 'month', simulated: true, paidAt: paidAt.toISOString(), periodEnd: periodEnd.toISOString(), receiptId: `DEMO-${randomUUID().slice(0, 8).toUpperCase()}` };
        for (const report of records.reports) if (report.isSample && item.example && report.status === 'shared' && report.broadcastAt && !item.retired && withinRadius(report.demoLocation || demoLocations[0], item.demoLocation) && !report.selectedQuoteId && !report.recipientIds.includes(item.id)) report.recipientIds.push(item.id);
      }
      return item;
    }); await requestMatching(); res.json({ company: updated });
  }));
  app.get('/api/marketplace/reports', route(async (req, res) => {
    await queue;
    const company = req.query.role === 'partner' ? requirePartner(req) : null;
    if (company && !active(company)) throw new HttpError(403, 'Activate your $100 CAD/month demo membership to view customer screenings.');
    res.json(state.reports.filter(report => company ? report.recipientIds.includes(company.id) : owns(req, report)).map(report => view(state, report, company)));
  }));
  app.post('/api/marketplace/reports', route(async (req, res) => {
    const owner = auth.customerIdentity(req);
    const labels = req.body.areas ?? [req.body.area || 'Basement'];
    if (!Array.isArray(labels) || !labels.length || labels.length > 12) throw new HttpError(400, 'Choose between 1 and 12 project areas.');
    const areas = labels.map(label => text(label, 'an affected area', 80));
    if (new Set(areas.map(areaId)).size !== areas.length || areas.some(label => !areaId(label))) throw new HttpError(400, 'Each project area must be unique.');
    const area = areas.join(', ');
    const testPostal = postalCode(req.body.postalCode || demoLocations[0].postalCode);
    let testLocation = demoLocations.find(location => location.postalCode === testPostal);
    if (!testLocation) { const found = await directory.locate(testPostal); testLocation = { city: 'Ontario', postalCode: testPostal, ...found }; }
    const description = text(req.body.description || 'Dark spotting near the basement window after a small leak. Looking for an inspection and advice on next steps.', 'a description');
    const report = await mutate(records => {
      const autoShare = req.body.autoShare === true;
      const report = { id: `MLR-${randomUUID().slice(0, 8).toUpperCase()}`, customerOwnerHash: owner.hash, city: testLocation.city, postalCode: testPostal, demoLocation: { lat: testLocation.lat, lng: testLocation.lng }, demoUsername: records.demoCustomers?.[owner.hash]?.username || null, area, projectAreas: areas.map(label => ({ id: areaId(label), label, description: '', findings: [] })), description, createdAt: now(), isSample: true, status: autoShare ? 'shared' : 'draft', recipientIds: [], selectedQuoteId: null, broadcastAt: autoShare ? now() : null };
      if (autoShare) report.recipientIds = sampleRecipients(records, report);
      records.reports.unshift(report); return view(records, report);
    });
    owner.save(res); res.status(201).json(report);
  }));
  app.post('/api/marketplace/reports/:id/broadcast', route(async (req, res) => {
    if (req.body.consent !== true) throw new HttpError(400, 'Confirm that you want to share this report with local contractors.');
    const report = await mutate(records => {
      const report = findReport(records, req.params.id); access(req, report, null);
      if (report.status !== 'draft') return view(records, report);
      report.recipientIds = report.isSample ? sampleRecipients(records, { ...report, demoLocation: report.demoLocation || demoLocations[0] }) : [];
      if (!report.recipientIds.length) throw new HttpError(409, 'No subscribed contractors are available in this area yet.');
      report.status = 'shared'; report.broadcastAt = now();
      return view(records, report);
    }); res.json(report);
  }));
  app.post('/api/marketplace/reports/:id/response', route(async (req, res) => {
    const company = requireMember(req);
    const action = req.body.action;
    if (!['decline', 'reopen', 'archive', 'remove', 'restore'].includes(action)) throw new HttpError(400, 'Choose a valid screening action.');
    res.json(await mutate(records => {
      const report = findReport(records, req.params.id); access(req, report, company);
      const quote = records.quotes.find(item => item.reportId === report.id && item.companyId === company.id);
      if (action === 'decline' && (quote?.id === report.selectedQuoteId || report.preliminarySelection && report.preliminarySelection.quoteId === quote?.id && report.preliminarySelection.revision === quote?.revision)) throw new HttpError(409, 'A selected proposal cannot be withdrawn. Contact the customer in messages.');
      const response = (report.contractorResponses ||= {})[company.id] ||= {};
      if (action === 'decline') {
        response.declinedAt = now();
        if (quote) { quote.withdrawnAt = now(); quote.updatedAt = now(); }
      }
      if (action === 'reopen') response.declinedAt = null;
      if (['archive', 'remove', 'restore'].includes(action)) {
        response.archivedAt = action === 'restore' ? null : now();
        if (action === 'restore' && quote) quote.contractorArchivedAt = null;
      }
      return view(records, report, company);
    }));
  }));
  app.post('/api/marketplace/reports/:id/quotes/:quoteId/action', route(async (req, res) => {
    const company = req.body.role === 'partner' ? requireMember(req) : null;
    const action = req.body.action;
    if (!['decline', 'undo-decline', 'archive', 'restore'].includes(action) || company && ['decline', 'undo-decline'].includes(action)) throw new HttpError(400, 'Choose a valid quote action.');
    res.json(await mutate(records => {
      const report = findReport(records, req.params.id); access(req, report, company);
      const quote = records.quotes.find(item => item.id === req.params.quoteId && item.reportId === report.id && (!company || item.companyId === company.id));
      if (!quote) throw new HttpError(404, 'Quote not found.');
      if (action === 'decline') {
        if (report.selectedQuoteId === quote.id || report.preliminarySelection?.quoteId === quote.id && report.preliminarySelection?.revision === quote.revision) throw new HttpError(409, 'The selected proposal cannot be declined. Contact the contractor in messages.');
        if (quote.withdrawnAt) throw new HttpError(409, 'This quote was withdrawn.');
        quote.declinedAt = now();
      }
      if (action === 'undo-decline') quote.declinedAt = null;
      if (action === 'archive' || action === 'restore') {
        quote[company ? 'contractorArchivedAt' : 'customerArchivedAt'] = action === 'archive' ? now() : null;
        if (company) ((report.contractorResponses ||= {})[company.id] ||= {}).archivedAt = quote.contractorArchivedAt;
      }
      quote.updatedAt = now();
      return view(records, report, company);
    }));
  }));
  app.post('/api/marketplace/reports/:id/quote', route(async (req, res) => {
    const company = requirePartner(req);
    const report = await mutate(records => {
      const report = findReport(records, req.params.id); access(req, report, company);
      const currentCompany = records.companies.find(item => item.id === company.id);
      if (!active(currentCompany)) throw new HttpError(403, 'An active $100 CAD/month demo membership is required to send a quote.');
      if (report.selectedQuoteId) throw new HttpError(409, 'The customer has already chosen a quote.');
      if (report.contractorResponses?.[company.id]?.declinedAt) throw new HttpError(409, 'Reopen bidding before sending a quote.');
      const input = validateProposal(req.body, projectAreas(report).map(area => area.id));
      const coverage = projectCoverage(report, { ...req.body, amount: input.amount });
      let quote = records.quotes.find(item => item.reportId === report.id && item.companyId === company.id);
      if (req.body.expectedRevision !== undefined && req.body.expectedRevision !== (quote ? quote.revision || 1 : 0)) throw new HttpError(409, 'This proposal changed in another session. Refresh before revising it.');
      if (quote?.declinedAt) throw new HttpError(409, 'The customer declined this quote. They must undo the decline before you can update it.');
      if (quote) {
        if (report.preliminarySelection?.quoteId === quote.id && report.preliminarySelection?.revision === quote.revision && input.proposalKind === 'assessment') throw new HttpError(409, 'The assessment visit was requested. Send a follow-up estimate or confirmed work quote instead.');
        (quote.revisions ||= []).push(proposalSnapshot(quote));
        Object.assign(quote, input, coverage, { revision: (quote.revision || 1) + 1, withdrawnAt: null, contractorArchivedAt: null, updatedAt: now() });
      } else records.quotes.push({ id: randomUUID(), reference: `MLQ-${randomUUID().slice(0, 8).toUpperCase()}`, revision: 1, revisions: [], reportId: report.id, companyId: company.id, ...input, ...coverage, createdBy: 'contractor', simulated: company.example, createdAt: now(), updatedAt: now() });
      return view(records, report, company);
    }); res.status(201).json(report);
  }));
  app.post('/api/marketplace/reports/:id/sample-quotes', route((req, _res) => {
    devOnly(req); throw new HttpError(410, 'Automatic sample quotes are disabled. Contractors must send their own proposal.');
  }));
  app.post('/api/marketplace/reports/:id/choose', route(async (req, res) => {
    res.json(await mutate(records => {
      const report = findReport(records, req.params.id); access(req, report, null);
      const quote = records.quotes.find(item => item.id === req.body.quoteId && item.reportId === report.id);
      if (!quote) throw new HttpError(404, 'Quote not found.');
      if (!records.customerContacts?.[report.customerOwnerHash]) throw new HttpError(400, 'Add your email and phone number before choosing a contractor.');
      if (req.body.revision !== undefined && req.body.revision !== (quote.revision || 1)) throw new HttpError(409, 'This proposal changed. Review the latest price and scope before choosing it.');
      if (!report.selectedQuoteId && !quote.proposalVersion) throw new HttpError(409, 'Ask the contractor for an updated itemized proposal.');
      if (!report.selectedQuoteId && proposalExpired(quote)) throw new HttpError(409, 'This proposal expired. Ask the contractor for an updated proposal.');
      if (!report.selectedQuoteId && (quote.declinedAt || quote.withdrawnAt || quote.customerArchivedAt)) throw new HttpError(409, 'Only an available, unarchived quote can be chosen.');
      if (!report.selectedQuoteId && !coversProject(report, quote)) throw new HttpError(409, 'Ask the contractor for an updated quote covering the entire project.');
      if (report.selectedQuoteId && report.selectedQuoteId !== quote.id) throw new HttpError(409, 'You have already chosen a contractor for this report.');
      if (quote.proposalKind !== 'fixed_quote' && !report.selectedQuoteId) {
        report.preliminarySelection = { quoteId: quote.id, companyId: quote.companyId, revision: quote.revision, selectedAt: now(), proposal: proposalSnapshot(quote) };
        return view(records, report);
      }
      report.selectedQuoteId = quote.id; report.status = 'chosen';
      return view(records, report);
    }));
  }));
  app.post('/api/marketplace/reports/:id/messages', route(async (req, res) => {
    const company = req.body.role === 'partner' ? requireMember(req) : null;
    const body = text(req.body.text, 'a message', 2000);
    res.status(201).json(await mutate(records => {
      const report = findReport(records, req.params.id); access(req, report, company);
      const companyId = company?.id || req.body.companyId;
      if (!report.recipientIds.includes(companyId)) throw new HttpError(404, 'Conversation not found.');
      records.messages.push({ id: randomUUID(), reportId: report.id, companyId, sender: company ? 'partner' : 'customer', text: body, createdAt: now() });
      return view(records, report, company);
    }));
  }));
  const lookupCooldown = new Map();
  async function locateSafely(code) {
    if (!code || !directory.configured || (lookupCooldown.get(code) || 0) > Date.now()) return null;
    try { return await directory.locate(code); }
    catch { lookupCooldown.set(code, Date.now() + 60000); return null; }
  }
  async function matchReport(id) {
    await queue;
    const report = state.reports.find(r => r.id === id);
    if (!report || report.isSample || report.status !== 'shared' || report.selectedQuoteId) return;
    const demoPoint = report.demoProject && demoLocations.find(location => location.postalCode === report.postalCode);
    const centre = demoPoint || await locateSafely(report.postalCode);
    const candidates = [];
    let unresolved = false;
    if (centre) for (const company of state.companies.filter(c => active(c) && !c.retired && (report.demoProject ? c.example : !c.example) && c.postalCode)) {
      const location = report.demoProject ? company.demoLocation : await locateSafely(company.postalCode);
      if (!location) unresolved = true;
      if (withinRadius(centre, location)) candidates.push(company.id);
    }
    const matchStatus = !centre || unresolved ? 'pending_location' : candidates.length ? 'matched' : 'no_contractors';
    const needsInvitation = candidates.some(id => state.companies.find(c => c.id === id)?.notificationsEnabled && state.accounts.some(a => a.companyId === id) && !(state.emailOutbox || []).some(e => e.reportId === report.id && e.companyId === id));
    if (report.matchStatus === matchStatus && candidates.every(id => report.recipientIds.includes(id)) && !needsInvitation) return;
    await mutate(records => {
      const current = records.reports.find(r => r.id === id);
      if (!current || current.status !== 'shared' || current.selectedQuoteId) return;
      // Preserve prior access/quotes, but only deliver new invitations to currently eligible companies.
      for (const companyId of candidates) {
        const company = records.companies.find(c => c.id === companyId);
        if (active(company) && !current.recipientIds.includes(companyId)) current.recipientIds.push(companyId);
      }
      current.matchStatus = matchStatus;
      if (candidates.length) current.broadcastAt ||= now();
      enqueueInvitations(records, { ...current, recipientIds: candidates });
    });
  }
  let processing;
  async function reconcile() {
    if (processing) return processing;
    processing = (async () => {
      await queue;
      for (const report of state.reports.filter(r => !r.isSample && r.status === 'shared' && !r.selectedQuoteId)) await matchReport(report.id);
      await queue;
      for (const item of state.emailOutbox || []) {
        if (!['pending', 'waiting_setup'].includes(item.status) || Date.parse(item.nextAttemptAt) > Date.now()) continue;
        if (!sender.ready) {
          if (item.status !== 'waiting_setup') await mutate(records => { const entry = records.emailOutbox.find(e => e.id === item.id); entry.status = 'waiting_setup'; entry.error = 'email_configuration_required'; });
          continue;
        }
        const report = state.reports.find(r => r.id === item.reportId);
        const company = state.companies.find(c => c.id === item.companyId);
        const account = state.accounts.find(a => a.companyId === item.companyId);
        if (!report || !active(company) || !company.notificationsEnabled || report.selectedQuoteId || report.status !== 'shared') continue;
        // Recheck both positions before sending queued mail (including after a profile move).
        if (!withinRadius(await locateSafely(report.postalCode), await locateSafely(company.postalCode))) continue;
        if (item.firstAttemptAt && Date.now() - Date.parse(item.firstAttemptAt) >= 23 * 60 * 60 * 1000) {
          await mutate(records => { const entry = records.emailOutbox.find(e => e.id === item.id); entry.status = 'needs_review'; entry.error = 'delivery_window_elapsed'; }); continue;
        }
        await mutate(records => { const entry = records.emailOutbox.find(e => e.id === item.id); entry.attempts++; entry.firstAttemptAt ||= now(); entry.to = account.email; entry.content ||= sender.prepare({ ...entry, to: account.email }, report); });
        try {
          const stored = state.emailOutbox.find(e => e.id === item.id);
          const outcome = await sender.send(stored, report);
          await mutate(records => Object.assign(records.emailOutbox.find(e => e.id === item.id), outcome, { error: null }));
        } catch (error) {
          await mutate(records => {
            const entry = records.emailOutbox.find(e => e.id === item.id);
            entry.error = ['email_configuration_required', 'email_provider_rejected'].includes(error.message) ? error.message : 'email_delivery_retry';
            entry.status = entry.attempts >= 8 || entry.error === 'email_provider_rejected' ? 'needs_review' : 'pending';
            entry.nextAttemptAt = new Date(Date.now() + Math.min(3600000, 60000 * 2 ** (entry.attempts - 1))).toISOString();
          });
        }
      }
    })().finally(() => { processing = null; });
    return processing;
  }
  const rates = new Map();
  const limited = req => {
    const time = Date.now(); const previous = rates.get(req.ip) || [];
    const recent = previous.filter(t => t > time - 60000);
    if (recent.length >= 4) throw new HttpError(429, 'Please wait a minute before searching again.');
    if (rates.size > 5000) rates.clear();
    rates.set(req.ip, [...recent, time]);
  };
  app.get('/api/marketplace/directory/status', route((_req, res) => res.json({ configured: directory.googleConfigured, radiusKm: 50, emailMode: sender.mode, emailReady: sender.ready })));
  app.get('/api/marketplace/directory', route(async (req, res) => { limited(req); res.setHeader('Cache-Control', 'no-store'); res.json(await directory.search(req.query.postalCode)); }));
  app.get('/api/marketplace/directory/:id/reviews', route(async (req, res) => { limited(req); res.setHeader('Cache-Control', 'no-store'); res.json(await directory.reviews(req.params.id)); }));
  app.post('/api/marketplace/company-profile', route(async (req, res) => {
    const company = requirePartner(req);
    if (company.example) throw new HttpError(400, 'Create a company account to configure real screening invitations.');
    const code = postalCode(req.body.postalCode);
    if (typeof req.body.notificationsEnabled !== 'boolean') throw new HttpError(400, 'Choose an email invitation preference.');
    const googlePlaceId = req.body.googlePlaceId === undefined ? company.googlePlaceId || null : req.body.googlePlaceId;
    if (googlePlaceId !== null && (typeof googlePlaceId !== 'string' || !await directory.known(googlePlaceId))) throw new HttpError(400, 'Choose your business from the Google directory first.');
    const updated = await mutate(records => { const current = records.companies.find(c => c.id === company.id); current.googlePlaceId = googlePlaceId; current.postalCode = code; current.notificationsEnabled = req.body.notificationsEnabled; return current; });
    await requestMatching(); res.json({ company: updated });
  }));
  app.get('/api/marketplace/invitations', route(async (req, res) => {
    const company = requirePartner(req); await queue;
    res.json({ mode: sender.mode, ready: sender.ready, invitations: (state.emailOutbox || []).filter(e => e.companyId === company.id).map(e => ({ id: e.id, reportId: e.reportId, status: e.status, to: e.to, createdAt: e.createdAt, sentAt: e.sentAt, error: e.error, ...(e.status === 'preview' ? { preview: e.content || invitationContent(e, state.reports.find(r => r.id === e.reportId), emailOptions) } : {}) })) });
  }));
  async function syncScreening(input) {
    // Only trusted screening callbacks can publish a real project.
    if (!input.customerOwnerHash || !input.sharingAllowed) return;
    await queue;
    const ready = input.reportAvailable && ['ready_preview', 'inconclusive'].includes(input.status);
    const snapshot = { screening: { id: input.id, reference: input.reference, status: input.status, reportAvailable: Boolean(input.reportAvailable) }, area: input.area, projectAreas: input.projectAreas || projectAreas({ area: input.area }), description: input.description, summary: input.summary || '', summaryPoints: input.summaryPoints || [], recommendations: input.recommendations || [], findings: input.findings || [], city: 'Ontario', postalCode: input.postalCode || '', demoProject: Boolean(state.demoCustomers?.[input.customerOwnerHash]), demoUsername: state.demoCustomers?.[input.customerOwnerHash]?.username || null };
    const id = `SCREEN-${input.id}`;
    const current = state.reports.find(report => report.id === id);
    const changed = !current || Object.entries(snapshot).some(([key, value]) => JSON.stringify(current[key]) !== JSON.stringify(value)) || ready && current.status === 'processing';
    if (changed) await mutate(records => {
      let report = records.reports.find(report => report.id === id);
      if (!report) { report = { id, customerOwnerHash: input.customerOwnerHash, createdAt: input.createdAt || now(), isSample: false, status: 'processing', recipientIds: [], selectedQuoteId: null, broadcastAt: null }; records.reports.unshift(report); }
      Object.assign(report, snapshot);
      if (ready && report.status === 'processing') { report.status = 'shared'; report.matchStatus = 'pending_location'; }
      return report.id;
    });
    if (ready && changed) await requestMatching();
    return id;
  }
  let timer;
  function requestMatching() {
    if (!timer) return reconcile();
    // Keep provider lookups and email latency out of screening/API responses.
    void reconcile().catch(() => console.error('Contractor matching retry required.'));
  }
  return { filename, syncScreening, runJobs: reconcile,
    start() { if (!timer) { timer = setInterval(() => { void reconcile().catch(() => console.error('Contractor matching retry required.')); }, 30000); timer.unref(); void reconcile().catch(() => {}); } },
    async stop() { clearInterval(timer); timer = null; await processing; await queue; await directory.close(); }
  };
}
