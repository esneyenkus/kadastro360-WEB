'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { analyzeTerrain } = require('./terrain');
const { AccountStore } = require('./account-store');
const { buildPilotCatalog, fetchGeoJson, wmsFeatureInfo, wmsProbe, wmsTile } = require('./open-data');
const { TKGMClient, sourcesFromEnvironment } = require('./tkgm-client');

const HOST = process.env.HOST || '0.0.0.0';
const START_PORT = Number(process.env.PORT) || 10000;
let activePort = START_PORT;
const TEST_USERNAME = process.env.TEST_USERNAME || 'admin';
const TEST_PASSWORD = process.env.TEST_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const COOKIE_SECURE = process.env.COOKIE_SECURE !== '0';
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const DEFAULT_DAILY_QUOTA = Math.max(1, Number(process.env.DEFAULT_DAILY_QUOTA) || 20);
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
  defaultDailyQuota: DEFAULT_DAILY_QUOTA
});

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
  userAgent: 'Kadastro360-Web-Pilot/1.8.1'
});

// OpenStreetMap Wiki'de listelenen global Overpass örnekleri.
// Aynı sorguyu bütün sunuculara aynı anda göndermiyoruz. Küçük sorgular sırayla
// denenir; böylece 504 durumunda ikinci sunucuya geçilir ve ortak servisler gereksiz yüklenmez.
const OVERPASS_ENDPOINTS = (() => {
  const explicit = String(process.env.OVERPASS_BASE_URLS || '').split(',').map(value => value.trim()).filter(Boolean);
  if (explicit.length) return explicit.map((url, index) => ({ name: `Özel Overpass ${index + 1}`, url }));
  return [
    { name: 'VK Maps Overpass', url: 'https://maps.mail.ru/osm/tools/overpass/api/interpreter' },
    { name: 'FOSSGIS Overpass', url: 'https://overpass-api.de/api/interpreter' },
    { name: 'Private.coffee Overpass', url: 'https://overpass.private.coffee/api/interpreter' }
  ];
})();

const overpassHealth = new Map(
  OVERPASS_ENDPOINTS.map((endpoint, index) => [
    endpoint.url,
    { failures: 0, blockedUntil: 0, averageMs: 1500 + index * 250, lastSuccess: 0 }
  ])
);

const cache = new Map();


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

function validSession(req) {
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
    const user = accounts.getUser(username);
    if (!user?.active) return null;
    if (user.trialEndsAt && Date.parse(user.trialEndsAt) <= Date.now()) return null;
    return user;
  } catch {
    return null;
  }
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
    ...extraHeaders
  });
  res.end(body);
}

