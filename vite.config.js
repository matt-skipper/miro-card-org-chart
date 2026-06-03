import path from 'path';
import fs from 'fs';
import dns from 'dns';
import {defineConfig} from 'vite';

// https://vitejs.dev/config/server-options.html#server-host
dns.setDefaultResultOrder('verbatim');

// Build every *.html at the project root as a Rollup entry (landing, panel, modal).
// Vite needs explicit inputs so each page is emitted under dist/ with hashed assets.
const allHtmlEntries = fs
  .readdirSync('.')
  .filter((file) => path.extname(file) === '.html')
  .reduce((acc, file) => {
    acc[path.basename(file, '.html')] = path.resolve(__dirname, file);
    return acc;
  }, {});

const contentSecurityPolicy = [
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
].join('; ');

const securityHeaders = {
  'Content-Security-Policy': contentSecurityPolicy,
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

// https://vitejs.dev/config/
export default defineConfig({
  build: {
    rollupOptions: {
      input: allHtmlEntries,
    },
  },
  server: {
    // Keep stable for Miro Developer Portal “App URL” during local testing.
    port: 3009,
    headers: securityHeaders,
  },
  preview: {
    headers: securityHeaders,
  },
});
