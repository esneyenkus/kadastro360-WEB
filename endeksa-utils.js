(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EndeksaUtils = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CATEGORY_LABELS = {
    arsa: 'Konut İmarlı Arsa',
    arazi: 'Arazi / Tarla / Bağ / Bahçe',
    konut: 'Konut',
    ticari: 'Dükkan / Mağaza / Ticari'
  };

  function normalizeTurkish(value) {
    return String(value || '')
      .toLocaleLowerCase('tr-TR')
      .replace(/ı/g, 'i')
      .replace(/ş/g, 's')
      .replace(/ğ/g, 'g')
      .replace(/ü/g, 'u')
      .replace(/ö/g, 'o')
      .replace(/ç/g, 'c')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[’']/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function stripAdministrativeSuffix(value, level) {
    let text = normalizeTurkish(value);
    const patterns = {
      il: /\s+ili$/,
      ilce: /\s+ilcesi$/,
      mahalle: /\s+(mahallesi|mah|koyu|koy|beldesi|belde)$/
    };
    const pattern = patterns[level];
    if (pattern) text = text.replace(pattern, '').trim();
    return text;
  }

  function slugify(value, level) {
    return stripAdministrativeSuffix(value, level)
      .replace(/\s+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  function countMatches(text, words) {
    return words.reduce((score, word) => score + (text.includes(word) ? 1 : 0), 0);
  }

  function classifyProperty(nitelik) {
    const normalized = normalizeTurkish(nitelik);

    const residential = [
      'mesken', 'daire', 'apartman', 'rezidans', 'villa', 'mustakil ev',
      'kargir ev', 'kagir ev', 'ev ve arsasi', 'bina', 'dubleks', 'tripleks'
    ];
    const commercial = [
      'dukkan', 'magaza', 'isyeri', 'is yeri', 'ofis', 'buro', 'ticarethane',
      'lokanta', 'restoran', 'showroom', 'atolye', 'fabrika', 'depo'
    ];
    const land = [
      'tarla', 'arazi', 'bag', 'bahce', 'zeytinlik', 'findiklik', 'meyvelik',
      'cayir', 'mera', 'otlak', 'fundalik', 'orman', 'tarim', 'agaclik',
      'kavaklik', 'bostan', 'hali arazi', 'ham toprak', 'bag yeri'
    ];
    const plot = [
      'arsa', 'imarli', 'konut alani', 'ticaret alani', 'sanayi alani',
      'depolama alani', 'parsel'
    ];

    const residentialScore = countMatches(normalized, residential);
    const commercialScore = countMatches(normalized, commercial);
    const landScore = countMatches(normalized, land);
    const plotScore = countMatches(normalized, plot);

    let category = 'arsa';
    let reason = 'Tapu niteliği arsa sınıfıyla eşleştirildi.';
    let fallback = false;

    if (commercialScore > 0) {
      category = 'ticari';
      reason = 'Tapu niteliğinde dükkan/mağaza/işyeri veya ticari yapı ifadesi bulundu.';
    } else if (residentialScore > 0 || normalized === 'konut') {
      category = 'konut';
      reason = 'Tapu niteliğinde konut/yapı ifadesi bulundu.';
    } else if (landScore > plotScore && landScore > 0) {
      category = 'arazi';
      reason = 'Tapu niteliğinde tarla/arazi/bağ/bahçe ifadesi bulundu.';
    } else if (plotScore > 0) {
      category = 'arsa';
      reason = 'Tapu niteliğinde arsa veya imar ifadesi bulundu.';
    } else if (landScore > 0) {
      category = 'arazi';
      reason = 'Tapu niteliği arazi sınıfıyla eşleştirildi.';
    } else {
      category = 'arsa';
      fallback = true;
      reason = normalized
        ? 'Nitelik Endeksa sınıflarıyla kesin eşleşmediği için arsa ekranı seçildi.'
        : 'Tapu niteliği gelmediği için arsa ekranı seçildi.';
    }

    return {
      category,
      label: CATEGORY_LABELS[category],
      reason,
      fallback,
      normalized
    };
  }

  function buildEndeksaLinks({ il, ilce, mahalle, nitelik }) {
    const ilSlug = slugify(il, 'il');
    const ilceSlug = slugify(ilce, 'ilce');
    const mahalleSlug = slugify(mahalle, 'mahalle');
    if (!ilSlug) throw new Error('Endeksa bağlantısı için il adı eksik.');

    const classification = classifyProperty(nitelik);
    const tail = `/endeks/satilik/${classification.category}`;
    const base = 'https://www.endeksa.com/tr/analiz/turkiye';
    const province = `${base}/${ilSlug}${tail}`;
    const district = ilceSlug ? `${base}/${ilSlug}/${ilceSlug}${tail}` : province;
    const neighborhood = mahalleSlug && ilceSlug
      ? `${base}/${ilSlug}/${ilceSlug}/${mahalleSlug}${tail}`
      : district;

    return {
      ...classification,
      slugs: { il: ilSlug, ilce: ilceSlug, mahalle: mahalleSlug },
      province,
      district,
      neighborhood
    };
  }

  return {
    CATEGORY_LABELS,
    normalizeTurkish,
    stripAdministrativeSuffix,
    slugify,
    classifyProperty,
    buildEndeksaLinks
  };
});
