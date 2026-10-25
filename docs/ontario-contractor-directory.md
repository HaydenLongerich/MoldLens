# Ontario directory and screening invitations

Customer screenings use an Ontario postal code. After a validated report is ready and the customer has consented to contractor sharing, the marketplace geocodes the project and each subscribed company's base postal code, then applies Haversine distance <= 50 km. This is straight-line distance between approximate postal-code positions, not driving distance. Google directory business distance uses the business location, which may differ from a registered company's chosen postal-code base.

Real routing has no Newmarket/city fallback. Missing credentials, invalid/unresolved locations, and outages leave reports saved and pending; they do not send to an assumed area. The background worker retries every 30 seconds with a cooldown on failed lookups. Open projects also match newly subscribed companies. Paused or expired memberships do not receive new invitations. Existing quotes and prior access remain intact when a company moves or pauses. Examples receive sample reports only; sample reports never send email.

## Google setup and data

Set server-only GOOGLE_MAPS_API_KEY, with Places API (New), Geocoding API, billing, IP/API restrictions and quotas configured in Google Cloud. No key belongs in VITE variables. Search is explicit, rate limited, and bounded to two service queries with three pages per query (up to six paid calls per search). Google returns at most 60 matches per text query; there is no guarantee that every contractor, or a majority of Ontario contractors, is included. Search results are filtered to Ontario and the exact 50 km circle after Google's rectangular search restriction.

The persistent PGlite database at data/contractor-directory-db stores only Google Place IDs and our indexing timestamps/region labels. Names, business locations, ratings, counts and review text are fetched live, are not copied into marketplace records, and are not persisted in that database. Postal-coordinate lookups are cached in server memory for 24 hours, never on disk. Registered company business information and postal codes are independently supplied at signup and persist in marketplace.json. Google listings are discovery data; they do not enroll businesses or authorize email delivery.

For a broad Ontario ID index, stop the app first (PGlite has one process owner), then run:

    node --env-file-if-exists=.env scripts/index-ontario-contractors.mjs --max-requests=120

This explicitly bounds billable API calls. It searches 56 Ontario communities across mold remediation and inspection/testing terms, paginates up to three pages per query and deduplicates IDs with a database primary key. Increase the cap deliberately if broader pagination is desired. This command has not been run against live Google data without credentials. The on-demand directory also expands the same index. Ratings/reviews remain live; the ID index is not a permanent mirror of Google's business database. No verified coverage percentage is claimed.

Companies can optionally select a Google business from the directory in settings. Only the Place ID is linked to their own record. Customers can request live Google ratings/reviews alongside those company quotes; the UI labels this as a company-provided profile, not verified business ownership.

The mobile directory includes Google Maps attribution, review author attribution and links to source reviews. Reviews are Google's selection (up to five), not a complete review history. Public directory terms/privacy are at /directory-terms.html and should be integrated into the deployment's full legal pages before launch.

## Email setup

Signup requires a company postal code and explicit agreement to quote invitation emails at the signup address. The $100 CAD/month demo membership still controls inbox access. Settings allow postal-code changes and opting out. Public business listing contact details are never used as email recipients.

Default MOLDLENS_EMAIL_MODE=preview stores an invitation preview in the authenticated company's settings and sends nothing. For live delivery, set MOLDLENS_EMAIL_MODE=live, RESEND_API_KEY, MOLDLENS_EMAIL_FROM on a verified sending domain, and MOLDLENS_PUBLIC_URL to the deployed HTTPS origin. A localhost link is not usable by real contractors. Review deployment email consent/identity verification and sending-domain requirements before opening public signup.

One durable outbox entry per project/company prevents duplicate invitations during worker reconciliation and restarts. Delivery uses Resend Idempotency-Key, exponential retry, provider outcome status, and an ambiguity cutoff below the provider's 24-hour idempotency window. Attempts exceeding that window require manual review rather than blind resend. Preview entries are terminal; enabling live mode never silently sends old previews. Provider rejection stops retries; transient failures retry up to eight attempts. Pending deliveries recheck membership, preference and distance. Configuration failures remain visible in the contractor settings. Each email links to a sign-in-protected whole-project report; it grants no access token and includes no customer contact information, photos or free-text description. Existing full-project proposal validation, revision tracking and contact-release rules are unchanged.

## Sources

- [Places policies and attribution](https://developers.google.com/maps/documentation/places/web-service/policies)
- [Text Search (New), fields and pagination](https://developers.google.com/maps/documentation/places/web-service/text-search)
- [Geocoding policies](https://developers.google.com/maps/documentation/geocoding/policies)
- [Resend sending API](https://resend.com/docs/api-reference/emails/send-email)
- [Resend idempotency](https://resend.com/docs/dashboard/emails/idempotency-keys)
