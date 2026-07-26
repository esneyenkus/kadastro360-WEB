'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
const { analyzeTerrain } = require('./terrain');
const { AccountStore, DEFAULT_SITE_CONTENT } = require('./account-store');
const { KadastroMailer } = require('./mailer');
const { buildPilotCatalog, fetchGeoJson, wmsFeatureInfo, wmsProbe, wmsSnapshot, wmsLegend, wmsTile } = require('./open-data');
const { TKGMClient, sourcesFromEnvironment } = require('./tkgm-client');

const HOST = process.env.HOST || '0.0.0.0';
const START_PORT = Number(process.env.PORT) || 10000;
let activePort = START_PORT;
const TEST_USERNAME = process.env.TEST_USERNAME || 'admin';
const TEST_PASSWORD = process.env.TEST_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const ADMIN_SESSION_MAX_AGE_SECONDS = 30 * 60;
const ADMIN_PANEL_PIN = String(process.env.ADMIN_PANEL_PIN || '');
const COOKIE_SECURE = process.env.COOKIE_SECURE !== '0';
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const DEFAULT_DAILY_QUOTA = Math.max(1, Number(process.env.DEFAULT_DAILY_QUOTA) || 20);
const DATABASE_URL = String(process.env.DATABASE_URL || '').trim();
const DB_SSL = String(process.env.DB_SSL || 'true').toLowerCase() !== 'false';
const DB_SSL_REJECT_UNAUTHORIZED = String(process.env.DB_SSL_REJECT_UNAUTHORIZED || 'false').toLowerCase() === 'true';
const APP_BASE_URL = String(process.env.APP_BASE_URL || 'https://kadastro360.com.tr').trim().replace(/\/$/, '');
const INVITE_TTL_HOURS = Math.max(1, Math.min(168, Number(process.env.INVITE_TTL_HOURS) || 48));
const RESET_TTL_HOURS = Math.max(1, Math.min(24, Number(process.env.RESET_TTL_HOURS) || 2));
const NOMINATIM_BASE_URL = String(process.env.NOMINATIM_BASE_URL || 'https://nominatim.openstreetmap.org').replace(/\/$/, '');
const ROUTING_BASE_URLS = (() => {
  const explicitList = String(process.env.ROUTING_BASE_URLS || '').split(',').map(value => value.trim()).filter(Boolean);
  const explicitOne = String(process.env.ROUTING_BASE_URL || '').trim();
  const values = explicitList.length ? explicitList : explicitOne ? [explicitOne] : [
    'https://router.project-osrm.org',
    'https://routing.openstreetmap.de/routed-car'
  ];
  return [...new Set(values.map(value => value.replace(/\/$/, '')))];
})();
const accounts = new AccountStore({
  dataDir: DATA_DIR,
  adminUsername: TEST_USERNAME,
  adminPassword: TEST_PASSWORD,
  defaultDailyQuota: DEFAULT_DAILY_QUOTA,
  databaseUrl: DATABASE_URL,
  dbSsl: DB_SSL,
  dbSslRejectUnauthorized: DB_SSL_REJECT_UNAUTHORIZED
});
const mailer = new KadastroMailer({
  apiKey: process.env.RESEND_API_KEY,
  from: process.env.MAIL_FROM,
  replyTo: process.env.MAIL_REPLY_TO,
  appBaseUrl: APP_BASE_URL
});
let siteContent = { ...DEFAULT_SITE_CONTENT };

const serviceHealth = {
  tkgm: { status: 'unknown', lastSuccessAt: null, lastErrorAt: null, message: 'Henüz kontrol edilmedi.' },
  terrain: { status: 'unknown', lastSuccessAt: null, lastErrorAt: null, message: 'Henüz kontrol edilmedi.' },
  overpass: { status: 'unknown', lastSuccessAt: null, lastErrorAt: null, message: 'Henüz kontrol edilmedi.' },
  routing: { status: 'unknown', lastSuccessAt: null, lastErrorAt: null, message: 'Henüz yol rotası hesaplanmadı.' },
  tucbs: { status: 'external', lastSuccessAt: null, lastErrorAt: null, message: 'e-Devlet oturumu gerektiren dış platform.' },
  openData: { status: 'unknown', lastSuccessAt: null, lastErrorAt: null, message: 'Kullanıcı isteğiyle kontrol edilir.' }
};

function markService(name, ok, message = '') {
  const row = serviceHealth[name];
  if (!row) return;
  row.status = ok ? 'ok' : 'error';
  row[ok ? 'lastSuccessAt' : 'lastErrorAt'] = new Date().toISOString();
  row.message = message || (ok ? 'Çalışıyor.' : 'Yanıt alınamadı.');
}

const tkgmClient = new TKGMClient({
  sources: sourcesFromEnvironment(),
  userAgent: 'Kadastro360/2.0.6'
});

// OpenStreetMap Wiki'de listelenen global Overpass örnekleri.
// Aynı sorguyu bütün sunuculara aynı anda göndermiyoruz. Küçük sorgular sırayla
// denenir; böylece 504 durumunda ikinci sunucuya geçilir ve ortak servisler gereksiz yüklenmez.
const OVERPASS_ENDPOINTS = (() => {
  const explicit = String(process.env.OVERPASS_BASE_URLS || '').split(',').map(value => value.trim()).filter(Boolean);
  if (explicit.length) return explicit.map((url, index) => ({ name: `Özel Overpass ${index + 1}`, url }));
  return [
    // Render çıkışlarında en kararlı iki global örnek önce denenir. VK Maps yedek
    // olarak tutulur; tek bir sunucunun geçici sorunu bütün kategorileri düşürmez.
    { name: 'Private.coffee Overpass', url: 'https://overpass.private.coffee/api/interpreter' },
    { name: 'FOSSGIS Overpass', url: 'https://overpass-api.de/api/interpreter' },
    { name: 'VK Maps Overpass', url: 'https://maps.mail.ru/osm/tools/overpass/api/interpreter' }
  ];
})();

const overpassHealth = new Map(
  OVERPASS_ENDPOINTS.map((endpoint, index) => [
    endpoint.url,
    { failures: 0, blockedUntil: 0, averageMs: 1500 + index * 250, lastSuccess: 0 }
  ])
);

const cache = new Map();
const poiSuccessfulCategoryCache = new Map();
const POI_SUCCESS_CACHE_TTL_MS = 30 * 60 * 1000;


function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>\"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

