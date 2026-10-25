import { randomBytes, randomUUID, createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from './validation.mjs';
import { validateProposal, proposalExpired } from './project-proposals.mjs';

export const exampleCompanies = [
  { id: 'moldtech', name: 'MoldTech', initials: 'MT', city: 'Newmarket', services: ['Mold inspection', 'Mold removal'], phone: '1-866-684-7684', website: 'https://www.moldtech.ca/newmarket', sourceUrl: 'https://www.moldtech.ca/contact', description: 'Mold testing and remediation serving Newmarket, based in nearby East Gwillimbury.' },
  { id: 'aro', name: 'ARO Restoration', initials: 'AR', city: 'Newmarket', services: ['Mold removal', 'Water damage'], phone: '416-938-4552', website: 'https://www.arorestorations.ca/service-areas/newmarket', sourceUrl: 'https://www.arorestorations.ca/service-areas/newmarket', description: 'Water, fire and mold restoration with a published Newmarket service area.' },
  { id: 'desa', name: 'Desa Contracting & Restoration', initials: 'DR', city: 'Newmarket', services: ['Mold removal', 'Water damage'], phone: '905-940-8994', website: 'https://desacontracting.com/areas-served/newmarket-on/', sourceUrl: 'https://desacontracting.com/areas-served/newmarket-on/', description: 'Restoration company serving Newmarket and the GTA, based in Markham.' },
].map(company => ({ ...company, example: true, subscription: 'pending', trialEndsAt: null, membership: { status: 'pending', amount: 100, currency: 'CAD', interval: 'month', simulated: true } }));

const digest = value => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const text = (value, label, max = 2000) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new HttpError(400, `Enter ${label} (up to ${max} characters).`);
  return value.trim();
};
const active = company => company.subscription === 'active' && company.membership?.status === 'paid_demo' && Date.parse(company.membership.periodEnd) > Date.now();
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

