# Mold contractor proposals: research and implementation

Reviewed October 25, 2026. There is no single public quoting workflow used by every mold company. This implementation follows the common stages below and lets a contractor define the actual scope and prices.

## What the sources support

- [Mold Busters' process](https://www.bustmold.com/about-us/our-process/) separates inspection, testing when needed, a written plan, remediation and verification. Its scope notes distinguish remediation from rebuilding. [Its FAQ](https://www.bustmold.com/about-us/faq/) describes virtual estimates and on-site follow-up where appropriate. The app therefore distinguishes preliminary pricing from a confirmed scope, and records exclusions and verification arrangements.
- [Mold.ca's inspection process](https://mold.ca/mold-inspection/) describes investigating water issues, explaining scope and costs after inspection, and providing detailed written quotations. Contractors enter their assessment basis and findings rather than presenting an automated screening as a completed site inspection.
- [Health Canada's professional-selection guidance](https://www.canada.ca/en/health-canada/services/publications/healthy-living/addressing-moisture-mould-your-home.html) describes proposals with phase-specific fees, scope, documentation, quality control, schedules, and possible independent clearance. These inform the itemized services, moisture responsibility, exclusions, deliverables, timing, and verification fields. Testing is not automatically mandatory or included.
- [CRA's tax-rate table](https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/charge-collect-which-rate/calculator.html) lists Ontario HST at 13%. A contractor can select no tax, HST added, or HST included. The server calculates the chosen treatment; the app does not determine a business's tax obligations.

## Product decisions

An **assessment visit** prices only assessment services and can be free. Requesting it shares contact details and keeps the remediation project open. A **preliminary estimate** remains indicative; the customer requests follow-up rather than awarding remediation. A **confirmed work quote** requires a declared completed virtual assessment or site visit, dated and described by the contractor. This declaration is not independent verification or certification.

Every proposal covers all project areas. Each service line records description, category, unit, quantity, price and optional applicable areas. Prices come from the contractor, not automatic market-rate guesses. The server computes line rounding, subtotal, tax and total, and validates any submitted total. Deposit and balance are displayed; no money is collected.

Required terms include moisture responsibility, exclusions/hidden conditions, verification, availability, duration, validity date and payment/change-order arrangements. A 30-day default validity is an editable product convenience, not a claim about an industry standard. Warranty text is optional. Expired proposals cannot be newly selected. Revisions preserve earlier offers, including a selected assessment's original price and scope. Final work selection freezes that proposal. Selection is an in-app preference: visit arrangements, contracts, cancellation, change orders and payments are handled directly with the contractor.

## Demo membership

The user's chosen product price is **$100 CAD/month**. Signup and example-company login lead to a clearly marked demo checkout. A simulated payment creates one receipt and a monthly access period; repeated activation during an active period is idempotent. No card entry, real charge, recurring billing, or automatic renewal is implemented. Demo activation is localhost-only and unavailable in production. Customer contacts remain account-free.

## Visibility and removal

Both customer and contractor lists show a separate **Remove screening** button on every card, plus a prominent button on the detail page. Removal requires confirmation, affects only that party's view, and is reversible through **Removed**. Quotes, messages and agreed choices are retained. This is not cancellation of a booked service or permanent data erasure.
