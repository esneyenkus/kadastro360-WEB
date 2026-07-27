'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function waitForLine(child, pattern, timeoutMs = 12000) {
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

function responseCookies(response) {
  const rows = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [String(response.headers.get('set-cookie') || '')];
  const pairs = [];
  for (const row of rows) {
    for (const match of String(row).matchAll(/(?:^|,\s*)(kadastro360_(?:session|admin)=[^;,]+)/g)) {
      pairs.push(match[1]);
    }
  }
  return [...new Set(pairs)].join('; ');
}

(async () => {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'k360-private-mode-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: {
      ...process.env,
      PRIVATE_MODE: 'true',
      PRIVATE_MODE_MESSAGE: 'Kurum görüşleri beklenirken halka açık kullanım kapalıdır.',
      DATABASE_URL: '',
      RESEND_API_KEY: '',
      MAIL_FROM: '',
      HOST: '127.0.0.1',
      PORT: String(port),
      COOKIE_SECURE: '0',
      DATA_DIR: dataDir,
      TEST_USERNAME: 'admin',
      TEST_PASSWORD: 'private-mode-test-password',
      ADMIN_PANEL_PIN: '864209',
      SESSION_SECRET: 'private-mode-session-secret-at-least-32-characters'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    await waitForLine(child, /Kadastro360 Web hazır/);
    const base = `http://127.0.0.1:${port}`;

    const home = await fetch(`${base}/`, { redirect: 'manual' });
    assert.strictEqual(home.status, 503, 'Halka açık ana sayfa pasif modda kapalı olmalı.');
    const homeText = await home.text();
    assert(homeText.includes('GEÇİCİ OLARAK KAPALI'), 'Pasif bilgilendirme ekranı görünmedi.');
    assert(homeText.includes('Kurum görüşleri beklenirken'), 'Özel pasif mod mesajı görünmedi.');
    assert(/noindex/i.test(String(home.headers.get('x-robots-tag') || '')), 'Pasif sayfada noindex başlığı eksik.');

    const appPublic = await fetch(`${base}/app`, { redirect: 'manual' });
    assert.strictEqual(appPublic.status, 503, 'Halka açık /app pasif modda kapalı olmalı.');

    const apiPublic = await fetch(`${base}/api/iller`, { redirect: 'manual' });
    assert.strictEqual(apiPublic.status, 503, 'Halka açık API pasif modda kapalı olmalı.');

    const loginPublic = await fetch(`${base}/login`, { redirect: 'manual' });
    assert.strictEqual(loginPublic.status, 503, 'Normal kullanıcı girişi pasif modda kapalı olmalı.');

    const asset = await fetch(`${base}/assets/favicon-32.png`, { redirect: 'manual' });
    assert.strictEqual(asset.status, 200, 'Pasif sayfa marka görsellerine erişebilmeli.');

    const adminLoginPage = await fetch(`${base}/yonetim-giris`, { redirect: 'manual' });
    assert.strictEqual(adminLoginPage.status, 200, 'Yönetici giriş ekranı pasif modda açık kalmalı.');

    const adminLogin = await fetch(`${base}/yonetim-giris`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        username: 'admin',
        password: 'private-mode-test-password',
        adminPin: '864209'
      })
    });
    assert([302, 303].includes(adminLogin.status), `Yönetici girişi başarısız: HTTP ${adminLogin.status}`);
    assert.strictEqual(adminLogin.headers.get('location'), '/admin');
    const cookies = responseCookies(adminLogin);
    assert(cookies.includes('kadastro360_session='), 'Yönetici ana oturum çerezi oluşmadı.');
    assert(cookies.includes('kadastro360_admin='), 'Yönetici güvenlik çerezi oluşmadı.');

    const authHeaders = { Cookie: cookies };
    const admin = await fetch(`${base}/admin`, { headers: authHeaders, redirect: 'manual' });
    assert.strictEqual(admin.status, 200, 'Yönetici paneli pasif modda açılmadı.');

    const appAdmin = await fetch(`${base}/app`, { headers: authHeaders, redirect: 'manual' });
    assert.strictEqual(appAdmin.status, 200, 'Yönetici uygulamaya pasif modda erişemedi.');

    const health = await fetch(`${base}/api/health`, { redirect: 'manual' });
    assert.strictEqual(health.status, 200, 'Render sağlık kontrolü pasif modda açık kalmalı.');

    console.log('Kadastro360 yalnızca yönetici pasif modu ve Render build ortamı doğrulaması geçti.');
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
