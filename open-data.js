'use strict';

const crypto = require('crypto');
const { PNG } = require('pngjs');

const ULASAV_ROOT = 'https://ulasav.csb.gov.tr';
const ULASAV_API = `${ULASAV_ROOT}/api/3/action`;
const ULASAV_LICENSE = `${ULASAV_ROOT}/license`;

const WMS_CONFIGS = [
  {
    key: 'cdp-ysk',
    provinces: ['Kayseri', 'Sivas', 'Yozgat'],
    title: 'Yozgat–Sivas–Kayseri Çevre Düzeni Planı',
    category: 'plan',
    baseUrl: 'https://tucbs-public-api.csb.gov.tr/csb_cdp_ysk_wms',
    layerCandidates: ['0'],
    versionCandidates: ['1.1.1', '1.3.0'],
    bounds: [37.335310, 32.378300, 40.687798, 38.957376],
    provider: 'Coğrafi Bilgi Sistemleri Genel Müdürlüğü',
    sourceUrl: `${ULASAV_ROOT}/dataset/?q=${encodeURIComponent('Yozgat Sivas Kayseri Çevre Düzeni Planı')}`,
    description: 'Üst ölçekli arazi kullanım kararlarını renkli plan katmanı olarak gösterir.'
  },
  {
    key: 'cdp-ergene',
    provinces: ['Tekirdağ', 'Kırklareli', 'Edirne'],
    title: 'Tekirdağ–Kırklareli–Edirne Çevre Düzeni Planı',
    category: 'plan',
    baseUrl: 'https://tucbs-public-api.csb.gov.tr/csb_cdp_ergene_wms',
    layerCandidates: ['0'],
    versionCandidates: ['1.1.1', '1.3.0'],
    bounds: [39.845453, 25.412765, 42.261958, 30.364822],
    provider: 'Coğrafi Bilgi Sistemleri Genel Müdürlüğü',
    sourceUrl: `${ULASAV_ROOT}/dataset/?q=${encodeURIComponent('Tekirdağ Kırklareli Edirne Çevre Düzeni Planı')}`,
    description: 'Trakya planlama bölgesindeki üst ölçekli arazi kullanım kararlarını gösterir.'
  },
  {
    key: 'cdp-kirikkale',
    provinces: ['Kırıkkale'],
    title: 'Kırıkkale Çevre Düzeni Planı',
    category: 'plan',
    baseUrl: 'https://tucbs-public-api.csb.gov.tr/csb_cdp_kirikkale_wms',
    layerCandidates: ['0'],
    versionCandidates: ['1.1.1', '1.3.0'],
    bounds: [39.354056, 32.854130, 40.386116, 34.649764],
    provider: 'Coğrafi Bilgi Sistemleri Genel Müdürlüğü',
    sourceUrl: `${ULASAV_ROOT}/dataset/?q=${encodeURIComponent('Kırıkkale Çevre Düzeni Planı')}`,
    description: 'Kırıkkale için renkli üst ölçek plan kararlarını gösterir.'
  },
  {
    key: 'cdp-otrgga',
    provinces: ['Ordu', 'Trabzon', 'Rize', 'Gümüşhane', 'Giresun', 'Artvin'],
    title: 'Ordu–Trabzon–Rize–Gümüşhane–Giresun–Artvin Çevre Düzeni Planı',
    category: 'plan',
    baseUrl: 'https://tucbs-public-api.csb.gov.tr/csb_cdp_otrgga_wms',
    layerCandidates: ['0'],
    versionCandidates: ['1.1.1', '1.3.0'],
    bounds: [38.618676, 36.176773, 42.897070, 43.324884],
    provider: 'Coğrafi Bilgi Sistemleri Genel Müdürlüğü',
    sourceUrl: `${ULASAV_ROOT}/dataset/?q=${encodeURIComponent('Ordu Trabzon Rize Gümüşhane Giresun Artvin Çevre Düzeni Planı')}`,
    description: 'Doğu Karadeniz planlama bölgesindeki renkli arazi kullanım kararlarını gösterir.'
  },
  {
    key: 'ortho-gorele',
    provinces: ['Giresun'],
    districts: ['Görele'],
    title: 'Giresun Görele Ortofoto',
    category: 'ortho',
    baseUrl: 'https://tucbs-public-api.csb.gov.tr/trk_cbs_ortofoto_giresun_gorele_test',
    layerCandidates: ['0'],
    versionCandidates: ['1.1.1', '1.3.0'],
    provider: 'Coğrafi Bilgi Sistemleri Genel Müdürlüğü',
    sourceUrl: 'https://cbs.csb.gov.tr/ortofoto-web-servisleri-86198',
    description: 'Görele için kamuya açık örnek ortofoto görüntüsünü haritaya ekler.'
  }
];

