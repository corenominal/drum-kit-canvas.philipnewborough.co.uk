#!/usr/bin/env node

/**
 * cache-bust.js
 *
 * Computes a content hash for main.css and main.js and updates their
 * references in public/index.html and public/sw.js using query strings
 * (?v={hash}).  Also bumps the SW CACHE_NAME so stale caches are purged.
 *
 * Usage: node cache-bust.js
 */

import { createHash } from 'crypto';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const HTML = join(__dirname, 'public', 'index.html');
const SW   = join(__dirname, 'public', 'sw.js');

const TARGETS = [
  {
    file:    join(__dirname, 'public', 'css', 'main.css'),
    htmlRef: /css\/main\.css(?:\?v=[a-f0-9]+)?/,
    swRef:   /\/css\/main\.css(?:\?v=[a-f0-9]+)?/,
    htmlNew: (h) => `css/main.css?v=${h}`,
    swNew:   (h) => `/css/main.css?v=${h}`,
  },
  {
    file:    join(__dirname, 'public', 'js', 'main.js'),
    htmlRef: /js\/main\.js(?:\?v=[a-f0-9]+)?/,
    swRef:   /\/js\/main\.js(?:\?v=[a-f0-9]+)?/,
    htmlNew: (h) => `js/main.js?v=${h}`,
    swNew:   (h) => `/js/main.js?v=${h}`,
  },
];

function shortHash(filePath) {
  const content = readFileSync(filePath);
  return createHash('md5').update(content).digest('hex').slice(0, 8);
}

let html = readFileSync(HTML, 'utf8');
let sw   = readFileSync(SW, 'utf8');

for (const { file, htmlRef, swRef, htmlNew, swNew } of TARGETS) {
  const hash = shortHash(file);
  html = html.replace(htmlRef, htmlNew(hash));
  sw   = sw.replace(swRef,   swNew(hash));
  console.log(`${file.split('/').pop()} → ?v=${hash}`);
}

// Bump the SW CACHE_NAME so stale caches are purged
sw = sw.replace(
  /(const CACHE_NAME\s*=\s*['"][^'"]+\.)(\d+)(['"]\s*;)/,
  (_, prefix, num, suffix) => `${prefix}${parseInt(num, 10) + 1}${suffix}`
);

writeFileSync(HTML, html, 'utf8');
console.log('Updated: public/index.html');

writeFileSync(SW, sw, 'utf8');
console.log('Updated: public/sw.js');
