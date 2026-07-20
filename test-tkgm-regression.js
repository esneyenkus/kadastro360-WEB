'use strict';

const assert = require('assert');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { normalizeAdminItems } = require('./tkgm-client');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise(resolve => server.close(() => resolve()));
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function waitForLine(child, pattern, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Sunucu başlatılamadı. Çıktı: ${output}`)), timeoutMs);
    const onData = chunk => {
      output += chunk.toString();
      if (pattern.test(output)) {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        resolve(output);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', chunk => { output += chunk.toString(); });
    child.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`Sunucu erken kapandı (${code}). Çıktı: ${output}`));
    });
  });
}

(async () => {
  // Regresyonun kökü: fid/objectid, gerçek ilId'den önce seçilmemeli.
  const normalized = normalizeAdminItems({
    features: [{ properties: { fid: 9999, ilId: 59, text: 'TEKİRDAĞ' } }]
  }, 'province', 'mock');
  assert.deepStrictEqual(normalized[0], { id: '59', name: 'TEKİRDAĞ', source: 'mock' });

  const requests = [];
  const mockTkgm = http.createServer((req, res) => {
    requests.push(req.url);
    if (req.url === '/api/idariYapi/ilListe') {
      return json(res, 200, { features: [{ properties: { fid: 9999, ilId: 59, text: 'TEKİRDAĞ' } }] });
    }
    // Tek slash yolu bilerek 404. İstemci eski TKGM sunucularındaki çift slash
    // yolunu deneyerek gerçek ilçe listesini bulmalıdır.
    if (req.url === '/api/idariYapi/ilceListe/59') return json(res, 404, { error: 'not found' });
    if (req.url === '/api//idariYapi/ilceListe/59') {
      return json(res, 200, { features: [{ properties: { objectid: 777, ilceId: 501, text: 'ÇORLU' } }] });
    }
    if (req.url === '/api/idariYapi/mahalleListe/501') return json(res, 404, { error: 'not found' });
    if (req.url === '/api//idariYapi/mahalleListe/501') {
      return json(res, 200, { features: [{ properties: { fid: 888, mahalleId: 9001, text: 'ÖNERLER' } }] });
    }
    if (req.url === '/api/parsel/9001/323/2' || req.url === '/api/parsel/9001/323/2/') {
      return json(res, 200, {
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          properties: { ilAd: 'TEKİRDAĞ', ilceAd: 'ÇORLU', mahalleAd: 'ÖNERLER', adaNo: '323', parselNo: '2' },
          geometry: { type: 'Polygon', coordinates: [[[27.7, 41.1], [27.701, 41.1], [27.701, 41.101], [27.7, 41.1]]] }
        }]
      });
    }
    return json(res, 404, { error: `mock route missing: ${req.url}` });
  });

  const mockPort = await listen(mockTkgm);
  const appPort = 19000 + Math.floor(Math.random() * 1000);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kadastro360-test-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(appPort),
      TEST_USERNAME: 'admin',
      TEST_PASSWORD: 'test-password',
      SESSION_SECRET: 'test-session-secret-at-least-32-chars',
      COOKIE_SECURE: '0',
      DATA_DIR: dataDir,
      TKGM_BASE_URLS: `mock=http://127.0.0.1:${mockPort}/api`
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    await waitForLine(child, /Kadastro360 Web hazır/);
    const base = `http://127.0.0.1:${appPort}`;
    const login = await fetch(`${base}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'admin', password: 'test-password' })
    });
    assert([302, 303].includes(login.status), `Giriş başarısız: HTTP ${login.status}`);
    const cookie = String(login.headers.get('set-cookie') || '').split(';')[0];
    assert(cookie.includes('kadastro360_session='), 'Oturum çerezi oluşmadı.');
    const authHeaders = { Cookie: cookie };

    const provincesResponse = await fetch(`${base}/api/iller`, { headers: authHeaders });
    assert.strictEqual(provincesResponse.status, 200);
    const provinces = await provincesResponse.json();
    assert.strictEqual(provinces.items[0].id, '59', 'İl kimliği olarak fid seçildi; gerçek ilId kullanılmalı.');
    assert.strictEqual(provinces.items[0].source, 'mock');

    const districtsResponse = await fetch(`${base}/api/idari/ilceler`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ parentId: provinces.items[0].id, source: provinces.items[0].source })
    });
    assert.strictEqual(districtsResponse.status, 200, `İlçe yükleme HTTP ${districtsResponse.status} döndürdü.`);
    const districts = await districtsResponse.json();
    assert.strictEqual(districts.items[0].id, '501');
    assert.strictEqual(districts.items[0].name, 'ÇORLU');

    const neighborhoodsResponse = await fetch(`${base}/api/idari/mahalleler`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ parentId: districts.items[0].id, source: districts.items[0].source })
    });
    assert.strictEqual(neighborhoodsResponse.status, 200);
    const neighborhoods = await neighborhoodsResponse.json();
    assert.strictEqual(neighborhoods.items[0].id, '9001');
    assert.strictEqual(neighborhoods.items[0].name, 'ÖNERLER');

    const parcelResponse = await fetch(`${base}/api/parsel-sorgu`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mahalleId: '9001', ada: '323', parsel: '2', source: 'mock' })
    });
    assert.strictEqual(parcelResponse.status, 200);
    const parcel = await parcelResponse.json();
    assert.strictEqual(parcel.features[0].properties.parselNo, '2');

    assert(requests.includes('/api/idariYapi/ilceListe/59'), 'Standart ilçe yolu denenmedi.');
    assert(requests.includes('/api//idariYapi/ilceListe/59'), 'Çift slash TKGM yedek yolu denenmedi.');
    assert(requests.includes('/api//idariYapi/mahalleListe/501'), 'Mahalle yedek yolu denenmedi.');

    console.log('TKGM il → ilçe → mahalle → parsel regresyon testi geçti.');
  } finally {
    child.kill('SIGTERM');
    await close(mockTkgm);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
