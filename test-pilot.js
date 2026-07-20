'use strict';
const fs = require('fs');
const assert = require('assert');
const server = fs.readFileSync('server.js', 'utf8');
const html = fs.readFileSync('index.html', 'utf8');
const admin = fs.readFileSync('admin.html', 'utf8');
const account = fs.readFileSync('account-store.js', 'utf8');
const openDataCode = fs.readFileSync('open-data.js', 'utf8');
const {
  parseWmsCapabilities,
  summarizeRayicCsv,
  matchesLocation,
  buildPilotCatalog,
  analyzePngVisibility
} = require('./open-data');
const { PNG } = require('pngjs');

(async () => {
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
    /pathname === '\/api\/open-data\/wms-info'/,
    /pathname === '\/api\/open-data\/wms-probe'/
  ]) assert(pattern.test(server), `Eksik rota: ${pattern}`);

  assert(!/Math\.random\s*\(/.test(server + html + account + openDataCode), 'Rastgele veri üretimi bulunmamalı.');
  assert(!/mockData\s*:\s*true/.test(server + html), 'Mock veri açık olmamalı.');
  assert(server.includes("dataMode: 'live-only'"), 'Canlı veri modu belirtilmemiş.');
  assert(server.includes("version: '1.5.1'"), 'Sunucu sürümü 1.5.1 değil.');
  assert(server.includes('TKGM, seçilen mahallede bu ada/parsel kaydını bulamadı'), 'TKGM 404 kullanıcı mesajı eksik.');

  assert(html.includes('TUCBS’de Bu Konumu Aç'), 'TUCBS geçişi eksik.');
  assert(html.includes('Katmanın mevcut olduğu kesinmiş gibi gösterilmez'), 'TUCBS doğruluk uyarısı eksik.');
  assert(html.includes('service-strip') && html.includes('process-step'), 'Durum ve ilerleme ekranı eksik.');
  assert((html.match(/<button[^>]+data-layer-toggle=/g) || []).length === 5, 'Üst görünürlük düğmeleri eksik.');
  assert(html.includes("setLayerVisibility('poi',true)"), 'Yakın yer aramasında işaretçileri açma eksik.');
  assert(html.includes('createDirectWmsLayer') && html.includes('discoverBrowserWmsLayers'), 'Tarayıcıdan WMS keşfi eksik.');
  assert(html.includes('probeWmsInBrowser') && html.includes('/open-data/wms-probe'), 'WMS görsel doğrulaması eksik.');
  assert(html.includes('Şeffaf veya boş görüntü başarı sayılmaz'), 'Boş WMS güvenlik uyarısı eksik.');
  assert(!html.includes('Servisi Aç ↗'), 'Teknik WMS XML bağlantısı kullanıcı ekranında görünmemeli.');
  assert(html.includes('resmî WMS görüntüsü parsel çevresinde kontrol edilir'), 'WMS görsel doğrulama açıklaması eksik.');

  assert(html.includes('id="legend-modal"') && html.includes('Renk Rehberi'), 'Gömülü renk rehberi eksik.');
  assert(html.includes('focusOpenDataPlan') && html.includes('Plan Ölçeğine Git'), 'Plan ölçeği görünüm düzeltmesi eksik.');
  assert(html.includes('22.01.2026') && html.includes('RGB 255/250/38'), 'Resmî 2026 ÇDP renk rehberi eksik.');
  assert(!html.includes('Renk Lejantı ↗'), 'Teknik GetLegendGraphic bağlantısı kullanıcı ekranında görünmemeli.');

  assert(admin.includes('Yeni kullanıcı') && account.includes('CREATE TABLE IF NOT EXISTS users'), 'Kullanıcı yönetimi eksik.');
  assert(html.includes('örnek, sanal veya tahmini parsel/yakın yer sonucu üretmez'), 'Canlı veri ilkesi görünmüyor.');
  assert(html.includes('Katmanlar otomatik yüklenmez') && html.includes('Açık Katmanları Kontrol Et'), 'İsteğe bağlı açık katman arayüzü eksik.');
  assert(html.includes('en son') && html.includes('veri sağlayıcısının güncel kaydını kontrol edin'), 'Veri güncelliği uyarısı eksik.');

  const wms = parseWmsCapabilities('<WMS_Capabilities version="1.3.0"><Capability><Layer><Title>Kök</Title><Layer><Name>plan:cdp</Name><Title>Plan Katmanı</Title></Layer></Layer></Capability></WMS_Capabilities>');
  assert(wms.layers.some(row => row.name === 'plan:cdp'), 'WMS katman ayrıştırma başarısız.');

  const summary = summarizeRayicCsv('Mahalle;Arsa Rayiç Değeri (TL/m2)\nA;1250,50\nB;980,00\nC;1500,00', '2025 Rayiç', '2025 CSV');
  assert(summary && summary.min === 980 && summary.max === 1500 && summary.dataYear === 2025, 'Rayiç CSV özeti başarısız.');
  assert(matchesLocation({provinces:['Giresun'],districts:['Görele']},'Giresun','Görele'), 'Pilot bölge eşleştirmesi başarısız.');

  const transparent = new PNG({ width: 16, height: 16 });
  transparent.data.fill(0);
  assert.strictEqual(analyzePngVisibility(PNG.sync.write(transparent)).visible, false, 'Tam şeffaf WMS görüntüsü görünür sayılmamalı.');
  const colored = new PNG({ width: 16, height: 16 });
  for (let i = 0; i < colored.data.length; i += 4) { colored.data[i] = 255; colored.data[i + 1] = 250; colored.data[i + 2] = 38; colored.data[i + 3] = 255; }
  assert.strictEqual(analyzePngVisibility(PNG.sync.write(colored)).visible, true, 'Renkli WMS görüntüsü görünür sayılmalı.');

  // Yozgat için katalog oluşturma internet gerektirmez: WMS tanımı doğrudan hazırlanmalıdır.
  const catalog = await buildPilotCatalog({ province: 'Yozgat', district: 'Yerköy' });
  const ysk = catalog.items.find(item => item.id === 'cdp-ysk');
  assert(ysk?.type === 'wms', 'Yozgat WMS kaynağı sunucu doğrulaması olmadan listelenmedi.');
  assert(ysk?.wms?.loadMode === 'browser-direct', 'WMS tarayıcıdan doğrudan yükleme modunda değil.');
  assert(ysk?.wms?.layerCandidates?.includes('0'), 'WMS güvenli katman adayı eksik.');
  assert(catalog.wmsLoadMode === 'browser-direct', 'Katalog WMS yükleme modu eksik.');

  console.log('Kadastro360 Web Pilot v1.5.1 doğrulaması geçti.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
