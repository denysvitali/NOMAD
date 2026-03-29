#!/usr/bin/env node
// Startup script to inject SENTRY_DSN into the built client at runtime
// This runs when the container starts, allowing DSN configuration without rebuilding

const fs = require('fs');
const path = require('path');

const indexHtmlPath = path.join(__dirname, '../public/index.html');

if (!process.env.SENTRY_DSN) {
  console.log('[Sentry] SENTRY_DSN not set - client-side error tracking disabled');
  process.exit(0);
}

if (!fs.existsSync(indexHtmlPath)) {
  console.warn('[Sentry] index.html not found at', indexHtmlPath, '- skipping DSN injection');
  process.exit(0);
}

const dsn = process.env.SENTRY_DSN;
const script = `<script>window.SENTRY_DSN="${dsn}";</script>`;

let html = fs.readFileSync(indexHtmlPath, 'utf8');

// Check if already injected
if (html.includes('window.SENTRY_DSN')) {
  console.log('[Sentry] DSN already injected into index.html');
  process.exit(0);
}

// Inject right after <head> tag
if (html.includes('<head>')) {
  html = html.replace('<head>', `<head>\n${script}`);
} else {
  console.warn('[Sentry] Could not find <head> tag in index.html');
  process.exit(1);
}

fs.writeFileSync(indexHtmlPath, html);
console.log('[Sentry] Client DSN injected into index.html');
