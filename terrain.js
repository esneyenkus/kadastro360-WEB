'use strict';

const zlib = require('zlib');

const TERRAIN_TILE_URL = 'https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png';
const TERRAIN_ZOOM = 12; // Türkiye enlemlerinde yaklaşık 30 m/piksel; kaynak çoğunlukla SRTM 30 m.
const TILE_TTL_MS = 60 * 60 * 1000;
const MAX_TILE_CACHE = 160;
const tileCache = new Map();

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function toRad(value) { return value * Math.PI / 180; }
function toDeg(value) { return value * 180 / Math.PI; }

function haversine(lat1, lon1, lat2, lon2) {
  const radius = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * radius * Math.asin(Math.sqrt(a));
}

function localXY(lat, lng, origin) {
  const metersPerLat = 111132.92;
  const metersPerLng = 111412.84 * Math.cos(toRad(origin.lat));
  return {
    x: (lng - origin.lng) * metersPerLng,
    y: (lat - origin.lat) * metersPerLat
  };
}

function fromLocalXY(x, y, origin) {
  const metersPerLat = 111132.92;
  const metersPerLng = 111412.84 * Math.cos(toRad(origin.lat));
  return {
    latitude: origin.lat + y / metersPerLat,
    longitude: origin.lng + x / metersPerLng
  };
}

function geometryRings(geometry) {
  if (!geometry || typeof geometry !== 'object') return [];
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates || [];
  return [];
}

function validRing(ring) {
  return (ring || [])
    .map(pair => [Number(pair?.[0]), Number(pair?.[1])])
    .filter(pair => pair.every(Number.isFinite));
}

