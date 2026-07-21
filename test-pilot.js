'use strict';

const fs = require('fs');
const assert = require('assert');
const vm = require('vm');
const server = fs.readFileSync('server.js', 'utf8');
const html = fs.readFileSync('index.html', 'utf8');
const admin = fs.readFileSync('admin.html', 'utf8');
const account = fs.readFileSync('account-store.js', 'utf8');
const openDataCode = fs.readFileSync('open-data.js', 'utf8');
const tkgmCode = fs.readFileSync('tkgm-client.js', 'utf8');
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
    /pathname === '\/api\/idari\/ilceler'/,
    /pathname === '\/api\/idari\/mahalleler'/,
    /pathname === '\/api\/parsel-sorgu'/,
    /pathname === '\/api\/terrain-analysis'/,
    /pathname === '\/api\/poi'/,
    /pathname === '\/api\/route'/,
    /pathname === '\/api\/services'/,
    /pathname === '\/api\/history'/,
    /pathname === '\/api\/admin\/users'/,
    /pathname === '\/api\/open-data\/catalog'/,
    /pathname === '\/api\/open-data\/geojson'/,
    /pathname === '\/api\/open-data\/wms-info'/,
    /pathname === '\/api\/open-data\/wms-probe'/,
    /wms-tile/
  ]) assert(pattern.test(server), `Eksik rota: ${pattern}`);

  const inlineScripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(match => match[1]).filter(code => code.trim());
  const adminScripts = [...admin.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(match => match[1]).filter(code => code.trim());
  for (const [index, code] of [...inlineScripts, ...adminScripts].entries()) {
    new vm.Script(code, { filename: `inline-script-${index + 1}.js` });
  }

  const allCode = server + html + account + openDataCode + tkgmCode;
  assert(!/Math\.random\s*\(/.test(allCode), 'Uygulama kodunda rastgele veri üretimi bulunmamalı.');
  assert(!/mockData\s*:\s*true/.test(server + html), 'Mock veri açık olmamalı.');
  assert(server.includes("dataMode: 'live-only'"), 'Canlı veri modu belirtilmemiş.');
  assert(server.includes("version: '1.8.1'"), 'Sunucu sürümü 1.8.1 değil.');
  assert(tkgmCode.includes('TKGM, seçilen mahallede bu ada/parsel kaydını bulamadı'), 'TKGM parsel bulunamadı mesajı eksik.');

  assert(tkgmCode.includes('normalizeAdminItems'), 'TKGM idari veri normalizasyonu eksik.');
  assert(tkgmCode.includes('doubleSlashAdmin'), 'Eski TKGM çift-slash yedek yolu eksik.');
  assert(tkgmCode.indexOf("'ilId'") < tkgmCode.indexOf('properties?.fid'), 'Gerçek ilId, fid alanından önce değerlendirilmelidir.');
  assert(html.includes("api('/idari/ilceler'"), 'İlçe listesi yeni kaynak-bağlı uçtan alınmıyor.');
  assert(html.includes("api('/idari/mahalleler'"), 'Mahalle listesi yeni kaynak-bağlı uçtan alınmıyor.');
  assert(html.includes("api('/parsel-sorgu'"), 'Parsel yeni kaynak-bağlı uçtan sorgulanmıyor.');

  assert(html.includes('TUCBS’de Bu Konumu Aç'), 'TUCBS geçişi eksik.');
  assert(html.includes('Katmanın mevcut olduğu kesinmiş gibi gösterilmez'), 'TUCBS doğruluk uyarısı eksik.');
  assert(html.includes('service-strip') && html.includes('process-step'), 'Durum ve ilerleme ekranı eksik.');
  assert((html.match(/<button[^>]+data-layer-toggle=/g) || []).length === 5, 'Üst görünürlük düğmeleri eksik.');
  assert(html.includes("setLayerVisibility('poi',true)"), 'Yakın yer aramasında işaretçileri açma eksik.');
  assert(html.includes('discoverBrowserWmsLayers') && html.includes('waitForWmsLayer'), 'Tarayıcıdan WMS keşfi ve doğrudan karo yüklemesi eksik.');
  assert(html.includes('probeWmsInBrowser') && html.includes('/open-data/wms-probe'), 'WMS görsel doğrulaması eksik.');
  assert(html.includes('Şeffaf/boş WMS görüntüsü başarılı sayılmaz'), 'Boş WMS güvenlik uyarısı eksik.');
  assert(!html.includes('Servisi Aç ↗'), 'Teknik WMS XML bağlantısı kullanıcı ekranında görünmemeli.');
  assert(html.includes('resmî WMS görüntüsü parsel çevresinde doğrulanır'), 'WMS görsel doğrulama açıklaması eksik.');
  assert(html.includes('id="legend-window"') && html.includes('Renk Rehberi') && html.includes('initDraggableLegend'), 'Taşınabilir renk rehberi eksik.');
  assert(html.includes('focusOpenDataPlan') && html.includes('Plan Ölçeğine Git'), 'Plan ölçeği görünüm düzeltmesi eksik.');
  assert(html.includes('22.01.2026') && html.includes('RGB 255/250/38'), 'Resmî 2026 ÇDP renk rehberi eksik.');
  assert(!html.includes('Renk Lejantı ↗'), 'Teknik GetLegendGraphic bağlantısı kullanıcı ekranında görünmemeli.');

  assert(html.includes('createSharpWmsLayer') && html.includes('waitForWmsLayer') && html.includes('proxyWmsTileUrl') && html.includes('/api/open-data/wms-tile/'), 'Keskin doğrudan WMS ve proxy yedek yüklemesi eksik.');
  assert(html.includes('Harita yakınlığı korunuyor') && html.includes('Keskin karo görünümü'), 'Açık veri keskin karo açıklaması eksik.');
  assert(html.includes('parcel-locator') && html.includes('updateParcelLocator'), 'Parsel hedef animasyonu eksik.');
  assert(html.includes('sessionStorage') && html.includes('renderNeighborhoodComparisons'), 'Aynı mahalle geçici karşılaştırma önbelleği eksik.');
  assert(html.includes('parcelHaloPane') && html.includes('bringParcelToFront'), 'Parsel üst görünürlük katmanı eksik.');
  assert(html.includes('id="poi-route-planner"') && html.includes('route-draw-btn') && html.includes('poi-route-checkbox'), 'Seçilebilir yakın yer rota arayüzü eksik.');
  assert(html.includes('drawRoadRoutes') && html.includes("api('/route'") && html.includes('routePane'), 'Harita içi yol rotası çizimi eksik.');
  assert(html.includes('route-destination-label'), 'Varışta seçilen yer adı etiketi yok.');
  assert(html.includes('routeLineWeight'), 'Üst üste binen rotaları görünür tutan şerit hesabı yok.');
  assert(html.includes('routeConnector'), 'Parsel ve gerçek varış koordinatı bağlantı çizgisi yok.');
  assert(!html.includes('route-number-pin'), 'Eski numaralı varış ikonu kaldırılmamış.');
  assert(html.includes("['routePane',640]"), 'Rota katmanı parselin üstünde değil.');
  assert(html.includes('Rota alınamadı') && html.includes('${drawn}/${total}'), 'Kısmi rota sonucu hedef bazında gösterilmiyor.');
  assert(html.includes('tek toplu ve önbellekli taramayla'), 'Yakın yer hızlı toplu arama akışı eksik.');
  assert(html.includes('poi-accordion-grid') && html.includes('adet'), 'Tek akordeon kategori listesi eksik.');

  assert(admin.includes('Yeni kullanıcı') && account.includes('CREATE TABLE IF NOT EXISTS users'), 'Kullanıcı yönetimi eksik.');
  assert(html.includes('örnek, sanal veya tahmini parsel/yakın yer sonucu üretmez'), 'Canlı veri ilkesi görünmüyor.');
  assert(html.includes('Katmanlar otomatik yüklenmez') && html.includes('Açık Katmanları Kontrol Et'), 'İsteğe bağlı açık katman arayüzü eksik.');
  assert(html.includes('en son') && html.includes('veri sağlayıcısının güncel kaydını kontrol edin'), 'Veri güncelliği uyarısı eksik.');

  const wms = parseWmsCapabilities('<WMS_Capabilities version="1.3.0"><Capability><Layer><Title>Kök</Title><Layer><Name>plan:cdp</Name><Title>Plan Katmanı</Title></Layer></Layer></Capability></WMS_Capabilities>');
  assert(wms.layers.some(row => row.name === 'plan:cdp'), 'WMS katman ayrıştırma başarısız.');

  const summary = summarizeRayicCsv('Mahalle;Arsa Rayiç Değeri (TL/m2)\nA;1250,50\nB;980,00\nC;1500,00', '2025 Rayiç', '2025 CSV');
  assert(summary && summary.min === 980 && summary.max === 1500 && summary.dataYear === 2025, 'Rayiç CSV özeti başarısız.');
  assert(matchesLocation({ provinces: ['Giresun'], districts: ['Görele'] }, 'Giresun', 'Görele'), 'Pilot bölge eşleştirmesi başarısız.');

  const transparent = new PNG({ width: 16, height: 16 });
  transparent.data.fill(0);
  assert.strictEqual(analyzePngVisibility(PNG.sync.write(transparent)).visible, false, 'Tam şeffaf WMS görüntüsü görünür sayılmamalı.');
  const colored = new PNG({ width: 16, height: 16 });
  for (let i = 0; i < colored.data.length; i += 4) {
    colored.data[i] = 255; colored.data[i + 1] = 250; colored.data[i + 2] = 38; colored.data[i + 3] = 255;
  }
  assert.strictEqual(analyzePngVisibility(PNG.sync.write(colored)).visible, true, 'Renkli WMS görüntüsü görünür sayılmalı.');

  const catalog = await buildPilotCatalog({ province: 'Yozgat', district: 'Yerköy' });
  const ysk = catalog.items.find(item => item.id === 'cdp-ysk');
  assert(ysk?.type === 'wms', 'Yozgat WMS kaynağı listelenmedi.');
  assert(ysk?.wms?.loadMode === 'hybrid-direct-proxy', 'WMS doğrudan + proxy yedek karo modunda değil.');
  assert(catalog.wmsLoadMode === 'hybrid-direct-proxy', 'Katalog WMS yükleme modu eksik.');

  console.log('Kadastro360 Web Pilot v1.8.1 statik, rota ve açık veri doğrulaması geçti.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
