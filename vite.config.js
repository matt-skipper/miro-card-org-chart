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
  },
});
