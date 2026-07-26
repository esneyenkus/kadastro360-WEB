'use strict';

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const { WMS_CONFIGS, wmsCapabilitiesDocument, wmsTile, wmsSnapshot, wmsLegend, tileMercatorBounds } = require('./open-data');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}
function close(server) { return new Promise(resolve => server.close(resolve)); }

function solidPng(size) {
  const png = new PNG({ width: size, height: size });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 255; png.data[i + 1] = 250; png.data[i + 2] = 38; png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

function edgeOnlyPng(size) {
  const png = new PNG({ width: size, height: size });
  png.data.fill(0);
  const edgeHeight = Math.max(8, Math.floor(size * 0.18));
  for (let y = 0; y < edgeHeight; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      png.data[i] = 110; png.data[i + 1] = 70; png.data[i + 2] = 35; png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

(async () => {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  assert(html.includes('waitForProxyWmsLayer') && html.includes('createPersistentViewportWmsLayer'), 'Dinamik proxy WMS karo akışı eksik.');
  assert(html.includes('/api/open-data/wms-capabilities/') && html.includes('localLeafNames'), 'CORS engelinde çalışan WMS katman keşfi yedeği eksik.');
  assert(html.includes("loadMode:'retina-proxy-tiles'") && html.includes('k360-wms-retina-tile'), 'Yüksek çözünürlüklü WMS karo modu eksik.');
  assert(html.includes('size=${size}') && html.includes('tileRequestSize'), '2× WMS karo boyutu eksik.');
  assert(html.includes('Parsel merkezinde gerçek plan içeriği doğrulanamadığı için katman açık sayılmadı'), 'Boş parsel merkezini reddeden kontrol eksik.');
  assert(html.includes('legend-preview-modal') && html.includes('openLegendPreview'), 'Lejant büyütme penceresi eksik.');

  const requests = [];
  const mock = http.createServer((req, res) => {
    requests.push(req.url);
    const url = new URL(req.url, 'http://127.0.0.1');
    const requestName = url.searchParams.get('REQUEST') || url.searchParams.get('request') || '';
    if (/GetCapabilities/i.test(requestName)) {
      const xml = '<?xml version="1.0"?><WMS_Capabilities version="1.1.1"><Capability><Layer><Title>Kök</Title><Layer><Name>0</Name><Title>Genel Plan</Title></Layer><Layer><Name>malkara-pafta</Name><Title>Malkara Plan Paftası</Title><LatLonBoundingBox minx="26.5" miny="40.7" maxx="27.5" maxy="41.2"/></Layer></Layer></Capability></WMS_Capabilities>';
      res.writeHead(200, { 'Content-Type':'application/xml', 'Content-Length':Buffer.byteLength(xml) });
      return res.end(xml);
    }
    const width = Math.max(64, Math.min(1024, Number(url.searchParams.get('WIDTH')) || 512));
    const layer = url.searchParams.get('LAYERS') || url.searchParams.get('layer') || '';
    const body = /edgeonly/i.test(layer) ? edgeOnlyPng(width) : solidPng(width);
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': body.length });
    res.end(body);
  });
  const port = await listen(mock);
  const config = WMS_CONFIGS.find(row => row.key === 'cdp-ysk');
  const original = config.baseUrl;
  config.baseUrl = `http://127.0.0.1:${port}/wms`;
  try {
    const capabilities = await wmsCapabilitiesDocument('cdp-ysk');
    assert(/malkara-pafta/.test(capabilities.buffer.toString('utf8')), 'Sunucu üzerinden WMS alt katman listesi alınamadı.');

    const beforeTile = requests.length;
    const bounds = tileMercatorBounds(8, 148, 96);
    assert.strictEqual(bounds.length, 4);
    assert(bounds.every(Number.isFinite), 'Karo BBOX hesaplaması geçersiz.');

    const first = await wmsTile({ key: 'cdp-ysk', layerName: '0', version: '1.1.1', z: 8, x: 148, y: 96, size: 512 });
    assert.strictEqual(first.cache, 'MISS');
    assert.strictEqual(first.contentType, 'image/png');
    assert(first.buffer.length > 0, 'WMS karo gövdesi boş döndü.');
    const decoded = PNG.sync.read(first.buffer);
    assert.strictEqual(decoded.width, 512, 'WMS karo genişliği 2× çözünürlükte değil.');
    assert.strictEqual(decoded.height, 512, 'WMS karo yüksekliği 2× çözünürlükte değil.');

    const second = await wmsTile({ key: 'cdp-ysk', layerName: '0', version: '1.1.1', z: 8, x: 148, y: 96, size: 512 });
    assert.strictEqual(second.cache, 'HIT', 'İkinci WMS karo isteği önbellekten gelmedi.');
    assert.strictEqual(requests.length, beforeTile + 1, 'Önbellek WMS kaynağına ikinci kez istek gönderdi.');
    assert(/REQUEST=GetMap/i.test(requests[beforeTile]) && /WIDTH=512/i.test(requests[beforeTile]) && /BBOX=/i.test(requests[beforeTile]), '2× WMS karo parametreleri eksik.');
    await assert.rejects(() => wmsTile({ key: 'cdp-ysk', layerName: '0&bad=1', version: '1.1.1', z: 8, x: 148, y: 96 }), /Geçersiz/);

    const beforeSnapshot = requests.length;
    const snapshot = await wmsSnapshot({
      key: 'cdp-ysk', layerName: '0', version: '1.1.1',
      latitude: 39.7, longitude: 35.2, radiusKm: 6, size: 1024
    });
    assert.strictEqual(snapshot.contentType, 'image/png');
    assert.strictEqual(snapshot.analysis.visible, true, 'Plan görüntüsü görünür olmalı.');
    assert.strictEqual(snapshot.analysis.centerVisible, true, 'Parsel merkezi görünür olmalı.');
    assert.strictEqual(requests.length, beforeSnapshot + 1, 'Plan doğrulama görüntüsü tek kaynak isteğiyle alınmalı.');
    assert(/REQUEST=GetMap/i.test(requests.at(-1)) && /WIDTH=1024/i.test(requests.at(-1)), 'Plan doğrulama parametreleri eksik.');

    await assert.rejects(() => wmsSnapshot({
      key: 'cdp-ysk', layerName: 'edgeonly', version: '1.1.1',
      latitude: 39.7, longitude: 35.2, radiusKm: 6, size: 512
    }), /merkezinde|boş|görünür/i, 'Yalnızca uzakta içerik bulunan plan reddedilmelidir.');

    const beforeLegend = requests.length;
    const legend = await wmsLegend({ key: 'cdp-ysk', layerName: '0', version: '1.1.1' });
    assert.strictEqual(legend.contentType, 'image/png');
    assert.strictEqual(requests.length, beforeLegend + 1, 'WMS lejantı tek kaynak isteğiyle alınmalı.');
    assert(/REQUEST=GetLegendGraphic/i.test(requests.at(-1)), 'WMS lejant isteği eksik.');
  } finally {
    config.baseUrl = original;
    await close(mock);
  }
  console.log('Kadastro360 2× WMS karo, merkez görünürlük, önbellek ve lejant testi geçti.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
