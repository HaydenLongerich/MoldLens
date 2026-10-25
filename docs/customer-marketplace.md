# Unified screening and quotes

The app has three main destinations:

- `/#screening`: start or resume a screening.
- `/#customer`: the user's screenings, reports, quotes, and messages.
- `/#partner`: contractor sign-in and customer screenings awaiting quotes.

Legacy `/#requests`, `/#inspection`, and `/#contractors` links redirect to these views. There is no separate request workflow in the customer navigation. Existing request records are preserved in storage.

## Automatic contractor delivery

The screening form collects permission to automatically share the completed screening with Newmarket contractors. Submitting saves that permission and service area in `moldlens_screening_links.contractor_sharing` and `sharing_city`.

`syncClient` in `server/screening/index.ts` calls the trusted `onScreeningUpdate` callback. `server/app.mjs` connects it to the marketplace's `syncScreening`. Submitted screenings appear as processing for the owner. Only validated/published reports in `ready_preview` or `inconclusive` reach contractors. A deterministic screening ID prevents duplicate records and quote loss on retries. The background worker reconciles submitted screenings on startup, including cases where an earlier process stopped before writing the legacy client-case link.

Recipients are active, unexpired contractor memberships serving Newmarket. Paused and pending companies are excluded. No separate customer share/request action is required for new screenings. If no contractors are eligible, later worker passes retry delivery. Demo membership activation also makes existing open, shared local projects available to that company; completed/awarded projects are not backfilled.

The contractor receives the screening reference, area, description, validated report headline, and finding statements. Raw media, customer account/contact details, and private staff notes are not exposed through the marketplace. Each contractor sees only its own quotes and conversation.

Older screenings created before sharing consent was added remain private. Their owner can explicitly enable quotes from the screening's Quotes section. Drafts, processing screenings, follow-up questions, completed reports, quotes, and conversations all appear in the same user list; no duplicate row is created when processing finishes.

## Quoting and messages

Each screening is one project, regardless of how many areas it contains. Structured `projectAreas` preserve area IDs, labels, and area-specific findings from the validated screening, while the overall description, summary points, and recommendations remain attached to that same project. Older records derive their areas from the saved labels.

The interactive review supports filtering and expanding areas, reading the full screening summary, and marking areas reviewed. Review progress is kept in session storage for that company and project.

Contractors submit a structured assessment offer, preliminary estimate, or confirmed quote, with `coveredAreaIds` containing every project area. The server validates itemized services, completed-assessment declarations for confirmed quotes, scope, moisture responsibility, exclusions, clearance, dates and payment terms. It calculates totals and optional Ontario HST. Updating keeps one proposal ID per company/project with immutable previous revisions. Assessment and estimate follow-up requests preserve the original offer and keep the work project open; choosing a confirmed work quote awards the entire project. See [research and field mapping](mold-quoting-research.md).

The local sample-screening button creates one example project with Basement, Bathroom, and Attic. Sample proposals are indicative and labelled, with no invented completed site inspection. Legacy quotes need an itemized update before new selection; existing choices are preserved.

The first screening opens automatically on entry, and changing an inbox filter opens its first matching screening. Explicit detail links are preserved. On mobile, **All screenings** returns to the list without immediately reopening a detail.

The contractor inbox defaults to **All screenings**, with Awaiting quote, Quoted / follow-up, Chosen, Declined / withdrawn and Removed filters. Each list card and detail page has an explicit Remove screening button. Customers have the same visible controls. Removal affects only that viewer and is reversible. Contractors can also decline to bid or withdraw an unselected proposal. Reopening bidding does not revive a withdrawn price; the contractor sends a revised proposal.

Customers can decline any unchosen quote, undo that decline, and archive or restore quotes through the quote list's Current / Archived selector. A customer decline blocks contractor updates until the customer undoes it. Customer archives do not affect contractor archives, and private contractor responses are not exposed to customers or other companies. Declined, withdrawn, or customer-archived quotes cannot be chosen. A chosen quote cannot be declined or withdrawn; messages remain available to discuss changes. Archives preserve prices, scope, history, messages, and selections.

Customers enter an email and phone before seeing quote details. This is a contact card tied to their existing browser identity, with no customer account, password, or sign-in flow. The server withholds quote details and prevents selection until both fields are valid. Contact details can be edited from Quotes and are returned only to the customer and the contractor whose quote was chosen. Other contractors receive no customer contact card. No automatic email or SMS is sent.

**Remove screening** moves a customer screening into **Removed**, with a confirmation and restore action. This applies to sample projects and real drafts, processing screenings, and finished reports. Removal affects only the customer's list; it retains messages, prices, contractor access, and any chosen contractor. Ownership is checked on the server, and a source screening keeps its removed state when background processing later creates or updates the marketplace project.

Use Quote to submit amount in CAD, scope, availability, and tax inclusion. The quote appears on the user's existing screening. Users can compare, choose a contractor, and message each company privately. Selection marks a preference; it does not make a payment or book a visit.

Membership is $100 CAD/month; customers are free. Signup and example-company login prompt for a simulated payment. Pending/paused/expired memberships cannot access contractor inboxes or send proposals. The demo payment records a receipt and monthly period, without card entry, real billing, or automatic renewal. Real SMS remains unconnected. Data is atomically saved in `data/marketplace.json`; contractor passwords use scrypt and sessions use HttpOnly/SameSite cookies. Customers use their existing browser identity, with no account.

## Testing

In local development, **Create sample screening** on the Screen page creates a labelled example and automatically sends it to the demo contractor inboxes in one action. **Open demo** on contractor sign-in selects an example company. Sample quotes are clearly labelled; no real company is contacted. Demo identities, sample replies, and membership testing controls are disabled in production mode.

The eleven marketplace tests and two screening integration tests cover privacy, subscription gating, automatic delivery only after completion, consent, recipient filtering, idempotency, proposals, messages, accounts, persistence, legacy opt-in, whole-project coverage, bid withdrawal, customer declines, private removal/restoration, chosen-proposal protections, contact gating and screening removal across processing. Mobile checks cover signup price disclosure, simulated membership activation, proposal entry and HST preview, submission, visible removal controls for both roles, and removal confirmation. The temporary sample used for verification was moved to Removed for both parties.

The thirteen project/marketplace integration tests pass, including monthly demo activation/idempotency, line-item totals/HST/deposits, invalid assessments/dates, a free assessment followed by a revised work quote, immutable proposal history, and expired-offer selection. The last full Windows suite had two existing platform failures concerning POSIX credential-file mode assertions on Windows and a screening video test helper failing to launch (`spawn EFTYPE`).

## Example company sources

These are service-area examples, not enrolled partners:

- [MoldTech](https://www.moldtech.ca/newmarket), [contact information](https://www.moldtech.ca/contact)
- [ARO Restoration](https://www.arorestorations.ca/service-areas/newmarket)
- [Desa Contracting & Restoration](https://desacontracting.com/areas-served/newmarket-on/)

The server remains a localhost prototype. Production hosting, customer accounts/recovery, business verification, billing, and SMS are separate integrations.
