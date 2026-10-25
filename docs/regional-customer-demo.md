# Regional customer demo

The local development app has six example workspaces. ARO and Desa have been retired from the dropdown; their existing reports, messages and quote references remain saved. Company names and services were verified against the companies' own pages, without inventing Google ratings or a commercial relationship with MoldLens.

| Workspace | City | Test postal code | Business source |
| --- | --- | --- | --- |
| MoldTech_N | Newmarket | L3Y 1A1 | [MoldTech contact](https://www.moldtech.ca/contact) |
| KleenCondition_M | Mississauga | L4W 5A8 | [Kleen Condition locations](https://kleencondition.com/locations/) |
| UltraFreeMold_O | Oakville | L6J 6Z1 | [UltraFreeMold contact](https://www.ultrafreemold.com/contact-us) |
| TheMoldGuy_T | Toronto | M6R 3B9 | [The Mold Guy contact](https://www.moldguy.ca/contact-us/) |
| LETS_L | London | N6G 2N3 | [London Environmental Testing Services](https://londonenvironmental.ca/contact-us.php) |
| MoldBusters_O | Ottawa | K1P 1J1 | [Mold Busters Ottawa](https://www.bustmold.com/locations/ottawa/) |

These are approximate city test locations; they are not verified office coordinates. MoldTech serves Newmarket and has its office in nearby East Gwillimbury. LETS offers inspection/testing, not a claimed remediation service. The postal presets are deterministic test points. Actual production matching still requires real geocoding; no preset replaces that path. The two O suffixes are distinguished by company name and the city shown in the dropdown.

## Test flow

1. Load or reload `/#home`. The local demo starts a new guest once per document load; StrictMode does not create a second reset. Returning by hash navigation within the same document does not reset again.
2. Open **Customer demo**, enter a **Screening name**, then **Use name**. That name appears with new demo screenings for customer and contractor review.
3. On **Screen**, open **Customer demo** and select a **Postal-code test location**. **Create sample screening** creates a three-area project at that code and adds indicative sample quotes from in-range example companies.
4. The Quotes tab requests email and phone before showing prices. The **50 km postal-code test** panel lists all six example companies, their approximate distance, and whether the screening reached them. London and Ottawa each match their own isolated city; the GTA examples can overlap within 50 km.
5. Reload home for a fresh guest. Old demo data stays saved but disappears from the new guest's list; contact details are blank so the prompt can be tested again.
6. **Continue with email** reopens a previously linked local demo. If the email is new, it links the current guest. Saving the quote contact form also links an unused email to that guest. If that email already belongs to an older demo, use Continue explicitly to switch to it; saving contact does not silently switch or merge identities.

The six example companies receive simulated paid membership when a customer demo begins, so no real subscription payment is needed for regional testing. Normal company registration still has its demo membership checkout. The sign-in footer reads **Only $100 CAD/month for our membership**.

## Isolation and persistence

The demo uses its own HttpOnly cookie. Leave customer demo restores access through the original customer cookie; no records are deleted. Only hashed session tokens are persisted; the normal customer cookie remains intact underneath. An email continuation lookup searches only the local demo index, never ordinary customer contacts. It cannot reopen a real customer's records just by knowing their email. Demo endpoints and demo identity resolution are disabled in production. Source screenings created under a local demo identity also route exclusively to the example companies and never enqueue external email invitations.

New guest creation changes active ownership rather than deleting data. Demo customer names, email links and session hashes are stored with the existing marketplace data so email continuation survives a server restart. Seven-day demo session cookies are resolved with server-side expiry. This email-only continuation is intentionally a local testing feature; production recovery needs a verified email link or other proof of ownership.

Validation: six dedicated demo integration tests cover all six locations, reset/resume/contact gating, exclusion of ordinary customer data, restart persistence/history preservation, and source-screening routing without external mail, and production disablement. Existing marketplace, routing and screening integration tests remain in place.
