'use strict';
const path = require('path');
// Local prototype, not an authenticated public web server.
const ALLOWED_PUBLIC_FILES = new Set(['/index.html','/login.html','/manager.html','/docs/index.html']);
function resolvePublicFile(root, requestPath) {
  let decoded;
  try { decoded = decodeURIComponent(requestPath); } catch { return null; }
  if (!ALLOWED_PUBLIC_FILES.has(decoded)) return null;
  return path.join(root, decoded.slice(1));
}
function isTrustedOrigin(origin, port) {
  if (!origin) return true; // CLI callers without Origin are local-only.
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1') &&
      url.port === String(port) && url.pathname === '/';
  } catch { return false; }
}
module.exports = {resolvePublicFile, isTrustedOrigin};