function parseCookies(req) {
  const result = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    result[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return result;
}

function signSession(username, expiresAt) {
  const payload = `${username}|${expiresAt}`;
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return Buffer.from(`${payload}|${signature}`, 'utf8').toString('base64url');
}

async function validSession(req) {
  if (!TEST_PASSWORD || !SESSION_SECRET) return null;
  const token = parseCookies(req).kadastro360_session;
  if (!token) return null;
  try {
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    const [username, expiresRaw, signature] = decoded.split('|');
    const expiresAt = Number(expiresRaw);
    if (!username || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
    const expected = crypto.createHmac('sha256', SESSION_SECRET)
      .update(`${username}|${expiresAt}`).digest('hex');
    const a = Buffer.from(signature || '', 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const user = await accounts.getUser(username);
    if (!user?.active) return null;
    if (user.trialEndsAt && Date.parse(user.trialEndsAt) <= Date.now()) return null;
    return user;
  } catch {
    return null;
  }
}

function signAdminSession(username, expiresAt) {
  const payload = `${username}|admin|${expiresAt}`;
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return Buffer.from(`${payload}|${signature}`, 'utf8').toString('base64url');
}

function validAdminSession(req, user) {
  if (!user || user.role !== 'admin' || !ADMIN_PANEL_PIN || !SESSION_SECRET) return false;
  const token = parseCookies(req).kadastro360_admin;
  if (!token) return false;
  try {
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    const [username, scope, expiresRaw, signature] = decoded.split('|');
    const expiresAt = Number(expiresRaw);
    if (scope !== 'admin' || username !== user.username || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) return false;
    const expected = crypto.createHmac('sha256', SESSION_SECRET)
      .update(`${username}|admin|${expiresAt}`).digest('hex');
    const a = Buffer.from(signature || '', 'hex');
    const b = Buffer.from(expected, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function adminLoginPage(message = '', configured = Boolean(ADMIN_PANEL_PIN)) {
  const alert = message ? `<div class="alert">${escapeHtml(message)}</div>` : '';
  const setup = configured ? '' : '<div class="setup">Render Environment bölümüne <strong>ADMIN_PANEL_PIN</strong> adında, tahmin edilmesi zor ayrı bir güvenlik kodu eklenmeden yönetim paneli açılmaz.</div>';
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kadastro360 Yönetici Girişi</title><link rel="icon" href="/assets/favicon.ico" sizes="any"><link rel="icon" type="image/png" sizes="32x32" href="/assets/favicon-32.png"><style>
  *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at top,#173d4d,#0d1f29 60%,#08141b);font-family:Arial,sans-serif;color:#17212b;padding:20px}.box{width:min(440px,100%);background:#fff;border-radius:20px;padding:26px;box-shadow:0 30px 90px rgba(0,0,0,.38);border:1px solid rgba(255,255,255,.5)}.login-logo{display:block;width:min(290px,90%);height:auto;margin:0 0 16px}.mark{display:inline-flex;padding:6px 10px;border-radius:99px;background:#eef8f4;color:#0e6b51;font-size:11px;font-weight:900}.title{font-size:28px;font-weight:900;margin:14px 0 5px}.sub{color:#62727c;font-size:13px;line-height:1.6;margin-bottom:18px}.field{display:grid;gap:6px;margin:12px 0}.field label{font-size:12px;font-weight:800;color:#2c4350}.field input{width:100%;height:43px;border:1px solid #c8d3da;border-radius:11px;padding:0 12px;font-size:15px}.button{width:100%;border:0;border-radius:11px;padding:13px;background:#0e6b51;color:#fff;font-size:14px;font-weight:900;cursor:pointer;margin-top:8px}.alert,.setup{padding:10px 12px;border-radius:10px;font-size:12px;line-height:1.55;margin-bottom:12px}.alert{background:#fff0f0;color:#982d2d;border:1px solid #efc3c3}.setup{background:#fff8e7;color:#72520d;border:1px solid #ecd69e}.foot{display:flex;justify-content:space-between;gap:12px;margin-top:16px;font-size:12px}.foot a{color:#315fae;text-decoration:none;font-weight:800}</style></head><body><main class="box"><img class="login-logo" src="/assets/kadastro360-logo-horizontal.png" alt="Kadastro360"><div class="mark">KORUMALI YÖNETİM ALANI</div><div class="title">Kadastro360 Yönetici</div><div class="sub">Normal kullanıcı girişinden bağımsız olarak yönetici hesabı, parolası ve ikinci güvenlik kodu birlikte doğrulanır. Yönetici yetkisi 30 dakika sonra yeniden istenir.</div>${alert}${setup}<form method="post" action="/yonetim-giris"><div class="field"><label>Yönetici kullanıcı adı</label><input name="username" autocomplete="username" required></div><div class="field"><label>Yönetici parolası</label><input name="password" type="password" autocomplete="current-password" required></div><div class="field"><label>Yönetim güvenlik kodu</label><input name="adminPin" type="password" inputmode="numeric" autocomplete="one-time-code" required></div><button class="button" type="submit" ${configured ? '' : 'disabled'}>Yönetim paneline gir</button></form><div class="foot"><a href="/">Ana sayfa</a><a href="/app">Uygulama</a></div></main></body></html>`;
}

function sendHtml(res, status, html, extraHeaders = {}) {
  const body = Buffer.from(html, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    ...extraHeaders
  });
  res.end(body);
}

function marketingPage({ loginMessage = '', requestMessage = '', requestOk = false, user = null } = {}) {
  const content = siteContent || DEFAULT_SITE_CONTENT;
  const safeLogin = loginMessage ? `<div class="msg error">${escapeHtml(loginMessage)}</div>` : '';
  const safeRequest = requestMessage ? `<div class="msg ${requestOk ? 'success' : 'error'}">${escapeHtml(requestMessage)}</div>` : '';
  const userPanel = user ? `
    <div class="session-box">
      <div>
        <div class="mini-label">Oturum</div>
        <strong>${escapeHtml(user.username)}</strong>
      </div>
      <div class="session-actions">
        <a class="mini-btn primary" href="/app">Uygulamayı Aç</a>
        <a class="mini-btn" href="/hesabim">Hesabım</a>
        <a class="mini-btn" href="/logout">Çıkış</a>
      </div>
    </div>` : '';
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kadastro360</title><link rel="icon" href="/assets/favicon.ico" sizes="any"><link rel="icon" type="image/png" sizes="32x32" href="/assets/favicon-32.png"><link rel="apple-touch-icon" href="/assets/apple-touch-icon.png">
  <style>
    :root{--bg:#eef3f6;--text:#16222d;--muted:#5d6c76;--line:#d8e0e7;--brand:#0e6b51;--brand2:#2d7ff9;--card:#ffffff;--soft:#f6f8fa;--shadow:0 26px 70px rgba(10,38,55,.14)}
    *{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:linear-gradient(180deg,#eef3f6 0%,#f8fbfc 100%);color:var(--text);font-family:Arial,sans-serif}
    a{text-decoration:none;color:inherit}.page{min-height:100vh;padding:22px}.shell{max-width:1280px;margin:0 auto}.topbar{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:18px}.brand-logo-main{display:block;width:300px;max-width:100%;height:auto;max-height:74px;object-fit:contain;object-position:left center;filter:drop-shadow(0 3px 8px rgba(20,63,74,.10))}.brand-sub{font-size:12px;color:var(--muted);margin-top:4px}.top-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.top-pill{padding:8px 12px;border-radius:999px;background:#fff;border:1px solid var(--line);font-size:12px;font-weight:700;color:#365064}.top-link{padding:10px 14px;border-radius:10px;border:1px solid var(--line);background:#fff;font-size:13px;font-weight:800}.top-link.primary{background:var(--brand);border-color:var(--brand);color:#fff}
    .hero{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(360px,.95fr);gap:22px;align-items:start}.card{background:var(--card);border:1px solid var(--line);border-radius:24px;box-shadow:var(--shadow)}.hero-main{padding:28px 28px 24px}.eyebrow{display:inline-flex;gap:8px;align-items:center;padding:7px 12px;border-radius:999px;background:#ecf7f3;color:var(--brand);font-weight:800;font-size:12px}.hero-main h1{font-size:46px;line-height:1.03;margin:16px 0 14px;letter-spacing:-.03em}.hero-main p{font-size:16px;line-height:1.72;color:var(--muted);margin:0}.cta-row{display:flex;gap:12px;flex-wrap:wrap;margin:22px 0 14px}.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:14px 18px;border-radius:14px;font-size:14px;font-weight:800;border:1px solid var(--line);background:#fff;cursor:pointer}.btn.primary{background:linear-gradient(135deg,var(--brand),#118d69);border-color:transparent;color:#fff}.btn.secondary{background:#fff;color:#244f9e;border-color:#b8c8ec}.hero-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:18px}.stat{border:1px solid var(--line);border-radius:16px;padding:14px;background:var(--soft)}.stat strong{display:block;font-size:24px;margin-bottom:5px}.stat span{display:block;color:var(--muted);font-size:12px;line-height:1.45}
    .showcase{margin-top:22px;display:grid;grid-template-columns:1.05fr .95fr;gap:14px}.map-shot,.side-shot{border:1px solid var(--line);border-radius:20px;background:#fff;overflow:hidden}.map-shot{padding:14px}.map-surface{height:260px;border-radius:16px;position:relative;background:linear-gradient(135deg,#e6efe8,#f5f3eb 55%,#dde9f8);overflow:hidden}.map-surface:before,.map-surface:after{content:"";position:absolute;inset:auto auto 0 0;background:rgba(255,255,255,.7)}.road{position:absolute;border-radius:999px;background:#d16a4d;opacity:.9}.road.one{width:120%;height:12px;left:-10%;top:44%;transform:rotate(-10deg)}.road.two{width:70%;height:9px;left:20%;top:18%;transform:rotate(34deg);background:#8aab5f}.road.three{width:80%;height:10px;left:10%;top:72%;transform:rotate(18deg);background:#8b8fd5}.parcel{position:absolute;left:39%;top:46%;width:86px;height:64px;border:4px solid #e03d3d;background:rgba(255,255,255,.4);transform:rotate(-12deg);box-shadow:0 8px 22px rgba(0,0,0,.08)}.poi{position:absolute;width:14px;height:14px;border-radius:50%;background:#2463eb;border:3px solid #fff;box-shadow:0 2px 10px rgba(0,0,0,.2)}.poi.p1{left:63%;top:24%}.poi.p2{left:70%;top:32%}.poi.p3{left:24%;top:76%}.route{position:absolute;border-radius:999px}.route.r1{left:45%;top:37%;width:26%;height:0;border-top:7px solid #2463eb;transform:rotate(-18deg)}.route.r2{left:43%;top:48%;width:29%;height:0;border-top:7px dashed #8a4fe8;transform:rotate(16deg)}.route.r3{left:40%;top:49%;width:17%;height:0;border-top:7px solid #11a56a;transform:rotate(105deg)}.map-footer{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-top:12px}.map-chip{padding:10px;border-radius:12px;background:#f7f9fb;border:1px solid var(--line);font-size:11px;font-weight:800;text-align:center}.side-shot{padding:14px;display:grid;gap:12px}.side-box{border:1px solid var(--line);border-radius:16px;padding:14px;background:linear-gradient(180deg,#fff,#fbfcfd)}.side-box h3{margin:0 0 8px;font-size:14px}.side-box p{margin:0;color:var(--muted);font-size:12px;line-height:1.6}.mini-steps{display:grid;gap:8px}.mini-step{display:flex;gap:10px;align-items:flex-start}.mini-badge{flex:0 0 26px;height:26px;border-radius:50%;display:grid;place-items:center;background:#eaf0ff;color:#244f9e;font-weight:900;font-size:12px}.mini-step div{font-size:12px;line-height:1.5;color:var(--muted)}
    .auth{padding:20px;position:sticky;top:18px}.auth-logo{display:block;width:220px;max-width:86%;height:auto;margin:0 auto 15px}.auth h2{margin:0 0 4px;font-size:24px}.auth-sub{color:var(--muted);font-size:13px;line-height:1.6;margin:0 0 18px}.msg{padding:10px 12px;border-radius:12px;font-size:13px;line-height:1.5;margin-bottom:12px}.msg.error{background:#fff3f3;color:#a12626;border:1px solid #f0c3c3}.msg.success{background:#eefaf5;color:#0e6b51;border:1px solid #b8e0cf}.auth-grid{display:grid;gap:14px}.auth-box{border:1px solid var(--line);border-radius:18px;padding:16px;background:var(--soft)}.auth-box h3{margin:0 0 6px;font-size:16px}.auth-box p{margin:0 0 14px;color:var(--muted);font-size:12px;line-height:1.6}.field{display:grid;gap:6px;margin-bottom:11px}.field label{font-size:12px;font-weight:800;color:#264050}.field input,.field textarea{width:100%;border:1px solid #c9d4dd;border-radius:12px;padding:12px 13px;font-size:14px;background:#fff;color:var(--text)}.field textarea{min-height:92px;resize:vertical}.submit{width:100%;border:0;border-radius:12px;padding:13px 14px;background:linear-gradient(135deg,var(--brand2),#245fd5);color:#fff;font-size:14px;font-weight:900;cursor:pointer}.submit.secondary{background:linear-gradient(135deg,var(--brand),#118d69)}.helper{font-size:12px;color:var(--muted);line-height:1.6;margin-top:10px}.session-box{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 14px;border:1px solid #c8ddd4;background:#eef9f4;border-radius:14px;margin-bottom:14px}.mini-label{font-size:11px;color:var(--muted);margin-bottom:4px}.session-actions{display:flex;gap:8px;flex-wrap:wrap}.mini-btn{padding:9px 12px;border-radius:10px;border:1px solid var(--line);background:#fff;font-size:12px;font-weight:800}.mini-btn.primary{background:#0e6b51;border-color:#0e6b51;color:#fff}
    .info-strip{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:18px}.info-card{padding:18px;border-radius:20px;border:1px solid var(--line);background:#fff;box-shadow:0 14px 35px rgba(10,38,55,.07)}.info-card h3{margin:0 0 8px;font-size:18px}.info-card p{margin:0;color:var(--muted);font-size:13px;line-height:1.75}.info-card ul{margin:10px 0 0;padding-left:18px;color:var(--muted);font-size:13px;line-height:1.7}
    .footer-note{margin:20px 0 0;color:var(--muted);font-size:12px;line-height:1.65;text-align:center}
    @media (max-width:1100px){.hero{grid-template-columns:1fr}.auth{position:static}.showcase,.info-strip,.hero-grid{grid-template-columns:1fr}.map-footer{grid-template-columns:repeat(2,minmax(0,1fr))}}
    @media (max-width:700px){.page{padding:14px}.hero-main{padding:20px}.brand-logo-main{width:240px}.hero-main h1{font-size:34px}.cta-row{flex-direction:column}.btn{width:100%}.topbar{flex-direction:column;align-items:flex-start}.map-surface{height:210px}}
  </style></head><body><div class="page"><div class="shell">
    <div class="topbar">
      <div><img class="brand-logo-main" src="/assets/kadastro360-logo-horizontal.png" alt="Kadastro360"><div class="brand-sub">Parsel sorgusu, eğim analizi, yakın yerler ve açık kamu katmanları tek ekranda.</div></div>
      <div class="top-actions">
        <div class="top-pill">Canlı veri · TKGM + OSM + açık veri</div>
        <a class="top-link" href="#erişim">Pilot erişim</a>
        ${user ? `<a class="top-link primary" href="/app">Uygulamayı aç</a>` : `<a class="top-link primary" href="#giris">Üye girişi</a>`}
      </div>
    </div>
    <div class="hero">
      <section class="card hero-main">
        <div class="eyebrow">${escapeHtml(content.heroBadge)}</div>
        <h1>${escapeHtml(content.heroTitle)}</h1>
        <p>${escapeHtml(content.heroDescription)}</p>
        <div class="cta-row">
          ${user ? `<a class="btn primary" href="/app">Uygulamaya gir</a>` : `<a class="btn primary" href="#giris">Pilot hesaba giriş yap</a>`}
          <a class="btn secondary" href="#nasil">Nasıl çalışır?</a>
        </div>
        <div class="hero-grid">
          <div class="stat"><strong>81 İl</strong><span>TKGM odaklı canlı parsel akışı ve tüm sorgu zinciri.</span></div>
          <div class="stat"><strong>Gerçek Yakın Yer</strong><span>Sahte sonuç üretmeden canlı OSM/Overpass taraması.</span></div>
          <div class="stat"><strong>Rota + Eğim</strong><span>Seçilen noktaya yol rotası ve arazinin eğim özeti.</span></div>
        </div>
        <div class="showcase">
          <div class="map-shot">
            <div class="map-surface">
              <div class="road one"></div><div class="road two"></div><div class="road three"></div>
              <div class="parcel"></div>
              <div class="poi p1"></div><div class="poi p2"></div><div class="poi p3"></div>
              <div class="route r1"></div><div class="route r2"></div><div class="route r3"></div>
            </div>
            <div class="map-footer">
              <div class="map-chip">Parsel</div><div class="map-chip">Eğim</div><div class="map-chip">Yakın Yer</div><div class="map-chip">Açık Veri</div>
            </div>
          </div>
          <div class="side-shot">
            <div class="side-box" id="nasil"><h3>Nasıl çalışır?</h3><p>Önce parsel bulunur, ardından harita merkezlenir. Sonrasında gerçek yakın yerler canlı servislerden toplanır, seçilen noktalara yol rotası çizilir ve açık veri katmanları tek tıkla görüntülenir.</p></div>
            <div class="side-box"><div class="mini-steps">
              <div class="mini-step"><div class="mini-badge">1</div><div><strong>Parsel sorgusu</strong><br>İl, ilçe, mahalle, ada ve parsel bilgisiyle ara.</div></div>
              <div class="mini-step"><div class="mini-badge">2</div><div><strong>Eğim ve çevre analizi</strong><br>Parselin topografik yapısını ve çevresindeki önemli noktaları gör.</div></div>
              <div class="mini-step"><div class="mini-badge">3</div><div><strong>Rota ve karar desteği</strong><br>Seçtiğin yakın yerlere rota çiz ve açık katmanlarla konumu güçlendir.</div></div>
            </div></div>
          </div>
        </div>
      </section>
      <aside class="card auth" id="giris">
        <img class="auth-logo" src="/assets/kadastro360-logo-horizontal.png" alt="Kadastro360">
        <h2>Hızlı erişim</h2>
        <p class="auth-sub">Pilot kullanıcılar giriş yapabilir. Yeni test kullanıcıları ise aşağıdaki formdan erişim talebi bırakabilir.</p>
        ${userPanel}
        ${safeLogin}
        ${safeRequest}
        <div class="auth-grid">
          <section class="auth-box">
            <h3>Üye girişi</h3>
            <p>Tanımlı pilot hesabınız varsa doğrudan Kadastro360 uygulamasına geçin.</p>
            <form method="post" action="/login">
              <div class="field"><label>Kullanıcı adı</label><input name="username" autocomplete="username" required></div>
              <div class="field"><label>Parola</label><input name="password" type="password" autocomplete="current-password" required></div>
              <button class="submit" type="submit">Giriş yap</button>
            </form>
            <div class="helper">Sistem yalnızca canlı veri kaynakları kullanır; örnek veya sanal yakın yer verisi üretmez.<br><a href="/parolami-unuttum" style="color:#315fae;font-weight:800">Parolamı unuttum</a></div>
          </section>
          <section class="auth-box" id="erişim">
            <h3>Üye ol / pilot erişim talebi</h3>
            <p>Test kullanıcılarına hesap açmak için temel bilgilerinizi bırakın. Talebiniz yönetici ekranında saklanır.</p>
            <form method="post" action="/request-access">
              <input name="website" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px;opacity:0" aria-hidden="true">
              <div class="field"><label>Ad soyad</label><input name="fullName" required></div>
              <div class="field"><label>Kurum / şirket</label><input name="company"></div>
              <div class="field"><label>E-posta</label><input name="email" type="email" required></div>
              <div class="field"><label>Telefon</label><input name="phone"></div>
              <div class="field"><label>Kısa not</label><textarea name="note" placeholder="Kullanım amacınızı veya test ihtiyacınızı yazabilirsiniz."></textarea></div>
              <button class="submit secondary" type="submit">Erişim talebi gönder</button>
            </form>
          </section>
        </div>
      </aside>
    </div>
    <section class="info-strip">
      <article class="info-card"><h3>Ne işe yarar?</h3><p>Arsa, tarla veya parsel kararlarını verirken konumu sadece haritada göstermek yerine çevresel erişimi, eğimi ve resmi/açık veri katmanlarını tek yerde görmenizi sağlar.</p></article>
      <article class="info-card"><h3>Neler var?</h3><ul><li>TKGM tabanlı parsel akışı</li><li>Yakın okul, market, cami, eczane, banka, ATM, hastane</li><li>Otogar, tren garı/istasyonu, havaalanı</li><li>Yol rotası ve mesafe/süre bilgisi</li><li>Açık kamu katmanları ve plan odaklı görünüm</li></ul></article>
      <article class="info-card"><h3>Neden Kadastro360?</h3><p>Hedef; emlak ve arazi kararında birden fazla ekran, dağınık servis ve yavaş iş akışı yerine tek bir çalışma yüzeyi sunmaktır. Pilot sürüm düzenli olarak gerçek kullanım geri bildirimleriyle geliştirilmektedir.</p></article>
    </section>
    <div class="footer-note">${escapeHtml(content.footerNote)}<br><strong>İletişim:</strong> <a href="mailto:${escapeHtml(content.contactEmail)}" style="color:#0e6b51;font-weight:800">${escapeHtml(content.contactEmail)}</a></div>
  </div></div></body></html>`;
}


function publicAccountFormPage({ mode = 'forgot', token = '', message = '', ok = false } = {}) {
  const isForgot = mode === 'forgot';
  const isInvite = mode === 'invite';
  const title = isForgot ? 'Parolamı unuttum' : isInvite ? 'Kadastro360 hesabını etkinleştir' : 'Yeni parola belirle';
  const subtitle = isForgot
    ? 'Kullanıcı adınızı veya hesabınıza kayıtlı e-posta adresini girin.'
    : isInvite
      ? 'Davet bağlantınızla hesabınızı etkinleştirin ve güvenli parolanızı belirleyin.'
      : 'Parola yenileme bağlantınızla yeni parolanızı belirleyin.';
  const action = isForgot ? '/parolami-unuttum' : isInvite ? '/davet' : '/parola-yenile';
  const alert = message ? `<div class="notice ${ok ? 'ok' : 'error'}">${escapeHtml(message)}</div>` : '';
  const form = ok && !isForgot ? `<a class="button" href="/">Giriş sayfasına dön</a>` : isForgot ? `
    <form method="post" action="${action}">
      <div class="field"><label>Kullanıcı adı veya e-posta</label><input name="identifier" autocomplete="username" required></div>
      <button class="button" type="submit">Yenileme bağlantısı gönder</button>
    </form>` : `
    <form method="post" action="${action}">
      <input type="hidden" name="token" value="${escapeHtml(token)}">
      <div class="field"><label>Yeni parola</label><input name="password" type="password" minlength="8" autocomplete="new-password" required></div>
      <div class="field"><label>Yeni parola tekrar</label><input name="passwordAgain" type="password" minlength="8" autocomplete="new-password" required></div>
      <button class="button" type="submit">${isInvite ? 'Hesabımı etkinleştir' : 'Parolamı yenile'}</button>
    </form>`;
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Kadastro360</title><link rel="icon" href="/assets/favicon.ico"><style>
  *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:20px;background:radial-gradient(circle at top,#e6f4ef,#eef3f6 58%,#dfe8ed);font-family:Arial,sans-serif;color:#16222d}.card{width:min(470px,100%);background:#fff;border:1px solid #d8e0e7;border-radius:22px;padding:26px;box-shadow:0 28px 80px rgba(10,38,55,.18)}.logo{display:block;width:250px;max-width:85%;height:auto;margin:0 0 18px}.tag{display:inline-flex;padding:6px 10px;border-radius:99px;background:#eef8f4;color:#0e6b51;font-size:11px;font-weight:900}h1{font-size:27px;margin:14px 0 7px}.sub{font-size:13px;line-height:1.65;color:#5d6c76;margin:0 0 18px}.field{display:grid;gap:6px;margin:12px 0}.field label{font-size:12px;font-weight:800}.field input{height:44px;border:1px solid #c8d3da;border-radius:11px;padding:0 12px;font-size:15px}.button{display:block;width:100%;border:0;border-radius:11px;padding:13px;background:#0e6b51;color:#fff;text-align:center;text-decoration:none;font-size:14px;font-weight:900;cursor:pointer;margin-top:10px}.notice{padding:11px 12px;border-radius:10px;font-size:12px;line-height:1.55;margin-bottom:12px}.notice.ok{background:#eefaf5;color:#0e6b51;border:1px solid #b8e0cf}.notice.error{background:#fff1f1;color:#8d2c2c;border:1px solid #efc3c3}.foot{display:flex;justify-content:space-between;gap:12px;margin-top:18px;font-size:12px}.foot a{color:#315fae;text-decoration:none;font-weight:800}</style></head><body><main class="card"><img class="logo" src="/assets/kadastro360-logo-horizontal.png" alt="Kadastro360"><div class="tag">GÜVENLİ HESAP İŞLEMİ</div><h1>${escapeHtml(title)}</h1><p class="sub">${escapeHtml(subtitle)}</p>${alert}${form}<div class="foot"><a href="/">Ana sayfa</a><a href="mailto:${escapeHtml(siteContent.contactEmail)}">${escapeHtml(siteContent.contactEmail)}</a></div></main></body></html>`;
}


function readFormBody(req, limit = 50_000) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > limit) {
        reject(new Error('Form çok büyük.'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(new URLSearchParams(body)));
    req.on('error', reject);
  });
}

function secureEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin'
  });
  res.end(body);
}

function sendBinary(res, status, buffer, contentType, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': contentType || 'application/octet-stream',
    'Content-Length': buffer.length,
    'Cache-Control': 'public, max-age=900, stale-while-revalidate=3600',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders
  });
  res.end(buffer);
}

function sendFile(res, filePath, contentType) {
  fs.readFile(filePath, (error, content) => {
    if (error) return sendJson(res, 404, { error: 'Dosya bulunamadı.' });
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': content.length,
      'Cache-Control': 'no-cache'
    });
    res.end(content);
  });
}

function readJsonBody(req, limit = 2_000_000) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > limit) {
        reject(new Error('İstek gövdesi çok büyük.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Geçersiz JSON.'));
      }
    });
    req.on('error', reject);
  });
}