function pointInRing(lat, lng, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersects = ((yi > lat) !== (yj > lat))
      && (lng < (xj - xi) * (lat - yi) / ((yj - yi) || Number.EPSILON) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointInPolygon(lat, lng, polygon) {
  const outer = validRing(polygon?.[0]);
  if (outer.length < 3 || !pointInRing(lat, lng, outer)) return false;
  for (let i = 1; i < (polygon || []).length; i++) {
    const hole = validRing(polygon[i]);
    if (hole.length >= 3 && pointInRing(lat, lng, hole)) return false;
  }
  return true;
}

function pointInGeometry(lat, lng, geometry) {
  return geometryRings(geometry).some(polygon => pointInPolygon(lat, lng, polygon));
}

function ringAreaMeters(ring, origin) {
  const points = validRing(ring).map(([lng, lat]) => localXY(lat, lng, origin));
  let area = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    area += points[j].x * points[i].y - points[i].x * points[j].y;
  }
  return Math.abs(area) / 2;
}

function geometryAreaMeters(geometry, origin) {
  let total = 0;
  for (const polygon of geometryRings(geometry)) {
    total += ringAreaMeters(polygon?.[0], origin);
    for (let i = 1; i < (polygon || []).length; i++) total -= ringAreaMeters(polygon[i], origin);
  }
  return Math.max(0, total);
}

function geometryBounds(geometry) {
  const pairs = geometryRings(geometry).flatMap(polygon => validRing(polygon?.[0]));
  if (!pairs.length) return null;
  return pairs.reduce((out, [lng, lat]) => ({
    minLat: Math.min(out.minLat, lat), maxLat: Math.max(out.maxLat, lat),
    minLng: Math.min(out.minLng, lng), maxLng: Math.max(out.maxLng, lng)
  }), { minLat: Infinity, maxLat: -Infinity, minLng: Infinity, maxLng: -Infinity });
}

function geometryCenter(geometry, suppliedCenter) {
  if (Number.isFinite(Number(suppliedCenter?.lat)) && Number.isFinite(Number(suppliedCenter?.lng))) {
    return { lat: Number(suppliedCenter.lat), lng: Number(suppliedCenter.lng) };
  }
  const bounds = geometryBounds(geometry);
  if (!bounds) throw new Error('Eğim analizi için parsel geometrisi bulunamadı.');
  return { lat: (bounds.minLat + bounds.maxLat) / 2, lng: (bounds.minLng + bounds.maxLng) / 2 };
}

function dedupePoints(points, precision = 7) {
  const seen = new Set();
  return points.filter(point => {
    const lat = Number(point.latitude), lng = Number(point.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
    const key = `${lat.toFixed(precision)}:${lng.toFixed(precision)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sampleBoundary(geometry, maxPoints = 24) {
  const all = geometryRings(geometry).flatMap(polygon => validRing(polygon?.[0]));
  if (!all.length) return [];
  const count = Math.min(maxPoints, all.length);
  const result = [];
  for (let i = 0; i < count; i++) {
    const index = Math.floor(i * all.length / count);
    result.push({ latitude: all[index][1], longitude: all[index][0], role: 'boundary' });
  }
  return result;
}

function generateTerrainSamples(geometry, suppliedCenter, maxPoints = 96) {
  const center = geometryCenter(geometry, suppliedCenter);
  const bounds = geometryBounds(geometry);
  if (!bounds) return { center, points: [{ latitude: center.lat, longitude: center.lng, role: 'center' }], metrics: {} };

  const sw = localXY(bounds.minLat, bounds.minLng, center);
  const ne = localXY(bounds.maxLat, bounds.maxLng, center);
  const width = Math.max(1, ne.x - sw.x);
  const height = Math.max(1, ne.y - sw.y);
  const area = geometryAreaMeters(geometry, center);
  const maxDimension = Math.max(width, height);
  const minDimension = Math.min(width, height);

  // Kaynağın doğal çözünürlüğü yaklaşık 30 m'dir. Izgarayı parsel boyutuna göre
  // 4x4 ile 9x9 arasında tutup gereksiz sahte hassasiyet üretmiyoruz.
  const targetAcross = clamp(Math.round(maxDimension / 30) + 2, 4, 9);
  let nx = targetAcross;
  let ny = clamp(Math.round(targetAcross * height / width), 4, 9);
  if (width < height) {
    ny = targetAcross;
    nx = clamp(Math.round(targetAcross * width / height), 4, 9);
  }

  const points = [];
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const x = sw.x + (ix + 0.5) * width / nx;
      const y = sw.y + (iy + 0.5) * height / ny;
      const point = fromLocalXY(x, y, center);
      if (pointInGeometry(point.latitude, point.longitude, geometry)) {
        points.push({ ...point, role: 'grid', gridX: ix, gridY: iy });
      }
    }
  }

  if (pointInGeometry(center.lat, center.lng, geometry)) {
    points.push({ latitude: center.lat, longitude: center.lng, role: 'center' });
  }
  points.push(...sampleBoundary(geometry, Math.min(24, Math.max(8, Math.round(maxDimension / 20)))));

  let unique = dedupePoints(points);
  if (unique.length > maxPoints) {
    const step = unique.length / maxPoints;
    unique = Array.from({ length: maxPoints }, (_, index) => unique[Math.floor(index * step)]);
  }

  return {
    center,
    points: unique,
    metrics: { area, width, height, maxDimension, minDimension, nx, ny }
  };
}

function parsePng(buffer) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!Buffer.isBuffer(buffer) || buffer.length < 24 || !buffer.subarray(0, 8).equals(signature)) {
    throw new Error('Yükseklik döşemesi geçerli PNG değil.');
  }
  let offset = 8;
  let width, height, bitDepth, colorType, interlace;
  const idat = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset); offset += 4;
    const type = buffer.toString('ascii', offset, offset + 4); offset += 4;
    const data = buffer.subarray(offset, offset + length); offset += length + 4; // CRC atla
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }
  if (!width || !height || bitDepth !== 8 || interlace !== 0 || ![2, 6].includes(colorType)) {
    throw new Error('Yükseklik PNG biçimi desteklenmiyor.');
  }
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(height * stride);
  let input = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[input++];
    const row = raw.subarray(input, input + stride); input += stride;
    const outOffset = y * stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[outOffset + x - channels] : 0;
      const up = y > 0 ? pixels[outOffset - stride + x] : 0;
      const upLeft = y > 0 && x >= channels ? pixels[outOffset - stride + x - channels] : 0;
      let value;
      if (filter === 0) value = row[x];
      else if (filter === 1) value = (row[x] + left) & 255;
      else if (filter === 2) value = (row[x] + up) & 255;
      else if (filter === 3) value = (row[x] + Math.floor((left + up) / 2)) & 255;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft);
        const predictor = pa <= pb && pa <= pc ? left : (pb <= pc ? up : upLeft);
        value = (row[x] + predictor) & 255;
      } else throw new Error('PNG filtre türü desteklenmiyor.');
      pixels[outOffset + x] = value;
    }
  }
  return { width, height, channels, pixels };
}

function tilePoint(lat, lng, zoom = TERRAIN_ZOOM) {
  const n = 2 ** zoom;
  const xFloat = (lng + 180) / 360 * n;
  const latRad = toRad(clamp(lat, -85.05112878, 85.05112878));
  const yFloat = (1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2 * n;
  const tileX = Math.floor(xFloat), tileY = Math.floor(yFloat);
  return {
    zoom, tileX, tileY,
    pixelX: clamp(Math.floor((xFloat - tileX) * 256), 0, 255),
    pixelY: clamp(Math.floor((yFloat - tileY) * 256), 0, 255)
  };
}

async function fetchBuffer(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Parsel-Egim-Rehber/1.6' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { buffer: Buffer.from(await response.arrayBuffer()), headers: response.headers };
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('30 m yükseklik servisi zaman aşımına uğradı.');
    throw error;
  } finally { clearTimeout(timer); }
}

function trimTileCache() {
  if (tileCache.size <= MAX_TILE_CACHE) return;
  const sorted = [...tileCache.entries()].sort((a, b) => a[1].savedAt - b[1].savedAt);
  for (const [key] of sorted.slice(0, tileCache.size - MAX_TILE_CACHE)) tileCache.delete(key);
}

async function getTerrainTile(zoom, x, y) {
  const key = `${zoom}/${x}/${y}`;
  const saved = tileCache.get(key);
  if (saved && Date.now() - saved.savedAt < TILE_TTL_MS) return saved.value;
  const promise = (async () => {
    const url = TERRAIN_TILE_URL.replace('{z}', zoom).replace('{x}', x).replace('{y}', y);
    const { buffer, headers } = await fetchBuffer(url, 11000);
    return {
      ...parsePng(buffer),
      imagerySources: headers.get('x-imagery-sources') || null,
      url
    };
  })();
  tileCache.set(key, { savedAt: Date.now(), value: promise });
  trimTileCache();
  try { return await promise; }
  catch (error) { tileCache.delete(key); throw error; }
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
  await Promise.all(Array.from({ length: Math.min(limit, Math.max(1, values.length)) }, worker));
  return results;
}

async function terrariumElevations(points) {
  const tileGroups = new Map();
  points.forEach((point, index) => {
    const tile = tilePoint(point.latitude, point.longitude);
    const key = `${tile.zoom}/${tile.tileX}/${tile.tileY}`;
    if (!tileGroups.has(key)) tileGroups.set(key, { ...tile, indexes: [] });
    tileGroups.get(key).indexes.push({ index, pixelX: tile.pixelX, pixelY: tile.pixelY });
  });
  const groups = [...tileGroups.values()];
  const decoded = await mapLimit(groups, 5, async group => ({ group, tile: await getTerrainTile(group.zoom, group.tileX, group.tileY) }));
  const output = new Array(points.length);
  const imagerySources = new Set();
  for (const { group, tile } of decoded) {
    if (tile.imagerySources) tile.imagerySources.split(',').map(x => x.trim()).filter(Boolean).forEach(x => imagerySources.add(x));
    for (const item of group.indexes) {
      const offset = (item.pixelY * tile.width + item.pixelX) * tile.channels;
      const r = tile.pixels[offset], g = tile.pixels[offset + 1], b = tile.pixels[offset + 2];
      const elevation = r * 256 + g + b / 256 - 32768;
      output[item.index] = { ...points[item.index], elevation };
    }
  }
  return { results: output, imagerySources: [...imagerySources] };
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const low = Math.floor(index), high = Math.ceil(index);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}

function fitPlane(points, center) {
  const rows = points.map(point => ({ ...localXY(point.latitude, point.longitude, center), z: point.elevation }));
  const meanX = rows.reduce((s, p) => s + p.x, 0) / rows.length;
  const meanY = rows.reduce((s, p) => s + p.y, 0) / rows.length;
  const meanZ = rows.reduce((s, p) => s + p.z, 0) / rows.length;
  let sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0;
  for (const point of rows) {
    const x = point.x - meanX, y = point.y - meanY, z = point.z - meanZ;
    sxx += x * x; syy += y * y; sxy += x * y; sxz += x * z; syz += y * z;
  }
  const determinant = sxx * syy - sxy * sxy;
  if (Math.abs(determinant) < 1e-9) return { eastGradient: 0, northGradient: 0, slopePercent: 0, residualRmse: 0 };
  const eastGradient = (sxz * syy - syz * sxy) / determinant;
  const northGradient = (syz * sxx - sxz * sxy) / determinant;
  const residuals = rows.map(point => {
    const estimated = meanZ + eastGradient * (point.x - meanX) + northGradient * (point.y - meanY);
    return point.z - estimated;
  });
  const residualRmse = Math.sqrt(residuals.reduce((sum, value) => sum + value * value, 0) / residuals.length);
  return { eastGradient, northGradient, slopePercent: Math.hypot(eastGradient, northGradient) * 100, residualRmse };
}

function aspectInfo(eastGradient, northGradient) {
  if (Math.hypot(eastGradient, northGradient) < 0.001) return { degrees: null, label: 'Belirgin yön yok' };
  let uphill = toDeg(Math.atan2(eastGradient, northGradient));
  if (uphill < 0) uphill += 360;
  const downhill = (uphill + 180) % 360;
  const names = ['Kuzey', 'Kuzeydoğu', 'Doğu', 'Güneydoğu', 'Güney', 'Güneybatı', 'Batı', 'Kuzeybatı'];
  return { degrees: downhill, label: names[Math.round(downhill / 45) % 8] };
}

function localSlopeStats(points, center, nativeResolution) {
  const rows = points.map((point, index) => ({ index, ...point, ...localXY(point.latitude, point.longitude, center) }));
  const slopes = [];
  const maxDistance = Math.max(nativeResolution * 2.4, 75);
  for (const point of rows) {
    const neighbors = rows
      .filter(other => other.index !== point.index)
      .map(other => ({ other, distance: Math.hypot(other.x - point.x, other.y - point.y) }))
      .filter(item => item.distance >= 5 && item.distance <= maxDistance)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 5);
    for (const { other, distance } of neighbors) {
      if (other.index < point.index) continue;
      slopes.push(Math.abs(other.elevation - point.elevation) / distance * 100);
    }
  }
  return {
    values: slopes,
    median: percentile(slopes, 0.5),
    p75: percentile(slopes, 0.75),
    p90: percentile(slopes, 0.9),
    max: slopes.length ? Math.max(...slopes) : 0
  };
}

function slopeClass(value) {
  if (value < 3) return 'Düz / çok hafif';
  if (value < 8) return 'Hafif eğimli';
  if (value < 15) return 'Orta eğimli';
  if (value < 30) return 'Dik';
  return 'Çok dik';
}

function confidenceFor(metrics, sampleCount, sourceResolution, residualRmse) {
  let score = 0;
  if (metrics.minDimension >= sourceResolution * 3) score += 2;
  else if (metrics.minDimension >= sourceResolution * 1.5) score += 1;
  if (metrics.maxDimension >= sourceResolution * 4) score += 2;
  else if (metrics.maxDimension >= sourceResolution * 2) score += 1;
  if (sampleCount >= 25) score += 2;
  else if (sampleCount >= 12) score += 1;
  if (residualRmse <= 2.5) score += 1;
  else if (residualRmse > 6) score -= 1;
  if (score >= 6) return { level: 'Yüksek', code: 'high' };
  if (score >= 3) return { level: 'Orta', code: 'medium' };
  return { level: 'Düşük', code: 'low' };
}

function analyzeElevationPoints(points, center, metrics, source) {
  const valid = points.filter(point => Number.isFinite(Number(point.elevation))).map(point => ({ ...point, elevation: Number(point.elevation) }));
  if (valid.length < 4) throw new Error('Eğim için yeterli yükseklik noktası alınamadı.');
  const values = valid.map(point => point.elevation);
  const minimum = Math.min(...values), maximum = Math.max(...values);
  const plane = fitPlane(valid, center);
  const local = localSlopeStats(valid, center, source.resolutionMeters);
  const averageSlope = local.values.length ? local.median : plane.slopePercent;
  const representativeSlope = Math.max(plane.slopePercent, local.p75 * 0.75);
  const steepSlope = local.values.length ? local.p90 : plane.slopePercent;
  const aspect = aspectInfo(plane.eastGradient, plane.northGradient);
  const confidence = confidenceFor(metrics, valid.length, source.resolutionMeters, plane.residualRmse);
  const warnings = [];
  if (metrics.minDimension < source.resolutionMeters * 1.5) warnings.push('Parselin kısa kenarı veri çözünürlüğüne yakın; küçük kot farkları kesin kabul edilmemelidir.');
  if (valid.length < 12) warnings.push('Parsel içinde sınırlı sayıda örnek noktası oluştu.');
  if (plane.residualRmse > 5) warnings.push('Arazi yüzeyi düzensiz; tek bir genel eğim değeri tüm parseli temsil etmeyebilir.');
  warnings.push('Sonuç ön değerlendirmedir; aplikasyon, kot ve mühendislik ölçümü yerine geçmez.');
  return {
    source: source.name,
    sourceDetail: source.detail,
    resolutionMeters: source.resolutionMeters,
    sampleCount: valid.length,
    parcel: {
      areaM2: Math.round(metrics.area || 0),
      widthM: Math.round(metrics.width || 0),
      heightM: Math.round(metrics.height || 0),
      minDimensionM: Math.round(metrics.minDimension || 0),
      maxDimensionM: Math.round(metrics.maxDimension || 0)
    },
    elevation: {
      min: minimum,
      max: maximum,
      range: maximum - minimum,
      mean: values.reduce((sum, value) => sum + value, 0) / values.length
    },
    slopes: {
      average: averageSlope,
      general: plane.slopePercent,
      representative: representativeSlope,
      steep: steepSlope,
      maximumObserved: local.max,
      class: slopeClass(representativeSlope)
    },
    aspect,
    roughnessRmse: plane.residualRmse,
    confidence,
    warnings,
    points: valid
  };
}

async function analyzeTerrain({ geometry, center, fallbackElevation }) {
  const sampling = generateTerrainSamples(geometry, center, 96);
  try {
    const terrain = await terrariumElevations(sampling.points);
    const sourceNames = terrain.imagerySources.filter(name => /srtm|eudem|dem|gmted/i.test(name));
    return analyzeElevationPoints(terrain.results, sampling.center, sampling.metrics, {
      name: 'AWS Terrain Tiles / Terrarium',
      detail: sourceNames.length ? sourceNames.slice(0, 4).join(', ') : 'Türkiye’de yüksek yakınlaştırmada çoğunlukla SRTM tabanlı yaklaşık 30 m arazi modeli',
      resolutionMeters: 30
    });
  } catch (primaryError) {
    if (typeof fallbackElevation !== 'function') throw primaryError;
    const fallbackPoints = sampling.points.length > 30
      ? Array.from({ length: 30 }, (_, index) => sampling.points[Math.floor(index * sampling.points.length / 30)])
      : sampling.points;
    const fallback = await fallbackElevation(fallbackPoints);
    const analysis = analyzeElevationPoints(fallback.results, sampling.center, sampling.metrics, {
      name: fallback.source || 'Open-Meteo Elevation',
      detail: `30 m döşeme alınamadı; yaklaşık 90 m yedek kaynak kullanıldı. İlk hata: ${primaryError.message}`,
      resolutionMeters: 90
    });
    analysis.confidence = { level: 'Düşük', code: 'low' };
    analysis.warnings.unshift('30 m kaynak kullanılamadığı için 90 m yedek yükseklik verisine geçildi.');
    return analysis;
  }
}

module.exports = {
  analyzeTerrain,
  analyzeElevationPoints,
  generateTerrainSamples,
  parsePng,
  tilePoint,
  pointInGeometry,
  slopeClass,
  _internals: { fitPlane, localSlopeStats, aspectInfo, terrariumElevations }
};
