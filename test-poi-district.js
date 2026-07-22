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

function queryCenter(query) {
  const match = query.match(/\((-?\d+\.\d+),(-?\d+\.\d+),(-?\d+\.\d+),(-?\d+\.\d+)\)/);
  if (!match) return { lat:0, lng:0 };
  return {
    lat: (Number(match[1]) + Number(match[3])) / 2,
    lng: (Number(match[2]) + Number(match[4])) / 2
  };
}

(async () => {
  let nominatimRequests = 0;
  let districtQueries = 0;
  const nominatim = http.createServer((req, res) => {
    nominatimRequests++;
    const body = JSON.stringify([{
      lat:'40.5000', lon:'27.5000', type:'administrative', place_rank:12,
      display_name:'Gönen, Balıkesir, Türkiye',
      boundingbox:['40.30','40.70','27.30','27.70'],
      address:{town:'Gönen',state:'Balıkesir',country:'Türkiye'}
    }]);
    res.writeHead(200, {'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)});
    res.end(body);
  });

  const overpass = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const query = new URLSearchParams(body).get('data') || '';
      const center = queryCenter(query);
      const inDistrictCenter = center.lat > 40.3;
      if (inDistrictCenter) districtQueries++;
      const elements = [];

      // Parsel çevresinde daha yakın görünen fakat açıkça Balya adresli banka.
      if (!inDistrictCenter && query.includes('amenity"="bank')) {
        elements.push({
          type:'node', id:100, lat:40.18, lon:27.00,
          tags:{amenity:'bank',name:'Balya Ziraat Bankası','addr:city':'Balya','addr:province':'Balıkesir'}
        });
      }

      // Gönen merkez taramasında gerçek banka ve adıyla doğrulanan bankamatik.
      if (inDistrictCenter && query.includes('amenity"="bank')) {
        elements.push({
          type:'node', id:200, lat:40.501, lon:27.501,
          tags:{amenity:'bank',name:'Gönen İş Bankası','addr:city':'Gönen','addr:province':'Balıkesir'}
        });
      }
      if (inDistrictCenter && query.toLowerCase().includes('bankamatik')) {
        elements.push({
          type:'node', id:201, lat:40.502, lon:27.502,
          tags:{name:'Gönen Ziraat Bankamatik','addr:city':'Gönen','addr:province':'Balıkesir'}
        });
      }

      const payload = JSON.stringify({version:0.6,elements});
      res.writeHead(200, {'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)});
      res.end(payload);
    });
  });

  const nominatimPort = await listen(nominatim);
  const overpassPort = await listen(overpass);
  process.env.NOMINATIM_BASE_URL = `http://127.0.0.1:${nominatimPort}`;
  process.env.OVERPASS_BASE_URLS = `http://127.0.0.1:${overpassPort}/api/interpreter`;
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'k360-poi-district-'));
  process.env.TEST_USERNAME = 'admin';
  process.env.TEST_PASSWORD = 'poi-district-test-password';
  process.env.SESSION_SECRET = 'poi-district-session-secret-at-least-32-chars';

  const { getPoi } = require('./server');
  try {
    const result = await getPoi(40, 27, 'auto', 'all', null, {
      province:'Balıkesir', district:'Gönen', neighborhood:'Ortaoba'
    });
    const banks = result.items.filter(item => item.type === 'bank');
    const atms = result.items.filter(item => item.type === 'atm');
    assert(banks.some(item => item.name.includes('Gönen')), 'Gönen merkez bankası bulunamadı.');
    assert(!banks.some(item => item.name.includes('Balya')), 'Aynı ilçe sonucu varken Balya bankası listede tutuldu.');
    assert(atms.some(item => item.name.includes('Bankamatik')), 'ATM adı fallback taramasından bulunamadı.');
    assert(banks.every(item => item.districtMatch === true), 'Gönen banka sonucu ilçe eşleşmesi olarak işaretlenmedi.');
    assert(atms.every(item => item.districtMatch === true), 'Gönen ATM sonucu ilçe eşleşmesi olarak işaretlenmedi.');
    assert(result.districtFallbackCategories.includes('bank'), 'Uzak banka için ilçe merkezi fallback çalışmadı.');
    assert(result.districtFallbackCategories.includes('atm'), 'Eksik ATM için ilçe merkezi fallback çalışmadı.');
    assert(nominatimRequests >= 1, 'İlçe merkezi çözümlemesi yapılmadı.');
    assert(districtQueries >= 1, 'İlçe merkezi Overpass taraması yapılmadı.');
  } finally {
    await close(overpass);
    await close(nominatim);
  }
  console.log('Kadastro360 ilçe merkezi önceliği ve ATM fallback testi geçti.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