async function fetchJson(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) {
      const upstreamError = new Error(`HTTP ${response.status}`);
      upstreamError.statusCode = response.status;
      upstreamError.upstreamUrl = url;
      throw upstreamError;
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('Geçersiz JSON yanıtı.');
    }
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('Zaman aşımı.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function cached(key, ttlMs, loader) {
  const saved = cache.get(key);
  if (saved && saved.expiresAt > Date.now()) return saved.promise;
  const promise = Promise.resolve().then(loader).catch(error => {
    cache.delete(key);
    throw error;
  });
  cache.set(key, { expiresAt: Date.now() + ttlMs, promise });
  return promise;
}

function numberList(value) {
  if (Array.isArray(value)) return value.map(Number).filter(Number.isFinite);
  if (Number.isFinite(Number(value))) return [Number(value)];
  return [];
}

async function getElevation(locations) {
  const latitudes = locations.map(item => Number(item.latitude));
  const longitudes = locations.map(item => Number(item.longitude));
  if (latitudes.some(value => !Number.isFinite(value)) || longitudes.some(value => !Number.isFinite(value))) {
    throw new Error('Geçersiz koordinat.');
  }

  try {
    const url = new URL('https://api.open-meteo.com/v1/elevation');
    url.searchParams.set('latitude', latitudes.join(','));
    url.searchParams.set('longitude', longitudes.join(','));
    const data = await fetchJson(url.toString(), {}, 8000);
    let elevations = [];
    if (Array.isArray(data?.elevation)) elevations = numberList(data.elevation);
    else if (Array.isArray(data)) elevations = data.flatMap(item => numberList(item?.elevation));
    if (elevations.length === locations.length) {
      return {
        source: 'Open-Meteo Elevation',
        results: locations.map((item, index) => ({ ...item, elevation: elevations[index] }))
      };
    }
  } catch (error) {
    console.warn('[EĞİM] Open-Meteo:', error.message);
  }

  const body = JSON.stringify({ locations });
  const fallback = await fetchJson('https://api.open-elevation.com/api/v1/lookup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body
  }, 11000);
  if (!Array.isArray(fallback?.results) || fallback.results.length !== locations.length) {
    throw new Error('Eğim servisi geçerli sonuç döndürmedi.');
  }
  return { source: 'Open-Elevation', results: fallback.results };
}

function validRoutePoint(value) {
  const lat = Number(value?.lat);
  const lng = Number(value?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

function normalizeRouteRequest(body = {}) {
  const origin = validRoutePoint(body.origin);
  const rows = Array.isArray(body.destinations) ? body.destinations : [];
  if (!origin) throw Object.assign(new Error('Geçerli parsel başlangıç koordinatı gereklidir.'), { httpStatus: 400 });
  if (!rows.length || rows.length > 5) throw Object.assign(new Error('Yol rotası için 1-5 arasında hedef seçilmelidir.'), { httpStatus: 400 });
  const destinations = rows.map((row, index) => {
    const point = validRoutePoint(row);
    if (!point) throw Object.assign(new Error(`${index + 1}. hedef koordinatı geçersiz.`), { httpStatus: 400 });
    return { id: String(row.id || index + 1).slice(0, 160), ...point };
  });
  return { origin, destinations };
}

function routeCacheKey(origin, destination) {
  const rounded = value => Number(value).toFixed(5);
  return `road:${rounded(origin.lat)},${rounded(origin.lng)}:${rounded(destination.lat)},${rounded(destination.lng)}`;
}

async function routeOne(origin, destination) {
  return cached(routeCacheKey(origin, destination), 30 * 60_000, async () => {
    const coordinates = `${origin.lng},${origin.lat};${destination.lng},${destination.lat}`;
    const errors = [];
    for (const baseUrl of ROUTING_BASE_URLS) {
      const providerName = baseUrl.includes('routing.openstreetmap.de') ? 'FOSSGIS OSRM' : baseUrl.includes('project-osrm.org') ? 'Project OSRM' : new URL(baseUrl).host;
      for (const snapRadius of [null, 1800]) {
        const url = new URL(`${baseUrl}/route/v1/driving/${coordinates}`);
        url.searchParams.set('alternatives', 'false');
        url.searchParams.set('steps', 'false');
        url.searchParams.set('overview', 'full');
        url.searchParams.set('geometries', 'geojson');
        url.searchParams.set('continue_straight', 'false');
        if (snapRadius) url.searchParams.set('radiuses', `${snapRadius};${snapRadius}`);
        try {
          const payload = await fetchJson(url.toString(), {
            headers: { 'User-Agent': 'Kadastro360/2.0.6', Accept: 'application/json' }
          }, 9000);
          if (payload?.code === 'Ok' && Array.isArray(payload.routes) && payload.routes[0]?.geometry) {
            const route = payload.routes[0];
            return {
              id: destination.id,
              distance: Number(route.distance) || 0,
              duration: Number(route.duration) || 0,
              geometry: route.geometry,
              provider: `${providerName} / OpenStreetMap yol ağı`,
              snapped: Boolean(snapRadius)
            };
          }
          const message = payload?.message || payload?.code || 'Geçerli rota döndürülmedi.';
          errors.push(`${providerName}${snapRadius ? ' (geniş yol eşleştirme)' : ''}: ${message}`);
          if (!/NoSegment|NoRoute/i.test(String(payload?.code || message))) break;
        } catch (error) {
          errors.push(`${providerName}: ${error?.message || 'yanıt vermedi'}`);
          break;
        }
      }
    }
    throw new Error(errors.join(' | ') || 'Yol rotası servisleri yanıt vermedi.');
  });
}

async function getRoadRoutes(body) {
  const { origin, destinations } = normalizeRouteRequest(body);
  const routes = [];
  const failed = [];
  const results = [];
  for (const destination of destinations) {
    try {
      const route = await routeOne(origin, destination);
      routes.push(route);
      results.push({ id: destination.id, status: 'ready', route });
    } catch (error) {
      const row = { id: destination.id, error: error?.message || 'Rota alınamadı.' };
      failed.push(row);
      results.push({ ...row, status: 'failed' });
    }
  }
  return {
    origin,
    routes,
    failed,
    results,
    complete: failed.length === 0 && routes.length === destinations.length,
    provider: 'OSRM / OpenStreetMap yol ağı',
    providersTried: ROUTING_BASE_URLS.length
  };
}

const CATEGORY_LABELS = {
  school: 'Okul', market: 'Market', mosque: 'Cami', bank: 'Banka', atm: 'ATM',
  beach: 'Sahil / Plaj', pharmacy: 'Eczane', hospital: 'Hastane',
  bus_terminal: 'Otogar', train_station: 'Tren Garı / İstasyonu', airport: 'Havaalanı'
};
const BANK_BRAND_PATTERN = '(ziraat|ziraat bankasi|ziraat bankası|vakifbank|vakıfbank|vakif katilim|vakıf katılım|halkbank|halk bankasi|halk bankası|akbank|garanti|garanti bbva|teb|qnb|qnb finansbank|denizbank|ing|yapi kredi|yapı kredi|is bankasi|iş bankası|sekerbank|şekerbank|kuveyt turk|kuveyt türk|turkiye finans|türkiye finans|albaraka|ptt)';
const ATM_BRAND_PATTERN = '(atm|bankamatik|paramatik|bank24|parafpara|ziraat|vakifbank|vakıfbank|halkbank|akbank|garanti|teb|qnb|denizbank|ing|yapi kredi|yapı kredi|is bankasi|iş bankası|sekerbank|şekerbank|kuveyt turk|kuveyt türk|turkiye finans|türkiye finans|albaraka|ptt)';

/*
 * Sadece name alanına güvenilmez. Türkiye'deki eksik OSM kayıtlarında sık görülen
 * amenity, building, healthcare, shop, atm ve vending etiketleri birlikte aranır.
 */
const CATEGORY_QUERIES = {
  school: {
    core: [
      'nwr["amenity"~"^(school|kindergarten|college|university|training)$"]',
      'nwr["building"~"^(school|kindergarten|college|university)$"]'
    ],
    fallback: []
  },
  market: {
    core: [
      'nwr["shop"~"^(supermarket|convenience|grocery|general|greengrocer|department_store)$"]'
    ],
    fallback: []
  },
  mosque: {
    core: [
      'nwr["amenity"="place_of_worship"]["religion"="muslim"]',
      'nwr["amenity"="place_of_worship"][!"religion"]',
      'nwr["building"="mosque"]',
      'nwr["place_of_worship"="musalla"]'
    ],
    fallback: [
      'nwr["name"~"(cami|camii|mescit|mescidi|mosque)",i]'
    ]
  },
  bank: {
    core: [
      'nwr["amenity"="bank"]'
    ],
    fallback: [
      `nwr["name"~"${BANK_BRAND_PATTERN}",i]`,
      `nwr["brand"~"${BANK_BRAND_PATTERN}",i]`,
      'nwr["name"~"(bankası|bankasi|banka|bank$)",i]'
    ]
  },
  atm: {
    core: [
      'nwr["amenity"="atm"]',
      'nwr["atm"="yes"]',
      'nwr["cash_withdrawal"="yes"]',
      'nwr["vending"="cash"]'
    ],
    fallback: [
      `nwr["name"~"${ATM_BRAND_PATTERN}",i]`,
      `nwr["brand"~"${ATM_BRAND_PATTERN}",i]`,
      'nwr["name"~"(atm|bankamatik|paramatik|bank24|parafpara)",i]'
    ]
  },
  beach: {
    core: [
      'nwr["natural"="beach"]',
      'nwr["leisure"="beach_resort"]',
      'nwr["place"="beach"]'
    ],
    fallback: []
  },
  pharmacy: {
    core: [
      'nwr["amenity"="pharmacy"]',
      'nwr["healthcare"="pharmacy"]',
      'nwr["shop"="chemist"]'
    ],
    fallback: [
      'node["name"~"eczane",i]'
    ]
  },
  hospital: {
    core: [
      'nwr["amenity"="hospital"]',
      'nwr["healthcare"="hospital"]',
      'nwr["building"="hospital"]'
    ],
    fallback: [
      'nwr["amenity"~"^(clinic|doctors)$"]["name"~"(hastane|tıp merkezi|tip merkezi|medical center|sağlık merkezi|saglik merkezi)",i]',
      'nwr["healthcare"~"^(clinic|doctor|centre|health_centre)$"]["name"~"(hastane|tıp merkezi|tip merkezi|medical center|sağlık merkezi|saglik merkezi)",i]'
    ]
  },
  bus_terminal: {
    core: [
      'nwr["amenity"="bus_station"]',
      'nwr["public_transport"="station"]["bus"="yes"]'
    ],
    fallback: [
      'nwr["name"~"(otogar|otobüs terminali|otobus terminali|bus station|bus terminal)",i]["public_transport"]',
      'nwr["name"~"(otogar|otobüs terminali|otobus terminali|bus station|bus terminal)",i]["amenity"]'
    ]
  },
  train_station: {
    core: [
      'nwr["railway"~"^(station|halt)$"]',
      'nwr["public_transport"="station"]["train"="yes"]'
    ],
    fallback: [
      'nwr["name"~"(tren garı|tren gari|tren istasyonu|train station|railway station)",i]["railway"]',
      'nwr["name"~"(tren garı|tren gari|tren istasyonu|train station|railway station)",i]["public_transport"]'
    ]
  },
  airport: {
    core: [
      'nwr["aeroway"="aerodrome"]'
    ],
    fallback: [
      'nwr["aeroway"="terminal"]',
      'nwr["name"~"(havaalanı|havalimanı|havaalani|havalimani|airport|aerodrome)",i]["aeroway"]'
    ]
  }
};
function normalizeSearchText(value) {
  return String(value || '')
    .toLocaleLowerCase('tr-TR')
    .replace(/ı/g, 'i')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9çğıöşü]+/g, ' ')
    .trim();
}

function haversine(lat1, lon1, lat2, lon2) {
  const radius = 6371000;
  const toRad = value => value * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * radius * Math.asin(Math.sqrt(a));
}

