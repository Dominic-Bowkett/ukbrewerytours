// Compare Viator products against existing GYG + DMN experiences (same city) to find
// likely duplicates that differ in wording. Uses distinctive-token (operator/venue) overlap.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const read = p => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

// existing partner experiences (GYG from gyg/*.json, DMN from dmn/*.json)
const existing = [];
for (const f of fs.readdirSync(path.join(ROOT, 'content', 'gyg'))) {
  const g = read('content/gyg/' + f);
  for (const t of (g.gyg_tours || [])) existing.push({ src: 'gyg', title: t.title, city: g.name });
}
for (const f of fs.readdirSync(path.join(ROOT, 'content', 'dmn'))) {
  const d = read('content/dmn/' + f);
  for (const t of (d.dmn_experiences || [])) existing.push({ src: 'dmn', title: t.title, city: t.city || d.name });
}

// stopwords: generic tour vocabulary + ALL city names (city is always shared, so useless as a signal)
const CITIES = 'london manchester edinburgh glasgow liverpool bristol leeds york birmingham cardiff newcastle nottingham sheffield kent salford'.split(' ');
const STOP = new Set([
  ...'the a an and or of in on at to for with tour tours tasting tastings taste experience experiences beer beers brewery breweries craft small large group groups private public walking walk guided guide food foods drink drinks gin whisky whiskey distillery distilleries city centre center half day days hour hours evening night nighttime historic historical history pub pubs bar bars session sessions admission tickets ticket more your best around self led local locally sourced hidden gems highlights lunch flight flights class stops stop bike music'.split(/\s+/),
  ...CITIES,
]);
const toks = s => (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !STOP.has(w));

const viator = [];
for (const f of fs.readdirSync(path.join(ROOT, 'content', 'viator'))) {
  const v = read('content/viator/' + f);
  for (const t of (v.viator_experiences || [])) viator.push({ title: t.title, city: t.city, slug: t.slug });
}

const dupes = [];
for (const v of viator) {
  const vt = new Set(toks(v.title));
  if (!vt.size) continue;
  for (const e of existing) {
    if (e.city !== v.city) continue;
    const et = new Set(toks(e.title));
    const shared = [...vt].filter(w => et.has(w));
    // after removing city + generic vocab, ANY shared token is distinctive (operator/venue/cuisine)
    if (shared.length >= 1) {
      dupes.push({ city: v.city, viator: v.title, existing: `[${e.src}] ${e.title}`, shared: shared.join(','), slug: v.slug });
    }
  }
}
console.log('Viator products:', viator.length, '| existing GYG/DMN:', existing.length);
console.log('LIKELY cross-partner duplicates (' + dupes.length + '):');
for (const d of dupes) console.log(`  ${d.city}: "${d.viator}"  ~=  ${d.existing}   [shared: ${d.shared}]`);
fs.writeFileSync(path.join(__dirname, 'viator-dupe-slugs.json'), JSON.stringify([...new Set(dupes.map(d => d.slug))], null, 2));
