export interface Company {
  id: string; name: string; initials: string; city: string; postalCode?: string; googlePlaceId?: string | null; notificationsEnabled?: boolean; notificationEmail?: string | null; services: string[]; phone: string;
  website: string; sourceUrl: string; description: string; example: boolean;
  subscription: 'pending' | 'active' | 'paused'; trialEndsAt: string | null;
  membership: { status: 'pending' | 'paid_demo'; amount: number; currency: string; interval: 'month'; simulated: boolean; paidAt?: string; periodEnd?: string; receiptId?: string };
}
export interface ProposalLine { description: string; category: string; unit: string; quantity: number; unitPrice: number; areaIds: string[]; total?: number; }
export interface ProposalFields {
  proposalKind: 'assessment' | 'estimate' | 'fixed_quote'; assessmentBasis: 'screening' | 'virtual' | 'site_visit'; assessedOn?: string | null;
  assessmentNotes: string; scope: string; moisturePlan: string; exclusions: string; clearancePlan: string; warranty?: string;
  availability: string; duration: string; validUntil: string; paymentTerms: string; depositAmount: number;
  taxMode: 'none' | 'hst13' | 'included_hst13'; lineItems: ProposalLine[];
}
export interface Quote extends Partial<ProposalFields> {
  id: string; reportId: string; companyId: string; amount: number; scope: string;
  availability: string; taxIncluded: boolean; simulated: boolean; createdAt: string; updatedAt: string;
  quoteType?: 'project'; coveredAreaIds?: string[]; breakdown?: { areaId: string; amount: number }[];
  declinedAt?: string | null; withdrawnAt?: string | null; archivedAt?: string | null;
  proposalVersion?: number; reference?: string; revision?: number; revisions?: Quote[];
  lineItemsTotal?: number; subtotal?: number; taxAmount?: number;
}
export interface ProjectArea { id: string; label: string; description: string; findings: string[]; }
export interface CustomerContact { email: string; phone: string; }
export interface RemovedScreening { key: string; removedAt: string; }
export type ProjectQuoteInput = ProposalFields & { amount: number; coveredAreaIds: string[]; breakdown?: { areaId: string; amount: number }[]; expectedRevision?: number };
export interface Message { id: string; reportId: string; companyId: string; sender: 'customer' | 'partner'; text: string; createdAt: string; }
export interface MarketReport {
  id: string; city: string; demoUsername?: string | null; demoProject?: boolean; postalCode?: string; matchStatus?: 'pending_location' | 'matched' | 'no_contractors'; area: string; description: string; createdAt: string; isSample: boolean;
  status: 'draft' | 'processing' | 'shared' | 'chosen'; recipientIds: string[]; selectedQuoteId: string | null;
  screening?: { id: string; reference: string; status: string; reportAvailable: boolean };
  summary?: string; findings?: string[]; projectAreas?: ProjectArea[]; summaryPoints?: string[]; recommendations?: string[];
  broadcastAt: string | null; recipients: Company[]; quotes: Quote[]; messages: Message[];
  demoMatches?: { companyId: string; name: string; city: string; distanceKm: number; inRange: boolean; received: boolean }[];
  response?: { declinedAt?: string | null; archivedAt?: string | null };
  contactRequired?: boolean; customerContact?: CustomerContact | null; quoteCount?: number;
  preliminarySelection?: { quoteId: string; companyId: string; revision: number; selectedAt: string; proposal: Quote } | null;
}
async function request<T>(path: string, body?: object): Promise<T> {
  const response = await fetch(`/api/marketplace${path}`, {
    credentials: 'same-origin', cache: 'no-store',
    ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || data === null) throw new Error(data?.error || 'Could not connect. Check your connection and try again.');
  return data;
}
export interface CustomerDemo { customer: { username: string; email: string | null } | null; locations: { city: string; postalCode: string }[]; }
export const marketplace = {
  exitCustomerDemo: () => request<CustomerDemo>('/demo-customer/exit', {}),
  customerDemo: () => request<CustomerDemo>('/demo-customer'),
  startCustomerDemo: () => request<CustomerDemo>('/demo-customer/start', {}),
  continueCustomerDemo: (email: string) => request<CustomerDemo>('/demo-customer/continue', { email }),
  nameCustomerDemo: (username: string) => request<CustomerDemo>('/demo-customer/name', { username }),
  companies: () => request<Company[]>('/companies'),
  session: () => request<{ company: Company | null; demoAvailable: boolean }>('/session'),
  signIn: (email: string, password: string) => request<{ company: Company }>('/login', { email, password }),
  register: (name: string, email: string, password: string, postalCode: string) => request<{ company: Company }>('/register', { name, email, password, postalCode, notificationsEnabled: true }),
  companyProfile: (postalCode: string, notificationsEnabled: boolean, googlePlaceId?: string | null) => request<{ company: Company }>('/company-profile', { postalCode, notificationsEnabled, googlePlaceId }),
  invitations: () => request<{ mode: string; ready: boolean; invitations: Invitation[] }>('/invitations'),
  directoryStatus: () => request<{ configured: boolean; radiusKm: number; emailMode: string }>('/directory/status'),
  directory: (postalCode: string) => request<DirectoryResult>(`/directory?postalCode=${encodeURIComponent(postalCode)}`),
  reviews: (placeId: string) => request<GoogleReviews>(`/directory/${encodeURIComponent(placeId)}/reviews`),
  demo: (companyId: string) => request<{ company: Company }>('/demo-login', { companyId }),
  signOut: () => request('/logout', {}),
  subscription: (status: Company['subscription']) => request<{ company: Company }>('/subscription', { status }),
  demoPayment: () => request<{ company: Company }>('/membership/demo-pay', { confirm: true }),
  reports: (partner = false) => request<MarketReport[]>(`/reports${partner ? '?role=partner' : ''}`),
  saveContact: (values: CustomerContact) => request<CustomerContact>('/customer-contact', values),
  removedScreenings: () => request<RemovedScreening[]>('/removed-screenings'),
  removeScreening: (key: string, removed: boolean) => request<RemovedScreening[]>(`/screenings/${encodeURIComponent(key)}/removal`, { removed }),
  sampleReport: (area: string | string[], description: string, postalCode?: string) => request<MarketReport>('/reports', { areas: Array.isArray(area) ? area : [area], description, postalCode, autoShare: true }),
  broadcast: (id: string) => request<MarketReport>(`/reports/${id}/broadcast`, { consent: true }),
  quote: (id: string, values: ProjectQuoteInput) => request<MarketReport>(`/reports/${id}/quote`, values),
  samples: (id: string) => request<MarketReport>(`/reports/${id}/sample-quotes`, {}),
  choose: (id: string, quoteId: string, revision?: number) => request<MarketReport>(`/reports/${id}/choose`, { quoteId, revision }),
  respond: (id: string, action: 'decline' | 'reopen' | 'archive' | 'remove' | 'restore') => request<MarketReport>(`/reports/${id}/response`, { action }),
  quoteAction: (id: string, quoteId: string, action: 'decline' | 'undo-decline' | 'archive' | 'restore', partner = false) => request<MarketReport>(`/reports/${id}/quotes/${quoteId}/action`, { action, role: partner ? 'partner' : 'customer' }),
  message: (id: string, companyId: string, text: string, partner = false) => request<MarketReport>(`/reports/${id}/messages`, { companyId, text, role: partner ? 'partner' : 'customer' }),
};
export const cad = (value: number) => new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 2, minimumFractionDigits: 0 }).format(value);
export const proposalExpired = (quote: Quote) => Boolean(quote.validUntil && `${quote.validUntil}T23:59:59.999Z` < new Date().toISOString());
export const quoteAvailable = (quote: Quote) => !quote.declinedAt && !quote.withdrawnAt && !proposalExpired(quote);
export const memberActive = (company: Company) => company.subscription === 'active' && company.membership?.status === 'paid_demo' && Date.parse(company.membership.periodEnd || '') > Date.now();
export const proposalLabel = (quote: Pick<Quote, 'proposalKind'>) => quote.proposalKind === 'assessment' ? 'Assessment visit' : quote.proposalKind === 'estimate' ? 'Preliminary estimate' : quote.proposalKind === 'fixed_quote' ? 'Confirmed quote' : 'Previous quote';
export function proposalTotals(lines: ProposalLine[], taxMode: ProposalFields['taxMode']) {
  const lineCents = lines.reduce((sum, item) => sum + Math.round(Math.round(item.unitPrice * 100) * item.quantity), 0);
  const taxCents = taxMode === 'hst13' ? Math.round(lineCents * .13) : taxMode === 'included_hst13' ? Math.round(lineCents * 13 / 113) : 0;
  return { lineItemsTotal: lineCents / 100, subtotal: (taxMode === 'included_hst13' ? lineCents - taxCents : lineCents) / 100, taxAmount: taxCents / 100, amount: (taxMode === 'hst13' ? lineCents + taxCents : lineCents) / 100 };
}
export const quoteCountOf = (report: MarketReport) => report.contactRequired ? report.quoteCount || 0 : report.quotes.filter(quote => quoteAvailable(quote) && !quote.archivedAt).length;
export const areasOf = (report: MarketReport): ProjectArea[] => report.projectAreas?.length ? report.projectAreas : (report.area || 'Property').split(',').map(label => ({ id: label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-'), label: label.trim(), description: '', findings: [] }));
export const projectTitle = (report: MarketReport) => areasOf(report).length > 1 ? `${areasOf(report).length}-area project` : `${areasOf(report)[0].label} project`;
export const coversProject = (report: MarketReport, quote: Quote) => quote.coveredAreaIds ? quote.coveredAreaIds.length === areasOf(report).length && new Set(quote.coveredAreaIds).size === areasOf(report).length && areasOf(report).every(area => quote.coveredAreaIds!.includes(area.id)) : areasOf(report).length === 1;

export interface Invitation { id: string; reportId: string; to: string; status: string; createdAt: string; error?: string; preview?: { subject: string; text: string }; }
export interface DirectoryResult { postalCode: string; radiusKm: number; truncated: boolean; fetchedAt: string; contractors: { placeId: string; name: string; address: string; rating: number | null; reviewCount: number; mapsUrl?: string; distanceKm: number; attributions: { provider: string; uri: string }[] }[]; }
export interface GoogleReviews { rating?: number; userRatingCount?: number; attributions?: { provider: string; uri: string }[]; googleMapsUri?: string; reviews?: { rating: number; relativePublishTimeDescription?: string; text?: { text: string }; googleMapsUri?: string; authorAttribution?: { displayName: string; uri?: string; photoUri?: string } }[]; }
