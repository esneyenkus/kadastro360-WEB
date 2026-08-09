'use strict';

const fs = require('fs');
const assert = require('assert');

const html = fs.readFileSync('index.html', 'utf8');
const server = fs.readFileSync('server.js', 'utf8');

// Inline tarayıcı kodunun JavaScript sözdizimini parse et.
const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]).filter(Boolean);
assert(inlineScripts.length, 'index.html içinde inline script bulunamadı.');
for (const source of inlineScripts) new Function(source);

// Kullanıcının istediği dört regresyon kilidi.
assert(html.includes("event.key==='ArrowDown'||event.key==='ArrowUp'"), 'İl/ilçe/mahalle klavye gezinmesi eksik.');
assert(html.includes("event.key==='Enter'&&drop.classList.contains('open')"), 'Enter ile seçim onayı eksik.');
assert(html.includes('controller.pendingRefresh=true'), 'WMS zoom/kaydırma istek birleştirme eksik.');
assert(html.includes("opacity:0,interactive:false"), 'WMS atomik görünürlük koruması eksik.');
assert(html.includes('const scale=Math.max(1,Math.min(pixelRatio,2048/rawW,1536/rawH));'), 'Geniş ekran WMS en-boy oranı düzeltmesi eksik.');
assert(html.includes("scope:'district-center'"), 'Tarayıcı yakın yer ilçe merkezi yedeği eksik.');
assert(html.includes('centerOpaqueRatio'), 'Malkara merkez kapsama doğrulaması eksik.');
assert(html.includes('const choiceScope=['), 'WMS seçim önbelleği il/ilçe bazında değil.');

assert(server.includes("if (keys.some(key => key === 'bank' || key === 'atm'))"), 'Banka/ATM küçük tarayıcı sorgularına bölünmüyor.');
assert(server.includes("item.searchScope === 'district-center' || item.centerDistance <= safeRadius * 1.03"), 'İlçe merkezi POI normalizasyonu eksik.');
assert(server.includes('includeDistrictAnchor'), 'Tarayıcı POI planında ilçe merkezi bilgisi eksik.');
assert(server.includes("version: '2.0.9.1-pilot-stability-fix'"), 'Sunucu sürüm işareti güncel değil.');

console.log('Kadastro360 v2.0.9.1 regresyon kontrolleri geçti.');
