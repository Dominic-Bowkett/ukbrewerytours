// Parse the viator-research workflow output, validate URL structure, dedupe by product code.
const fs = require('fs');
const OUT = process.argv[2];
const parsed = JSON.parse(fs.readFileSync(OUT, 'utf8'));
const products = (parsed.result && parsed.result.products) || [];

// A real Viator product URL: optional /en-XX/ locale, /tours/<City>/<Name>/d<digits>-<code>P<digits>
const RE = /^https:\/\/www\.viator\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?tours\/[^/]+\/[^/]+\/d\d+-[A-Za-z0-9]*\d+P\d+$/;
const codeOf = u => (u.split('?')[0].split('/').pop() || '').toLowerCase(); // d737-116890p1

const bad = [], byCode = new Map();
for (const p of products) {
  const u = (p.url || '').split('?')[0].trim();
  if (!RE.test(u)) { bad.push(`${p.city}: ${p.title} -> ${p.url}`); continue; }
  const code = codeOf(u);
  if (!byCode.has(code)) byCode.set(code, { ...p, url: u, code });
}

console.log('raw products:', products.length);
console.log('structurally INVALID (dropped):', bad.length);
bad.forEach(b => console.log('  x', b));
console.log('\nunique valid products (by code):', byCode.size);

// counts by city + type
const byCity = {}, byType = {};
for (const p of byCode.values()) { byCity[p.city] = (byCity[p.city]||0)+1; byType[p.type] = (byType[p.type]||0)+1; }
console.log('\nby city:', JSON.stringify(byCity));
console.log('by type:', JSON.stringify(byType));

// locale normalisation preview + emit clean list
const clean = [...byCode.values()].map(p => ({
  title: p.title.replace(/&amp;/g, '&').trim(),
  url: p.url.replace(/viator\.com\/[a-z]{2}-[A-Z]{2}\/tours\//, 'viator.com/tours/'), // strip locale → canonical
  city: p.city, type: p.type,
  ...(p.duration ? { duration: p.duration } : {}),
  ...(p.rating ? { rating: p.rating } : {}),
  ...(p.reviews ? { reviews: p.reviews } : {}),
  code: p.code,
}));
fs.writeFileSync(__dirname + '/viator-clean.json', JSON.stringify(clean, null, 2));
console.log('\nwrote scripts/viator-clean.json (', clean.length, 'products )');
