# Live camera capture

A desktop customer opens **Use phone camera** inside a screening. The page shows a QR code. Scanning it with the phone's own camera opens `/live/<session>#<token>` in the browser. The phone streams frames to the server. The server checks lighting, focus and framing, and sends guidance back to the phone. When framing has been stable for about a second, the phone takes a full-resolution photo. The desktop then adds those photos to the screening through the normal upload path.

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

Framing guidance ("move closer", "move back") needs a trained detector. Lighting and focus checks work without one. Without a model, no detections are invented.

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
| `WS /api/live/socket` | desktop cookie, or phone token in the first message | Phone sends frames and gets guidance. Desktop only gets `hello`, `phone` and `snapshot` messages; no frames or guidance. |

## Privacy and lifetime

- Pairing tokens are random, are stored only as SHA-256 digests, are valid for 10 minutes until a phone claims them, and expire 20 minutes after the last activity.
- A session belongs to one customer. Desktop routes return 404 to anyone else.
- Video frames stay in memory and are never written to disk. Only the photos the phone takes are stored, under `data/live/<session>`, and deleted when the session ends.
- The phone page reads the token from the URL fragment, so it is not sent in the page request.

## Known limits

- Frames are analysed one at a time, so guidance latency is the server round trip plus analysis time. There is no WebRTC path yet.
- Sessions are in memory. A server restart ends active sessions.
- The socket and HTTP host allowlist are shared, so a new host must be added in one place (`MOLDLENS_ALLOWED_HOSTS`).

## Browser test checklist

Start the server on a free port (5173 may be taken by another checkout): `PORT=5180 npm run dev`, then open `http://127.0.0.1:5180`.

Desktop (Chrome or Edge):

1. Go to **Start a screening**. Confirm the camera buttons are locked until both permission boxes are ticked.
2. Tick both consent boxes, pick an area and a concern, choose a property type, and click **Save draft**.
3. Click **Use phone camera**. Expect a QR code, the status "Scan with your phone camera", and a "Can't scan? Copy the phone link" box.
4. Open the link in a private window. Allow camera access when asked.
5. Expect "Phone connected" on the desktop and guidance messages in the chat box.
6. Tap the shutter on the phone. Expect "Photo 1 of 12 saved." and a thumbnail on the desktop.
7. Click **Add 1 photo to screening**. Expect "1 photo added to your screening." and an **Added** label.
8. Click **End live camera**. Expect the phone to show "Live camera ended".

Edge cases to try:

- Open a `/live/...` link with the last few characters of the token changed. Expect "Live camera ended" on the phone.
- Open `/live/` on its own. Expect "This link is incomplete".
- Scan the same code from a second device. Expect the first phone to show "Another phone connected with this code."

Phone camera needs HTTPS. To test on a real phone, run a tunnel to the port (for example `cloudflared tunnel --url http://localhost:5180`), then restart with `MOLDLENS_ALLOWED_HOSTS=<tunnel host> MOLDLENS_PUBLIC_ORIGIN=https://<tunnel host> PORT=5180 npm run dev`. Open the tunnel URL on the desktop and scan the code.
