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
  const requests = [];
  const mock = http.createServer((req, res) => {
    requests.push(req.url);
    if (!req.url.startsWith('/route/v1/driving/')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ code: 'InvalidUrl' }));
    }
    const body = JSON.stringify({
      code: 'Ok',
      routes: [{
        distance: 4250,
        duration: 510,
        geometry: { type: 'LineString', coordinates: [[27.70, 41.10], [27.71, 41.11], [27.72, 41.12]] }
      }]
    });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  });
  const mockPort = await listen(mock);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'k360-route-'));
  process.env.ROUTING_BASE_URL = `http://127.0.0.1:${mockPort}`;
  process.env.DATA_DIR = dataDir;
  process.env.TEST_USERNAME = 'admin';
  process.env.TEST_PASSWORD = 'route-test-password';
  process.env.SESSION_SECRET = 'route-test-session-secret-at-least-32-chars';

  const { normalizeRouteRequest, getRoadRoutes } = require('./server');

  const normalized = normalizeRouteRequest({
    origin: { lat: 41.10, lng: 27.70 },
    destinations: [{ id: 'hospital-1', lat: 41.12, lng: 27.72 }]
  });
  assert.strictEqual(normalized.destinations.length, 1);
  assert.throws(() => normalizeRouteRequest({ origin: { lat: 41, lng: 27 }, destinations: [] }), /1-5/);
  assert.throws(() => normalizeRouteRequest({ origin: { lat: 41, lng: 27 }, destinations: Array.from({ length: 6 }, (_, i) => ({ id: i, lat: 41, lng: 27 })) }), /1-5/);

  const result = await getRoadRoutes({
    origin: { lat: 41.10, lng: 27.70 },
    destinations: [
      { id: 'hospital-1', lat: 41.12, lng: 27.72 },
      { id: 'school-1', lat: 41.13, lng: 27.73 }
    ]
  });
  assert.strictEqual(result.routes.length, 2);
  assert.strictEqual(result.failed.length, 0);
  assert.strictEqual(result.routes[0].geometry.type, 'LineString');
  assert.strictEqual(result.routes[0].distance, 4250);
  assert(requests.every(url => url.includes('geometries=geojson') && url.includes('overview=full')), 'OSRM rota parametreleri eksik.');

  const appPort = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(appPort),
      COOKIE_SECURE: '0',
      ROUTING_BASE_URL: `http://127.0.0.1:${mockPort}`,
      DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'k360-route-api-'))
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
      body: new URLSearchParams({ username: 'admin', password: 'route-test-password' })
    });
    const cookie = String(login.headers.get('set-cookie') || '').split(';')[0];
    assert(cookie.includes('kadastro360_session='), 'Rota API testi için oturum oluşmadı.');

    const apiResponse = await fetch(`${base}/api/route`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        origin: { lat: 41.10, lng: 27.70 },
        destinations: [
          { id: 'hospital-1', lat: 41.12, lng: 27.72 },
          { id: 'school-1', lat: 41.13, lng: 27.73 }
        ]
      })
    });
    assert.strictEqual(apiResponse.status, 200, `Rota API HTTP ${apiResponse.status}`);
    const apiPayload = await apiResponse.json();
    assert.strictEqual(apiPayload.routes.length, 2, 'Rota API iki hedefi döndürmedi.');
    assert.strictEqual(apiPayload.routes[0].distance, 4250);

    const invalidResponse = await fetch(`${base}/api/route`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
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

  await close(mock);
  console.log('Kadastro360 yol rotası ve API regresyon testi geçti.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
