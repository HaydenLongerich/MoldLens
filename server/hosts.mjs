// Loopback is the default. A phone reaches the app only through a host listed in
// MOLDLENS_ALLOWED_HOSTS (a LAN address or tunnel name), and that setup needs HTTPS
// because browsers only expose the camera on secure origins.
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

export function allowedHosts(env = process.env) {
  const extra = (env.MOLDLENS_ALLOWED_HOSTS || '').split(',').map((host) => host.trim().toLowerCase()).filter(Boolean);
  return new Set([...LOOPBACK, ...extra]);
}

export function isAllowedHost(hostHeader, env = process.env) {
  let host;
  try { host = new URL(`http://${hostHeader}`).hostname.toLowerCase(); }
  catch { return false; }
  return allowedHosts(env).has(host);
}

export function behindProxy(env = process.env) {
  return Boolean(env.MOLDLENS_ALLOWED_HOSTS);
}
