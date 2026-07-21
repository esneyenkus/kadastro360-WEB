'use strict';

const assert = require('assert');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}
function close(server) { return new Promise(resolve => server.close(resolve)); }
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
async function freePort() {
  const server = http.createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

(async () => {
  let primaryRequests = 0;
  let fallbackRequests = 0;
  const primary = http.createServer((req, res) => {
    primaryRequests++;
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 'Unavailable', message: 'Geçici servis hatası' }));
  });
  const fallback = http.createServer((req, res) => {
    fallbackRequests++;
    if (!req.url.startsWith('/route/v1/driving/')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ code: 'InvalidUrl' }));
    }
    const pathPart = decodeURIComponent(req.url.split('?')[0]);
    const coords = pathPart.slice(pathPart.lastIndexOf('/') + 1).split(';').map(value => value.split(',').map(Number));
    const start = coords[0];
    const end = coords[1];
    const middle = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
    const body = JSON.stringify({
      code: 'Ok',
      routes: [{
        distance: 4250,
        duration: 510,
        geometry: { type: 'LineString', coordinates: [start, middle, end] }
      }]
    });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  });
  const primaryPort = await listen(primary);
  const fallbackPort = await listen(fallback);
  const routeBases = `http://127.0.0.1:${primaryPort},http://127.0.0.1:${fallbackPort}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'k360-route-'));
  process.env.ROUTING_BASE_URLS = routeBases;
  process.env.DATA_DIR = dataDir;
  process.env.TEST_USERNAME = 'admin';
  process.env.TEST_PASSWORD = 'route-test-password';
  process.env.SESSION_SECRET = 'route-test-session-secret-at-least-32-chars';

  const { normalizeRouteRequest, getRoadRoutes } = require('./server');

  const destinations = [
    { id: 'hospital-1', lat: 41.12, lng: 27.72 },
    { id: 'school-1', lat: 41.13, lng: 27.73 },
    { id: 'market-1', lat: 41.14, lng: 27.74 },
    { id: 'pharmacy-1', lat: 41.15, lng: 27.75 }
  ];
  const normalized = normalizeRouteRequest({ origin: { lat: 41.10, lng: 27.70 }, destinations });
  assert.strictEqual(normalized.destinations.length, 4);
  assert.throws(() => normalizeRouteRequest({ origin: { lat: 41, lng: 27 }, destinations: [] }), /1-5/);
  assert.throws(() => normalizeRouteRequest({ origin: { lat: 41, lng: 27 }, destinations: Array.from({ length: 6 }, (_, i) => ({ id: i, lat: 41, lng: 27 })) }), /1-5/);

  const result = await getRoadRoutes({ origin: { lat: 41.10, lng: 27.70 }, destinations });
  assert.strictEqual(result.routes.length, 4, 'Dört seçili hedefin tamamı yedek rota sağlayıcısıyla çizilmelidir.');
  assert.strictEqual(result.failed.length, 0);
  assert.strictEqual(result.complete, true);
  assert.strictEqual(result.results.length, 4);
  assert(result.results.every(row => row.status === 'ready'));
  assert.strictEqual(result.routes[0].geometry.type, 'LineString');
  assert.strictEqual(result.routes[0].distance, 4250);
  assert(primaryRequests >= 4, 'Birincil rota sağlayıcısı denenmedi.');
  assert(fallbackRequests >= 4, 'Yedek rota sağlayıcısı bütün hedefler için kullanılmadı.');

  const appPort = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(appPort),
      COOKIE_SECURE: '0',
      ROUTING_BASE_URLS: routeBases,
      DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'k360-route-api-'))
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    await waitForLine(child, /Kadastro360 Web hazır/);
    const base = `http://127.0.0.1:${appPort}`;
    const login = await fetch(`${base}/login`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'admin', password: 'route-test-password' })
    });
    const cookie = String(login.headers.get('set-cookie') || '').split(';')[0];
    assert(cookie.includes('kadastro360_session='), 'Rota API testi için oturum oluşmadı.');

    const apiResponse = await fetch(`${base}/api/route`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin: { lat: 41.10, lng: 27.70 }, destinations })
    });
    assert.strictEqual(apiResponse.status, 200, `Rota API HTTP ${apiResponse.status}`);
    const apiPayload = await apiResponse.json();
    assert.strictEqual(apiPayload.routes.length, 4, 'Rota API dört hedefi döndürmedi.');
    assert.strictEqual(apiPayload.complete, true);

    const invalidResponse = await fetch(`${base}/api/route`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        origin: { lat: 41.10, lng: 27.70 },
        destinations: Array.from({ length: 6 }, (_, i) => ({ id: `x${i}`, lat: 41.12, lng: 27.72 }))
      })
    });
    assert.strictEqual(invalidResponse.status, 400, 'Altı hedefli rota isteği reddedilmelidir.');
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
  }

  await close(primary);
  await close(fallback);
  console.log('Kadastro360 dört hedefli çoklu sağlayıcı rota regresyon testi geçti.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
