'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
assert(html.includes('function routeStripeOptions(index,total)'), 'Çok renkli ortak rota şerit fonksiyonu eksik.');
assert(html.includes('dashOffset:stripeStyle.dashOffset'), 'Rota renklerinin dönüşümlü çizimi eksik.');
assert(html.includes('function layoutRouteDestinationLabels()'), 'Varış etiketi çakışma düzeni eksik.');
assert(html.includes('function routeLabelRows(items)') && html.includes('element.offsetWidth') && html.includes('horizontalGap=14'), 'Etiketlerin gerçek genişliğine göre yan yana/alt alta yerleşimi eksik.');
assert(html.includes('routeLabelEntries'), 'Varış etiketi yerleşim takibi eksik.');
assert(html.includes('routePointAtFraction'), 'Mesafe etiketlerini farklı noktalara dağıtma eksik.');
assert(html.includes('Gönen ilçe merkezi önceliği') === false, 'Arayüze test bölgesine özel sabit metin yazılmamalı.');
console.log('Kadastro360 çok renkli rota ve etiket çakışma statik testi geçti.');
