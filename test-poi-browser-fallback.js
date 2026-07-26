const assert = require('assert');
const { buildBrowserPoiPlan, normalizeBrowserPoiElements } = require('./server');

const plan = buildBrowserPoiPlan(39.64, 34.47, 10000, ['school','market','mosque']);
assert(plan.endpoints[0].includes('maps.mail.ru'), 'Çalışan VK Maps örneği ilk sırada olmalı.');
assert(plan.queries.length >= 1, 'Tarayıcı sorgu planı üretilmeli.');
assert(plan.queries[0].query.includes('amenity'), 'Overpass sorgusu etiketleri içermeli.');

const normalized = normalizeBrowserPoiElements({
  lat: 39.64,
  lng: 34.47,
  radius: 10000,
  category: 'all',
  geometry: null,
  adminContext: { province: 'Yozgat', district: 'Yerköy' },
  successfulCategories: ['school','market','mosque'],
  elements: [
    { type:'node', id:1, lat:39.641, lon:34.471, tags:{ amenity:'school', name:'Canlı Test Okulu', 'addr:district':'Yerköy' } },
    { type:'node', id:2, lat:39.642, lon:34.472, tags:{ shop:'supermarket', name:'Canlı Test Marketi', 'addr:district':'Yerköy' } },
    { type:'node', id:3, lat:39.643, lon:34.473, tags:{ amenity:'place_of_worship', religion:'muslim', name:'Canlı Test Camii', 'addr:district':'Yerköy' } }
  ]
});
assert.strictEqual(normalized.items.length, 3, 'Tarayıcıdan gelen gerçek OSM kayıtları sınıflandırılmalı.');
assert.strictEqual(normalized.coverage.school.status, 'found');
assert.strictEqual(normalized.coverage.market.status, 'found');
assert.strictEqual(normalized.coverage.mosque.status, 'found');
assert.strictEqual(normalized.coverage.bank.status, 'failed');
assert.strictEqual(normalized.browserFallback, true);
console.log('[GEÇTİ] Tarayıcı Overpass yedek akışı ve gerçek OSM normalizasyonu testi.');
