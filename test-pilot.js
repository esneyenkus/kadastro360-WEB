'use strict';
const fs = require('fs');
const assert = require('assert');
const server = fs.readFileSync('server.js', 'utf8');
const html = fs.readFileSync('index.html', 'utf8');
for (const pattern of [
  /pathname === '\/api\/iller'/,
  /\^\\\/api\\\/ilceler/,
  /\^\\\/api\\\/mahalleler/,
  /\^\\\/api\\\/parsel/,
  /pathname === '\/api\/terrain-analysis'/,
  /pathname === '\/api\/poi'/
]) {
  assert(pattern.test(server), `Eksik gerçek veri rotası: ${pattern}`);
}
assert(!/Math\.random\s*\(/.test(server + html), 'Rastgele veri üretimi bulunmamalı.');
assert(!/mockData\s*:\s*true/.test(server + html), 'Mock veri açık olmamalı.');
assert(server.includes("dataMode: 'live-only'"), 'Canlı veri modu belirtilmemiş.');
assert(html.includes('örnek, sanal veya tahmini parsel/yakın yer sonucu üretmez'), 'Canlı veri ilkesi arayüzde görünmüyor.');
console.log('Kadastro360 Web Pilot doğrulaması geçti.');
