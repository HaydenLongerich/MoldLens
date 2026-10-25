# Screening backend

Adapted from [timothytenzin20/soon-2026](https://github.com/timothytenzin20/soon-2026/tree/82c4a58ef4faa8564a46d04d46b542c084e9b323), commit `82c4a58ef4faa8564a46d04d46b542c084e9b323`. The domain, database, storage, media, AI, pipeline, observability, and reporting packages remain under `vendor/`, with MoldLens integration and correctness fixes. `scripts/build-screening.mjs` resolves internal `@mb/*` imports into the ignored `runtime.mjs` bundle; npm packages stay external. Database migrations ship alongside the bundle.

## Flow

1. Explicit AI-processing and media-storage consent creates a browser-owned draft.
2. Save property context and optional contact details. Upload up to 12 files using resumable 8 MiB chunks; sessions expire after 24 hours. Defaults allow 500 MiB/file and 10 minutes/video. Paused uploads require reselecting the same local file after reload.
3. Durable jobs validate signatures, normalize photos, strip metadata, make silent video previews, and extract bounded JPEG frames. Originals stay private. A bounded early observation can run as media becomes ready.
4. Submission creates one linked case in the staff dashboard. Jobs analyze selected frames with the configured provider, ask up to four approved follow-up questions, then generate and validate a report. Skipped answers remain unknown.
5. Owners and signed-in staff can view reports and authorized evidence. Staff can retry failed screenings. Case synchronization preserves staff notes, assignment, status, and scheduling.

Reports describe visible conditions and uncertainty; they cannot establish mold species, toxicity, medical effects, or confirm mold from an image. The validator checks references and prohibited claims. It does not prove every generated statement is factually correct. Form-only submissions produce limited deterministic guidance without an AI call. Missing credentials fail media analysis visibly; `AI_PROVIDER=mock` must be explicitly selected and is labeled as simulated.

## API

All routes use existing same-origin protections and HttpOnly identities. Customers can only access their own screenings; staff privileges use the existing staff session. Browser-provided IDs never grant access.

| Route | Purpose |
| --- | --- |
| `GET /api/screening-config` | Limits, provider status, approved choices |
| `GET/POST /api/screenings` | Own list / consented draft; staff list uses `?admin=true` |
| `GET/PATCH /api/screenings/:id` | Status/context / save draft |
| `POST /api/screenings/:id/uploads` | Create or resume an upload |
| `GET/PUT/DELETE /api/screening-uploads/:id` | Offset / binary chunk with `?offset=N` / cancel |
| `POST /api/screening-uploads/:id/complete` | Verify bytes and queue processing; idempotent |
| `DELETE /api/screening-assets/:id` | Remove draft media |
| `POST /api/screenings/:id/submit` | Submit completed intake; idempotent |
| `GET /api/screenings/:id/questions` | Follow-up questions |
| `POST /api/screenings/:id/answers` | Save approved answers and finish |
| `GET /api/screenings/:id/report` | Validated report and evidence URLs |
| `POST /api/screenings/:id/retry` | Staff retry of a failed screening |
| `GET /api/screening-media/assets/:id/:variant` | Authorized preview/poster; supports video range requests |
| `GET /api/screening-media/frames/:id` | Authorized JPEG evidence |

The React client in `src/lib/screening-api.ts` defines request bodies and handles conflicts/timeouts. Invalid chunk offsets return the authoritative byte position. Cross-customer IDs return 404; report requests return 409 until ready.

## Running and operating

`npm run dev` builds the backend, loads `.env`, applies migrations, and starts the worker with Express. `npm run build && npm start` uses the production frontend. Use Node 20.19+ and a normal `npm install` with install scripts enabled for Sharp and FFmpeg. If FFmpeg downloads are unavailable, point `FFMPEG_PATH` and `FFPROBE_PATH` at installed binaries. Build and tests make no live AI requests.

If `ffmpeg-static` is installed without its binary (for example, after an interrupted download), run `npm rebuild ffmpeg-static` in a terminal with network access. The restricted development environment used an external FFmpeg binary for native video tests; that temporary test path is not part of app configuration.

The database persists under `data/screening-db`; private media lives under `data/screening-media`. `MOLDLENS_DATA_DIR` relocates both. `SCREENING_DATABASE_URL` accepts a PostgreSQL URL, `pglite:/absolute/path`, or `memory:` for disposable tests. One process must own a local PGlite directory. PostgreSQL support does not make the JSON case store or local staff sessions multi-process ready.

The worker claims durable jobs, retries transient failures with backoff, and recovers stale leases after 20 minutes. Database row locks protect chunk offsets and upload quotas. Shutdown drains HTTP work and active jobs before closing the database.

`AI_MAX_FRAMES_PER_RUN` bounds one vision call to 1–24 frames (12 by default). Provider deadlines and media bounds limit individual operations. `AI_BUDGET_USD_PER_RUN` records a warning after estimated spend exceeds its threshold; it is **not** a billing limit. Early observations, later uploads, and provider retries can add calls and cost. Use provider-side spending controls separately.

Photos/video frames and relevant answers can reach the configured provider after consent. Metadata/audio stripping occurs before analysis, but there is no face blurring or guaranteed anonymization before transmission. Provider-reported privacy flags suppress evidence only after the provider has seen it. Files, database records, and expired upload bytes have no automatic retention cleanup; back up and manage them together.

All validated reports are available without the source app's unfinished checkout gate. Fake contractor seeds and development login routes were not imported. There is no checkout, email/magic-link delivery, PDF export, S3 driver, transcription, malware scanner, or species-identification model in this integration.

## Verification

`npm test` exercises Express through an in-memory HTTP transport and uses real temporary PGlite databases, private storage, Sharp processing, and synthetic media. Provider adapters use injected fixtures. Native checks are skipped with an explicit reason if dependencies are absent; set `FFMPEG_PATH`/`FFPROBE_PATH` to include them. Tests cover isolation, consent, restart persistence, concurrent chunks, quotas/cancellation, idempotency, case linking, report claims, invalid model output, missing credentials, and staff retry.
