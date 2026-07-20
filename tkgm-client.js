'use strict';

const DEFAULT_SOURCES = [
  { key: 'v31', label: 'TKGM v3.1', baseUrl: 'https://cbsapi.tkgm.gov.tr/megsiswebapi.v3.1/api', doubleSlashAdmin: false },
  { key: 'v3', label: 'TKGM v3', baseUrl: 'https://cbsservis.tkgm.gov.tr/megsiswebapi.v3/api', doubleSlashAdmin: true },
  { key: 'v2', label: 'TKGM v2 yedek', baseUrl: 'https://cbsservis.tkgm.gov.tr/megsiswebapi.v2/api', doubleSlashAdmin: true }
];

function sourcesFromEnvironment(value = process.env.TKGM_BASE_URLS || '') {
  const text = String(value || '').trim();
  if (!text) return DEFAULT_SOURCES.map(item => ({ ...item }));
  return text.split(',').map((entry, index) => {
    const trimmed = entry.trim();
    const equalIndex = trimmed.indexOf('=');
    const key = equalIndex > 0 ? trimmed.slice(0, equalIndex).trim() : `env${index + 1}`;
    const baseUrl = (equalIndex > 0 ? trimmed.slice(equalIndex + 1) : trimmed).trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(baseUrl)) throw new Error(`Geçersiz TKGM_BASE_URLS girdisi: ${trimmed}`);
    return { key, label: `TKGM ${key}`, baseUrl, doubleSlashAdmin: true };
  });
}

function rowsFromPayload(payload) {
  if (Array.isArray(payload?.features)) return payload.features;
  if (Array.isArray(payload?.data?.features)) return payload.data.features;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload)) return payload;
  return [];
}

function firstDefined(object, keys) {
  for (const key of keys) {
    const value = object?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return null;
}

function numericId(values) {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (/^\d+$/.test(text) && Number(text) > 0) return text;
  }
  return null;
}

const LEVEL_CONFIG = {
  province: {
    idKeys: ['ilId', 'IL_ID', 'ilID', 'id', 'ID'],
    nameKeys: ['ilAdi', 'ilAd', 'IL_AD', 'text', 'TEXT', 'adi', 'ADI', 'ad', 'AD', 'name', 'NAME'],
    path: '/idariYapi/ilListe',
    label: 'il'
  },
  district: {
    idKeys: ['ilceId', 'ILCE_ID', 'ilceID', 'id', 'ID'],
    nameKeys: ['ilceAdi', 'ilceAd', 'ILCE_AD', 'text', 'TEXT', 'adi', 'ADI', 'ad', 'AD', 'name', 'NAME'],
    path: parentId => `/idariYapi/ilceListe/${parentId}`,
    label: 'ilçe'
  },
  neighborhood: {
    idKeys: ['mahalleId', 'MAHALLE_ID', 'mahalleID', 'id', 'ID'],
    nameKeys: ['mahalleAdi', 'mahalleAd', 'MAHALLE_AD', 'text', 'TEXT', 'adi', 'ADI', 'ad', 'AD', 'name', 'NAME'],
    path: parentId => `/idariYapi/mahalleListe/${parentId}`,
    label: 'mahalle'
  }
};

