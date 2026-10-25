# MoldLens · Home hub

A working local app for client intake, inspection management, and discovering Ottawa mold specialists. React, TypeScript, Vite, Express, and persistent local storage.

## Open the app

Open **`dist/offline.html`** in Chrome, Edge, or Firefox for the browser-only customer preview. It saves requests, photos, and videos in IndexedDB. Staff sign-in and case management require the running server; the standalone file does not provide a simulated admin account. Web fonts use external URLs; core customer functionality works without them.

For the server version:

```sh
cd /Users/jaden/soonhacks/MoldLens
npm install
cp -n .env.example .env
npm run dev
```

Open **http://127.0.0.1:5173**. The server binds to the local computer. Uploads and requests persist under `data/`. Set `PORT` or `MOLDLENS_DATA_DIR` to change the port or storage directory.

Use Node 20.19 or newer. For photo/video AI screening, set `OPENAI_API_KEY` in `.env` and restart the server. The default model is `gpt-4.1`; Anthropic and explicitly labeled mock mode are also supported. Form-only screening works without a key. Install scripts supply Sharp/FFmpeg; `FFMPEG_PATH` and `FFPROBE_PATH` can point to existing binaries if needed. API keys never belong in browser code or `VITE_*` variables.

```sh
npm run build    # TypeScript check, production bundle, standalone preview
npm start        # Serve the production build on port 5173
```

## Staff access

1. Start or restart the server with `npm run dev`.
2. Open **Staff sign in** in the customer footer. On the first run, this opens **Set up staff access**.
3. Enter your email, choose a password of 12–128 characters, and paste the one-time setup code printed in the server terminal.
4. Create the account to open the dashboard. Later visits use your email and password.

The setup code is available only to the person running the app and is consumed when the first staff account is created. Passwords are stored as salted scrypt hashes in the ignored `data/` directory. Staff sessions use HttpOnly cookies, expire after eight hours, and end on sign-out or server restart. There is no default password or public staff registration.

Signed-in staff can switch between **View customer page** and **Dashboard** and sign out from either view. Direct dashboard URLs and the administrative API require a valid staff session. Customers can submit without an account; **My requests** and uploaded media are scoped to the submitting browser using a separate HttpOnly cookie. Internal notes and source records are excluded from customer responses. Clearing that cookie or using a different browser removes access to that browser's history. Requests created before this access-control update remain available to staff; their old request IDs alone do not grant customer access.

## Workflows

- **Start a screening:** a consented draft with optional photos/video and contact details, resumable uploads, saved context, background processing, up to four follow-up questions, and a full evidence-linked preliminary report. Screenings persist in a local PGlite database and become staff cases on submission. Reports explain visible conditions and limitations; they do not identify species or confirm mold. Missing AI configuration is shown clearly. See [screening setup, routes, limits, and operating notes](server/screening/README.md).
- **Request a review:** one short form for the concern, name, email, and postal code. Photos and videos are optional; address and phone sit under an optional details section. Includes upload previews, validation, resumable text drafts, consent, and a saved request number. Up to 10 files, 25 MB each. A specialist reviews submissions; the app does not diagnose mold from images.
- **My requests:** a simple list of this browser's requests with their current status. Open a request to see the concern, photos/video, and any appointment details. No email tracking links are sent.
- **Client dashboard:** search/filter cases, assign team members, change status/priority, schedule inspections, add notes, and export filtered CSV. Review source findings, historical estimates, discrepancies, timelines, and reports.
- **Find a specialist:** five Ottawa providers with service filters, saved providers, comparisons, contact links, and official sources. Published prices appear where available; otherwise the directory asks for a quote. No partnerships, distances, or live capacity are invented.

The customer view has a minimal header and one main action. The specialist directory and staff sign-in are available from footer links; the authenticated admin view retains its team navigation. The standalone preview includes the public directory and customer form only.

## Hackathon data

`public/sample-data/` contains the user's de-identified sample pack: two case timelines, 24 unchanged source photos, a silent walkthrough, job stories, and reference reports. The server seeds these cases once for staff review. The standalone customer preview does not embed staff cases.

- **MB-CASE01:** on-site Ontario house inspection, 21 photos, remediation estimate viewed but not accepted.
- **MB-CASE02:** virtual Quebec apartment assessment, three photos and a walkthrough, IAQ estimate viewed but not accepted.

Dates, findings, historical amounts, and staff aliases are retained. Missing addresses and contact details are not invented. `In review` and `Medium` are prototype workflow defaults, not clinical risk assessments. Source disagreements and placeholder clock times are explicitly flagged. Historical invoices are not current advertised prices. Reference reports are source documents, not diagnostic training inputs.

Directory sources: [Mold Busters Ottawa](https://www.bustmold.com/locations/ottawa/), [PuroClean Ottawa East](https://puroclean.ca/franchise/vars-on-puroclean-ottawa-east), [Enviropure](https://www.enviropurehome.com/), [OIES](https://oies.ca/index.html), [Healthy Home Center](https://healthyhomecenter.ca/). Each listing links its source.

## Validation

```sh
npm test               # Real Express middleware/storage/upload checks without sockets
npm run test:e2e       # Browser tests with an isolated server and temporary data
npm run test:offline   # Browser tests against dist/offline.html and IndexedDB
```

The API tests exercise authentication, customer isolation, screening persistence, concurrent uploads, background jobs, reports, model validation, and staff retry. Native media tests include real JPEG processing and synthetic video; AI responses are injected fixtures with no live provider calls. Browser tests require Playwright Chromium (`npx playwright install chromium`) and cover customer submission, staff navigation, provider filtering/comparison, and mobile layouts. Tests use temporary stores or isolated browser contexts.

The build and non-browser tests run in this restricted workspace. Listening sockets, Chromium launch, and browser navigation to `file://` are blocked here; live server and visual verification must run from an ordinary local terminal.

## Scope

This is a functional local prototype. Browser-only and server stores are separate. No requests, emails, SMS, bookings, or referrals are sent to Mold Busters or other providers. The directory is a manually sourced snapshot.

This local app provides a single staff administrator account and browser-scoped customer access. Before public deployment, provide HTTPS, managed account recovery and staff provisioning, persistent shared session storage, a managed database and object storage, upload scanning/quotas, operational integrations, and deployment controls. Loopback binding and local host checks are intentional. The offline preview is local browser storage, not a multi-user authentication boundary.