const STATIC_REGION_LINKS = [
  {
    provinces: ['Kayseri'],
    title: 'Kayseri İlçe ve Mahalle Sınırları',
    description: 'ULASAV üzerindeki Kayseri idari sınır veri setlerini açar. Harita katmanı yalnızca erişilebilir GeoJSON kaynağı bulunursa yüklenir.',
    category: 'boundary',
    sourceUrl: `${ULASAV_ROOT}/dataset/?q=${encodeURIComponent('Kayseri ilçe mahalle sınırı')}`
  },
  {
    provinces: ['Tekirdağ'], districts: ['Çorlu'],
    title: 'Çorlu Belediyesi Arsa Rayiç Kayıtları',
    description: 'Yayımlanan dönemsel arsa rayiç kaynaklarını açar. Okunabilir veri bulunmadıkça fiyat üretilmez.',
    category: 'rayic',
    sourceUrl: `${ULASAV_ROOT}/dataset/?q=${encodeURIComponent('Çorlu arsa rayiç değerleri')}`
  },
  {
    provinces: ['Kırıkkale'], districts: ['Yahşihan'],
    title: 'Yahşihan Arsa Rayiç Kayıtları',
    description: 'Yayımlanan dönemsel rayiç kaynaklarını açar. Okunabilir veri bulunmadıkça fiyat üretilmez.',
    category: 'rayic',
    sourceUrl: `${ULASAV_ROOT}/dataset/?q=${encodeURIComponent('Yahşihan arsa rayiç')}`
  }
];

const REGION_DATASETS = [
  {
    provinces: ['Kayseri'],
    exactPackages: ['38-kayseri-ilce-siniri', '38-kayseri-mahalle-siniri'],
    category: 'boundary'
  },
  {
    provinces: ['Tekirdağ'],
    districts: ['Çorlu'],
    searches: [
      { query: 'ARSA RAYİÇ DEĞERLERİ', fq: 'organization:tekirdag-corlu-belediyesi', category: 'rayic' },
      { query: 'arsa rayiç Çorlu', category: 'rayic' }
    ]
  },
  {
    provinces: ['Kırıkkale'],
    districts: ['Yahşihan'],
    searches: [
      { query: 'Yahşihan arsa rayiç', category: 'rayic' },
      { query: '2025 rayiç Yahşihan', category: 'rayic' }
    ]
  }
];

const cache = new Map();
const resourceTokens = new Map();

function normalizeTr(value) {
  return String(value || '')
    .toLocaleLowerCase('tr-TR')
    .replace(/ı/g, 'i')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function matchesLocation(config, province, district) {
  const p = normalizeTr(province);
  const d = normalizeTr(district);
  const provinceMatch = (config.provinces || []).some(item => normalizeTr(item) === p);
  if (!provinceMatch) return false;
  if (!config.districts?.length) return true;
  return config.districts.some(item => normalizeTr(item) === d);
}

async function fetchBuffer(url, options = {}, timeoutMs = 10000, maxBytes = 8_000_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': 'Kadastro360-Web-Pilot/1.8.9 (+stable-open-data-snapshot)',
        Accept: '*/*',
        ...(options.headers || {})
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength && contentLength > maxBytes) throw new Error('Kaynak dosya çok büyük.');
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new Error('Kaynak dosya çok büyük.');
    return { buffer, contentType: response.headers.get('content-type') || '', response };
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('Açık veri servisi zaman aşımına uğradı.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function decodeBuffer(buffer) {
  const utf8 = new TextDecoder('utf-8').decode(buffer);
  const replacementCount = (utf8.match(/�/g) || []).length;
  if (replacementCount <= 2) return utf8;
  try { return new TextDecoder('windows-1254').decode(buffer); } catch { return utf8; }
}

async function fetchBufferRetry(url, options = {}, timeoutMs = 10000, maxBytes = 8_000_000, attempts = 2) {
  let lastError;
  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt++) {
    try {
      return await fetchBuffer(url, options, timeoutMs, maxBytes);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, 500 * attempt));
    }
  }
  throw lastError;
}

async function fetchText(url, options = {}, timeoutMs = 10000, maxBytes = 8_000_000) {
  const { buffer, contentType, response } = await fetchBuffer(url, options, timeoutMs, maxBytes);
  return { text: decodeBuffer(buffer), contentType, response };
}

async function fetchJson(url, options = {}, timeoutMs = 10000, maxBytes = 8_000_000) {
  const { text } = await fetchText(url, options, timeoutMs, maxBytes);
  try { return JSON.parse(text); } catch { throw new Error('Açık veri servisi geçersiz JSON döndürdü.'); }
}

