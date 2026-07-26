'use strict';

const assert = require('assert');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const Module = require('module');
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'pngjs') return { PNG: { sync: { read(){ throw new Error('PNG stub'); }, write(){ return Buffer.alloc(0); } } } };
  return originalLoad.call(this, request, parent, isMain);
};

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}
function close(server) { return new Promise(resolve => server.close(resolve)); }

(async () => {
  let phase = 'cache-success';
  let failedMarketRequests = 0;
  let failedSchoolRequests = 0;
  const mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const query = new URLSearchParams(body).get('data') || '';
      const isSchool = /school|kindergarten|college|university/.test(query);
      const isMarket = /supermarket|convenience|grocery|greengrocer/.test(query);
      const isHospital = /amenity"="hospital|healthcare"="hospital|building"="hospital/.test(query);

      if (phase === 'cache-fail' && isSchool) {
        failedSchoolRequests++;
        res.writeHead(503, { 'Content-Type':'text/plain' });
        return res.end('temporary school failure');
      }
      if (phase === 'mixed' && isMarket) {
        failedMarketRequests++;
        res.writeHead(503, { 'Content-Type':'text/plain' });
        return res.end('temporary market failure');
      }

      const elements = [];
      if (isSchool) elements.push({
        type:'node', id:101, lat:40.201, lon:27.201,
        tags:{amenity:'school',name:'Korunan Canlı Okul'}
      });
      if (phase === 'mixed' && isHospital) {
        elements.push({
          type:'node', id:201, lat:40.301, lon:27.301,
          tags:{amenity:'doctors',healthcare:'doctor',name:'Dr. Örnek Özel Kliniği'}
        });
        elements.push({
          type:'node', id:202, lat:40.302, lon:27.302,
          tags:{amenity:'hospital',name:'Gönen Devlet Hastanesi'}
        });
      }
      const payload = JSON.stringify({ version:0.6, elements });
      res.writeHead(200, { 'Content-Type':'application/json', 'Content-Length':Buffer.byteLength(payload) });
      res.end(payload);
    });
  });

  const port = await listen(mock);
  process.env.OVERPASS_BASE_URLS = `http://127.0.0.1:${port}/api/interpreter`;
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'k360-poi-resilience-'));
  process.env.TEST_USERNAME = 'admin';
  process.env.TEST_PASSWORD = 'poi-resilience-password';
  process.env.SESSION_SECRET = 'poi-resilience-session-secret-at-least-32-chars';
  const { getPoi } = require('./server');

  try {
    const initial = await getPoi(40.2, 27.2, '10000', 'school', null);
    assert(initial.items.some(item => item.type === 'school'), 'İlk başarılı canlı okul sonucu alınamadı.');

    phase = 'cache-fail';
    const preserved = await getPoi(40.2, 27.2, '30000', 'school', null);
    assert(failedSchoolRequests >= 1, '30 km okul servis hatası tetiklenmedi.');
    assert(preserved.items.some(item => item.name === 'Korunan Canlı Okul'), 'Önceki başarılı canlı sonuç korunmadı.');
    assert(preserved.cachedFallbackCategories.includes('school'), 'Korunan kategori açıkça işaretlenmedi.');
    assert.strictEqual(preserved.coverage.school.status, 'cached', 'Korunan sonuç yeni 30 km sonucu gibi gösterildi.');

    phase = 'mixed';
    const mixed = await getPoi(40.3, 27.3, '30000', 'all', null);
    assert(failedMarketRequests >= 1, 'Market servis hatası tetiklenmedi.');
    assert(mixed.failedCategories.includes('market'), 'Yalnızca başarısız market kategorisi işaretlenmedi.');
    assert(mixed.items.some(item => item.type === 'school'), 'Market hatası çalışan okul sonucunu düşürdü.');
    const hospitals = mixed.items.filter(item => item.type === 'hospital');
    assert(hospitals.some(item => item.name.includes('Devlet Hastanesi')), 'Gerçek hastane sonucu bulunamadı.');
    assert(!hospitals.some(item => /klinik|doktor|dr\.?/i.test(item.name)), 'Özel doktor kliniği hastane olarak sınıflandırıldı.');
    assert(mixed.partial, 'Tek kategori hatasında sonuç kısmi olarak işaretlenmedi.');
  } finally {
    await close(mock);
  }
  console.log('Kadastro360 30 km kategori yalıtımı, son başarılı sonuç koruma ve hastane sınıflandırma testi geçti.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
