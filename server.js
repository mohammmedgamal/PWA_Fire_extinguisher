// Minimal static file server for hosting the PWA (e.g. on Railway). No dependencies.
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';

// Only these files and folders are served; server code and repo files stay private.
const PUBLIC = new Set(['index.html', 'styles.css', 'app.js', 'sw.js', 'manifest.webmanifest']);
const PUBLIC_DIRS = new Set(['icons', 'vendor', 'data']);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function isPublic(rel) {
  const parts = rel.split('/');
  if (parts.length === 1) return PUBLIC.has(parts[0]);
  return PUBLIC_DIRS.has(parts[0]) && !parts.some((p) => p.startsWith('.')) && path.extname(rel) !== '.mjs';
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  let rel;
  try {
    rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
  } catch {
    res.writeHead(400).end();
    return;
  }
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT + path.sep) || !isPublic(rel)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    return;
  }
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Content-Length': stat.size,
      // Always revalidate so phones pick up new versions; the service worker handles offline use.
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(self)',
    });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(file).pipe(res);
  });
});

server.listen(PORT, HOST, () => console.log(`Fire Extinguisher Survey running on http://${HOST}:${PORT}`));
