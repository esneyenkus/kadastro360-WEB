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
  let active = 0;
  let maxActive = 0;
  let requests = 0;
  const mock = http.createServer((req, res) => {
    requests++;
    active++;
    maxActive = Math.max(maxActive, active);
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const query = new URLSearchParams(body).get('data') || '';
      const box = query.match(/\((-?\d+\.\d+),(-?\d+\.\d+),(-?\d+\.\d+),(-?\d+\.\d+)\)/);
      const centerLat = box ? (Number(box[1]) + Number(box[3])) / 2 : 39.65;
      const centerLng = box ? (Number(box[2]) + Number(box[4])) / 2 : 34.47;
      const elements = [];
      if (/school|kindergarten/.test(query)) elements.push({type:'node',id:1,lat:centerLat+0.001,lon:centerLng+0.001,tags:{amenity:'school',name:'Yerköy Test Okulu'}});
      if (/supermarket|convenience/.test(query)) elements.push({type:'node',id:2,lat:centerLat+0.002,lon:centerLng+0.002,tags:{shop:'supermarket',name:'Yerköy Test Marketi'}});
      if (/place_of_worship/.test(query)) elements.push({type:'node',id:3,lat:centerLat+0.003,lon:centerLng+0.003,tags:{amenity:'place_of_worship',religion:'muslim',name:'Yerköy Test Camii'}});
      setTimeout(() => {
        active--;
        const payload = JSON.stringify({version:0.6,elements});
        res.writeHead(200, {'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)});
        res.end(payload);
      }, 25);
    });
  });

  const port = await listen(mock);
  process.env.OVERPASS_BASE_URLS = `http://127.0.0.1:${port}/api/interpreter`;
  process.env.OVERPASS_REQUEST_GAP_MS = '1';
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'k360-poi-queue-'));
  process.env.TEST_USERNAME = 'admin';
  process.env.TEST_PASSWORD = 'poi-queue-password';
  process.env.SESSION_SECRET = 'poi-queue-session-secret-at-least-32-chars';
  const { getPoi } = require('./server');

  try {
    const [a, b] = await Promise.all([
      getPoi(39.65, 34.47, '10000', 'all', null),
      getPoi(39.75, 34.57, '10000', 'all', null)
    ]);
    assert(a.items.some(item => item.type === 'school'));
    assert(b.items.some(item => item.type === 'market'));
    assert.strictEqual(maxActive, 1, `Overpass istekleri paralel yürüdü: ${maxActive}`);
    assert(requests >= 8, 'İki bağımsız arama gerçekten yürütülmedi.');
  } finally {
    await close(mock);
  }
  console.log('Kadastro360 Render/Overpass tekli istek kuyruğu testi geçti.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