function detectionsForTags(tags = {}) {
  const amenity = tags.amenity;
  const shop = tags.shop;
  const building = tags.building;
  const healthcare = tags.healthcare;
  const publicTransport = tags.public_transport;
  const railway = tags.railway;
  const aeroway = tags.aeroway;
  const text = normalizeSearchText([tags['name:tr'], tags.name, tags.official_name, tags.short_name].filter(Boolean).join(' '));
  const brandText = normalizeSearchText([tags.brand, tags.operator, tags.network].filter(Boolean).join(' '));
  const results = [];
  const add = (type, confidence, reason) => {
    if (!results.some(item => item.type === type)) results.push({ type, confidence, reason });
  };

  if (['school', 'kindergarten', 'college', 'university', 'training'].includes(amenity)) {
    add('school', 'Yüksek', `amenity=${amenity}`);
  } else if (['school', 'kindergarten', 'college', 'university'].includes(building)) {
    add('school', 'Orta', `building=${building}`);
  }

  if (['supermarket', 'convenience', 'grocery', 'general', 'greengrocer', 'department_store'].includes(shop)) {
    add('market', 'Yüksek', `shop=${shop}`);
  }

  if (amenity === 'place_of_worship' && tags.religion === 'muslim') {
    add('mosque', 'Yüksek', 'Müslüman ibadethanesi etiketi');
  } else if (tags.place_of_worship === 'musalla') {
    add('mosque', 'Yüksek', 'place_of_worship=musalla');
  } else if (building === 'mosque') {
    add('mosque', 'Orta', 'building=mosque; güncel kullanım etiketi bulunmuyor');
  } else if (/\b(cami|camii|mescit|mescidi|mosque)\b/.test(text)) {
    add('mosque', 'Yüksek', 'Ad/etiket cami olarak eşleşti');
  } else if (amenity === 'place_of_worship' && !tags.religion) {
    add('mosque', 'Kontrol önerilir', 'Dini türü yazılmamış ibadethane');
  }

  if (amenity === 'bank') add('bank', 'Yüksek', 'amenity=bank');
  else if (new RegExp(BANK_BRAND_PATTERN, 'i').test(text) || new RegExp(BANK_BRAND_PATTERN, 'i').test(brandText) || /\b(banka|bankasi|bank)\b/.test(text)) {
    add('bank', amenity ? 'Orta' : 'Kontrol önerilir', amenity ? 'Ad banka olarak eşleşti' : 'Ad/marka banka olarak eşleşti');
  }

  if (amenity === 'atm') add('atm', 'Yüksek', 'amenity=atm');
  else if (tags.atm === 'yes' || tags.cash_withdrawal === 'yes' || tags.vending === 'cash') {
    add('atm', 'Yüksek', tags.atm === 'yes' ? 'atm=yes' : (tags.cash_withdrawal === 'yes' ? 'cash_withdrawal=yes' : 'vending=cash'));
  } else if (/\b(atm|bankamatik|paramatik|bank24|parafpara)\b/.test(text) || /\b(atm|bankamatik|paramatik|bank24|parafpara)\b/.test(brandText)) {
    add('atm', 'Orta', 'Ad/marka ATM olarak eşleşti');
  }

  if (tags.natural === 'beach' || tags.leisure === 'beach_resort' || tags.place === 'beach') {
    add('beach', 'Yüksek', tags.natural === 'beach' ? 'natural=beach' : (tags.leisure === 'beach_resort' ? 'leisure=beach_resort' : 'place=beach'));
  }

  if (amenity === 'pharmacy' || healthcare === 'pharmacy') {
    add('pharmacy', 'Yüksek', amenity === 'pharmacy' ? 'amenity=pharmacy' : 'healthcare=pharmacy');
  } else if (shop === 'chemist' || /\beczane\b/.test(text)) {
    add('pharmacy', 'Orta', shop === 'chemist' ? 'shop=chemist' : 'Yalnızca ad eczane olarak eşleşti');
  }

  const hospitalName = /\b(hastane|devlet hastanesi|şehir hastanesi|sehir hastanesi|tıp merkezi|tip merkezi|medical center|sağlık merkezi|saglik merkezi)\b/.test(text);
  const privatePracticeName = /\b(muayenehane|doktor|dr\.?|diş|dis|dental|poliklinik|klinik)\b/.test(text) && !hospitalName;
  if (amenity === 'hospital' || healthcare === 'hospital' || building === 'hospital') {
    add('hospital', 'Yüksek', amenity === 'hospital' ? 'amenity=hospital' : (healthcare === 'hospital' ? 'healthcare=hospital' : 'building=hospital'));
  } else if (!privatePracticeName && hospitalName && (['clinic', 'doctors'].includes(amenity) || ['clinic', 'doctor', 'centre', 'health_centre'].includes(healthcare))) {
    add('hospital', 'Orta', 'Kurumsal hastane veya tıp merkezi adıyla doğrulandı');
  }

  if (amenity === 'bus_station') {
    add('bus_terminal', 'Yüksek', 'amenity=bus_station');
  } else if (publicTransport === 'station' && tags.bus === 'yes') {
    add('bus_terminal', 'Yüksek', 'public_transport=station ve bus=yes');
  } else if (/\b(otogar|otobus terminali|bus station|bus terminal)\b/.test(text)
      && (amenity || publicTransport)) {
    add('bus_terminal', 'Orta', 'Ad/etiket otogar olarak eşleşti');
  }

  const railMode = String(tags.station || '').toLowerCase();
  const urbanRailOnly = ['subway', 'light_rail', 'monorail'].includes(railMode) && tags.train !== 'yes';
  if (!urbanRailOnly && ['station', 'halt'].includes(railway)) {
    add('train_station', 'Yüksek', `railway=${railway}`);
  } else if (publicTransport === 'station' && tags.train === 'yes') {
    add('train_station', 'Yüksek', 'public_transport=station ve train=yes');
  } else if (/\b(tren gari|tren istasyonu|train station|railway station)\b/.test(text)
      && (railway || publicTransport)) {
    add('train_station', 'Orta', 'Ad/etiket tren istasyonu olarak eşleşti');
  }

  if (aeroway === 'aerodrome') {
    add('airport', 'Yüksek', 'aeroway=aerodrome');
  } else if (aeroway === 'terminal') {
    add('airport', 'Orta', 'aeroway=terminal; havaalanı terminali');
  } else if (/\b(havaalani|havalimani|airport|aerodrome)\b/.test(text) && aeroway) {
    add('airport', 'Orta', 'Ad/etiket havaalanı olarak eşleşti');
  }

  return results;
}

function detectionForTags(tags = {}, preferredCategory = null) {
  const detections = detectionsForTags(tags);
  if (preferredCategory) return detections.find(item => item.type === preferredCategory) || null;
  return detections[0] || null;
}

function radiusBoundingBox(lat, lng, radius) {
  const latitudeDelta = radius / 111320;
  const longitudeScale = Math.max(0.15, Math.cos(lat * Math.PI / 180));
  const longitudeDelta = radius / (111320 * longitudeScale);
  return {
    south: lat - latitudeDelta,
    west: lng - longitudeDelta,
    north: lat + latitudeDelta,
    east: lng + longitudeDelta
  };
}

function expandNwrSelector(selector) {
  const text = String(selector || '').trim();
  if (!text.startsWith('nwr')) return text ? [text] : [];
  const suffix = text.slice(3);
  return [`node${suffix}`, `way${suffix}`, `relation${suffix}`];
}

function selectorsForCategories(categories, mode = 'core') {
  const keys = Array.isArray(categories) ? categories : [categories];
  return keys.flatMap(key => {
    const definition = CATEGORY_QUERIES[key];
    if (!definition) return [];
    const selectors = mode === 'fallback'
      ? (definition.fallback || [])
      : mode === 'all'
        ? [...(definition.core || []), ...(definition.fallback || [])]
        : (definition.core || []);
    // node / way / relation ayrı seçicilere çevrilir. Ağır bir sorgu 504 verirse
    // yalnızca başarısız nesne tipi yeniden denenir; çalışan parçalar kaybolmaz.
    return selectors.flatMap(expandNwrSelector);
  });
}

function buildOverpassQueryFromSelectors(lat, lng, radius, selectors) {
  if (!Array.isArray(selectors) || !selectors.length) throw new Error('Geçersiz yakın yer sorgusu.');
  const bbox = radiusBoundingBox(lat, lng, radius);
  const box = [bbox.south, bbox.west, bbox.north, bbox.east]
    .map(value => Number(value).toFixed(6))
    .join(',');
  const clauses = selectors.map(selector => `${selector}(${box});`);
  const timeoutSeconds = radius >= 20000 ? 25 : radius >= 10000 ? 20 : 16;
  return `[out:json][timeout:${timeoutSeconds}][maxsize:67108864];(${clauses.join('')});out center tags qt;`;
}

function buildOverpassQuery(lat, lng, radius, categories, mode = 'core') {
  return buildOverpassQueryFromSelectors(lat, lng, radius, selectorsForCategories(categories, mode));
}

function sortedOverpassEndpoints({ bypassHealth = false } = {}) {
  const now = Date.now();
  const sorted = [...OVERPASS_ENDPOINTS].sort((a, b) => {
    const ah = overpassHealth.get(a.url);
    const bh = overpassHealth.get(b.url);
    const aScore = (ah?.averageMs || 2000) + (ah?.failures || 0) * 2500;
    const bScore = (bh?.averageMs || 2000) + (bh?.failures || 0) * 2500;
    return aScore - bScore;
  });
  if (bypassHealth) return sorted;
  const ready = sorted.filter(endpoint => (overpassHealth.get(endpoint.url)?.blockedUntil || 0) <= now);
  return ready;
}

function recordOverpassSuccess(endpoint, elapsedMs) {
  const health = overpassHealth.get(endpoint.url) || {};
  health.failures = Math.max(0, Number(health.failures || 0) - 1);
  health.blockedUntil = 0;
  health.averageMs = health.averageMs
    ? Math.round(health.averageMs * 0.65 + elapsedMs * 0.35)
    : elapsedMs;
  health.lastSuccess = Date.now();
  overpassHealth.set(endpoint.url, health);
}

function recordOverpassFailure(endpoint) {
  const health = overpassHealth.get(endpoint.url) || {};
  health.failures = Number(health.failures || 0) + 1;
  health.blockedUntil = Date.now() + Math.min(45000, health.failures * 10000);
  overpassHealth.set(endpoint.url, health);
}

async function runOverpassSelectors(lat, lng, radius, selectors, options = {}) {
  const query = buildOverpassQueryFromSelectors(lat, lng, radius, selectors);
  const body = new URLSearchParams({ data: query }).toString();
  const errors = [];
  let endpoints = sortedOverpassEndpoints({ bypassHealth: options.bypassHealth === true });

  // Önceki kategoride geçici hata oluşmuş olsa bile yeni kategoriyi tamamen
  // engelleme. Hazır sunucu kalmadıysa bütün yedekleri yeniden sırayla dene.
  if (!endpoints.length) endpoints = sortedOverpassEndpoints({ bypassHealth: true });
  if (Number.isFinite(Number(options.maxEndpoints))) endpoints = endpoints.slice(0, Math.max(1, Number(options.maxEndpoints)));

  for (const endpoint of endpoints) {
    const startedAt = Date.now();
    try {
      const requestTimeoutMs = radius >= 20000 ? 18000 : radius >= 10000 ? 15000 : 11000;
      const data = await fetchJson(endpoint.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          Accept: 'application/json',
          'Accept-Language': 'tr-TR,tr;q=0.9',
          'User-Agent': 'Kadastro360/2.0.6 (kadastro360.com.tr)'
        },
        body
      }, requestTimeoutMs);
      if (data?.remark) throw new Error(`Overpass çalışma hatası: ${data.remark}`);
      recordOverpassSuccess(endpoint, Date.now() - startedAt);
      return { data, endpoint: endpoint.name };
    } catch (error) {
      recordOverpassFailure(endpoint);
      errors.push(`${endpoint.name}: ${error.message}`);
    }
  }

  throw new Error(errors.join(' | ') || 'Yakın yer servisi yanıt vermedi.');
}

async function runSelectorSetResilient(lat, lng, radius, selectors, depth = 0) {
  try {
    const result = await runOverpassSelectors(lat, lng, radius, selectors, { bypassHealth: depth > 0, maxEndpoints: 3 });
    return {
      elements: Array.isArray(result.data?.elements) ? result.data.elements : [],
      providers: [result.endpoint],
      warnings: [],
      successfulParts: 1,
      failedParts: 0
    };
  } catch (error) {
    const transient = /504|502|503|429|zaman aşımı|timeout|çalışma hatası|runtime/i.test(String(error.message || error));
    const canSplit = selectors.length > 1 && depth < 2 && radius <= 30000 && transient;
    if (!canSplit) {
      return {
        elements: [],
        providers: [],
        warnings: [error.message],
        successfulParts: 0,
        failedParts: 1
      };
    }

    const middle = Math.ceil(selectors.length / 2);
    // Aynı genel Overpass sunucusuna iki ağır istek birden yüklememek için
    // parçaları sırayla çalıştır. Başarılı parçalar korunur.
    const left = await runSelectorSetResilient(lat, lng, radius, selectors.slice(0, middle), depth + 1);
    const right = await runSelectorSetResilient(lat, lng, radius, selectors.slice(middle), depth + 1);
    return {
      elements: [...left.elements, ...right.elements],
      providers: [...new Set([...left.providers, ...right.providers])],
      warnings: [...left.warnings, ...right.warnings],
      successfulParts: left.successfulParts + right.successfulParts,
      failedParts: left.failedParts + right.failedParts
    };
  }
}

function mergeElementArray(target, elements) {
  for (const element of elements || []) {
    const key = `${element.type || 'x'}-${element.id}`;
    if (!target.has(key)) target.set(key, element);
  }
}

function detectedCategorySet(elements) {
  const set = new Set();
  for (const element of elements || []) {
    for (const detection of detectionsForTags(element.tags || {})) set.add(detection.type);
  }
  return set;
}

async function mapLimit(values, limit, mapper) {
  const results = new Array(values.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= values.length) return;
      results[index] = await mapper(values[index], index);
    }
  }

  const count = Math.max(1, Math.min(limit, values.length));
  await Promise.all(Array.from({ length: count }, () => worker()));
  return results;
}

const POI_CATEGORY_BATCHES = [
  ['school', 'market', 'mosque'],
  ['pharmacy', 'hospital', 'bank', 'atm'],
  ['beach', 'bus_terminal', 'train_station', 'airport']
];

// Kırsal parsellerde okul, market, eczane, banka ve ATM çoğu zaman ilçe
// merkezinde 10 km'den daha uzakta kalır. Akıllı arama bu türleri erken
// 'yok' saymaz; sonuç bulunmayan her kategori 30 km'ye kadar bağımsız genişler.
const POI_MAX_RADIUS = {
  school: 30000, market: 30000, mosque: 30000, pharmacy: 30000,
  hospital: 30000, bank: 30000, atm: 30000,
  beach: 30000, bus_terminal: 30000, train_station: 30000, airport: 30000
};