function loginPage(message = '') {
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kadastro360 Giriş</title>
  <style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#eef3f6;font-family:Arial,sans-serif;color:#17242c}.box{width:min(390px,calc(100% - 32px));background:white;padding:30px;border-radius:18px;box-shadow:0 18px 60px #1b394322}.brand{font-size:30px;font-weight:800;margin-bottom:4px}.sub{color:#60727d;margin-bottom:24px}label{display:block;font-weight:700;margin:14px 0 6px}input{box-sizing:border-box;width:100%;padding:13px;border:1px solid #bccbd2;border-radius:10px;font-size:16px}button{width:100%;margin-top:20px;padding:14px;border:0;border-radius:10px;background:#126b62;color:white;font-size:16px;font-weight:800;cursor:pointer}.msg{background:#fff0f0;color:#a12626;padding:10px;border-radius:9px;margin-bottom:12px}.note{font-size:12px;color:#71818a;margin-top:18px;text-align:center}</style></head><body><main class="box"><div class="brand">Kadastro360</div><div class="sub">Gerçek veri web pilotu · İsteğe bağlı ULASAV/TUCBS açık katmanları</div>${message ? `<div class="msg">${escapeHtml(message)}</div>` : ''}<form method="post" action="/login"><label>Kullanıcı adı</label><input name="username" autocomplete="username" required><label>Parola</label><input name="password" type="password" autocomplete="current-password" required><button type="submit">Giriş yap</button></form><div class="note">Bu pilot yalnızca canlı veri kaynaklarını kullanır; örnek veya sanal sonuç üretmez.</div></main></body></html>`;
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
            headers: { 'User-Agent': 'Kadastro360-Web-Pilot/1.8.1', Accept: 'application/json' }
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
  beach: 'Sahil / Plaj', pharmacy: 'Eczane', hospital: 'Hastane / Sağlık',
  bus_terminal: 'Otogar', train_station: 'Tren Garı / İstasyonu', airport: 'Havaalanı'
};

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
      'nwr["name"~"(bankası|bankasi|banka|bank$)",i]["amenity"]'
    ]
  },
  atm: {
    core: [
      'nwr["amenity"="atm"]',
      'nwr["atm"="yes"]',
      'nwr["cash_withdrawal"="yes"]',
      'nwr["vending"="cash"]'
    ],
    fallback: []
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
      'nwr["amenity"~"^(hospital|clinic|doctors|health_post)$"]',
      'nwr["healthcare"~"^(hospital|clinic|doctor|centre|health_centre|health_post)$"]',
      'nwr["building"~"^(hospital|clinic)$"]'
    ],
    fallback: []
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
  else if (/\b(banka|bankasi|bank|bankasi)\b/.test(text) && amenity) {
    add('bank', 'Orta', 'Ad banka olarak eşleşti');
  }

  if (amenity === 'atm') add('atm', 'Yüksek', 'amenity=atm');
  else if (tags.atm === 'yes' || tags.cash_withdrawal === 'yes' || tags.vending === 'cash') {
    add('atm', 'Yüksek', tags.atm === 'yes' ? 'atm=yes' : (tags.cash_withdrawal === 'yes' ? 'cash_withdrawal=yes' : 'vending=cash'));
  }

  if (tags.natural === 'beach' || tags.leisure === 'beach_resort' || tags.place === 'beach') {
    add('beach', 'Yüksek', tags.natural === 'beach' ? 'natural=beach' : (tags.leisure === 'beach_resort' ? 'leisure=beach_resort' : 'place=beach'));
  }

  if (amenity === 'pharmacy' || healthcare === 'pharmacy') {
    add('pharmacy', 'Yüksek', amenity === 'pharmacy' ? 'amenity=pharmacy' : 'healthcare=pharmacy');
  } else if (shop === 'chemist' || /\beczane\b/.test(text)) {
    add('pharmacy', 'Orta', shop === 'chemist' ? 'shop=chemist' : 'Yalnızca ad eczane olarak eşleşti');
  }

  if (['hospital', 'clinic', 'doctors', 'health_post'].includes(amenity)) {
    add('hospital', 'Yüksek', `amenity=${amenity}`);
  } else if (['hospital', 'clinic', 'doctor', 'centre', 'health_centre', 'health_post'].includes(healthcare)) {
    add('hospital', 'Yüksek', `healthcare=${healthcare}`);
  } else if (['hospital', 'clinic'].includes(building)) {
    add('hospital', 'Orta', `building=${building}`);
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
  return `[out:json][timeout:14][maxsize:67108864];(${clauses.join('')});out center tags qt;`;
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
      const data = await fetchJson(endpoint.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          Accept: 'application/json',
          'Accept-Language': 'tr-TR,tr;q=0.9',
          'User-Agent': 'Parsel-Egim-Yakin-Rehber/1.5 (+local-windows-app)'
        },
        body
      }, 7000);
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
    const result = await runOverpassSelectors(lat, lng, radius, selectors, { bypassHealth: depth > 0, maxEndpoints: depth > 0 ? 1 : 3 });
    return {
      elements: Array.isArray(result.data?.elements) ? result.data.elements : [],
      providers: [result.endpoint],
      warnings: [],
      successfulParts: 1,
      failedParts: 0
    };
  } catch (error) {
    const transient = /504|502|503|429|zaman aşımı|timeout|çalışma hatası|runtime/i.test(String(error.message || error));
    const canSplit = selectors.length > 1 && depth < 2 && transient;
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
  ['school', 'market', 'mosque', 'pharmacy', 'hospital'],
  ['bank', 'atm'],
  ['beach', 'bus_terminal', 'train_station', 'airport']
];

