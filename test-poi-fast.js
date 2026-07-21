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

(async () => {
  let requests = 0;
  const elements = [
    { type: 'node', id: 1, lat: 41.001, lon: 27.001, tags: { amenity: 'school', name: 'Test Okulu' } },
    { type: 'node', id: 2, lat: 41.002, lon: 27.002, tags: { shop: 'supermarket', name: 'Test Market' } },
    { type: 'node', id: 3, lat: 41.003, lon: 27.003, tags: { amenity: 'place_of_worship', religion: 'muslim', name: 'Test Camii' } },
    { type: 'node', id: 4, lat: 41.004, lon: 27.004, tags: { amenity: 'pharmacy', name: 'Test Eczanesi' } },
    { type: 'node', id: 5, lat: 41.005, lon: 27.005, tags: { amenity: 'hospital', name: 'Test Hastanesi' } },
    { type: 'node', id: 6, lat: 41.006, lon: 27.006, tags: { amenity: 'bank', name: 'Test Bankası' } },
    { type: 'node', id: 7, lat: 41.007, lon: 27.007, tags: { amenity: 'atm', name: 'Test ATM' } },
    { type: 'node', id: 8, lat: 41.008, lon: 27.008, tags: { natural: 'beach', name: 'Test Plajı' } },
    { type: 'node', id: 9, lat: 41.009, lon: 27.009, tags: { amenity: 'bus_station', name: 'Test Otogarı' } },
    { type: 'node', id: 10, lat: 41.010, lon: 27.010, tags: { railway: 'station', name: 'Test Garı' } },
    { type: 'node', id: 11, lat: 41.011, lon: 27.011, tags: { aeroway: 'aerodrome', name: 'Test Havaalanı' } }
  ];
  const mock = http.createServer((req, res) => {
    requests++;
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      assert(body.includes('data='), 'Overpass POST gövdesi eksik.');
      const payload = JSON.stringify({ version: 0.6, elements });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
      res.end(payload);
    });
  });
  const port = await listen(mock);
  process.env.OVERPASS_BASE_URLS = `http://127.0.0.1:${port}/api/interpreter`;
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'k360-poi-'));
  process.env.TEST_USERNAME = 'admin';
  process.env.TEST_PASSWORD = 'poi-test-password';
  process.env.SESSION_SECRET = 'poi-test-session-secret-at-least-32-chars';
  const { getPoi } = require('./server');
  try {
    const result = await getPoi(41, 27, 'auto', 'all', null);
    assert.strictEqual(result.items.length, 11, 'Toplu yakın yer taraması 11 kategoriyi döndürmedi.');
    assert.deepStrictEqual(result.searchedRadii, [5000], 'Bütün kategoriler 5 km içinde bulunduğunda gereksiz geniş tarama yapılmamalı.');
    assert(requests <= 3, `Yakın yer taraması çok fazla Overpass isteği gönderdi: ${requests}`);
    const before = requests;
    const cached = await getPoi(41, 27, 'auto', 'all', null);
    assert.strictEqual(cached.items.length, 11);
    assert.strictEqual(requests, before, 'Aynı konumdaki tekrar arama önbellekten gelmedi.');
  } finally {
    await close(mock);
  }
  console.log('Kadastro360 hızlı toplu yakın yer ve önbellek testi geçti.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
