# MoldLens · Home hub

A working local app for client intake, inspection management, and discovering Ottawa mold specialists. React, TypeScript, Vite, Express, and persistent local storage.

## Open the app

Open **`dist/offline.html`** in Chrome, Edge, or Firefox for the browser-only version. It saves requests, photos, videos, and case edits in IndexedDB. Keep the adjacent `sample-data` folder so the supplied photographs, video, and reports remain available. Web fonts use external URLs; core functionality works without them.

For the server version:

```sh
cd /Users/jaden/soonhacks/MoldLens
npm install
npm run dev
```

Open **http://127.0.0.1:5173**. The server binds to the local computer. Uploads and requests persist under `data/`. Set `PORT` or `MOLDLENS_DATA_DIR` to change the port or storage directory.

```sh
npm run build    # TypeScript check, production bundle, standalone preview
npm start        # Serve the production build on port 5173
```

## Workflows

- **Request a review:** one short form for the concern, name, email, and postal code. Photos and videos are optional; address and phone sit under an optional details section. Includes upload previews, validation, resumable text drafts, consent, and a saved request number. Up to 10 files, 25 MB each. A specialist reviews submissions; the app does not diagnose mold from images.
- **My requests:** a simple list of saved requests with their current status. Open a request to see the concern, photos/video, and any appointment details.
- **Client dashboard:** search/filter cases, assign team members, change status/priority, schedule inspections, add notes, and export filtered CSV. Review source findings, historical estimates, discrepancies, timelines, and reports.
- **Find a specialist:** five Ottawa providers with service filters, saved providers, comparisons, contact links, and official sources. Published prices appear where available; otherwise the directory asks for a quote. No partnerships, distances, or live capacity are invented.

The customer view has a minimal header and one main action. The specialist directory and team dashboard are available from footer links; the admin view retains its team navigation. Both views are accessible for demonstration; there is no sign-in gate.

## Hackathon data

`public/sample-data/` contains the user's de-identified sample pack: two case timelines, 24 unchanged source photos, a silent walkthrough, job stories, and reference reports. Each data store seeds these cases once.

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

Browser tests require Playwright Chromium (`npx playwright install chromium`). They cover client submission with a photo/video, persisted case changes, provider filtering/comparison, and mobile layouts. Tests use temporary stores or isolated browser contexts.

The build and non-browser tests run in this restricted workspace. Listening sockets, Chromium launch, and browser navigation to `file://` are blocked here; live server and visual verification must run from an ordinary local terminal.

## Scope

This is a functional local prototype. Browser-only and server stores are separate. No requests, emails, SMS, bookings, or referrals are sent to Mold Busters or other providers. The directory is a manually sourced snapshot.

Before public deployment, add authentication, role/client authorization, managed database and object storage, upload scanning/quotas, operational integrations, and deployment controls. Loopback binding and local host checks are intentional.