const POI_MAX_RADIUS = {
  school: 10000, market: 10000, mosque: 10000, pharmacy: 10000,
  hospital: 20000, bank: 10000, atm: 10000,
  beach: 30000, bus_terminal: 30000, train_station: 30000, airport: 30000
};

async function queryCategoriesAtRadius(lat, lng, radius, categories) {
  const requested = [...new Set(categories)].filter(key => CATEGORY_QUERIES[key]);
  const elementMap = new Map();
  const warnings = [];
  const providers = new Set();
  const succeededCategories = new Set();
  const failedCategories = new Set();
  const batches = POI_CATEGORY_BATCHES
    .map(batch => batch.filter(key => requested.includes(key)))
    .filter(batch => batch.length);

  const batchResults = await mapLimit(batches, 2, async keys => {
    const coreSelectors = selectorsForCategories(keys, 'core');
    const core = await runSelectorSetResilient(lat, lng, radius, coreSelectors);
    const localMap = new Map();
    mergeElementArray(localMap, core.elements);
    const localProviders = new Set(core.providers);
    const localWarnings = [...core.warnings];
    const found = detectedCategorySet([...localMap.values()]);
    const fallbackKeys = keys.filter(key => !found.has(key) && (CATEGORY_QUERIES[key].fallback || []).length && radius <= 10000);
    let successfulParts = core.successfulParts;
    let failedParts = core.failedParts;

    if (fallbackKeys.length) {
      const fallback = await runSelectorSetResilient(lat, lng, radius, selectorsForCategories(fallbackKeys, 'fallback'));
      mergeElementArray(localMap, fallback.elements);
      fallback.providers.forEach(provider => localProviders.add(provider));
      localWarnings.push(...fallback.warnings);
      successfulParts += fallback.successfulParts;
      failedParts += fallback.failedParts;
    }

    return { keys, elements: [...localMap.values()], providers: [...localProviders], warnings: localWarnings, successfulParts, failedParts };
  });

  for (const result of batchResults) {
    mergeElementArray(elementMap, result.elements);
    result.providers.forEach(provider => providers.add(provider));
    const label = result.keys.map(key => CATEGORY_LABELS[key]).join(', ');
    warnings.push(...result.warnings.map(message => `${label}: ${message}`));
    if (result.successfulParts > 0) result.keys.forEach(key => succeededCategories.add(key));
    else result.keys.forEach(key => failedCategories.add(key));
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

function itemFromElement(element, originLat, originLng, geometry, preferredCategory = null) {
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
    address
  };
}

function itemsFromElement(element, originLat, originLng, geometry, category = 'all') {
  if (category !== 'all') {
    const item = itemFromElement(element, originLat, originLng, geometry, category);
    return item ? [item] : [];
  }
  return detectionsForTags(element.tags || {})
    .map(detection => itemFromElement(element, originLat, originLng, geometry, detection.type))
    .filter(Boolean);
}

function mergeElements(target, data) {
  for (const element of data?.elements || []) {
    const key = `${element.type || 'x'}-${element.id}`;
    if (!target.has(key)) target.set(key, element);
  }
}

function categoryCounts(items) {
  return items.reduce((out, item) => {
    out[item.type] = (out[item.type] || 0) + 1;
    return out;
  }, {});
}

function limitBalanced(items, category) {
  if (category !== 'all') return items.slice(0, 120);
  const perType = new Map();
  for (const item of items) {
    const list = perType.get(item.type) || [];
    if (list.length < 60) list.push(item);
    perType.set(item.type, list);
  }
  return [...perType.values()]
    .flat()
    .sort((a, b) => a.distance - b.distance || a.centerDistance - b.centerDistance)
    .slice(0, 400);
}

async function getPoi(lat, lng, radiusMode, category, geometry) {
  const geometryKey = geometry ? JSON.stringify(geometry).slice(0, 2000) : '';
  const cacheKey = `poi-v180:${lat.toFixed(5)}:${lng.toFixed(5)}:${radiusMode}:${category}:${geometryKey}`;
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
    const coverage = {};

    const absorb = (result, radius) => {
      mergeElements(elementMap, { elements: result.elements });
      searchedRadii.push(radius);
      result.warnings.forEach(warning => warnings.push(warning));
      result.providers.forEach(provider => providers.add(provider));
      result.succeededCategories.forEach(key => {
        successfulCategories.add(key);
        failedCategories.delete(key);
      });
      result.failedCategories.forEach(key => {
        if (!successfulCategories.has(key)) failedCategories.add(key);
      });
    };

    if (radiusMode !== 'auto') {
      const radius = Math.max(300, Math.min(30000, Number(radiusMode) || 1000));
      const result = await queryCategoriesAtRadius(lat, lng, radius, requestedCategories);
      absorb(result, radius);
      for (const key of requestedCategories) coverage[key] = { radius, status: result.failedCategories.has(key) ? 'failed' : 'checked' };
    } else {
      let pending = [...requestedCategories];
      for (const radius of [5000, 10000, 20000, 30000]) {
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
          .flatMap(element => itemsFromElement(element, lat, lng, geometry, 'all'))
          .filter(item => item.centerDistance <= radius * 1.03);
        const found = new Set(currentItems.map(item => item.type));

        const nextPending = [];
        for (const key of pending) {
          const maxRadiusForCategory = POI_MAX_RADIUS[key] || 10000;
          if (found.has(key)) {
            coverage[key] = { radius, status: 'found' };
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

    const maxRadius = searchedRadii.length ? Math.max(...searchedRadii) : 0;
    const seenLocations = new Set();
    let items = [...elementMap.values()]
      .flatMap(element => itemsFromElement(element, lat, lng, geometry, category))
      .filter(item => {
        if (maxRadius && item.centerDistance > maxRadius * 1.03) return false;
        const key = `${item.type}|${item.lat.toFixed(6)}|${item.lng.toFixed(6)}`;
        if (seenLocations.has(key)) return false;
        seenLocations.add(key);
        return true;
      })
      .sort((a, b) => a.distance - b.distance || a.centerDistance - b.centerDistance);

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
      warnings: [...new Set(warnings)].slice(0, 8),
      coverage,
      counts: shownCounts,
      discoveredCounts,
      truncatedCategories
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
      return sendJson(res, 200, { ok: true, service: 'kadastro360-web-pilot', version: '1.8.1', dataMode: 'live-only', mockData: false, tucbsBridge: true, accounts: true });
    }

    if (!TEST_PASSWORD || !SESSION_SECRET) {
      return sendHtml(res, 503, '<h1>Kadastro360 kurulumu tamamlanmadı</h1><p>Sunucuda TEST_PASSWORD ve SESSION_SECRET ayarlanmalıdır.</p>');
    }

    if (req.method === 'GET' && pathname === '/login') {
      if (validSession(req)) {
        res.writeHead(302, { Location: '/' }); return res.end();
      }
      return sendHtml(res, 200, loginPage());
    }

    if (req.method === 'POST' && pathname === '/login') {
      const form = await readFormBody(req);
      const username = form.get('username') || '';
      const password = form.get('password') || '';
      if (loginBlocked(req, username)) {
        return sendHtml(res, 429, loginPage('Çok fazla başarısız giriş yapıldı. 15 dakika sonra tekrar deneyin.'));
      }
      const user = accounts.authenticate(username, password);
      if (!user) {
        recordLoginFailure(req, username);
        return sendHtml(res, 401, loginPage('Kullanıcı adı, parola veya hesap süresi geçersiz.'));
      }
      clearLoginFailures(req, username);
      const expiresAt = Date.now() + SESSION_MAX_AGE_SECONDS * 1000;
      const token = signSession(user.username, expiresAt);
      res.writeHead(302, {
        Location: '/',
        'Set-Cookie': `kadastro360_session=${encodeURIComponent(token)}; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}; HttpOnly; ${COOKIE_SECURE ? 'Secure; ' : ''}SameSite=Lax`
      });
      return res.end();
    }

    if (req.method === 'GET' && pathname === '/logout') {
      res.writeHead(302, {
        Location: '/login',
        'Set-Cookie': `kadastro360_session=; Path=/; Max-Age=0; HttpOnly; ${COOKIE_SECURE ? 'Secure; ' : ''}SameSite=Lax`
      });
      return res.end();
    }

    const sessionUser = validSession(req);
    if (!sessionUser) {
      if (pathname.startsWith('/api/')) return sendJson(res, 401, { error: 'Oturum gerekli.' });
      res.writeHead(302, { Location: '/login' }); return res.end();
    }
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      return sendFile(res, path.join(ROOT, 'index.html'), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && pathname === '/endeksa-utils.js') {
      return sendFile(res, path.join(ROOT, 'endeksa-utils.js'), 'application/javascript; charset=utf-8');
    }
    if (req.method === 'GET' && pathname === '/admin') {
      if (sessionUser.role !== 'admin') return sendHtml(res, 403, '<h1>Yetkisiz erişim</h1>');
      return sendFile(res, path.join(ROOT, 'admin.html'), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && pathname === '/favicon.ico') {
      res.writeHead(204); return res.end();
    }
    let match;
    if (req.method === 'GET' && pathname === '/api/me') {
      return sendJson(res, 200, accounts.publicUser(sessionUser));
    }
    if (req.method === 'GET' && pathname === '/api/history') {
      return sendJson(res, 200, { items: accounts.history(sessionUser.username, requestUrl.searchParams.get('limit') || 30) });
    }
    if (req.method === 'GET' && pathname === '/api/services') {
      return sendJson(res, 200, { updatedAt: new Date().toISOString(), services: serviceHealth });
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
      const result = await buildPilotCatalog({ province, district });
      markService('openData', true, `${province}${district ? ` / ${district}` : ''} için kaynak listesi hazırlandı. WMS katmanları kullanıcının tarayıcısından doğrudan yüklenir.`);
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
      if (sessionUser.role !== 'admin') return sendJson(res, 403, { error: 'Yönetici yetkisi gerekli.' });
      return sendJson(res, 200, { users: accounts.listUsers() });
    }
    if (req.method === 'POST' && pathname === '/api/admin/users') {
      if (sessionUser.role !== 'admin') return sendJson(res, 403, { error: 'Yönetici yetkisi gerekli.' });
      return sendJson(res, 201, { user: accounts.createUser(await readJsonBody(req)) });
    }
    match = pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
    if (req.method === 'PATCH' && match) {
      if (sessionUser.role !== 'admin') return sendJson(res, 403, { error: 'Yönetici yetkisi gerekli.' });
      return sendJson(res, 200, { user: accounts.updateUser(decodeURIComponent(match[1]), await readJsonBody(req)) });
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
      const allowance = accounts.canQuery(sessionUser);
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
        accounts.logQuery({
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
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return sendJson(res, 400, { error: 'Geçersiz parsel koordinatı.' });
      }
      if (category !== 'all' && !CATEGORY_QUERIES[category]) {
        return sendJson(res, 400, { error: 'Geçersiz yakın yer türü.' });
      }
      const result = await getPoi(lat, lng, radiusMode, category, geometry);
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


function startServer() {
  server.listen(START_PORT, HOST, () => {
    activePort = START_PORT;
    console.log(`Kadastro360 Web hazır: http://${HOST}:${activePort}`);
  });
}

if (require.main === module) startServer();

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
  itemFromElement,
  distanceToGeometry,
  limitBalanced,
  haversine,
  validRoutePoint,
  normalizeRouteRequest,
  getRoadRoutes
};
