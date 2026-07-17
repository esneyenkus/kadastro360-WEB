'use strict';
const fs = require('fs');
const assert = require('assert');
const server = fs.readFileSync('server.js', 'utf8');
const html = fs.readFileSync('index.html', 'utf8');
const admin = fs.readFileSync('admin.html', 'utf8');
const account = fs.readFileSync('account-store.js', 'utf8');
const openDataCode = fs.readFileSync('open-data.js', 'utf8');
const { parseWmsCapabilities, summarizeRayicCsv, matchesLocation } = require('./open-data');
for (const pattern of [
  /pathname === '\/api\/iller'/,
  /\^\\\/api\\\/ilceler/,
  /\^\\\/api\\\/mahalleler/,
  /\^\\\/api\\\/parsel/,
  /pathname === '\/api\/terrain-analysis'/,
  /pathname === '\/api\/poi'/,
  /pathname === '\/api\/services'/,
  /pathname === '\/api\/history'/,
  /pathname === '\/api\/admin\/users'/,
  /pathname === '\/api\/open-data\/catalog'/,
  /pathname === '\/api\/open-data\/geojson'/,
  /pathname === '\/api\/open-data\/wms-info'/
]) assert(pattern.test(server), `Eksik rota: ${pattern}`);
assert(!/Math\.random\s*\(/.test(server + html + account + openDataCode), 'Rastgele veri üretimi bulunmamalı.');
assert(!/mockData\s*:\s*true/.test(server + html), 'Mock veri açık olmamalı.');
assert(server.includes("dataMode: 'live-only'"), 'Canlı veri modu belirtilmemiş.');
assert(html.includes('TUCBS’de Bu Konumu Aç'), 'TUCBS geçişi eksik.');
assert(html.includes('Katmanın mevcut olduğu kesinmiş gibi gösterilmez'), 'TUCBS doğruluk uyarısı eksik.');
assert(html.includes('service-strip') && html.includes('process-step'), 'Durum ve ilerleme ekranı eksik.');
assert(admin.includes('Yeni kullanıcı') && account.includes('CREATE TABLE IF NOT EXISTS users'), 'Kullanıcı yönetimi eksik.');
assert(html.includes('örnek, sanal veya tahmini parsel/yakın yer sonucu üretmez'), 'Canlı veri ilkesi görünmüyor.');
assert(html.includes('Katmanlar otomatik yüklenmez') && html.includes('Açık Katmanları Kontrol Et'), 'İsteğe bağlı açık katman arayüzü eksik.');
assert(html.includes('en son') && html.includes('veri sağlayıcısının güncel kaydını kontrol edin'), 'Veri güncelliği uyarısı eksik.');
const wms = parseWmsCapabilities('<WMS_Capabilities version="1.3.0"><Capability><Layer><Title>Kök</Title><Layer><Name>plan:cdp</Name><Title>Plan Katmanı</Title></Layer></Layer></Capability></WMS_Capabilities>');
assert(wms.layers.some(row => row.name === 'plan:cdp'), 'WMS katman ayrıştırma başarısız.');
const summary = summarizeRayicCsv('Mahalle;Arsa Rayiç Değeri (TL/m2)\nA;1250,50\nB;980,00\nC;1500,00', '2025 Rayiç', '2025 CSV');
assert(summary && summary.min === 980 && summary.max === 1500 && summary.dataYear === 2025, 'Rayiç CSV özeti başarısız.');
assert(matchesLocation({provinces:['Giresun'],districts:['Görele']},'Giresun','Görele'), 'Pilot bölge eşleştirmesi başarısız.');
console.log('Kadastro360 Web Pilot v1.2 doğrulaması geçti.');
