'use strict';
const fs = require('fs');
const assert = require('assert');
const server = fs.readFileSync('server.js', 'utf8');
const html = fs.readFileSync('index.html', 'utf8');
const admin = fs.readFileSync('admin.html', 'utf8');
const account = fs.readFileSync('account-store.js', 'utf8');
for (const pattern of [
  /pathname === '\/api\/iller'/,
  /\^\\\/api\\\/ilceler/,
  /\^\\\/api\\\/mahalleler/,
  /\^\\\/api\\\/parsel/,
  /pathname === '\/api\/terrain-analysis'/,
  /pathname === '\/api\/poi'/,
  /pathname === '\/api\/services'/,
  /pathname === '\/api\/history'/,
  /pathname === '\/api\/admin\/users'/
]) assert(pattern.test(server), `Eksik rota: ${pattern}`);
assert(!/Math\.random\s*\(/.test(server + html + account), 'Rastgele veri üretimi bulunmamalı.');
assert(!/mockData\s*:\s*true/.test(server + html), 'Mock veri açık olmamalı.');
assert(server.includes("dataMode: 'live-only'"), 'Canlı veri modu belirtilmemiş.');
assert(html.includes('TUCBS’de Bu Konumu Aç'), 'TUCBS geçişi eksik.');
assert(html.includes('Katmanın mevcut olduğu kesinmiş gibi gösterilmez'), 'TUCBS doğruluk uyarısı eksik.');
assert(html.includes('service-strip') && html.includes('process-step'), 'Durum ve ilerleme ekranı eksik.');
assert(admin.includes('Yeni kullanıcı') && account.includes('CREATE TABLE IF NOT EXISTS users'), 'Kullanıcı yönetimi eksik.');
assert(html.includes('örnek, sanal veya tahmini parsel/yakın yer sonucu üretmez'), 'Canlı veri ilkesi görünmüyor.');
console.log('Kadastro360 Web Pilot v1.1 doğrulaması geçti.');
