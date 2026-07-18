'use strict';

const crypto = require('crypto');

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
    versionCandidates: ['1.3.0', '1.1.1'],
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
    versionCandidates: ['1.3.0', '1.1.1'],
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
    versionCandidates: ['1.3.0', '1.1.1'],
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
    versionCandidates: ['1.3.0', '1.1.1'],
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
    versionCandidates: ['1.3.0', '1.1.1'],
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
        'User-Agent': 'Kadastro360-Web-Pilot/1.2 (+open-data-integration)',
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
    supportsFeatureInfo: Boolean(resolved?.supportsFeatureInfo),
    infoFormats: resolved?.infoFormats || [],
    legendUrl: resolved?.legendUrl || `${config.baseUrl}?service=WMS&request=GetLegendGraphic&version=1.1.1&format=image/png&layer=${encodeURIComponent(layerCandidates[0] || '0')}`,
    verifiedAt: resolved?.verifiedAt || null,
    loadMode: 'browser-direct'
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

async function buildPilotCatalog({ province, district }) {
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
    wms: directWmsDefinition(config)
  }));
  const warnings = [];

  // WMS katmanları Render sunucusuna bağımlı olmadan kullanıcının tarayıcısından
  // doğrudan yüklenir. ULASAV katalog/CSV keşfi ise sunucudan denenir.
  const discovered = await Promise.race([
    discoverRegionDatasets(province, district),
    new Promise(resolve => setTimeout(() => resolve({
      items: [],
      warnings: ['ULASAV katalog/CSV kontrolü bu istekte zaman aşımına uğradı; kaynak bağlantıları gösterilmeye devam ediyor.']
    }), 6500))
  ]);
  items.push(...discovered.items);
  warnings.push(...discovered.warnings);

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
    wmsLoadMode: 'browser-direct',
    supportedRegions: [
      'Kayseri: çevre düzeni planı ve idari sınırlar',
      'Tekirdağ / Çorlu: çevre düzeni planı ve belediye rayiç kayıtları',
      'Kırıkkale / Yahşihan: çevre düzeni planı ve yayımlanmış rayiç kayıtları',
      'Giresun / Görele: çevre düzeni planı ve ortofoto'
    ]
  };
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
  fetchGeoJson,
  wmsFeatureInfo,
  configForKey
};
