'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const required = [
  'kadastro360-logo-horizontal.png',
  'kadastro360-logo-vertical.png',
  'kadastro360-mark.png',
  'favicon.ico',
  'favicon-32.png',
  'favicon-16.png',
  'apple-touch-icon.png',
  'icon-192.png',
  'icon-512.png'
];

const missing = [];
for (const name of required) {
  const file = path.join(ROOT, 'assets', name);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile() || fs.statSync(file).size < 100) {
    missing.push(name);
  }
}

const sources = ['server.js', 'index.html', 'admin.html'];
for (const source of sources) {
  const file = path.join(ROOT, source);
  if (!fs.existsSync(file)) throw new Error(`Zorunlu dosya eksik: ${source}`);
  const text = fs.readFileSync(file, 'utf8');
  if (!text.includes('/assets/kadastro360-logo-horizontal.png')) {
    throw new Error(`${source} yatay logo yolunu içermiyor.`);
  }
}

if (missing.length) {
  throw new Error(`Eksik/boş marka dosyaları: ${missing.join(', ')}`);
}

console.log(`Logo doğrulaması geçti: ${required.length} marka dosyası hazır.`);