async function queryCategoriesAtRadius(lat, lng, radius, categories) {
  const requested = [...new Set(categories)].filter(key => CATEGORY_QUERIES[key]);
  const elementMap = new Map();
  const warnings = [];
  const providers = new Set();
  const succeededCategories = new Set();
  const failedCategories = new Set();
  const batches = radius > 10000
    ? requested.map(key => [key])
    : POI_CATEGORY_BATCHES.map(batch => batch.filter(key => requested.includes(key))).filter(batch => batch.length);

  // 10 km'de hızlı küçük gruplar kullanılır. Bir grup geçici olarak hata verirse
  // yalnızca o grupta bulunamayan kategoriler tek tek yeniden denenir. Böylece normal
  // arama üç hafif istekle tamamlanır; tek bir ağır seçici diğer türleri düşürmez.
  const batchResults = await mapLimit(batches, radius > 10000 ? 2 : 3, async keys => {
    const localMap = new Map();
    const localProviders = new Set();
    const localWarnings = [];
    const categoryStatus = new Map(keys.map(key => [key, 'pending']));

    const absorbPart = result => {
      mergeElementArray(localMap, result.elements);
      result.providers.forEach(provider => localProviders.add(provider));
      localWarnings.push(...result.warnings);
    };

    const core = await runSelectorSetResilient(lat, lng, radius, selectorsForCategories(keys, 'core'));
    absorbPart(core);
    let found = detectedCategorySet([...localMap.values()]);

    if (core.failedParts === 0) {
      keys.forEach(key => categoryStatus.set(key, 'success'));
    } else {
      keys.filter(key => found.has(key)).forEach(key => categoryStatus.set(key, 'success'));
      const retryKeys = keys.filter(key => !found.has(key));
      const retries = await mapLimit(retryKeys, 2, async key => {
        const retry = await runSelectorSetResilient(lat, lng, radius, selectorsForCategories([key], 'core'));
        return { key, retry };
      });
      for (const { key, retry } of retries) {
        absorbPart(retry);
        categoryStatus.set(key, retry.successfulParts > 0 ? 'success' : 'failed');
      }
      found = detectedCategorySet([...localMap.values()]);
    }

    // Temel sorgusu çalışan fakat kayıt bulamayan kategoriler için ad/marka tabanlı
    // yedekler ayrı ayrı denenir. Yedek sorgunun geçici hatası, çalışan temel sorguyu
    // başarısız durumuna çevirmemelidir.
    const fallbackKeys = keys.filter(key => categoryStatus.get(key) !== 'failed'
      && !found.has(key) && (CATEGORY_QUERIES[key].fallback || []).length);
    const fallbackResults = await mapLimit(fallbackKeys, 2, async key => ({
      key,
      result: await runSelectorSetResilient(lat, lng, radius, selectorsForCategories([key], 'fallback'))
    }));
    for (const { key, result } of fallbackResults) {
      absorbPart(result);
      if (result.successfulParts === 0) {
        localWarnings.push(`${CATEGORY_LABELS[key]} yedek sorgusu yanıt vermedi; temel sorgu sonucu korundu.`);
      }
    }

    return {
      keys,
      elements: [...localMap.values()],
      providers: [...localProviders],
      warnings: localWarnings,
      categoryStatus
    };
  });

  for (const result of batchResults) {
    mergeElementArray(elementMap, result.elements);
    result.providers.forEach(provider => providers.add(provider));
    const label = result.keys.map(key => CATEGORY_LABELS[key]).join(', ');
    warnings.push(...result.warnings.map(message => `${label}: ${message}`));
    for (const key of result.keys) {
      if (result.categoryStatus.get(key) === 'failed') failedCategories.add(key);
      else succeededCategories.add(key);
    }
  }

  return {
    elements: [...elementMap.values()],
    warnings: [...new Set(warnings)].slice(0, 20),
    providers: [...providers],
    succeededCategories,
    failedCategories
  };
}

function pointInRing(lat, lng, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = Number(ring[i]?.[0]);
    const yi = Number(ring[i]?.[1]);
    const xj = Number(ring[j]?.[0]);
    const yj = Number(ring[j]?.[1]);
    if (![xi, yi, xj, yj].every(Number.isFinite)) continue;
    const intersects = ((yi > lat) !== (yj > lat))
      && (lng < (xj - xi) * (lat - yi) / ((yj - yi) || Number.EPSILON) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointInPolygon(lat, lng, polygon) {
  if (!Array.isArray(polygon) || !polygon.length || !pointInRing(lat, lng, polygon[0])) return false;
  for (let i = 1; i < polygon.length; i++) {
    if (pointInRing(lat, lng, polygon[i])) return false;
  }
  return true;
}

function pointToSegmentMeters(lat, lng, a, b) {
  const lat0 = lat * Math.PI / 180;
  const metersPerLat = 111132.92;
  const metersPerLng = 111412.84 * Math.cos(lat0);
  const ax = (Number(a?.[0]) - lng) * metersPerLng;
  const ay = (Number(a?.[1]) - lat) * metersPerLat;
  const bx = (Number(b?.[0]) - lng) * metersPerLng;
  const by = (Number(b?.[1]) - lat) * metersPerLat;
  if (![ax, ay, bx, by].every(Number.isFinite)) return Infinity;
  const dx = bx - ax;
  const dy = by - ay;
  const denom = dx * dx + dy * dy;
  const t = denom ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / denom)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}

function distanceToPolygon(lat, lng, polygon) {
  if (pointInPolygon(lat, lng, polygon)) return 0;
  let min = Infinity;
  for (const ring of polygon || []) {
    for (let i = 1; i < ring.length; i++) {
      min = Math.min(min, pointToSegmentMeters(lat, lng, ring[i - 1], ring[i]));
    }
    if (ring?.length > 2) min = Math.min(min, pointToSegmentMeters(lat, lng, ring[ring.length - 1], ring[0]));
  }
  return min;
}

function distanceToGeometry(lat, lng, geometry, fallbackLat, fallbackLng) {
  try {
    if (geometry?.type === 'Polygon') return distanceToPolygon(lat, lng, geometry.coordinates);
    if (geometry?.type === 'MultiPolygon') {
      return Math.min(...geometry.coordinates.map(polygon => distanceToPolygon(lat, lng, polygon)));
    }
    if (geometry?.type === 'Point') {
      return haversine(lat, lng, Number(geometry.coordinates?.[1]), Number(geometry.coordinates?.[0]));
    }
  } catch {
    // Aşağıdaki merkez mesafesine düş.
  }
  return haversine(fallbackLat, fallbackLng, lat, lng);
}


function cleanAdminName(value) {
  return String(value || '').trim().slice(0, 120);
}

function normalizeAdminContext(value = {}) {
  return {
    province: cleanAdminName(value.province),
    district: cleanAdminName(value.district),
    neighborhood: cleanAdminName(value.neighborhood)
  };
}

function tagAdminValues(tags = {}, keys = []) {
  return keys.map(key => cleanAdminName(tags[key])).filter(Boolean);
}

function adminMatchForItem(tags = {}, adminContext = {}, scope = 'parcel') {
  const districtNeedle = normalizeSearchText(adminContext.district);
  const provinceNeedle = normalizeSearchText(adminContext.province);
  const districtValues = tagAdminValues(tags, [
    'addr:district', 'is_in:district', 'addr:county', 'is_in:county',
    'addr:city', 'is_in:city', 'is_in'
  ]).map(normalizeSearchText);
  const provinceValues = tagAdminValues(tags, [
    'addr:province', 'addr:state', 'is_in:province', 'is_in:state'
  ]).map(normalizeSearchText);
  let districtMatch = null;
  let provinceMatch = null;
  if (districtNeedle && districtValues.length) {
    districtMatch = districtValues.some(value => value === districtNeedle || value.includes(districtNeedle) || districtNeedle.includes(value));
  }
  if (provinceNeedle && provinceValues.length) {
    provinceMatch = provinceValues.some(value => value === provinceNeedle || value.includes(provinceNeedle) || provinceNeedle.includes(value));
  }
  // İlçe merkez koordinatından yapılan tarama, açıkça başka ilçe etiketi yoksa
  // aynı ilçe sonucu olarak önceliklendirilir. Bu yalnızca sıralama bilgisidir;
  // POI yine canlı OSM/Overpass kaydıdır.
  if (scope === 'district-center' && districtNeedle && districtMatch !== false) districtMatch = true;
  if (scope === 'district-center' && provinceNeedle && provinceMatch !== false) provinceMatch = true;
  return { districtMatch, provinceMatch };
}

function poiScope(element) {
  const scopes = Array.isArray(element?._k360Scopes) ? element._k360Scopes : [];
  return scopes.includes('district-center') ? 'district-center' : 'parcel';
}

function poiPriority(item) {
  if (item?.districtMatch === true) return 0;
  if (item?.districtMatch === false) return 2;
  return 1;
}

function comparePoi(a, b) {
  return poiPriority(a) - poiPriority(b)
    || Number(a.distance || 0) - Number(b.distance || 0)
    || Number(a.centerDistance || 0) - Number(b.centerDistance || 0)
    || String(a.name || '').localeCompare(String(b.name || ''), 'tr');
}

function scoreDistrictResult(row, adminContext) {
  const display = normalizeSearchText(row?.display_name);
  const address = row?.address || {};
  const districtNeedle = normalizeSearchText(adminContext.district);
  const provinceNeedle = normalizeSearchText(adminContext.province);
  const districtFields = [address.town, address.city, address.county, address.municipality, address.city_district, address.district]
    .map(normalizeSearchText).filter(Boolean);
  const provinceFields = [address.state, address.province, address.region]
    .map(normalizeSearchText).filter(Boolean);
  let score = 0;
  if (districtNeedle && districtFields.some(value => value === districtNeedle)) score += 8;
  else if (districtNeedle && districtFields.some(value => value.includes(districtNeedle) || districtNeedle.includes(value))) score += 5;
  else if (districtNeedle && display.includes(districtNeedle)) score += 3;
  if (provinceNeedle && provinceFields.some(value => value === provinceNeedle)) score += 5;
  else if (provinceNeedle && display.includes(provinceNeedle)) score += 2;
  if (String(row?.type || '').toLowerCase() === 'administrative') score += 2;
  return score;
}

async function getDistrictSearchAnchor(adminContext = {}) {
  const context = normalizeAdminContext(adminContext);
  if (!context.province || !context.district) return null;
  const key = `district-anchor-v1:${normalizeSearchText(context.province)}:${normalizeSearchText(context.district)}`;
  return cached(key, 7 * 24 * 60 * 60 * 1000, async () => {
    const url = new URL(`${NOMINATIM_BASE_URL}/search`);
    url.searchParams.set('q', `${context.district}, ${context.province}, Türkiye`);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('addressdetails', '1');
    url.searchParams.set('countrycodes', 'tr');
    url.searchParams.set('limit', '8');
    const rows = await fetchJson(url.toString(), {
      headers: {
        Accept: 'application/json',
        'Accept-Language': 'tr-TR,tr;q=0.9',
        'User-Agent': 'Kadastro360/2.0.6 (kadastro360.com.tr)'
      }
    }, 9000);
    if (!Array.isArray(rows) || !rows.length) return null;
    const ranked = rows
      .map(row => ({ row, score: scoreDistrictResult(row, context) }))
      .filter(entry => entry.score >= 5)
      .sort((a, b) => b.score - a.score || Number(a.row?.place_rank || 99) - Number(b.row?.place_rank || 99));
    const selected = ranked[0]?.row;
    const lat = Number(selected?.lat);
    const lng = Number(selected?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return {
      lat, lng,
      displayName: cleanAdminName(selected.display_name),
      boundingbox: Array.isArray(selected.boundingbox) ? selected.boundingbox.map(Number) : null
    };
  });
}

function pointInsideDistrictBoundingBox(lat, lng, districtAnchor) {
  const box = Array.isArray(districtAnchor?.boundingbox) ? districtAnchor.boundingbox.map(Number) : null;
  if (!box || box.length !== 4 || !box.every(Number.isFinite)) return null;
  const [south, north, west, east] = box;
  return Number(lat) >= Math.min(south, north) && Number(lat) <= Math.max(south, north)
    && Number(lng) >= Math.min(west, east) && Number(lng) <= Math.max(west, east);
}

function poiSuccessfulCacheKey(lat, lng, category, scope, context = {}) {
  return [
    Number(lat).toFixed(4), Number(lng).toFixed(4), category, scope,
    normalizeSearchText(context.province), normalizeSearchText(context.district)
  ].join(':');
}

function rememberSuccessfulPoiCategory(lat, lng, category, scope, context, radius, elements) {
  const matched = (elements || []).filter(element => detectionForTags(element.tags || {}, category));
  if (!matched.length) return;
  const key = poiSuccessfulCacheKey(lat, lng, category, scope, context);
  poiSuccessfulCategoryCache.set(key, {
    elements: matched.map(element => ({ ...element })),
    radius: Number(radius) || 0,
    expiresAt: Date.now() + POI_SUCCESS_CACHE_TTL_MS
  });
  while (poiSuccessfulCategoryCache.size > 220) {
    const oldest = poiSuccessfulCategoryCache.keys().next().value;
    poiSuccessfulCategoryCache.delete(oldest);
  }
}

function readSuccessfulPoiCategory(lat, lng, category, scope, context, requestedRadius) {
  const key = poiSuccessfulCacheKey(lat, lng, category, scope, context);
  const row = poiSuccessfulCategoryCache.get(key);
  if (!row || row.expiresAt <= Date.now()) {
    if (row) poiSuccessfulCategoryCache.delete(key);
    return null;
  }
  // Daha dar önceki arama sonucu, daha geniş yeni arama başarısız olduğunda
  // güvenli biçimde korunabilir; sonuç yeni 30 km sonucuymuş gibi etiketlenmez.
  return { ...row, requestedRadius: Number(requestedRadius) || 0 };
}

function itemFromElement(element, originLat, originLng, geometry, preferredCategory = null, adminContext = {}) {
  const itemLat = Number(element.lat ?? element.center?.lat);
  const itemLng = Number(element.lon ?? element.center?.lon);
  if (!Number.isFinite(itemLat) || !Number.isFinite(itemLng)) return null;
  const tags = element.tags || {};
  const detection = detectionForTags(tags, preferredCategory);
  if (!detection) return null;

  const actualName = String(tags['name:tr'] || tags.name || tags.official_name || tags.short_name || '').trim();
  const isUnnamed = !actualName;
  const name = actualName || `İsimsiz ${CATEGORY_LABELS[detection.type]} noktası`;
  const centerDistance = Math.round(haversine(originLat, originLng, itemLat, itemLng));
  const parcelDistance = Math.max(0, Math.round(distanceToGeometry(itemLat, itemLng, geometry, originLat, originLng)));
  const address = [
    tags['addr:neighbourhood'] || tags['addr:suburb'] || tags['addr:quarter'] || tags['addr:village'],
    tags['addr:street'],
    tags['addr:housenumber']
  ].filter(Boolean).join(' ') || null;
  const searchScope = poiScope(element);
  const adminMatch = adminMatchForItem(tags, normalizeAdminContext(adminContext), searchScope);

  return {
    id: `${element.type || 'x'}-${element.id}-${detection.type}`,
    osmType: element.type || null,
    osmId: element.id || null,
    name,
    isUnnamed,
    type: detection.type,
    typeLabel: CATEGORY_LABELS[detection.type],
    confidence: detection.confidence,
    detectionReason: detection.reason,
    lat: itemLat,
    lng: itemLng,
    distance: parcelDistance,
    centerDistance,
    address,
    searchScope,
    districtMatch: adminMatch.districtMatch,
    provinceMatch: adminMatch.provinceMatch
  };
}

function itemsFromElement(element, originLat, originLng, geometry, category = 'all', adminContext = {}) {
  if (category !== 'all') {
    const item = itemFromElement(element, originLat, originLng, geometry, category, adminContext);
    return item ? [item] : [];
  }
  return detectionsForTags(element.tags || {})
    .map(detection => itemFromElement(element, originLat, originLng, geometry, detection.type, adminContext))
    .filter(Boolean);
}

function mergeElements(target, data, scope = 'parcel') {
  for (const element of data?.elements || []) {
    const key = `${element.type || 'x'}-${element.id}`;
    const existing = target.get(key);
    if (!existing) {
      target.set(key, { ...element, _k360Scopes: [scope] });
    } else {
      const scopes = new Set([...(existing._k360Scopes || []), scope]);
      existing._k360Scopes = [...scopes];
    }
  }
}

function categoryCounts(items) {
  return items.reduce((out, item) => {
    out[item.type] = (out[item.type] || 0) + 1;
    return out;
  }, {});
}

const POI_DISPLAY_LIMITS = {
  school: 20, market: 20, mosque: 25, pharmacy: 20, hospital: 12,
  bank: 15, atm: 15, beach: 15, bus_terminal: 10, train_station: 10, airport: 8
};

function limitBalanced(items, category) {
  const ordered = [...items].sort(comparePoi);
  if (category !== 'all') return ordered.slice(0, Math.max(20, POI_DISPLAY_LIMITS[category] || 40));
  const perType = new Map();
  for (const item of ordered) {
    const list = perType.get(item.type) || [];
    if (list.length < (POI_DISPLAY_LIMITS[item.type] || 20)) list.push(item);
    perType.set(item.type, list);
  }
  return [...perType.values()]
    .flat()
    .sort(comparePoi)
    .slice(0, 180);
}

async function getPoi(lat, lng, radiusMode, category, geometry, adminContext = {}) {
  const context = normalizeAdminContext(adminContext);
  const geometryKey = geometry ? JSON.stringify(geometry).slice(0, 2000) : '';
  const cacheKey = `poi-v206:${lat.toFixed(5)}:${lng.toFixed(5)}:${radiusMode}:${category}:${normalizeSearchText(context.province)}:${normalizeSearchText(context.district)}:${geometryKey}`;
  return cached(cacheKey, 30 * 60 * 1000, async () => {
    const startedAt = Date.now();
    const allCategories = Object.keys(CATEGORY_QUERIES);
    const requestedCategories = category === 'all' ? allCategories : [category];
    const elementMap = new Map();
    const searchedRadii = [];
    const warnings = [];
    const providers = new Set();
    const successfulCategories = new Set();
    const failedCategories = new Set();
    const cachedFallbackCategories = new Set();
    const coverage = {};
    const districtAnchorPromise = context.province && context.district
      ? getDistrictSearchAnchor(context).catch(error => {
          warnings.push(`İlçe merkezi bulunamadı: ${error.message}`);
          return null;
        })
      : Promise.resolve(null);

    const absorb = (result, radius, scope = 'parcel', searchLat = lat, searchLng = lng) => {
      mergeElements(elementMap, { elements: result.elements }, scope);
      searchedRadii.push(radius);
      result.warnings.forEach(warning => warnings.push(warning));
      result.providers.forEach(provider => providers.add(provider));
      result.succeededCategories.forEach(key => {
        successfulCategories.add(key);
        failedCategories.delete(key);
        rememberSuccessfulPoiCategory(searchLat, searchLng, key, scope, context, radius, result.elements);
      });
      result.failedCategories.forEach(key => {
        if (successfulCategories.has(key)) return;
        const previous = readSuccessfulPoiCategory(searchLat, searchLng, key, scope, context, radius);
        if (previous?.elements?.length) {
          mergeElements(elementMap, { elements: previous.elements }, scope);
          successfulCategories.add(key);
          cachedFallbackCategories.add(key);
          failedCategories.delete(key);
          warnings.push(`${CATEGORY_LABELS[key]}: yeni servis isteği yanıt vermedi; son başarılı canlı sonuç korundu.`);
        } else {
          failedCategories.add(key);
        }
      });
    };

    if (radiusMode !== 'auto') {
      const radius = Math.max(300, Math.min(30000, Number(radiusMode) || 1000));
      const result = await queryCategoriesAtRadius(lat, lng, radius, requestedCategories);
      absorb(result, radius);
      for (const key of requestedCategories) coverage[key] = { radius, status: failedCategories.has(key) ? 'failed' : cachedFallbackCategories.has(key) ? 'cached' : 'checked' };
    } else {
      let pending = [...requestedCategories];
      for (const radius of [10000, 20000, 30000]) {
        if (!pending.length) break;
        const eligible = pending.filter(key => radius <= (POI_MAX_RADIUS[key] || 10000));
        for (const key of pending.filter(key => !eligible.includes(key))) {
          coverage[key] = coverage[key] || { radius: POI_MAX_RADIUS[key] || 10000, status: 'empty' };
        }
        if (!eligible.length) {
          pending = pending.filter(key => !coverage[key]);
          continue;
        }
        const result = await queryCategoriesAtRadius(lat, lng, radius, eligible);
        absorb(result, radius);

        const currentItems = [...elementMap.values()]
          .flatMap(element => itemsFromElement(element, lat, lng, geometry, 'all', context))
          .filter(item => item.centerDistance <= radius * 1.03);
        const found = new Set(currentItems.map(item => item.type));

        const nextPending = [];
        for (const key of pending) {
          const maxRadiusForCategory = POI_MAX_RADIUS[key] || 10000;
          if (found.has(key)) {
            coverage[key] = { radius, status: cachedFallbackCategories.has(key) ? 'cached' : 'found' };
          } else if (eligible.includes(key) && result.failedCategories.has(key)) {
            coverage[key] = { radius, status: 'failed' };
          } else if (radius >= maxRadiusForCategory) {
            coverage[key] = { radius: maxRadiusForCategory, status: 'empty' };
          } else {
            nextPending.push(key);
          }
        }
        pending = nextPending;
      }
    }

    // Parsel ilçe merkezine uzaksa salt dairesel arama, komşu ilçedeki daha yakın
    // kayıtları seçebilir. Eksik veya 15 km'den uzak kritik türler için seçilen
    // ilçe merkezinde ikinci bir canlı OSM taraması yapılır ve aynı ilçe önceliklenir.
    let districtAnchor = null;
    let districtFallbackCategories = [];
    if (radiusMode === 'auto' && context.province && context.district) {
      const parcelItems = [...elementMap.values()]
        .flatMap(element => itemsFromElement(element, lat, lng, geometry, 'all', context));
      const districtPriorityCategories = new Set(['school', 'market', 'mosque', 'bank', 'atm', 'pharmacy', 'hospital', 'bus_terminal', 'train_station', 'airport']);
      districtFallbackCategories = requestedCategories.filter(key => {
        if (!districtPriorityCategories.has(key)) return false;
        const rows = parcelItems.filter(item => item.type === key);
        if (!rows.length) return true;
        const nearest = [...rows].sort(comparePoi)[0];
        if (['bank', 'atm'].includes(key) && nearest.districtMatch !== true) return true;
        return nearest.districtMatch === false || nearest.centerDistance > 12000;
      });
      if (districtFallbackCategories.length) {
        districtAnchor = await districtAnchorPromise;
        if (districtAnchor) {
          let pendingDistrict = [...districtFallbackCategories];
          for (const radius of [8000, 18000]) {
            if (!pendingDistrict.length) break;
            const result = await queryCategoriesAtRadius(districtAnchor.lat, districtAnchor.lng, radius, pendingDistrict);
            absorb(result, radius, 'district-center', districtAnchor.lat, districtAnchor.lng);
            const centerItems = [...elementMap.values()]
              .flatMap(element => itemsFromElement(element, lat, lng, geometry, 'all', context))
              .filter(item => item.searchScope === 'district-center');
            pendingDistrict = pendingDistrict.filter(key => !centerItems.some(item => item.type === key));
            for (const key of districtFallbackCategories) {
              if (centerItems.some(item => item.type === key)) {
                coverage[key] = { ...(coverage[key] || {}), status: 'found', districtRadius: radius, districtFallback: true };
              }
            }
          }
        }
      }
    }

    if (!districtAnchor && context.province && context.district) {
      districtAnchor = await districtAnchorPromise;
    }

    const maxRadius = searchedRadii.length ? Math.max(...searchedRadii) : 0;
    const seenLocations = new Set();
    let items = [...elementMap.values()]
      .flatMap(element => itemsFromElement(element, lat, lng, geometry, category, context))
      .filter(item => {
        if (maxRadius && item.searchScope !== 'district-center' && item.centerDistance > maxRadius * 1.03) return false;
        const key = `${item.type}|${item.lat.toFixed(6)}|${item.lng.toFixed(6)}`;
        if (seenLocations.has(key)) return false;
        seenLocations.add(key);
        return true;
      })
      .sort(comparePoi);

    if (districtAnchor?.boundingbox) {
      items = items.map(item => {
        const inside = pointInsideDistrictBoundingBox(item.lat, item.lng, districtAnchor);
        if (inside === null) return item;
        if (item.searchScope === 'district-center' || item.districtMatch === null) return { ...item, districtMatch: inside };
        if (item.districtMatch === true && inside === false) return { ...item, districtMatch: false };
        return item;
      });
      const strictDistrictTypes = new Set(['school', 'market', 'mosque', 'pharmacy', 'hospital', 'bank', 'atm', 'bus_terminal']);
      items = items.filter(item => !(strictDistrictTypes.has(item.type) && item.districtMatch === false));
    }

    const preferredTypeState = new Map();
    for (const item of items) {
      const row = preferredTypeState.get(item.type) || { hasDistrictCenter: false, hasDistrictTrue: false };
      if (item.searchScope === 'district-center') row.hasDistrictCenter = true;
      if (item.districtMatch === true) row.hasDistrictTrue = true;
      preferredTypeState.set(item.type, row);
    }
    items = items.filter(item => {
      const state = preferredTypeState.get(item.type) || {};
      if (state.hasDistrictCenter) {
        return item.searchScope === 'district-center' || item.districtMatch === true;
      }
      if (state.hasDistrictTrue) return item.districtMatch !== false;
      if (['bank', 'atm'].includes(item.type) && item.centerDistance > 40000 && item.districtMatch !== true && item.searchScope !== 'district-center') {
        return false;
      }
      return true;
    });
    const discoveredCounts = categoryCounts(items);
    items = limitBalanced(items, category);
    const shownCounts = categoryCounts(items);
    const truncatedCategories = requestedCategories.filter(key => (discoveredCounts[key] || 0) > (shownCounts[key] || 0));

    if (!items.length && successfulCategories.size === 0 && failedCategories.size) {
      throw new Error('Yakın yer servislerinin tamamı yanıt vermedi. Küçük sorgular ve yedek sunucular da denendi.');
    }

    for (const key of requestedCategories) {
      coverage[key] = {
        ...(coverage[key] || { radius: maxRadius, status: failedCategories.has(key) ? 'failed' : 'empty' }),
        count: shownCounts[key] || 0,
        discoveredCount: discoveredCounts[key] || 0,
        truncated: truncatedCategories.includes(key)
      };
    }

    return {
      items,
      elapsedMs: Date.now() - startedAt,
      searchedRadii: [...new Set(searchedRadii)].sort((a, b) => a - b),
      maxRadius,
      adaptive: radiusMode === 'auto',
      unnamedCount: items.filter(item => item.isUnnamed).length,
      sourceTimestamp: null,
      source: 'OpenStreetMap / Overpass',
      providers: [...providers],
      partial: failedCategories.size > 0 && successfulCategories.size > 0,
      failedCategories: [...failedCategories],
      cachedFallbackCategories: [...cachedFallbackCategories],
      warnings: [...new Set(warnings)].slice(0, 8),
      coverage,
      counts: shownCounts,
      discoveredCounts,
      truncatedCategories,
      adminContext: context,
      districtAnchor,
      districtFallbackCategories
    };
  });
}


function firstProperty(object, keys) {
  for (const key of keys) {
    const value = object?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return null;
}

function payloadFeature(payload) {
  if (payload?.type === 'Feature' && payload.geometry) return payload;
  if (payload?.geometry) return { type: 'Feature', geometry: payload.geometry, properties: payload.properties || {} };
  const rows = Array.isArray(payload?.features) ? payload.features
    : Array.isArray(payload?.data?.features) ? payload.data.features
      : Array.isArray(payload?.data) ? payload.data
        : Array.isArray(payload) ? payload : [];
  const found = rows.find(row => row?.geometry);
  if (found) return found.type === 'Feature' ? found : { type: 'Feature', geometry: found.geometry, properties: found.properties || {} };
  if (payload?.data?.geometry) return { type: 'Feature', geometry: payload.data.geometry, properties: payload.data.properties || {} };
  return null;
}

function geometryCenter(geometry) {
  const points = [];
  const walk = value => {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]))) {
      points.push([Number(value[0]), Number(value[1])]);
      return;
    }
    value.forEach(walk);
  };
  walk(geometry?.coordinates);
  if (!points.length) return { lat: null, lng: null };
  const minLng = Math.min(...points.map(p => p[0]));
  const maxLng = Math.max(...points.map(p => p[0]));
  const minLat = Math.min(...points.map(p => p[1]));
  const maxLat = Math.max(...points.map(p => p[1]));
  return { lat: (minLat + maxLat) / 2, lng: (minLng + maxLng) / 2 };
}

