import { createHash } from 'node:crypto';

export function enqueueInvitations(records, report) {
  if (report.isSample || report.demoProject || report.status !== 'shared' || !report.broadcastAt) return;
  const outbox = records.emailOutbox ||= [];
  for (const companyId of report.recipientIds) {
    const company = records.companies.find(c => c.id === companyId);
    const account = records.accounts.find(a => a.companyId === companyId);
    if (!account?.email || !company?.notificationsEnabled || company.example) continue;
    const id = createHash('sha256').update(`screening-ready:${report.id}:${companyId}`).digest('hex');
    if (!outbox.some(item => item.id === id)) outbox.push({ id, companyId, reportId: report.id, to: account.email, status: 'pending', attempts: 0, createdAt: new Date().toISOString(), nextAttemptAt: new Date().toISOString() });
  }
}
export function invitationContent(item, report, { appUrl = process.env.MOLDLENS_PUBLIC_URL || 'http://127.0.0.1:5173' } = {}) {
  const url = new URL(appUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid_public_url');
  url.hash = `partner?id=${encodeURIComponent(report.id)}`;
  const count = report.projectAreas?.length || 1;
  return { to: [item.to], subject: 'MoldLens: a nearby project is ready for your quote', text: `A completed screening within 50 km of your company postal code is ready.\n\nProject: ${report.screening?.reference || report.id}\nAreas to review: ${count}\n\nSign in to review the full screening and send one quote for the entire project:\n${url.href}\n\nThis is a quote invitation, not a confirmed job. Customer contact details are shared when the customer requests a follow-up or chooses your quote.\n\nManage screening emails in your contractor workspace settings.` };
}
export function createInvitationSender({ mode = process.env.MOLDLENS_EMAIL_MODE || 'preview', apiKey = process.env.RESEND_API_KEY, from = process.env.MOLDLENS_EMAIL_FROM, appUrl = process.env.MOLDLENS_PUBLIC_URL, fetcher = fetch } = {}) {
  let ready = mode === 'preview';
  try { ready ||= mode === 'live' && Boolean(apiKey && from && appUrl && new URL(appUrl).protocol === 'https:'); } catch {}
  return { mode, ready, prepare: (item, report) => invitationContent(item, report, { appUrl }), async send(item, report) {
    const content = item.content || invitationContent(item, report, { appUrl });
    if (mode === 'preview') return { status: 'preview', preview: content };
    if (!ready) throw new Error('email_configuration_required');
    const response = await fetcher('https://api.resend.com/emails', { method: 'POST', signal: AbortSignal.timeout(15000), headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': `moldlens-${item.id}` }, body: JSON.stringify({ from, ...content }) });
    if (!response.ok) {
      // Provider idempotency lasts 24 h; never blindly retry an ambiguous request past that window.
      throw new Error(response.status === 429 || response.status >= 500 ? 'email_provider_retry' : 'email_provider_rejected');
    }
    const data = await response.json();
    if (!data.id) throw new Error('email_provider_retry');
    return { status: 'sent', providerId: data.id, sentAt: new Date().toISOString() };
  } };
}