async function cached(key, ttlMs, factory) {
  const row = cache.get(key);
  if (row && row.expiresAt > Date.now()) return row.value;
  const value = await factory();
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

function stripXml(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function parseWmsCapabilities(xml) {
  const text = String(xml || '');
  const version = (text.match(/<WMS_Capabilities[^>]*version=["']([^"']+)/i) || text.match(/<WMT_MS_Capabilities[^>]*version=["']([^"']+)/i) || [])[1] || '1.1.1';
  const layers = [];
  const layerRegex = /<Layer\b[^>]*>([\s\S]*?)<\/Layer>/gi;
  let match;
  while ((match = layerRegex.exec(text))) {
    const block = match[1];
    const name = stripXml((block.match(/<Name>([\s\S]*?)<\/Name>/i) || [])[1]);
    const title = stripXml((block.match(/<Title>([\s\S]*?)<\/Title>/i) || [])[1]);
    if (name && !layers.some(row => row.name === name)) layers.push({ name, title: title || name });
  }
  if (!layers.length) {
    const names = [...text.matchAll(/<Name>([^<]+)<\/Name>/gi)].map(item => stripXml(item[1]));
    for (const name of names) {
      if (name && !/^WMS$/i.test(name) && !layers.some(row => row.name === name)) layers.push({ name, title: name });
    }
  }
  const infoFormats = [...text.matchAll(/<GetFeatureInfo[\s\S]*?<Format>([^<]+)<\/Format>/gi)].map(item => stripXml(item[1]));
  return { version, layers, infoFormats };
}

function capabilitiesUrl(baseUrl) {
  const url = new URL(baseUrl);
  url.searchParams.set('service', 'WMS');
  url.searchParams.set('request', 'GetCapabilities');
  return url.toString();
}

async function resolveWms(config) {
  return cached(`wms:${config.key}`, 6 * 60 * 60_000, async () => {
    const { text } = await fetchText(capabilitiesUrl(config.baseUrl), {}, 12000, 4_000_000);
    const parsed = parseWmsCapabilities(text);
    if (!parsed.layers.length) throw new Error('WMS katman adı bulunamadı.');
    const preferred = parsed.layers.find(row => /plan|ortofoto|raster|cdp|arazi|image/i.test(`${row.name} ${row.title}`)) || parsed.layers[0];
    return {
      key: config.key,
      baseUrl: config.baseUrl,
      version: parsed.version,
      layerName: preferred.name,
      layerTitle: preferred.title,
      supportsFeatureInfo: config.category === 'plan',
      infoFormats: parsed.infoFormats,
      legendUrl: `${config.baseUrl}?service=WMS&request=GetLegendGraphic&version=1.1.1&format=image/png&layer=${encodeURIComponent(preferred.name)}`,
      verifiedAt: new Date().toISOString()
    };
  });
}

function directWmsDefinition(config, resolved = null) {
  const resolvedName = resolved?.layerName ? [resolved.layerName] : [];
  const layerCandidates = [...new Set([...resolvedName, ...(config.layerCandidates || ['0'])])];
  const versions = [...new Set([resolved?.version, ...(config.versionCandidates || ['1.3.0', '1.1.1'])].filter(Boolean))];
  return {
    key: config.key,
    baseUrl: config.baseUrl,
    layerName: resolved?.layerName || layerCandidates[0] || '0',
    layerTitle: resolved?.layerTitle || config.title,
    layerCandidates,
    version: versions[0] || '1.3.0',
    versionCandidates: versions,
    bounds: config.bounds || null,
    supportsFeatureInfo: config.category === 'plan',
    recommendedZoom: config.category === 'plan' ? 10 : null,
    probeRadiusKm: config.category === 'plan' ? 24 : 8,
    snapshotRadiusKm: config.category === 'plan' ? 14 : 5,
    snapshotSize: config.category === 'plan' ? 1024 : 768,
    infoFormats: resolved?.infoFormats || [],
    legendUrl: resolved?.legendUrl || `${config.baseUrl}?service=WMS&request=GetLegendGraphic&version=1.1.1&format=image/png&layer=${encodeURIComponent(layerCandidates[0] || '0')}`,
    verifiedAt: resolved?.verifiedAt || null,
    loadMode: 'stable-single-image-with-cache'
  };
}

async function ckanPackageShow(id) {
  return cached(`package:${id}`, 2 * 60 * 60_000, async () => {
    const data = await fetchJson(`${ULASAV_API}/package_show?id=${encodeURIComponent(id)}`, {}, 10000, 8_000_000);
    if (!data?.success || !data.result) throw new Error('ULASAV veri seti bulunamadı.');
    return data.result;
  });
}

async function ckanSearch(query, fq = '') {
  const key = `search:${query}:${fq}`;
  return cached(key, 2 * 60 * 60_000, async () => {
    const url = new URL(`${ULASAV_API}/package_search`);
    url.searchParams.set('q', query);
    url.searchParams.set('rows', '20');
    if (fq) url.searchParams.set('fq', fq);
    const data = await fetchJson(url.toString(), {}, 10000, 12_000_000);
    if (!data?.success) throw new Error('ULASAV araması başarısız oldu.');
    return Array.isArray(data.result?.results) ? data.result.results : [];
  });
}

function resourceFormat(resource) {
  return String(resource?.format || resource?.mimetype || '').toUpperCase().trim();
}

function registerResource(resource) {
  const token = crypto.createHash('sha256').update(`${resource.id || ''}|${resource.url || ''}`).digest('hex').slice(0, 24);
  resourceTokens.set(token, {
    url: resource.url,
    format: resourceFormat(resource),
    expiresAt: Date.now() + 12 * 60 * 60_000
  });
  return token;
}

function datasetPage(pkg) {
  return `${ULASAV_ROOT}/dataset/${encodeURIComponent(pkg.name)}`;
}

function extractYear(...values) {
  for (const value of values) {
    const matches = String(value || '').match(/(?:19|20)\d{2}/g);
    if (matches?.length) return Math.max(...matches.map(Number));
  }
  return null;
}

function datasetToItems(pkg, forcedCategory = null) {
  const items = [];
  const pageUrl = datasetPage(pkg);
  const category = forcedCategory || (/rayi[çc]/i.test(normalizeTr(`${pkg.title} ${pkg.notes} ${(pkg.tags || []).map(tag => tag.name).join(' ')}`)) ? 'rayic' : 'dataset');
  const updatedAt = pkg.metadata_modified || pkg.metadata_created || null;
  const resources = Array.isArray(pkg.resources) ? pkg.resources : [];

  if (category === 'rayic') {
    items.push({
      id: `dataset-${pkg.id || pkg.name}`,
      type: 'rayic',
      title: pkg.title || pkg.name,
      description: pkg.notes || 'Belediye veya kurum tarafından yayımlanan arsa rayiç kaydı.',
      provider: pkg.organization?.title || pkg.author || 'ULASAV veri sağlayıcısı',
      sourceUrl: pageUrl,
      updatedAt,
      dataYear: extractYear(pkg.title, pkg.notes, ...resources.map(row => row.name)),
      resources: resources.map(resource => ({
        name: resource.name || resource.description || resourceFormat(resource) || 'Kaynak',
        format: resourceFormat(resource),
        url: resource.url,
        updatedAt: resource.last_modified || resource.created || updatedAt
      })).filter(row => row.url),
      rawPackage: pkg
    });
    return items;
  }

  for (const resource of resources) {
    const format = resourceFormat(resource);
    if (!resource.url) continue;
    if (format.includes('GEOJSON') || /\.geojson(?:\?|$)/i.test(resource.url)) {
      items.push({
        id: `geojson-${resource.id || crypto.randomUUID()}`,
        type: 'geojson',
        category: forcedCategory || 'boundary',
        title: `${pkg.title || pkg.name} · ${resource.name || 'GeoJSON'}`,
        description: resource.description || pkg.notes || 'Açık coğrafi veri katmanı.',
        provider: pkg.organization?.title || 'ULASAV veri sağlayıcısı',
        sourceUrl: pageUrl,
        directUrl: resource.url,
        updatedAt: resource.last_modified || resource.created || updatedAt,
        resourceToken: registerResource(resource),
        style: { color: '#7a3ff2', weight: 2, fillOpacity: 0.04 }
      });
    }
  }
  if (!items.length) {
    items.push({
      id: `dataset-${pkg.id || pkg.name}`,
      type: 'link',
      category: forcedCategory || 'dataset',
      title: pkg.title || pkg.name,
      description: pkg.notes || 'ULASAV açık veri seti.',
      provider: pkg.organization?.title || 'ULASAV veri sağlayıcısı',
      sourceUrl: pageUrl,
      updatedAt,
      resources: resources.map(resource => ({ name: resource.name || resourceFormat(resource), format: resourceFormat(resource), url: resource.url })).filter(row => row.url)
    });
  }
  return items;
}

function detectDelimiter(line) {
  const counts = { ';': 0, ',': 0, '\t': 0 };
  let quoted = false;
  for (const char of line) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && Object.prototype.hasOwnProperty.call(counts, char)) counts[char]++;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

function parseCsv(text) {
  const clean = String(text || '').replace(/^\uFEFF/, '');
  const firstLine = clean.split(/\r?\n/, 1)[0] || '';
  const delimiter = detectDelimiter(firstLine);
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const char = clean[i];
    if (quoted) {
      if (char === '"' && clean[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === delimiter) { row.push(field); field = ''; }
    else if (char === '\n') { row.push(field.replace(/\r$/, '')); if (row.some(cell => String(cell).trim())) rows.push(row); row = []; field = ''; }
    else field += char;
  }
  row.push(field.replace(/\r$/, ''));
  if (row.some(cell => String(cell).trim())) rows.push(row);
  return rows;
}

function parseTurkishNumber(value) {
  let text = String(value ?? '').trim().replace(/\s+/g, '').replace(/₺|TL|TRY/gi, '').replace(/[^0-9,.-]/g, '');
  if (!text || !/\d/.test(text)) return null;
  const lastComma = text.lastIndexOf(',');
  const lastDot = text.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    if (lastComma > lastDot) text = text.replace(/\./g, '').replace(',', '.');
    else text = text.replace(/,/g, '');
  } else if (lastComma > -1) {
    const decimals = text.length - lastComma - 1;
    text = decimals === 3 ? text.replace(/,/g, '') : text.replace(',', '.');
  } else if ((text.match(/\./g) || []).length > 1) text = text.replace(/\./g, '');
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function summarizeRayicCsv(text, datasetTitle = '', resourceName = '') {
  const rows = parseCsv(text);
  if (rows.length < 2) return null;
  const headers = rows[0].map(value => String(value || '').trim());
  const candidates = headers.map((header, index) => ({ header, index, normalized: normalizeTr(header) }))
    .filter(row => /(rayic|bedel|deger|fiyat|metrekare|m2)/.test(row.normalized) && !/(yil|kod|id|sira|no)/.test(row.normalized));
  if (!candidates.length) return null;

  let best = null;
  for (const candidate of candidates) {
    const values = rows.slice(1).map(row => parseTurkishNumber(row[candidate.index])).filter(value => Number.isFinite(value) && value > 0);
    if (!values.length) continue;
    const current = {
      column: candidate.header,
      min: Math.min(...values),
      max: Math.max(...values),
      count: values.length,
      dataYear: extractYear(datasetTitle, resourceName, candidate.header)
    };
    if (!best || current.count > best.count) best = current;
  }
  return best;
}

async function attachRayicSummary(item) {
  const csv = item.resources?.find(resource => resource.format.includes('CSV') || /\.csv(?:\?|$)/i.test(resource.url));
  if (!csv) return item;
  try {
    const { text } = await fetchText(csv.url, {}, 12000, 6_000_000);
    const summary = summarizeRayicCsv(text, item.title, csv.name);
    if (summary) item.summary = { ...summary, sourceResource: csv.name, sourceUrl: csv.url };
  } catch (error) {
    item.summaryError = error.message;
  }
  return item;
}

async function discoverRegionDatasets(province, district) {
  const configs = REGION_DATASETS.filter(config => matchesLocation(config, province, district));
  const found = [];
  const warnings = [];
  for (const config of configs) {
    for (const id of config.exactPackages || []) {
      try { found.push(...datasetToItems(await ckanPackageShow(id), config.category)); }
      catch (error) { warnings.push(`${id}: ${error.message}`); }
    }
    for (const search of config.searches || []) {
      try {
        const packages = await ckanSearch(search.query, search.fq || '');
        const relevant = packages.filter(pkg => {
          if (search.category !== 'rayic') return true;
          const haystack = normalizeTr(`${pkg.title || ''} ${pkg.notes || ''} ${(pkg.tags || []).map(tag => tag.name).join(' ')}`);
          const locationMatch = haystack.includes(normalizeTr(district)) || haystack.includes(normalizeTr(province));
          return /(rayic|arsa degeri|metrekare birim)/.test(haystack) && locationMatch;
        });
        for (const pkg of relevant.slice(0, 10)) found.push(...datasetToItems(pkg, search.category));
      } catch (error) { warnings.push(`${search.query}: ${error.message}`); }
    }
  }
  const deduped = [...new Map(found.map(item => [item.id, item])).values()];
  await Promise.all(deduped.filter(item => item.type === 'rayic').map(attachRayicSummary));
  return { items: deduped, warnings };
}

async function buildPilotCatalog({ province, district, detailed = false }) {
  const selectedWms = WMS_CONFIGS.filter(config => matchesLocation(config, province, district));
  const items = selectedWms.map(config => ({
    id: config.key,
    type: 'wms',
    category: config.category,
    title: config.title,
    description: config.description,
    provider: config.provider,
    sourceUrl: config.sourceUrl,
    updatedAt: null,
    verifiedAt: null,
    browserDirect: true,
    quickReady: true,
    wms: directWmsDefinition(config)
  }));
  const warnings = [];

  // Hızlı modda hazır WMS tanımları ve kaynak bağlantıları anında döner.
  // CKAN/CSV katalog taraması yalnızca kullanıcı ayrıntılı taramayı ayrıca isterse çalışır.
  if (detailed) {
    const discovered = await Promise.race([
      discoverRegionDatasets(province, district),
      new Promise(resolve => setTimeout(() => resolve({
        items: [],
        warnings: ['ULASAV katalog/CSV kontrolü bu istekte zaman aşımına uğradı; hazır katmanlar gösterilmeye devam ediyor.']
      }), 6500))
    ]);
    items.push(...discovered.items);
    warnings.push(...discovered.warnings);
  }

  for (const fallback of STATIC_REGION_LINKS.filter(config => matchesLocation(config, province, district))) {
    const id = `source-${normalizeTr(fallback.title).replace(/\s+/g, '-')}`;
    if (!items.some(item => item.id === id || normalizeTr(item.title) === normalizeTr(fallback.title))) {
      items.push({
        id,
        type: 'link',
        category: fallback.category,
        title: fallback.title,
        description: fallback.description,
        provider: 'ULASAV / ilgili veri sağlayıcısı',
        sourceUrl: fallback.sourceUrl,
        updatedAt: null,
        fallbackSource: true
      });
    }
  }

  return {
    pilot: true,
    province,
    district,
    checkedAt: new Date().toISOString(),
    items,
    warnings: [...new Set(warnings)],
    licenseUrl: ULASAV_LICENSE,
    providerUrl: ULASAV_ROOT,
    catalogMode: detailed ? 'detailed' : 'quick',
    wmsLoadMode: 'stable-single-image-with-cache',
    supportedRegions: [
      'Kayseri: çevre düzeni planı ve idari sınırlar',
      'Tekirdağ / Çorlu: çevre düzeni planı ve belediye rayiç kayıtları',
      'Kırıkkale / Yahşihan: çevre düzeni planı ve yayımlanmış rayiç kayıtları',
      'Giresun / Görele: çevre düzeni planı ve ortofoto'
    ]
  };
}


function lonLatToMercator(lon, lat) {
  const boundedLat = Math.max(-85.05112878, Math.min(85.05112878, Number(lat)));
  const x = Number(lon) * 20037508.34 / 180;
  const y = Math.log(Math.tan((90 + boundedLat) * Math.PI / 360)) / (Math.PI / 180) * 20037508.34 / 180;
  return { x, y };
}

function analyzePngVisibility(buffer) {
  const png = PNG.sync.read(buffer, { skipRescale: true });
  const total = png.width * png.height;
  if (!total) return { visible: false, reason: 'empty-image', width: png.width, height: png.height };
  const stride = Math.max(1, Math.floor(Math.sqrt(total / 70000)));
  let sampled = 0;
  let visiblePixels = 0;
  let opaquePixels = 0;
  let variedPixels = 0;
  let first = null;
  for (let y = 0; y < png.height; y += stride) {
    for (let x = 0; x < png.width; x += stride) {
      const index = (png.width * y + x) << 2;
      const r = png.data[index];
      const g = png.data[index + 1];
      const b = png.data[index + 2];
      const a = png.data[index + 3];
      sampled++;
      if (a > 16) opaquePixels++;
      const nearWhite = r > 246 && g > 246 && b > 246;
      const nearTransparent = a <= 16;
      if (!nearTransparent && !nearWhite) visiblePixels++;
      if (!nearTransparent) {
        const packed = (r << 16) | (g << 8) | b;
        if (first === null) first = packed;
        else if (Math.abs((packed & 255) - (first & 255)) > 5 || Math.abs(((packed >> 8) & 255) - ((first >> 8) & 255)) > 5 || Math.abs(((packed >> 16) & 255) - ((first >> 16) & 255)) > 5) variedPixels++;
      }
    }
  }
  const visibleRatio = sampled ? visiblePixels / sampled : 0;
  const opaqueRatio = sampled ? opaquePixels / sampled : 0;
  const variedRatio = sampled ? variedPixels / sampled : 0;
  const visible = visiblePixels >= 24 && (visibleRatio >= 0.0008 || variedRatio >= 0.0008);
  return { visible, width: png.width, height: png.height, sampled, visiblePixels, visibleRatio, opaqueRatio, variedRatio, reason: visible ? 'visual-content' : 'transparent-or-empty' };
}

function wmsMapUrl(config, { layerName, version = '1.1.1', latitude, longitude, radiusKm = 24, width = 512, height = 512 }) {
  const center = lonLatToMercator(longitude, latitude);
  const radius = Math.max(3000, Math.min(100000, Number(radiusKm) * 1000));
  const url = new URL(config.baseUrl);
  const params = {
    SERVICE: 'WMS', REQUEST: 'GetMap', VERSION: version,
    LAYERS: layerName, STYLES: String(layerName).split(',').map(() => '').join(','),
    FORMAT: 'image/png', TRANSPARENT: 'TRUE', WIDTH: String(width), HEIGHT: String(height),
    BBOX: [center.x - radius, center.y - radius, center.x + radius, center.y + radius].join(',')
  };
  if (version === '1.3.0') params.CRS = 'EPSG:3857';
  else params.SRS = 'EPSG:3857';
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

async function wmsProbe({ key, layerName, version, latitude, longitude, radiusKm }) {
  const config = WMS_CONFIGS.find(row => row.key === key);
  if (!config) throw new Error('Açık veri WMS kaynağı bulunamadı.');
  if (!layerName || String(layerName).length > 5000) throw new Error('Geçersiz WMS katman adı.');
  if (!Number.isFinite(Number(latitude)) || !Number.isFinite(Number(longitude))) throw new Error('Geçersiz parsel koordinatı.');
  const url = wmsMapUrl(config, { layerName: String(layerName), version: version === '1.3.0' ? '1.3.0' : '1.1.1', latitude: Number(latitude), longitude: Number(longitude), radiusKm: Number(radiusKm) || config.probeRadiusKm || 24 });
  const { buffer, contentType } = await fetchBuffer(url, {}, 16000, 5_000_000);
  if (!/image\/png/i.test(contentType) && buffer.slice(1, 4).toString() !== 'PNG') {
    const text = decodeBuffer(buffer).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 700);
    throw new Error(text || 'WMS görüntü yerine geçersiz cevap döndürdü.');
  }
  const analysis = analyzePngVisibility(buffer);
  return { ...analysis, layerName: String(layerName), version: version === '1.3.0' ? '1.3.0' : '1.1.1', checkedAt: new Date().toISOString() };
}



function validateWmsImage(buffer, contentType, label = 'WMS görüntüsü') {
  const isPng = /image\/png/i.test(String(contentType || '')) || buffer.slice(1, 4).toString() === 'PNG';
  if (!isPng) {
    const detail = decodeBuffer(buffer).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 700);
    throw new Error(detail || `${label} yerine geçersiz cevap döndü.`);
  }
  return analyzePngVisibility(buffer);
}

async function wmsSnapshot({ key, layerName, version, latitude, longitude, radiusKm = 14, size = 1024 }) {
  const config = WMS_CONFIGS.find(row => row.key === key);
  if (!config) throw Object.assign(new Error('Açık veri WMS kaynağı bulunamadı.'), { httpStatus: 404 });
  const safeLayer = safeWmsLayerName(layerName);
  const safeVersion = version === '1.3.0' ? '1.3.0' : '1.1.1';
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error('Geçersiz parsel koordinatı.');
  const safeRadiusKm = Math.max(3, Math.min(40, Number(radiusKm) || 14));
  const safeSize = Math.max(512, Math.min(1536, Number(size) || 1024));
  const cacheKey = `wms-snapshot:${key}:${safeLayer}:${safeVersion}:${lat.toFixed(4)}:${lng.toFixed(4)}:${safeRadiusKm}:${safeSize}`;
  return cached(cacheKey, 30 * 60_000, async () => {
    const url = wmsMapUrl(config, {
      layerName: safeLayer,
      version: safeVersion,
      latitude: lat,
      longitude: lng,
      radiusKm: safeRadiusKm,
      width: safeSize,
      height: safeSize
    });
    const result = await fetchBufferRetry(url, { headers: { Referer: 'https://kadastro360.com.tr/', Origin: 'https://kadastro360.com.tr' } }, 18000, 12_000_000, 2);
    const analysis = validateWmsImage(result.buffer, result.contentType, 'WMS sabit plan görüntüsü');
    if (!analysis.visible) {
      throw Object.assign(new Error('Bu parsel çevresinde katman görüntüsü boş veya şeffaf döndü.'), { httpStatus: 422 });
    }
    return {
      buffer: result.buffer,
      contentType: 'image/png',
      cache: 'MISS',
      analysis,
      radiusKm: safeRadiusKm,
      size: safeSize,
      layerName: safeLayer,
      version: safeVersion
    };
  });
}

async function wmsLegend({ key, layerName, version = '1.1.1' }) {
  const config = WMS_CONFIGS.find(row => row.key === key);
  if (!config) throw Object.assign(new Error('Açık veri WMS kaynağı bulunamadı.'), { httpStatus: 404 });
  const safeLayer = safeWmsLayerName(layerName);
  const safeVersion = version === '1.3.0' ? '1.3.0' : '1.1.1';
  const cacheKey = `wms-legend:${key}:${safeLayer}:${safeVersion}`;
  return cached(cacheKey, 6 * 60 * 60_000, async () => {
    const url = new URL(config.baseUrl);
    const params = {
      SERVICE: 'WMS', REQUEST: 'GetLegendGraphic', VERSION: safeVersion,
      FORMAT: 'image/png', LAYER: safeLayer, TRANSPARENT: 'TRUE'
    };
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
    const result = await fetchBufferRetry(url.toString(), { headers: { Referer: 'https://kadastro360.com.tr/' } }, 16000, 12_000_000, 2);
    const analysis = validateWmsImage(result.buffer, result.contentType, 'WMS lejantı');
    if (!analysis.visible) throw Object.assign(new Error('Katman servisi görünür bir lejant görseli döndürmedi.'), { httpStatus: 404 });
    return { buffer: result.buffer, contentType: 'image/png', cache: 'MISS', layerName: safeLayer, version: safeVersion };
  });
}

function safeResource(token) {
  const row = resourceTokens.get(String(token || ''));
  if (!row || row.expiresAt <= Date.now()) return null;
  let url;
  try { url = new URL(row.url); } catch { return null; }
  const hostname = url.hostname.toLowerCase();
  const privateHost = hostname === 'localhost' || hostname.endsWith('.local') || hostname === '0.0.0.0' || hostname === '127.0.0.1' || hostname === '::1' || /^10\./.test(hostname) || /^192\.168\./.test(hostname) || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) || /^169\.254\./.test(hostname);
  const allowed = ['https:', 'http:'].includes(url.protocol) && !privateHost;
  return allowed ? row : null;
}

async function fetchGeoJson(token) {
  const resource = safeResource(token);
  if (!resource) throw new Error('Açık veri kaynağı geçersiz veya süresi doldu. Katman listesini yenileyin.');
  const data = await fetchJson(resource.url, {}, 15000, 15_000_000);
  if (!data || !['FeatureCollection', 'Feature'].includes(data.type)) throw new Error('Kaynak geçerli GeoJSON döndürmedi.');
  return data;
}

async function wmsFeatureInfo({ key, bbox, width, height, x, y }) {
  const config = WMS_CONFIGS.find(row => row.key === key);
  if (!config || config.category !== 'plan') throw new Error('Katman bilgi sorgusu desteklenmiyor.');
  const wms = await resolveWms(config);
  const params = new URLSearchParams({
    service: 'WMS', request: 'GetFeatureInfo', version: '1.1.1',
    layers: wms.layerName, query_layers: wms.layerName, styles: '',
    srs: 'EPSG:3857', bbox: String(bbox), width: String(width), height: String(height),
    x: String(x), y: String(y), feature_count: '8', info_format: 'application/json'
  });
  let response;
  try {
    response = await fetchText(`${config.baseUrl}?${params}`, {}, 12000, 2_000_000);
    const parsed = JSON.parse(response.text);
    const features = Array.isArray(parsed.features) ? parsed.features : [];
    return {
      title: config.title,
      features: features.map(feature => ({ properties: feature.properties || {} })).slice(0, 8),
      text: null
    };
  } catch {
    params.set('info_format', 'text/plain');
    response = await fetchText(`${config.baseUrl}?${params}`, {}, 12000, 2_000_000);
    const text = stripXml(response.text).slice(0, 5000);
    return { title: config.title, features: [], text: text || null };
  }
}


const wmsTileCache = new Map();
const WMS_TILE_CACHE_LIMIT = 420;

function safeWmsLayerName(value) {
  const text = String(value || '').trim();
  if (!text || text.length > 5000 || /[\r\n&?#]/.test(text)) throw new Error('Geçersiz WMS katman adı.');
  return text;
}

function tileMercatorBounds(z, x, y) {
  const zoom = Number(z);
  const tileX = Number(x);
  const tileY = Number(y);
  if (!Number.isInteger(zoom) || zoom < 0 || zoom > 20) throw new Error('Geçersiz WMS yakınlaştırma seviyesi.');
  const count = 2 ** zoom;
  if (!Number.isInteger(tileX) || !Number.isInteger(tileY) || tileX < 0 || tileY < 0 || tileX >= count || tileY >= count) {
    throw new Error('Geçersiz WMS karo koordinatı.');
  }
  const world = 20037508.342789244;
  const span = (world * 2) / count;
  const minX = -world + tileX * span;
  const maxX = minX + span;
  const maxY = world - tileY * span;
  const minY = maxY - span;
  return [minX, minY, maxX, maxY];
}

function rememberWmsTile(key, value) {
  if (wmsTileCache.has(key)) wmsTileCache.delete(key);
  wmsTileCache.set(key, { ...value, expiresAt: Date.now() + 20 * 60_000 });
  while (wmsTileCache.size > WMS_TILE_CACHE_LIMIT) {
    const oldest = wmsTileCache.keys().next().value;
    wmsTileCache.delete(oldest);
  }
}

async function wmsTile({ key, layerName, version, z, x, y, size = 512 }) {
  const config = WMS_CONFIGS.find(row => row.key === key);
  if (!config) throw Object.assign(new Error('Açık veri WMS kaynağı bulunamadı.'), { httpStatus: 404 });
  const safeLayer = safeWmsLayerName(layerName);
  const safeVersion = version === '1.3.0' ? '1.3.0' : '1.1.1';
  const tileSize = Math.max(256, Math.min(512, Number(size) || 512));
  const cacheKey = `${key}:${safeLayer}:${safeVersion}:${z}:${x}:${y}:${tileSize}`;
  const cachedTile = wmsTileCache.get(cacheKey);
  if (cachedTile && cachedTile.expiresAt > Date.now()) {
    wmsTileCache.delete(cacheKey);
    wmsTileCache.set(cacheKey, cachedTile);
    return { buffer: cachedTile.buffer, contentType: cachedTile.contentType, cache: 'HIT' };
  }
  if (cachedTile) wmsTileCache.delete(cacheKey);

  const bbox = tileMercatorBounds(z, x, y);
  const url = new URL(config.baseUrl);
  const params = {
    SERVICE: 'WMS', REQUEST: 'GetMap', VERSION: safeVersion,
    LAYERS: safeLayer, STYLES: safeLayer.split(',').map(() => '').join(','),
    FORMAT: 'image/png', TRANSPARENT: 'TRUE', WIDTH: String(tileSize), HEIGHT: String(tileSize),
    BBOX: bbox.join(',')
  };
  if (safeVersion === '1.3.0') params.CRS = 'EPSG:3857';
  else params.SRS = 'EPSG:3857';
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);

  const result = await fetchBuffer(url.toString(), {}, 14000, 4_000_000);
  const isPng = /image\/png/i.test(result.contentType) || result.buffer.slice(1, 4).toString() === 'PNG';
  if (!isPng) {
    const text = decodeBuffer(result.buffer).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
    throw new Error(text || 'WMS karo görüntüsü yerine geçersiz cevap döndürdü.');
  }
  const row = { buffer: result.buffer, contentType: 'image/png' };
  rememberWmsTile(cacheKey, row);
  return { ...row, cache: 'MISS' };
}

function configForKey(key) {
  return WMS_CONFIGS.find(row => row.key === key) || null;
}

module.exports = {
  ULASAV_ROOT,
  ULASAV_LICENSE,
  WMS_CONFIGS,
  normalizeTr,
  matchesLocation,
  parseWmsCapabilities,
  parseCsv,
  parseTurkishNumber,
  summarizeRayicCsv,
  buildPilotCatalog,
  analyzePngVisibility,
  wmsProbe,
  fetchGeoJson,
  wmsFeatureInfo,
  wmsSnapshot,
  wmsLegend,
  wmsTile,
  tileMercatorBounds,
  configForKey
};
