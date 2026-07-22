'use strict';

const assert = require('assert');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}
function close(server) { return new Promise(resolve => server.close(resolve)); }

function queryRadiusMeters(query) {
  const match = query.match(/\((-?\d+\.\d+),(-?\d+\.\d+),(-?\d+\.\d+),(-?\d+\.\d+)\)/);
  if (!match) return 0;
  const south = Number(match[1]);
  const north = Number(match[3]);
  return Math.round(Math.abs(north - south) * 111320 / 2);
}

function requestedElements(query, radius) {
  const elements = [];
  const farEnough = radius >= 19000;
  const add = (condition, element) => { if (condition) elements.push(element); };

  // Kırsal örnek: 10 km içinde yalnızca cami ve sağlık noktası var.
  add(query.includes('place_of_worship'), { type:'node', id:1, lat:40.050, lon:27.050, tags:{ amenity:'place_of_worship', religion:'muslim', name:'Köy Camii' } });
  add(query.includes('healthcare') || query.includes('hospital|clinic'), { type:'node', id:2, lat:40.070, lon:27.070, tags:{ amenity:'clinic', name:'Aile Sağlığı Merkezi' } });

  // Okul, market, eczane, banka ve ATM ilçe merkezinde yaklaşık 20 km uzakta.
  add(farEnough && query.includes('school|kindergarten'), { type:'node', id:3, lat:40.140, lon:27.140, tags:{ amenity:'school', name:'İlçe Okulu' } });
  add(farEnough && query.includes('supermarket|convenience'), { type:'node', id:4, lat:40.145, lon:27.145, tags:{ shop:'supermarket', name:'İlçe Marketi' } });
  add(farEnough && query.includes('amenity"="pharmacy'), { type:'node', id:5, lat:40.150, lon:27.150, tags:{ amenity:'pharmacy', name:'Merkez Eczanesi' } });
  add(farEnough && query.includes('amenity"="bank'), { type:'node', id:6, lat:40.155, lon:27.155, tags:{ amenity:'bank', name:'Merkez Bankası' } });
  add(farEnough && query.includes('amenity"="atm'), { type:'node', id:7, lat:40.160, lon:27.160, tags:{ amenity:'atm', name:'Merkez ATM' } });
  add(farEnough && query.includes('amenity"="bus_station'), { type:'node', id:8, lat:40.165, lon:27.165, tags:{ amenity:'bus_station', name:'İlçe Otogarı' } });
  return elements;
}

(async () => {
  const radii = [];
  const mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const form = new URLSearchParams(body);
      const query = form.get('data') || '';
      const radius = queryRadiusMeters(query);
      radii.push(radius);
      const payload = JSON.stringify({ version:0.6, elements:requestedElements(query, radius) });
      res.writeHead(200, { 'Content-Type':'application/json', 'Content-Length':Buffer.byteLength(payload) });
      res.end(payload);
    });
  });

  const port = await listen(mock);
  process.env.OVERPASS_BASE_URLS = `http://127.0.0.1:${port}/api/interpreter`;
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'k360-poi-rural-'));
  process.env.TEST_USERNAME = 'admin';
  process.env.TEST_PASSWORD = 'poi-rural-test-password';
  process.env.SESSION_SECRET = 'poi-rural-session-secret-at-least-32-chars';
  const { getPoi } = require('./server');

  try {
    const result = await getPoi(40, 27, 'auto', 'all', null);
    const found = new Set(result.items.map(item => item.type));
    for (const category of ['school','market','mosque','pharmacy','hospital','bank','atm','bus_terminal']) {
      assert(found.has(category), `Kırsal geniş taramada ${category} bulunamadı.`);
    }
    for (const category of ['school','market','pharmacy','bank','atm']) {
      assert(result.coverage[category].radius >= 20000, `${category} 10 km'de erken kesildi.`);
      assert.strictEqual(result.coverage[category].status, 'found', `${category} geniş taramada bulunmuş görünmüyor.`);
    }
    assert(radii.some(radius => radius >= 19000), 'Akıllı arama 20 km aşamasına genişlemedi.');
  } finally {
    await close(mock);
  }
  console.log('Kadastro360 kırsal parsel 30 km kategori genişletme testi geçti.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
