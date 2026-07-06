// Merge the viator-enrich workflow output into content/viator/*.json:
// real price, duration, rating, reviews, rich description. Emits a slug->image-URL
// map for downloading real Viator photos.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const OUT = process.argv[2];
const parsed = JSON.parse(fs.readFileSync(OUT, 'utf8'));
const items = (parsed.result && parsed.result.items) || [];
const byslug = new Map(items.map(i => [i.slug, i]));

const dir = path.join(ROOT, 'content', 'viator');
const imgMap = {};
let updated = 0, priced = 0, described = 0, imaged = 0;

for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
  const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  for (const e of d.viator_experiences) {
    const it = byslug.get(e.slug);
    if (!it) continue;
    updated++;
    if (it.price_gbp && it.price_gbp > 0) { e.price_gbp = it.price_gbp; priced++; }
    if (it.duration) e.duration = it.duration.trim();
    if (it.rating) e.rating = it.rating.trim();
    if (it.reviews && it.reviews > 0) e.reviews = it.reviews;
    if (it.description_md && it.description_md.split(/\s+/).length >= 20) {
      e.description_md = it.description_md.trim();
      // short meta summary = first ~155 chars of the description
      e.summary = it.description_md.replace(/\s+/g, ' ').trim().slice(0, 155).replace(/\s+\S*$/, '') + '…';
      described++;
    }
    // real product photo -> download to /assets/img/viator/<slug>.jpg and use it
    if (/^https:\/\/media\.tacdn\.com\//.test(it.hero_image || '')) {
      imgMap[e.slug] = it.hero_image.replace(/\/attractions-splice-spp-\d+x\d+\//, '/attractions-splice-spp-674x446/');
      e.image = e.slug;   // expImage will use /assets/img/viator/<slug>.jpg once downloaded
      imaged++;
    }
    // else keep the existing city+type fallback image
  }
  fs.writeFileSync(path.join(dir, f), JSON.stringify(d, null, 2) + '\n', 'utf8');
}

fs.writeFileSync(path.join(__dirname, 'viator-photo-map.json'), JSON.stringify(imgMap, null, 2));
console.log(`updated ${updated} | with price ${priced} | with rich description ${described} | with real photo ${imaged}`);
console.log(`wrote scripts/viator-photo-map.json (${Object.keys(imgMap).length} images to download)`);
