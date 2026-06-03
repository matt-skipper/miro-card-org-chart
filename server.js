const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { URL } = require('node:url');

const PORT = Number(process.env.PORT || 8080);
const HOST = '0.0.0.0';
const DIST_DIR = path.join(__dirname, 'dist');

const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "script-src 'self' https://miro.com https://*.miro.com",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://miro.com https://*.miro.com",
    "font-src 'self' data: https://miro.com https://*.miro.com",
    "connect-src 'self' https://miro.com https://*.miro.com wss://*.miro.com",
    "frame-ancestors https://miro.com https://*.miro.com",
    "form-action 'none'",
  ].join('; '),
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': [
    'accelerometer=()',
    'autoplay=()',
    'camera=()',
    'clipboard-read=()',
    'clipboard-write=(self)',
    'display-capture=()',
    'encrypted-media=()',
    'fullscreen=(self)',
    'geolocation=()',
    'gyroscope=()',
    'magnetometer=()',
    'microphone=()',
    'midi=()',
    'payment=()',
    'picture-in-picture=()',
    'publickey-credentials-get=()',
    'screen-wake-lock=()',
    'usb=()',
    'web-share=()',
    'xr-spatial-tracking=()',
  ].join(', '),
};

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
};

function setHeaders(response, statusCode, contentType = 'text/plain; charset=utf-8') {
  response.writeHead(statusCode, {
    ...SECURITY_HEADERS,
    'Content-Type': contentType,
  });
}

function getFilePath(requestUrl) {
  const { pathname } = new URL(requestUrl, `http://${HOST}:${PORT}`);
  const decodedPath = decodeURIComponent(pathname);
  const requestedPath = decodedPath === '/' ? '/index.html' : decodedPath;
  const filePath = path.normalize(path.join(DIST_DIR, requestedPath));

  if (!filePath.startsWith(DIST_DIR + path.sep)) return null;
  return filePath;
}

const server = http.createServer((request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    setHeaders(response, 405);
    response.end('Method not allowed');
    return;
  }

  let filePath;
  try {
    filePath = getFilePath(request.url);
  } catch {
    setHeaders(response, 400);
    response.end('Bad request');
    return;
  }

  if (!filePath) {
    setHeaders(response, 403);
    response.end('Forbidden');
    return;
  }

  fs.stat(filePath, (statError, stats) => {
    if (statError || !stats.isFile()) {
      setHeaders(response, 404);
      response.end('Not found');
      return;
    }

    const contentType = MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    setHeaders(response, 200, contentType);

    if (request.method === 'HEAD') {
      response.end();
      return;
    }

    fs.createReadStream(filePath).pipe(response);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Serving ${DIST_DIR} at http://${HOST}:${PORT}`);
});