const loginFailures = new Map();
function loginKey(req, username = '') {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return `${forwarded || req.socket.remoteAddress || 'unknown'}:${String(username).toLocaleLowerCase('tr-TR')}`;
}
function loginBlocked(req, username) {
  const row = loginFailures.get(loginKey(req, username));
  return row && row.blockedUntil > Date.now();
}
function recordLoginFailure(req, username) {
  const key = loginKey(req, username);
  const now = Date.now();
  const row = loginFailures.get(key);
  const count = row && row.resetAt > now ? row.count + 1 : 1;
  loginFailures.set(key, { count, resetAt: now + 15 * 60_000, blockedUntil: count >= 5 ? now + 15 * 60_000 : 0 });
}
function clearLoginFailures(req, username) { loginFailures.delete(loginKey(req, username)); }

const publicFormWindows = new Map();
function publicFormAllowed(req, name, limit = 3, windowMs = 60 * 60_000) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = forwarded || req.socket.remoteAddress || 'unknown';
  const key = `${ip}:${name}`;
  const now = Date.now();
  const current = publicFormWindows.get(key);
  if (!current || current.resetAt <= now) {
    publicFormWindows.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  current.count += 1;
  return current.count <= limit;
}

const requestWindows = new Map();
function requestAllowed(req, pathname) {
  if (!pathname.startsWith('/api/') || pathname === '/api/health') return true;
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = forwarded || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const windowMs = 60_000;
  const limit = pathname === '/api/poi' || pathname === '/api/terrain-analysis' || pathname === '/api/route' ? 20 : 120;
  const key = `${ip}:${pathname}`;
  const current = requestWindows.get(key);
  if (!current || current.resetAt <= now) {
    requestWindows.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  current.count += 1;
  return current.count <= limit;
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return sendJson(res, 204, {});
  const requestUrl = new URL(req.url, `http://${req.headers.host || `${HOST}:${activePort}`}`);
  const pathname = requestUrl.pathname;

  if (!requestAllowed(req, pathname)) {
    return sendJson(res, 429, { error: 'Çok fazla istek gönderildi. Bir dakika sonra tekrar deneyin.' });
  }

  try {
    if (req.method === 'GET' && pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, service: 'kadastro360', version: '2.0.6-viewport-wms-poi-resilience', dataMode: 'live-only', mockData: false, tucbsBridge: true, accounts: true, brandingAssets: true, database: accounts.provider, mail: mailer.enabled });
    }

    if (req.method === 'GET' && pathname === '/favicon.ico') {
      return sendFile(res, path.join(ROOT, 'assets', 'favicon.ico'), 'image/x-icon');
    }
    const publicAsset = pathname.match(/^\/assets\/([A-Za-z0-9._-]+)$/);
    if (req.method === 'GET' && publicAsset) {
      const name = publicAsset[1];
      const types = { '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.webp': 'image/webp' };
      const assetPath = path.join(ROOT, 'assets', name);
      if (!fs.existsSync(assetPath) || !fs.statSync(assetPath).isFile()) return sendJson(res, 404, { error: 'Görsel bulunamadı.' });
      return sendFile(res, assetPath, types[path.extname(name).toLowerCase()] || 'application/octet-stream');
    }

    if (!TEST_PASSWORD || !SESSION_SECRET) {
      return sendHtml(res, 503, '<h1>Kadastro360 kurulumu tamamlanmadı</h1><p>Sunucuda TEST_PASSWORD ve SESSION_SECRET ayarlanmalıdır.</p>');
    }

    const sessionUser = await validSession(req);

    if (req.method === 'GET' && pathname === '/') {
      return sendHtml(res, 200, marketingPage({ user: sessionUser ? await accounts.publicUser(sessionUser) : null }));
    }

    if (req.method === 'GET' && pathname === '/login') {
      if (sessionUser) {
        res.writeHead(302, { Location: '/app' }); return res.end();
      }
      return sendHtml(res, 200, marketingPage());
    }

    if (req.method === 'POST' && pathname === '/request-access') {
      try {
        if (!publicFormAllowed(req, 'access-request')) {
          return sendHtml(res, 429, marketingPage({ requestMessage: 'Kısa sürede çok fazla erişim talebi gönderildi. Lütfen daha sonra tekrar deneyin.' }));
        }
        const form = await readFormBody(req);
        if (String(form.get('website') || '').trim()) {
          return sendHtml(res, 400, marketingPage({ requestMessage: 'Erişim talebi doğrulanamadı.' }));
        }
        await accounts.createAccessRequest({
          fullName: form.get('fullName') || '',
          company: form.get('company') || '',
          email: form.get('email') || '',
          phone: form.get('phone') || '',
          note: form.get('note') || ''
        });
        return sendHtml(res, 200, marketingPage({
          user: sessionUser ? await accounts.publicUser(sessionUser) : null,
          requestOk: true,
          requestMessage: 'Erişim talebiniz alındı. Uygun görülen test kullanıcılarına hesap açılacaktır.'
        }));
      } catch (error) {
        return sendHtml(res, 400, marketingPage({
          user: sessionUser ? await accounts.publicUser(sessionUser) : null,
          requestMessage: error.message || 'Erişim talebi kaydedilemedi.'
        }));
      }
    }

    if (req.method === 'POST' && pathname === '/login') {
      const form = await readFormBody(req);
      const username = form.get('username') || '';
      const password = form.get('password') || '';
      if (loginBlocked(req, username)) {
        return sendHtml(res, 429, marketingPage({ loginMessage: 'Çok fazla başarısız giriş yapıldı. 15 dakika sonra tekrar deneyin.' }));
      }
      const user = await accounts.authenticate(username, password);
      if (!user) {
        recordLoginFailure(req, username);
        return sendHtml(res, 401, marketingPage({ loginMessage: 'Kullanıcı adı, parola veya hesap süresi geçersiz.' }));
      }
      clearLoginFailures(req, username);
      const expiresAt = Date.now() + SESSION_MAX_AGE_SECONDS * 1000;
      const token = signSession(user.username, expiresAt);
      res.writeHead(302, {
        Location: '/app',
        'Set-Cookie': `kadastro360_session=${encodeURIComponent(token)}; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}; HttpOnly; ${COOKIE_SECURE ? 'Secure; ' : ''}SameSite=Lax`
      });
      return res.end();
    }

    if (req.method === 'GET' && pathname === '/yonetim-giris') {
      if (sessionUser?.role === 'admin' && validAdminSession(req, sessionUser)) {
        res.writeHead(302, { Location: '/admin' }); return res.end();
      }
      return sendHtml(res, ADMIN_PANEL_PIN ? 200 : 503, adminLoginPage());
    }

    if (req.method === 'POST' && pathname === '/yonetim-giris') {
      if (!ADMIN_PANEL_PIN) return sendHtml(res, 503, adminLoginPage('Yönetim güvenlik kodu sunucuda henüz ayarlanmadı.', false));
      const form = await readFormBody(req);
      const username = form.get('username') || '';
      const password = form.get('password') || '';
      const adminPin = form.get('adminPin') || '';
      const failureName = `admin:${username}`;
      if (loginBlocked(req, failureName)) {
        return sendHtml(res, 429, adminLoginPage('Çok fazla başarısız yönetici girişi yapıldı. 15 dakika sonra tekrar deneyin.'));
      }
      // Yönetici hesabı Render Environment değişkenleriyle yönetilir.
      // Veritabanı taşıma/sıfırlama durumunda eski yönetici parolasının kilitlenmemesi için
      // yönetici girişi doğrudan TEST_USERNAME, TEST_PASSWORD ve ADMIN_PANEL_PIN ile doğrulanır.
      const configuredUsername = String(TEST_USERNAME || '').trim().toLocaleLowerCase('tr-TR');
      const submittedUsername = String(username || '').trim().toLocaleLowerCase('tr-TR');
      const credentialsOk = Boolean(TEST_PASSWORD)
        && secureEqual(submittedUsername, configuredUsername)
        && secureEqual(password, TEST_PASSWORD)
        && secureEqual(adminPin, ADMIN_PANEL_PIN);
      if (!credentialsOk) {
        recordLoginFailure(req, failureName);
        return sendHtml(res, 401, adminLoginPage('Yönetici bilgileri veya güvenlik kodu geçersiz.'));
      }
      // Ortam değişkenleri doğrulandıktan sonra veritabanındaki yönetici kaydını da aynı
      // bilgilerle eşitle. Böylece SQLite/PostgreSQL geçişleri mevcut girişi bozmaz.
      await accounts.seedAdmin();
      const user = await accounts.getUser(TEST_USERNAME);
      if (!user || user.role !== 'admin' || !user.active) {
        return sendHtml(res, 503, adminLoginPage('Yönetici hesabı veritabanında hazırlanamadı. Lütfen yeniden deneyin.'));
      }
      clearLoginFailures(req, failureName);
      const sessionExpiresAt = Date.now() + SESSION_MAX_AGE_SECONDS * 1000;
      const adminExpiresAt = Date.now() + ADMIN_SESSION_MAX_AGE_SECONDS * 1000;
      const sessionToken = signSession(user.username, sessionExpiresAt);
      const adminToken = signAdminSession(user.username, adminExpiresAt);
      res.writeHead(302, {
        Location: '/admin',
        'Set-Cookie': [
          `kadastro360_session=${encodeURIComponent(sessionToken)}; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}; HttpOnly; ${COOKIE_SECURE ? 'Secure; ' : ''}SameSite=Lax`,
          `kadastro360_admin=${encodeURIComponent(adminToken)}; Path=/; Max-Age=${ADMIN_SESSION_MAX_AGE_SECONDS}; HttpOnly; ${COOKIE_SECURE ? 'Secure; ' : ''}SameSite=Strict`
        ]
      });
      return res.end();
    }

    if (req.method === 'GET' && pathname === '/logout') {
      res.writeHead(302, {
        Location: '/',
        'Set-Cookie': [
          `kadastro360_session=; Path=/; Max-Age=0; HttpOnly; ${COOKIE_SECURE ? 'Secure; ' : ''}SameSite=Lax`,
          `kadastro360_admin=; Path=/; Max-Age=0; HttpOnly; ${COOKIE_SECURE ? 'Secure; ' : ''}SameSite=Strict`
        ]
      });
      return res.end();
    }

    if (req.method === 'GET' && pathname === '/parolami-unuttum') {
      return sendHtml(res, 200, publicAccountFormPage({ mode: 'forgot' }));
    }
    if (req.method === 'POST' && pathname === '/parolami-unuttum') {
      try {
        if (!publicFormAllowed(req, 'password-reset')) {
          return sendHtml(res, 429, publicAccountFormPage({ mode: 'forgot', message: 'Kısa sürede çok fazla istek gönderildi. Lütfen daha sonra tekrar deneyin.' }));
        }
        const form = await readFormBody(req);
        const reset = await accounts.createPasswordReset(form.get('identifier') || '', RESET_TTL_HOURS);
        if (reset) {
          if (!mailer.enabled) throw new Error('E-posta servisi henüz hazır değil.');
          await mailer.sendPasswordReset({
            to: reset.user.email,
            fullName: reset.user.fullName,
            username: reset.user.username,
            token: reset.token,
            expiresAt: reset.expiresAt
          });
        }
        return sendHtml(res, 200, publicAccountFormPage({ mode: 'forgot', ok: true, message: 'Bilgiler bir hesapla eşleşiyorsa parola yenileme bağlantısı e-posta adresine gönderildi.' }));
      } catch (error) {
        return sendHtml(res, 400, publicAccountFormPage({ mode: 'forgot', message: error.message || 'Parola yenileme isteği gönderilemedi.' }));
      }
    }
    if (req.method === 'GET' && pathname === '/davet') {
      return sendHtml(res, 200, publicAccountFormPage({ mode: 'invite', token: requestUrl.searchParams.get('token') || '' }));
    }
    if (req.method === 'POST' && pathname === '/davet') {
      const form = await readFormBody(req);
      const token = form.get('token') || '';
      const password = form.get('password') || '';
      const passwordAgain = form.get('passwordAgain') || '';
      try {
        if (password !== passwordAgain) throw new Error('Parolalar birbiriyle aynı değil.');
        await accounts.completeInvite(token, password);
        return sendHtml(res, 200, publicAccountFormPage({ mode: 'invite', ok: true, message: 'Hesabınız etkinleştirildi. Artık kullanıcı adınız ve yeni parolanızla giriş yapabilirsiniz.' }));
      } catch (error) {
        return sendHtml(res, 400, publicAccountFormPage({ mode: 'invite', token, message: error.message || 'Davet bağlantısı kullanılamadı.' }));
      }
    }
    if (req.method === 'GET' && pathname === '/parola-yenile') {
      return sendHtml(res, 200, publicAccountFormPage({ mode: 'reset', token: requestUrl.searchParams.get('token') || '' }));
    }
    if (req.method === 'POST' && pathname === '/parola-yenile') {
      const form = await readFormBody(req);
      const token = form.get('token') || '';
      const password = form.get('password') || '';
      const passwordAgain = form.get('passwordAgain') || '';
      try {
        if (password !== passwordAgain) throw new Error('Parolalar birbiriyle aynı değil.');
        await accounts.resetPassword(token, password);
        return sendHtml(res, 200, publicAccountFormPage({ mode: 'reset', ok: true, message: 'Parolanız yenilendi. Yeni parolanızla giriş yapabilirsiniz.' }));
      } catch (error) {
        return sendHtml(res, 400, publicAccountFormPage({ mode: 'reset', token, message: error.message || 'Parola yenilenemedi.' }));
      }
    }

    if (!sessionUser) {
      if (pathname.startsWith('/api/')) return sendJson(res, 401, { error: 'Oturum gerekli.' });
      res.writeHead(302, { Location: '/' }); return res.end();
    }
    if (req.method === 'GET' && (pathname === '/app' || pathname === '/index.html')) {
      return sendFile(res, path.join(ROOT, 'index.html'), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && pathname === '/hesabim') {
      return sendFile(res, path.join(ROOT, 'account.html'), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && pathname === '/endeksa-utils.js') {
      return sendFile(res, path.join(ROOT, 'endeksa-utils.js'), 'application/javascript; charset=utf-8');
    }
    if (req.method === 'GET' && pathname === '/admin') {
      if (sessionUser.role !== 'admin' || !validAdminSession(req, sessionUser)) {
        res.writeHead(302, { Location: '/yonetim-giris' }); return res.end();
      }
      return sendFile(res, path.join(ROOT, 'admin.html'), 'text/html; charset=utf-8');
    }
    let match;
    if (req.method === 'GET' && pathname === '/api/me') {
      return sendJson(res, 200, await accounts.publicUser(sessionUser));
    }
    if (req.method === 'PATCH' && pathname === '/api/me') {
      return sendJson(res, 200, { user: await accounts.updateProfile(sessionUser.username, await readJsonBody(req)) });
    }
    if (req.method === 'POST' && pathname === '/api/me/password') {
      const body = await readJsonBody(req);
      await accounts.changePassword(sessionUser.username, body.currentPassword, body.newPassword);
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'GET' && pathname === '/api/history') {
      return sendJson(res, 200, { items: await accounts.history(sessionUser.username, requestUrl.searchParams.get('limit') || 30) });
    }
    if (req.method === 'GET' && pathname === '/api/services') {
      return sendJson(res, 200, { updatedAt: new Date().toISOString(), services: serviceHealth });
    }
    let snapshotMatch = pathname.match(/^\/api\/open-data\/wms-snapshot\/([^/]+)\.png$/);
    if (req.method === 'GET' && snapshotMatch) {
      const result = await wmsSnapshot({
        key: decodeURIComponent(snapshotMatch[1]),
        layerName: requestUrl.searchParams.get('layers') || '',
        version: requestUrl.searchParams.get('version') || '1.1.1',
        latitude: Number(requestUrl.searchParams.get('lat')),
        longitude: Number(requestUrl.searchParams.get('lng')),
        radiusKm: Number(requestUrl.searchParams.get('radiusKm')) || 14,
        size: Number(requestUrl.searchParams.get('size')) || 1024
      });
      markService('openData', true, 'Açık veri sabit plan görüntüsü yüklendi.');
      return sendBinary(res, 200, result.buffer, result.contentType, {
        'X-Kadastro360-Cache': result.cache,
        'X-Kadastro360-Layer': encodeURIComponent(result.layerName),
        'X-Kadastro360-Version': result.version
      });
    }

    let legendMatch = pathname.match(/^\/api\/open-data\/wms-legend\/([^/]+)\.png$/);
    if (req.method === 'GET' && legendMatch) {
      const result = await wmsLegend({
        key: decodeURIComponent(legendMatch[1]),
        layerName: requestUrl.searchParams.get('layers') || '',
        version: requestUrl.searchParams.get('version') || '1.1.1'
      });
      return sendBinary(res, 200, result.buffer, result.contentType, { 'X-Kadastro360-Cache': result.cache });
    }

    let tileMatch = pathname.match(/^\/api\/open-data\/wms-tile\/([^/]+)\/(\d+)\/(\d+)\/(\d+)\.png$/);
    if (req.method === 'GET' && tileMatch) {
      const result = await wmsTile({
        key: decodeURIComponent(tileMatch[1]),
        z: Number(tileMatch[2]), x: Number(tileMatch[3]), y: Number(tileMatch[4]),
        layerName: requestUrl.searchParams.get('layers') || '',
        version: requestUrl.searchParams.get('version') || '1.1.1',
        size: Number(requestUrl.searchParams.get('size')) || 512
      });
      markService('openData', true, 'Açık veri WMS karosu yüklendi.');
      return sendBinary(res, 200, result.buffer, result.contentType, { 'X-Kadastro360-Cache': result.cache });
    }

    if (req.method === 'GET' && pathname === '/api/open-data/catalog') {
      const province = String(requestUrl.searchParams.get('province') || '').trim();
      const district = String(requestUrl.searchParams.get('district') || '').trim();
      if (!province) return sendJson(res, 400, { error: 'Açık veri kontrolü için il gereklidir.' });
      const result = await buildPilotCatalog({ province, district, detailed: requestUrl.searchParams.get('mode') === 'detailed' });
      markService('openData', true, `${province}${district ? ` / ${district}` : ''} için kaynak listesi hazırlandı. Eşleşen WMS planı parsel merkezinde doğrulanır ve dinamik yüksek çözünürlüklü karolarla yüklenir.`);
      return sendJson(res, 200, result);
    }
    if (req.method === 'GET' && pathname === '/api/open-data/geojson') {
      const token = String(requestUrl.searchParams.get('token') || '');
      const data = await fetchGeoJson(token);
      markService('openData', true, 'GeoJSON katmanı yüklendi.');
      return sendJson(res, 200, data);
    }
    if (req.method === 'POST' && pathname === '/api/open-data/wms-probe') {
      const body = await readJsonBody(req, 30_000);
      const result = await wmsProbe({
        key: String(body.key || ''),
        layerName: String(body.layerName || ''),
        version: String(body.version || '1.1.1'),
        latitude: Number(body.latitude),
        longitude: Number(body.longitude),
        radiusKm: Number(body.radiusKm) || 24
      });
      markService('openData', result.visible, result.visible ? 'WMS görsel içeriği doğrulandı.' : 'WMS şeffaf veya boş görüntü döndürdü.');
      return sendJson(res, 200, result);
    }
    if (req.method === 'POST' && pathname === '/api/open-data/wms-info') {
      const body = await readJsonBody(req, 100_000);
      const width = Math.max(1, Math.min(5000, Number(body.width) || 0));
      const height = Math.max(1, Math.min(5000, Number(body.height) || 0));
      const x = Math.max(0, Math.min(width, Number(body.x) || 0));
      const y = Math.max(0, Math.min(height, Number(body.y) || 0));
      const bbox = String(body.bbox || '');
      if (!/^[-0-9.,]+$/.test(bbox) || bbox.split(',').length !== 4) return sendJson(res, 400, { error: 'Geçersiz harita sorgusu.' });
      const result = await wmsFeatureInfo({ key: String(body.key || ''), bbox, width, height, x, y });
      markService('openData', true, 'Plan katmanı bilgi sorgusu tamamlandı.');
      return sendJson(res, 200, result);
    }
    if (req.method === 'GET' && pathname === '/api/admin/users') {
      if (sessionUser.role !== 'admin' || !validAdminSession(req, sessionUser)) return sendJson(res, 403, { error: 'Korumalı yönetici oturumu gerekli.' });
      return sendJson(res, 200, { users: await accounts.listUsers() });
    }
    if (req.method === 'POST' && pathname === '/api/admin/users') {
      if (sessionUser.role !== 'admin' || !validAdminSession(req, sessionUser)) return sendJson(res, 403, { error: 'Korumalı yönetici oturumu gerekli.' });
      return sendJson(res, 201, { user: await accounts.createUser(await readJsonBody(req)) });
    }
    match = pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
    if (req.method === 'PATCH' && match) {
      if (sessionUser.role !== 'admin' || !validAdminSession(req, sessionUser)) return sendJson(res, 403, { error: 'Korumalı yönetici oturumu gerekli.' });
      return sendJson(res, 200, { user: await accounts.updateUser(decodeURIComponent(match[1]), await readJsonBody(req)) });
    }
    if (req.method === 'GET' && pathname === '/api/admin/access-requests') {
      if (sessionUser.role !== 'admin' || !validAdminSession(req, sessionUser)) return sendJson(res, 403, { error: 'Korumalı yönetici oturumu gerekli.' });
      return sendJson(res, 200, { requests: await accounts.listAccessRequests(requestUrl.searchParams.get('limit') || 200) });
    }
    match = pathname.match(/^\/api\/admin\/access-requests\/(\d+)$/);
    if (req.method === 'PATCH' && match) {
      if (sessionUser.role !== 'admin' || !validAdminSession(req, sessionUser)) return sendJson(res, 403, { error: 'Korumalı yönetici oturumu gerekli.' });
      return sendJson(res, 200, { request: await accounts.updateAccessRequest(Number(match[1]), await readJsonBody(req)) });
    }
    match = pathname.match(/^\/api\/admin\/access-requests\/(\d+)\/invite$/);
    if (req.method === 'POST' && match) {
      if (sessionUser.role !== 'admin' || !validAdminSession(req, sessionUser)) return sendJson(res, 403, { error: 'Korumalı yönetici oturumu gerekli.' });
      if (!mailer.enabled) return sendJson(res, 503, { error: 'Resend e-posta ayarları tamamlanmadı.' });
      const body = await readJsonBody(req);
      const invitation = await accounts.prepareInviteFromRequest(Number(match[1]), {
        username: body.username,
        dailyQuota: body.dailyQuota,
        trialDays: body.trialDays,
        ttlHours: INVITE_TTL_HOURS
      });
      await mailer.sendInvite({
        to: invitation.request.email,
        fullName: invitation.request.fullName,
        username: invitation.user.username,
        token: invitation.token,
        expiresAt: invitation.expiresAt
      });
      return sendJson(res, 200, {
        ok: true,
        user: invitation.user,
        request: await accounts.getAccessRequest(Number(match[1])),
        expiresAt: invitation.expiresAt
      });
    }
    if (req.method === 'GET' && pathname === '/api/admin/site-content') {
      if (sessionUser.role !== 'admin' || !validAdminSession(req, sessionUser)) return sendJson(res, 403, { error: 'Korumalı yönetici oturumu gerekli.' });
      return sendJson(res, 200, { content: siteContent, mailEnabled: mailer.enabled, databaseProvider: accounts.provider });
    }
    if (req.method === 'PATCH' && pathname === '/api/admin/site-content') {
      if (sessionUser.role !== 'admin' || !validAdminSession(req, sessionUser)) return sendJson(res, 403, { error: 'Korumalı yönetici oturumu gerekli.' });
      siteContent = await accounts.updateSiteContent(await readJsonBody(req));
      return sendJson(res, 200, { content: siteContent });
    }
    if (req.method === 'GET' && pathname === '/api/iller') {
      const result = await tkgmClient.getAdminList('province');
      markService('tkgm', true, `TKGM il listesi çalışıyor (${result.sourceLabel}).`);
      return sendJson(res, 200, result);
    }

    if (req.method === 'POST' && pathname === '/api/idari/ilceler') {
      const body = await readJsonBody(req, 50_000);
      const result = await tkgmClient.getAdminList('district', body.parentId, String(body.source || ''));
      markService('tkgm', true, `TKGM ilçe listesi çalışıyor (${result.sourceLabel}).`);
      return sendJson(res, 200, result);
    }

    if (req.method === 'POST' && pathname === '/api/idari/mahalleler') {
      const body = await readJsonBody(req, 50_000);
      const result = await tkgmClient.getAdminList('neighborhood', body.parentId, String(body.source || ''));
      markService('tkgm', true, `TKGM mahalle listesi çalışıyor (${result.sourceLabel}).`);
      return sendJson(res, 200, result);
    }

    // Eski arayüz bağlantıları bozulmasın diye sayısal GET uçları korunur.
    // Yeni arayüz kaynak kimliğini de taşıyan POST uçlarını kullanır; böylece
    // v3.1 ve eski TKGM servislerinin id hiyerarşileri birbirine karışmaz.
    match = pathname.match(/^\/api\/ilceler\/(\d+)\/?$/);
    if (req.method === 'GET' && match) {
      const result = await tkgmClient.getAdminList('district', match[1]);
      markService('tkgm', true, `TKGM ilçe listesi çalışıyor (${result.sourceLabel}).`);
      return sendJson(res, 200, result);
    }

    match = pathname.match(/^\/api\/mahalleler\/(\d+)\/?$/);
    if (req.method === 'GET' && match) {
      const result = await tkgmClient.getAdminList('neighborhood', match[1]);
      markService('tkgm', true, `TKGM mahalle listesi çalışıyor (${result.sourceLabel}).`);
      return sendJson(res, 200, result);
    }

    async function handleParcelLookup({ mahalleId, blockNo, parcelNo, source }) {
      const allowance = await accounts.canQuery(sessionUser);
      if (!allowance.ok) {
        const quotaError = new Error(allowance.reason);
        quotaError.httpStatus = 429;
        throw quotaError;
      }
      let result;
      try {
        result = await tkgmClient.getParcel({
          neighborhoodId: mahalleId,
          block: blockNo,
          parcel: parcelNo,
          preferredSource: String(source || '')
        });
      } catch (error) {
        if (error?.statusCode === 404) error.httpStatus = 404;
        throw error;
      }
      const payload = result.payload;
      markService('tkgm', true, `TKGM parsel servisi çalışıyor (${result.sourceLabel}).`);
      const feature = payloadFeature(payload);
      if (feature?.geometry) {
        const props = feature.properties || {};
        const center = geometryCenter(feature.geometry);
        await accounts.logQuery({
          username: sessionUser.username,
          province: firstProperty(props, ['ilAd','ilAdi','IL_AD','il']),
          district: firstProperty(props, ['ilceAd','ilceAdi','ILCE_AD','ilce']),
          neighborhood: firstProperty(props, ['mahalleAd','mahalleAdi','MAHALLE_AD','mahalle']),
          blockNo, parcelNo, latitude: center.lat, longitude: center.lng, source: 'TKGM', status: 'success'
        });
      }
      return payload;
    }

    if (req.method === 'POST' && pathname === '/api/parsel-sorgu') {
      const body = await readJsonBody(req, 50_000);
      const payload = await handleParcelLookup({
        mahalleId: body.mahalleId,
        blockNo: String(body.ada || '').trim(),
        parcelNo: String(body.parsel || '').trim(),
        source: body.source
      });
      return sendJson(res, 200, payload);
    }

    match = pathname.match(/^\/api\/parsel\/(\d+)\/([^/]+)\/([^/]+)\/?$/);
    if (req.method === 'GET' && match) {
      const payload = await handleParcelLookup({
        mahalleId: match[1],
        blockNo: decodeURIComponent(match[2]),
        parcelNo: decodeURIComponent(match[3]),
        source: ''
      });
      return sendJson(res, 200, payload);
    }

    if (req.method === 'POST' && pathname === '/api/elevation') {
      const { locations } = await readJsonBody(req);
      if (!Array.isArray(locations) || locations.length < 2 || locations.length > 30) {
        return sendJson(res, 400, { error: '2-30 arasında koordinat gönderilmelidir.' });
      }
      const result = await getElevation(locations);
      markService('terrain', true, `Yükseklik kaynağı: ${result.source || 'canlı servis'}.`);
      return sendJson(res, 200, result);
    }

    if (req.method === 'POST' && pathname === '/api/terrain-analysis') {
      const body = await readJsonBody(req);
      const geometry = body.geometry && typeof body.geometry === 'object' ? body.geometry : null;
      const center = body.center && typeof body.center === 'object' ? body.center : null;
      if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type)) {
        return sendJson(res, 400, { error: 'Eğim analizi için geçerli parsel geometrisi gereklidir.' });
      }
      const result = await analyzeTerrain({
        geometry,
        center,
        fallbackElevation: getElevation
      });
      markService('terrain', true, `Eğim kaynağı: ${result.source || 'canlı servis'}.`);
      return sendJson(res, 200, result);
    }

    if (req.method === 'POST' && pathname === '/api/route') {
      const body = await readJsonBody(req, 100_000);
      const result = await getRoadRoutes(body);
      const ok = result.routes.length > 0;
      const message = result.complete
        ? `${result.routes.length}/${result.results.length} yol rotası hesaplandı.`
        : `${result.routes.length}/${result.results.length} yol rotası hesaplandı; ${result.failed.length} hedef için rota alınamadı.`;
      markService('routing', ok, message);
      return sendJson(res, 200, result);
    }

    if (req.method === 'POST' && pathname === '/api/poi') {
      const body = await readJsonBody(req);
      const lat = Number(body.lat);
      const lng = Number(body.lng);
      const radiusMode = body.radius === 'auto' ? 'auto' : Math.max(300, Math.min(30000, Number(body.radius) || 1000));
      const category = String(body.category || 'all');
      const geometry = body.geometry && typeof body.geometry === 'object' ? body.geometry : null;
      const adminContext = normalizeAdminContext({
        province: body.province,
        district: body.district,
        neighborhood: body.neighborhood
      });
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return sendJson(res, 400, { error: 'Geçersiz parsel koordinatı.' });
      }
      if (category !== 'all' && !CATEGORY_QUERIES[category]) {
        return sendJson(res, 400, { error: 'Geçersiz yakın yer türü.' });
      }
      const result = await getPoi(lat, lng, radiusMode, category, geometry, adminContext);
      markService('overpass', true, `OpenStreetMap/Overpass yanıt verdi (${result.providers?.join(', ') || 'sağlayıcı'}).`);
      return sendJson(res, 200, { success: true, data: result.items, ...result });
    }

    if (req.method === 'GET' && !pathname.startsWith('/api/') && (req.headers.accept || '').includes('text/html')) {
      return sendFile(res, path.join(ROOT, 'index.html'), 'text/html; charset=utf-8');
    }
    return sendJson(res, 404, { error: 'Uç nokta bulunamadı.' });
  } catch (error) {
    console.error('[HATA]', req.method, pathname, error);
    const message = error?.message || 'Beklenmeyen sunucu hatası.';
    if (/\/api\/(iller|ilceler|mahalleler|idari\/|parsel(?:-sorgu)?)/.test(pathname)) markService('tkgm', false, message);
    if (/\/api\/(elevation|terrain-analysis)/.test(pathname)) markService('terrain', false, message);
    if (pathname === '/api/poi') markService('overpass', false, message);
    if (pathname === '/api/route') markService('routing', false, message);
    if (pathname.startsWith('/api/open-data/')) markService('openData', false, message);
    const upstream = /TKGM|yakın yer|eğim|HTTP|zaman aşımı/i.test(message);
    const status = Number(error?.httpStatus) || (upstream ? 502 : 500);
    return sendJson(res, status, { error: message });
  }
});


