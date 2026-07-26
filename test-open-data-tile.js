'use strict';

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const { WMS_CONFIGS, wmsTile, wmsSnapshot, wmsLegend, tileMercatorBounds } = require('./open-data');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}
function close(server) { return new Promise(resolve => server.close(resolve)); }

(async () => {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  assert(html.includes('externalWmsViewportUrl') && html.includes('createPersistentViewportWmsLayer'), 'Sabit tarayıcı ImageOverlay akışı eksik.');
  assert(html.includes("'browser-viewport'") && html.includes("'server-viewport-cache'"), 'Hibrit sabit görüntü modları eksik.');
  assert(html.includes('stableWmsView') && html.includes('findVisibleWmsAttempt'), 'Sabit görünüm ve görünür katman doğrulaması eksik.');
  assert(html.includes("loadMode:'browser-tile-emergency'"), 'Acil WMS karo yedeği eksik.');
  assert(html.includes('legend-preview-modal') && html.includes('openLegendPreview'), 'Lejant büyütme penceresi eksik.');

  const png = new PNG({ width: 256, height: 256 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 255; png.data[i + 1] = 250; png.data[i + 2] = 38; png.data[i + 3] = 255;
  }
  const body = PNG.sync.write(png);
  const requests = [];
  const mock = http.createServer((req, res) => {
    requests.push(req.url);
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': body.length });
    res.end(body);
  });
  const port = await listen(mock);
  const config = WMS_CONFIGS.find(row => row.key === 'cdp-ysk');
  const original = config.baseUrl;
  config.baseUrl = `http://127.0.0.1:${port}/wms`;
  try {
    const bounds = tileMercatorBounds(8, 148, 96);
    assert.strictEqual(bounds.length, 4);
    assert(bounds.every(Number.isFinite), 'Karo BBOX hesaplaması geçersiz.');
    const first = await wmsTile({ key: 'cdp-ysk', layerName: '0', version: '1.1.1', z: 8, x: 148, y: 96, size: 256 });
    assert.strictEqual(first.cache, 'MISS');
    assert.strictEqual(first.contentType, 'image/png');
    assert(first.buffer.length > 0, 'WMS karo gövdesi boş döndü.');
    const decoded = PNG.sync.read(first.buffer);
    assert.strictEqual(decoded.width, 256, 'WMS karo genişliği beklenen değer değil.');
    assert.strictEqual(decoded.height, 256, 'WMS karo yüksekliği beklenen değer değil.');
    const second = await wmsTile({ key: 'cdp-ysk', layerName: '0', version: '1.1.1', z: 8, x: 148, y: 96, size: 256 });
    assert.strictEqual(second.cache, 'HIT', 'İkinci WMS karo isteği önbellekten gelmedi.');
    assert.strictEqual(requests.length, 1, 'Önbellek WMS kaynağına ikinci kez istek gönderdi.');
    assert(/REQUEST=GetMap/i.test(requests[0]) && /WIDTH=256/i.test(requests[0]) && /BBOX=/i.test(requests[0]), 'WMS karo parametreleri eksik.');
    await assert.rejects(() => wmsTile({ key: 'cdp-ysk', layerName: '0&bad=1', version: '1.1.1', z: 8, x: 148, y: 96 }), /Geçersiz/);

    const beforeSnapshot = requests.length;
    const snapshot = await wmsSnapshot({
      key: 'cdp-ysk', layerName: '0', version: '1.1.1',
      latitude: 39.7, longitude: 35.2, radiusKm: 14, size: 1024
    });
    assert.strictEqual(snapshot.contentType, 'image/png');
    assert.strictEqual(snapshot.analysis.visible, true, 'Sabit WMS plan görüntüsü görünür olmalı.');
    assert.strictEqual(requests.length, beforeSnapshot + 1, 'Sabit WMS görüntüsü tek kaynak isteğiyle alınmalı.');
    assert(/REQUEST=GetMap/i.test(requests.at(-1)) && /WIDTH=1024/i.test(requests.at(-1)), 'Sabit WMS görüntü parametreleri eksik.');
    await wmsSnapshot({ key: 'cdp-ysk', layerName: '0', version: '1.1.1', latitude: 39.7, longitude: 35.2, radiusKm: 14, size: 1024 });
    assert.strictEqual(requests.length, beforeSnapshot + 1, 'Sabit WMS görüntüsü önbellekten gelmedi.');

    const beforeLegend = requests.length;
    const legend = await wmsLegend({ key: 'cdp-ysk', layerName: '0', version: '1.1.1' });
    assert.strictEqual(legend.contentType, 'image/png');
    assert.strictEqual(requests.length, beforeLegend + 1, 'WMS lejantı tek kaynak isteğiyle alınmalı.');
    assert(/REQUEST=GetLegendGraphic/i.test(requests.at(-1)), 'WMS lejant isteği eksik.');
  } finally {
    config.baseUrl = original;
    await close(mock);
  }
  console.log('Kadastro360 WMS sabit pilot görünümü, görünür katman doğrulaması, lejant ve önbellek testi geçti.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
