# Live camera capture

A desktop customer opens **Show phone code** inside a screening. The page shows a QR code. Scanning it with the phone's own camera opens `/live/<session>#<token>` in the browser. The phone streams frames to the server. The server checks lighting, focus and framing, and sends guidance back to the phone and to the desktop chat. When framing has been stable for about a second, the phone takes a full-resolution photo. The desktop then adds those photos to the screening through the normal upload path.

## Running it on a phone

Browsers only expose the camera on secure origins, and the app binds to loopback by default. For a phone to use the feature you need both an HTTPS address and an allowed host name:

| Variable | Purpose |
| --- | --- |
| `MOLDLENS_ALLOWED_HOSTS` | Extra host names the app accepts, such as a tunnel name or a LAN address. Enabling this also trusts the `X-Forwarded-*` headers from the proxy. |
| `HOST` | Interface to listen on. Defaults to `127.0.0.1`. Set to `0.0.0.0` only behind HTTPS on a trusted network. |
| `MOLDLENS_PUBLIC_ORIGIN` | Origin written into the QR code, for example `https://moldlens.example.test`. Needed when the desktop is reached on a different address from the phone. |

Example with a tunnel that terminates HTTPS (for example Cloudflare Tunnel or ngrok) forwarding to the local server:

```sh
MOLDLENS_ALLOWED_HOSTS=abc123.trycloudflare.com MOLDLENS_PUBLIC_ORIGIN=https://abc123.trycloudflare.com npm run dev
```

The desktop panel warns when the origin is not HTTPS, because the phone will not be able to start the camera.

## Detection model

Framing guidance ("move closer", "move back") needs a trained detector. Lighting and focus checks work without one. Without a model, the desktop chat says so, and no detections are invented.

- `MOLDLENS_LIVE_MODEL`: path to an ONNX export of a YOLOv8 or YOLO11 model with no built-in NMS. Output shape `[1, 4 + classes, anchors]`.
- `MOLDLENS_LIVE_CLASSES`: comma-separated class names in model order. Defaults to `visible_staining`.
- Requires the optional runtime: `npm install onnxruntime-node`.

The class name describes what the model sees (visible dark staining), not a confirmed mold identification, which matches the screening policy. No trained weights ship with the repository. Training needs labelled photos from the customer domain.

## API

| Route | Who | Purpose |
| --- | --- | --- |
| `POST /api/live/sessions` | customer cookie | Create a session. Returns the one-time token and the detector status. Replaces any earlier session for that customer. |
| `GET /api/live/sessions/:id` | customer cookie | Phone status, guidance, photo list, detector status. |
| `GET /api/live/sessions/:id/snapshots/:snapshotId` | customer cookie | One photo, for thumbnails and for adding to the screening. |
| `DELETE /api/live/sessions/:id` | customer cookie | End the session. Deletes its photos from disk. |
| `POST /api/live/sessions/:id/snapshots` | `X-Live-Token` header | Phone uploads one JPEG or PNG. Up to 12 per session. |
| `WS /api/live/socket` | desktop cookie, or phone token in the first message | Frames and guidance. Desktop gets `hello`, `phone`, `analysis` and `snapshot` messages and binary preview frames. |

## Privacy and lifetime

- Pairing tokens are random, are stored only as SHA-256 digests, are valid for 10 minutes until a phone claims them, and expire 20 minutes after the last activity.
- A session belongs to one customer. Desktop routes return 404 to anyone else.
- Video frames stay in memory and are never written to disk. Only the photos the phone takes are stored, under `data/live/<session>`, and deleted when the session ends.
- The phone page reads the token from the URL fragment, so it is not sent in the page request.

## Known limits

- Frames are analysed one at a time, so guidance latency is the server round trip plus analysis time. There is no WebRTC path yet.
- Sessions are in memory. A server restart ends active sessions.
- The socket and HTTP host allowlist are shared, so a new host must be added in one place (`MOLDLENS_ALLOWED_HOSTS`).