function normalizeAdminItems(payload, level, sourceKey) {
  const config = LEVEL_CONFIG[level];
  if (!config) throw new Error(`Bilinmeyen idari seviye: ${level}`);
  const output = [];
  const seen = new Set();
  for (const row of rowsFromPayload(payload)) {
    const properties = row?.properties || row || {};
    // Önce seviyeye özgü gerçek TKGM kimliği kullanılır. fid/objectid ancak başka
    // hiçbir sayısal kimlik yoksa son çare olarak denenir; aksi halde il seçimi
    // sonrası yanlış üst kimlik nedeniyle ilçe servisi 404 dönebiliyordu.
    const id = numericId([
      ...config.idKeys.map(key => properties?.[key]),
      row?.id,
      properties?.objectid,
      properties?.OBJECTID,
      properties?.fid,
      properties?.FID
    ]);
    const nameValue = firstDefined(properties, config.nameKeys);
    const name = String(nameValue ?? '').trim();
    if (!id || !name) continue;
    const dedupeKey = `${id}|${name}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    output.push({ id, name, source: sourceKey });
  }
  return output.sort((a, b) => a.name.localeCompare(b.name, 'tr'));
}

class TKGMClient {
  constructor({ sources = sourcesFromEnvironment(), fetchImpl = global.fetch, userAgent = 'Kadastro360-Web-Pilot/1.5.2' } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('Fetch desteği bulunamadı.');
    this.sources = sources.map(source => ({ ...source, baseUrl: String(source.baseUrl).replace(/\/+$/, '') }));
    this.fetchImpl = fetchImpl;
    this.userAgent = userAgent;
    this.cache = new Map();
  }

  sourceOrder(preferredKey = '') {
    const preferred = this.sources.find(source => source.key === preferredKey);
    return preferred ? [preferred, ...this.sources.filter(source => source.key !== preferred.key)] : [...this.sources];
  }

  headers() {
    return {
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'tr-TR,tr;q=0.9',
      Origin: 'https://parselsorgu.tkgm.gov.tr',
      Referer: 'https://parselsorgu.tkgm.gov.tr/',
      'User-Agent': this.userAgent,
      'X-Requested-With': 'XMLHttpRequest'
    };
  }

  urlVariants(source, apiPath) {
    const standard = `${source.baseUrl}${apiPath}`;
    const variants = [standard];
    if (source.doubleSlashAdmin && apiPath.startsWith('/idariYapi/')) {
      variants.push(`${source.baseUrl}/${apiPath}`);
    }
    if (apiPath.startsWith('/parsel/')) variants.push(`${standard}/`);
    return [...new Set(variants)];
  }

  async fetchJson(url, timeoutMs = 10_000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        signal: controller.signal,
        headers: this.headers(),
        redirect: 'follow'
      });
      const text = await response.text();
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        error.statusCode = response.status;
        error.upstreamUrl = url;
        throw error;
      }
      try {
        return JSON.parse(text);
      } catch {
        const error = new Error('TKGM geçersiz JSON yanıtı döndürdü.');
        error.upstreamUrl = url;
        throw error;
      }
    } catch (error) {
      if (error?.name === 'AbortError') {
        const timeout = new Error('TKGM isteği zaman aşımına uğradı.');
        timeout.upstreamUrl = url;
        throw timeout;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async fromSource(source, apiPath, timeoutMs = 10_000) {
    const errors = [];
    for (const url of this.urlVariants(source, apiPath)) {
      try {
        return { data: await this.fetchJson(url, timeoutMs), source };
      } catch (error) {
        errors.push(error);
      }
    }
    const result = new Error(errors.map(error => `${error.message} (${error.upstreamUrl || source.label})`).join(' · ') || `${source.label} yanıt vermedi.`);
    result.errors = errors;
    const statuses = errors.map(error => Number(error.statusCode)).filter(Number.isFinite);
    if (statuses.length && statuses.every(status => status === 404)) result.statusCode = 404;
    throw result;
  }

  async getAdminList(level, parentId = '', preferredSource = '') {
    const config = LEVEL_CONFIG[level];
    if (!config) throw new Error(`Bilinmeyen idari seviye: ${level}`);
    const cleanParent = level === 'province' ? '' : numericId([parentId]);
    if (level !== 'province' && !cleanParent) {
      const error = new Error(`${config.label} listesi için geçerli üst kayıt kimliği bulunamadı.`);
      error.httpStatus = 400;
      throw error;
    }
    const apiPath = typeof config.path === 'function' ? config.path(cleanParent) : config.path;
    const cacheKey = `${level}:${cleanParent}:${preferredSource || 'auto'}`;
    const saved = this.cache.get(cacheKey);
    if (saved && saved.expiresAt > Date.now()) return saved.value;

    const errors = [];
    for (const source of this.sourceOrder(preferredSource)) {
      try {
        const response = await this.fromSource(source, apiPath);
        const items = normalizeAdminItems(response.data, level, source.key);
        if (!items.length) throw new Error(`${source.label} ${config.label} listesini boş veya tanınmayan biçimde döndürdü.`);
        const value = { items, source: source.key, sourceLabel: source.label };
        this.cache.set(cacheKey, { expiresAt: Date.now() + 6 * 60 * 60 * 1000, value });
        return value;
      } catch (error) {
        errors.push({ source, error });
      }
    }

    const statusCodes = errors.flatMap(row => row.error?.errors || [row.error]).map(error => Number(error?.statusCode)).filter(Number.isFinite);
    const all404 = statusCodes.length > 0 && statusCodes.every(status => status === 404);
    const result = new Error(
      all404
        ? `TKGM ${config.label} servisi seçilen kayıt için 404 döndürdü. Kimlik eşleştirmesi yedek kaynaklarla da doğrulanamadı.`
        : `TKGM ${config.label} listesi alınamadı. ${errors.map(row => `${row.source.label}: ${row.error.message}`).join(' | ')}`
    );
    result.statusCode = all404 ? 404 : 502;
    throw result;
  }

  async getParcel({ neighborhoodId, block, parcel, preferredSource = '' }) {
    const cleanNeighborhood = numericId([neighborhoodId]);
    if (!cleanNeighborhood) {
      const error = new Error('Geçerli mahalle kimliği bulunamadı.');
      error.httpStatus = 400;
      throw error;
    }
    const cleanBlock = encodeURIComponent(String(block || '').trim());
    const cleanParcel = encodeURIComponent(String(parcel || '').trim());
    if (!cleanBlock || !cleanParcel) {
      const error = new Error('Ada ve parsel numarası gereklidir.');
      error.httpStatus = 400;
      throw error;
    }
    const apiPath = `/parsel/${cleanNeighborhood}/${cleanBlock}/${cleanParcel}`;
    const errors = [];
    for (const source of this.sourceOrder(preferredSource)) {
      try {
        const response = await this.fromSource(source, apiPath, 12_000);
        return { payload: response.data, source: source.key, sourceLabel: source.label };
      } catch (error) {
        errors.push({ source, error });
      }
    }
    const statuses = errors.flatMap(row => row.error?.errors || [row.error]).map(error => Number(error?.statusCode)).filter(Number.isFinite);
    const all404 = statuses.length > 0 && statuses.every(status => status === 404);
    const result = new Error(all404
      ? 'TKGM, seçilen mahallede bu ada/parsel kaydını bulamadı. Mahalle, ada ve parsel bilgilerini kontrol edin.'
      : `TKGM parsel servisine ulaşılamadı. ${errors.map(row => `${row.source.label}: ${row.error.message}`).join(' | ')}`);
    result.statusCode = all404 ? 404 : 502;
    throw result;
  }
}

module.exports = {
  DEFAULT_SOURCES,
  sourcesFromEnvironment,
  rowsFromPayload,
  normalizeAdminItems,
  TKGMClient
};