const REQUIRED_BRAND_ASSETS = [
  'kadastro360-logo-horizontal.png',
  'kadastro360-logo-vertical.png',
  'kadastro360-mark.png',
  'favicon.ico',
  'favicon-32.png',
  'favicon-16.png',
  'apple-touch-icon.png',
  'icon-192.png',
  'icon-512.png'
];

function verifyBrandAssets() {
  const missing = REQUIRED_BRAND_ASSETS.filter(name => {
    const filePath = path.join(ROOT, 'assets', name);
    return !fs.existsSync(filePath) || !fs.statSync(filePath).isFile() || fs.statSync(filePath).size < 100;
  });
  if (missing.length) {
    throw new Error(`Kadastro360 logo dosyaları eksik: ${missing.join(', ')}. GitHub/Render yüklemesinde assets klasörünü proje köküne eksiksiz ekleyin.`);
  }
}

async function startServer() {
  await accounts.init();
  siteContent = await accounts.getSiteContent();
  verifyBrandAssets();
  server.listen(START_PORT, HOST, () => {
    activePort = START_PORT;
    console.log(`Kadastro360 Web hazır: http://${HOST}:${activePort} · Veritabanı: ${accounts.provider} · E-posta: ${mailer.enabled ? 'aktif' : 'pasif'}`);
  });
}

if (require.main === module) {
  startServer().catch(error => {
    console.error('[BAŞLATMA HATASI]', error);
    process.exitCode = 1;
  });
  const shutdown = async () => {
    try { await accounts.close(); } catch {}
    process.exit(0);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

module.exports = {
  CATEGORY_QUERIES,
  detectionsForTags,
  detectionForTags,
  radiusBoundingBox,
  expandNwrSelector,
  selectorsForCategories,
  buildOverpassQuery,
  buildOverpassQueryFromSelectors,
  runOverpassSelectors,
  runSelectorSetResilient,
  queryCategoriesAtRadius,
  getPoi,
  getDistrictSearchAnchor,
  normalizeAdminContext,
  comparePoi,
  itemFromElement,
  distanceToGeometry,
  limitBalanced,
  haversine,
  validRoutePoint,
  normalizeRouteRequest,
  getRoadRoutes
};