export async function registerMarketplace(app, { dataDirectory, auth, ownsScreening = () => false }) {
  app.use('/api/marketplace', (req, _res, next) => {
    if (req.method === 'POST' && (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))) return next(new HttpError(400, 'Please provide a JSON object.'));
    next();
  });
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
  const sessions = new Map();
  const attempts = new Map();
  const cookie = 'moldlens_partner';
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
    return { ...safe, preliminarySelection: canSeeSelection && !contactRequired ? preliminarySelection || null : null, contactRequired, customerContact: !company || chosenCompany === company.id || preliminarySelection?.companyId === company.id ? contact : null, quoteCount: quotes.filter(quote => !quote.declinedAt && !quote.withdrawnAt && !quote.archivedAt && !proposalExpired(quote)).length, response: company ? contractorResponses?.[company.id] || {} : undefined, projectAreas: projectAreas(report), quotes: contactRequired ? [] : quotes, messages: records.messages.filter(item => item.reportId === report.id && (!company || item.companyId === company.id)), recipients: report.recipientIds.map(id => records.companies.find(item => item.id === id)).filter(Boolean) };
  };
  const devOnly = req => {
    if (process.env.NODE_ENV === 'production' || !['127.0.0.1', 'localhost', '[::1]'].includes(req.hostname)) throw new HttpError(404, 'Testing tools are only available locally.');
  };
  app.get('/api/marketplace/companies', route(async (_req, res) => { await queue; res.json(state.companies.map(company => ({ ...company, membership: { status: company.membership.status, amount: 100, currency: 'CAD', interval: 'month', simulated: true } }))); }));
  app.get('/api/marketplace/session', route(async (req, res) => { await queue; res.json({ company: partner(req), demoAvailable: process.env.NODE_ENV !== 'production' }); }));
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
    const contact = await mutate(records => { const contact = { email, phone }; (records.customerContacts ||= {})[owner.hash] = contact; return contact; });
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
    const company = state.companies.find(item => item.id === req.body.companyId && item.example);
    if (!company) throw new HttpError(400, 'Choose an example company.');
    res.json({ company: startSession(req, res, company.id) });
  }));
  app.post('/api/marketplace/register', route(async (req, res) => {
    const name = text(req.body.name, 'your company name', 100);
    const email = text(req.body.email, 'an email address', 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter a valid email address.');
    const password = text(req.body.password, 'a password', 128);
    if (password.length < 12) throw new HttpError(400, 'Use a password with at least 12 characters.');
    const salt = randomBytes(16).toString('hex');
    const passwordHash = scryptSync(password, salt, 64).toString('hex');
    const company = await mutate(records => {
      if (records.accounts.some(account => account.email === email)) throw new HttpError(409, 'This email already has an account. Sign in instead.');
      const company = { id: randomUUID(), name, initials: name.split(/\s+/).map(word => word[0]).join('').slice(0, 2).toUpperCase(), city: 'Newmarket', services: ['Mold removal'], phone: '', website: '', sourceUrl: '', description: 'Independent contractor serving Newmarket.', example: false, subscription: 'pending', trialEndsAt: null, membership: { status: 'pending', amount: 100, currency: 'CAD', interval: 'month', simulated: true } };
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
        for (const report of records.reports) if (report.status === 'shared' && report.broadcastAt && report.city === item.city && !report.selectedQuoteId && !report.recipientIds.includes(item.id)) report.recipientIds.push(item.id);
      }
      return item;
    }); res.json({ company: updated });
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
    const description = text(req.body.description || 'Dark spotting near the basement window after a small leak. Looking for an inspection and advice on next steps.', 'a description');
    const report = await mutate(records => {
      const autoShare = req.body.autoShare === true;
      const report = { id: `MLR-${randomUUID().slice(0, 8).toUpperCase()}`, customerOwnerHash: owner.hash, city: 'Newmarket', area, projectAreas: areas.map(label => ({ id: areaId(label), label, description: '', findings: [] })), description, createdAt: now(), isSample: true, status: autoShare ? 'shared' : 'draft', recipientIds: autoShare ? records.companies.filter(company => active(company) && company.city === 'Newmarket').map(company => company.id) : [], selectedQuoteId: null, broadcastAt: autoShare ? now() : null };
      records.reports.unshift(report); return view(records, report);
    });
    owner.save(res); res.status(201).json(report);
  }));
  app.post('/api/marketplace/reports/:id/broadcast', route(async (req, res) => {
    if (req.body.consent !== true) throw new HttpError(400, 'Confirm that you want to share this report with local contractors.');
    const report = await mutate(records => {
      const report = findReport(records, req.params.id); access(req, report, null);
      if (report.status !== 'draft') return view(records, report);
      report.recipientIds = records.companies.filter(company => active(company) && company.city.toLowerCase() === report.city.toLowerCase()).map(company => company.id);
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
      } else records.quotes.push({ id: randomUUID(), reference: `MLQ-${randomUUID().slice(0, 8).toUpperCase()}`, revision: 1, revisions: [], reportId: report.id, companyId: company.id, ...input, ...coverage, simulated: company.example, createdAt: now(), updatedAt: now() });
      return view(records, report, company);
    }); res.status(201).json(report);
  }));
  app.post('/api/marketplace/reports/:id/sample-quotes', route(async (req, res) => {
    devOnly(req);
    res.json(await mutate(records => {
      const report = findReport(records, req.params.id); access(req, report, null);
      if (report.status === 'draft') throw new HttpError(409, 'Share your report before adding sample quotes.');
      if (report.selectedQuoteId) throw new HttpError(409, 'A quote has already been chosen.');
      report.recipientIds.forEach((companyId, index) => {
        const company = records.companies.find(item => item.id === companyId);
        if (!company?.example || !active(company) || report.contractorResponses?.[companyId]?.declinedAt || records.quotes.some(item => item.reportId === report.id && item.companyId === companyId)) return;
        const areaIds = projectAreas(report).map(area => area.id);
        const validUntil = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
        const amount = [295, 350, 425][index % 3] * areaIds.length;
        const proposal = validateProposal({ proposalKind: 'estimate', assessmentBasis: 'screening', assessmentNotes: 'Example only: based on the submitted screening; extent and access remain unverified.', scope: `Review all ${areaIds.length} project areas, inspect moisture conditions and provide a written plan.`, moisturePlan: 'Locate the source during the visit; correction work will be quoted separately.', exclusions: 'Remediation, reconstruction, hidden damage and laboratory testing are not included.', clearancePlan: 'Determine whether independent post-remediation clearance is needed after assessment.', availability: ['Next business day', 'Within 2 business days', 'This week'][index % 3], duration: 'One assessment visit', validUntil, paymentTerms: 'Example: confirm service and payment arrangements before booking.', depositAmount: 0, taxMode: 'none', lineItems: [{ description: 'Whole-project assessment and written plan', category: 'assessment', unit: 'job', quantity: 1, unitPrice: amount, areaIds }] }, areaIds);
        records.quotes.push({ id: randomUUID(), reference: `MLQ-${randomUUID().slice(0, 8).toUpperCase()}`, revision: 1, revisions: [], reportId: report.id, companyId, quoteType: 'project', coveredAreaIds: areaIds, breakdown: [], ...proposal, simulated: true, createdAt: now(), updatedAt: now() });
      }); return view(records, report);
    }));
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
  async function syncScreening(input) {
    // This is a trusted server callback. No client-provided owner or screening ID is accepted.
    if (!input.customerOwnerHash || !input.sharingAllowed) return;
    await queue;
    const ready = input.reportAvailable && ['ready_preview', 'inconclusive'].includes(input.status);
    const snapshot = { screening: { id: input.id, reference: input.reference, status: input.status, reportAvailable: Boolean(input.reportAvailable) }, area: input.area, projectAreas: input.projectAreas || projectAreas({ area: input.area }), description: input.description, summary: input.summary || '', summaryPoints: input.summaryPoints || [], recommendations: input.recommendations || [], findings: input.findings || [], city: input.city };
    const id = `SCREEN-${input.id}`;
    const current = state.reports.find(report => report.id === id);
    if (current && Object.entries(snapshot).every(([key, value]) => JSON.stringify(current[key]) === JSON.stringify(value)) && (!ready || current.broadcastAt || !state.companies.some(company => active(company) && company.city === input.city))) return;
    return mutate(records => {
      let report = records.reports.find(report => report.id === id);
      if (!report) {
        report = { id, customerOwnerHash: input.customerOwnerHash, createdAt: input.createdAt || now(), isSample: false, status: 'processing', recipientIds: [], selectedQuoteId: null, broadcastAt: null };
        records.reports.unshift(report);
      }
      Object.assign(report, snapshot);
      if (ready && !report.broadcastAt) {
        report.recipientIds = records.companies.filter(company => active(company) && company.city === input.city).map(company => company.id);
        report.status = 'shared';
        if (report.recipientIds.length) report.broadcastAt = now();
      }
      return report.id;
    });
  }
  return { filename, syncScreening };
}
