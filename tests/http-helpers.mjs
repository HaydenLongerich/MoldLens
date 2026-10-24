import { IncomingMessage, ServerResponse } from 'node:http';
import { Duplex } from 'node:stream';
// Exercise the real Express middleware stack using an in-memory HTTP transport.
// No listening socket is needed, so tests work in the restricted build workspace.
export async function dispatch(app, { method = 'GET', url = '/api/requests', body, headers = {} } = {}) {
  const output = [];
  const socket = new Duplex({ read() {}, write(chunk, _encoding, callback) { output.push(Buffer.from(chunk)); callback(); } });
  const request = new IncomingMessage(socket);
  request.method = method;
  request.url = url;
  request.headers = { host: '127.0.0.1:5173', ...headers };
  request.httpVersion = '1.1';
  request.httpVersionMajor = 1;
  request.httpVersionMinor = 1;
  if (body !== undefined) request.headers['content-length'] = String(Buffer.byteLength(body));
  const response = new ServerResponse(request);
  response.assignSocket(socket);
  // Node's network server normally forwards socket backpressure to its response.
  socket.on('drain', () => response.emit('drain'));
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('In-memory HTTP request timed out')), 5000);
    response.once('finish', () => { clearTimeout(timeout); resolve(); });
    response.once('error', (error) => { clearTimeout(timeout); reject(error); });
    app.handle(request, response);
    if (body !== undefined) request.push(body);
    request.complete = true;
    request.push(null);
  });
  const raw = Buffer.concat(output);
  const separator = raw.indexOf('\r\n\r\n');
  let payload = raw.subarray(separator + 4);
  if (response.getHeader('transfer-encoding') === 'chunked' || raw.subarray(0, separator).toString().toLowerCase().includes('transfer-encoding: chunked')) {
    const chunks = [];
    while (payload.length) {
      const line = payload.indexOf('\r\n');
      const size = Number.parseInt(payload.subarray(0, line).toString(), 16);
      if (!size) break;
      chunks.push(payload.subarray(line + 2, line + 2 + size));
      payload = payload.subarray(line + 2 + size + 2);
    }
    payload = Buffer.concat(chunks);
  }
  socket.destroy();
  return { status: response.statusCode, headers: response.getHeaders(), body: payload, json: () => JSON.parse(payload.toString()) };
}

export const intake = {
  name: 'Test Homeowner', email: 'homeowner@example.test', phone: '(613) 555-0123',
  address: '123 Sample Street, Ottawa', postalCode: 'k1s3w7', propertyType: 'House',
  area: 'Basement', size: 'Small — under 1 m²', duration: 'In the last few days',
  description: 'Dark spots appeared below the basement window after recent rain.',
  signs: ['Visible spots or discolouration', 'Water damage'], contactPreference: 'Email', relationship: 'Homeowner', consent: true,
};
export const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
export function multipart(data, files = []) {
  const boundary = 'moldlens-test-boundary';
  const parts = [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="data"\r\n\r\n${JSON.stringify(data)}\r\n`)];
  for (const file of files) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`), file.data, Buffer.from('\r\n'));
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { method: 'POST', url: '/api/requests', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, body: Buffer.concat(parts) };
}
export const jsonRequest = (method, url, body, headers = {}) => ({ method, url, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });


export const setupCode = 'moldlens-isolated-test-bootstrap-code-2026';
export const staffCredentials = { email: 'staff@example.test', password: 'Fixture-password-2026!' };
export function cookieHeader(response) {
  const cookies = response.headers['set-cookie'] || [];
  return (Array.isArray(cookies) ? cookies : [cookies]).map(cookie => cookie.split(';')[0]).join('; ');
}
export function withCookie(options, cookie) {
  return { ...options, headers: { ...options.headers, cookie } };
}
export async function createStaff(app) {
  const response = await dispatch(app, jsonRequest('POST', '/api/auth/setup', { ...staffCredentials, setupCode }));
  if (![200, 201].includes(response.status)) throw new Error(`Staff setup failed (${response.status}): ${response.body}`);
  return cookieHeader(response);
}
export async function signIn(app) {
  const response = await dispatch(app, jsonRequest('POST', '/api/auth/login', staffCredentials));
  if (response.status !== 200) throw new Error(`Staff login failed (${response.status}): ${response.body}`);
  return cookieHeader(response);
}
