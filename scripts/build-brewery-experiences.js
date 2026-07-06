// Turn the 126 direct-booking breweries into on-site "direct" experiences.
// Each is assigned a guide city where it clearly belongs, otherwise a region label,
// so it appears in the tours filter / city guides. Writes content/brewery-experiences.json.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const GUIDES = ['London','Manchester','Edinburgh','Glasgow','Liverpool','Bristol','Leeds','York','Birmingham','Cardiff','Newcastle','Nottingham','Sheffield','Kent','Lewes','Burnley','Blandford Forum'];
// area / county / suburb  ->  guide city  (word-boundary matched on the location string)
const AREA = {
  'greater manchester':'Manchester','salford':'Manchester','stockport':'Manchester','macclesfield':'Manchester',
  'city of edinburgh':'Edinburgh','midlothian':'Edinburgh','loanhead':'Edinburgh','leith':'Edinburgh','abbeyhill':'Edinburgh',
  'city of glasgow':'Glasgow','paisley':'Glasgow',
  'merseyside':'Liverpool','baltic triangle':'Liverpool',
  'tyne and wear':'Newcastle','tyne & wear':'Newcastle','gateshead':'Newcastle',
  'shipley':'Leeds','holbeck':'Leeds','ilkley':'Leeds',
  'city of bristol':'Bristol',
};
// region label used when a brewery is not near any guide city
const REGION_LABEL = {
  'Scotland':'Scotland',
  'North West England':'North West England',
  'Yorkshire & North East England':'Yorkshire & the North East',
  'Midlands':'The Midlands',
  'Wales':'Wales',
  'East of England':'East of England',
  'London':'London',
  'South East England':'South East England',
  'South West England':'South West England',
};
const wordRe = w => new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');

function assign(loc, region) {
  const s = loc || '';
  for (const g of GUIDES) { if (wordRe('\\(' + g + '\\)').test(s) || wordRe('near ' + g).test(s)) return { city: g, onGuide: true }; }
  for (const g of GUIDES) { if (wordRe(g).test(s)) return { city: g, onGuide: true }; }
  for (const [k, v] of Object.entries(AREA)) if (wordRe(k).test(s)) return { city: v, onGuide: true };
  return { city: REGION_LABEL[region] || region, onGuide: false };
}
const slugify = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const regionSlug = r => slugify(r.replace(/&.*/, '').trim()); // matches assets/img/breweries/<slug>.jpg

const bd = JSON.parse(fs.readFileSync(path.join(ROOT, 'content', 'breweries.json'), 'utf8'));
const REGION_IMG = { // region -> hero image slug already on disk
  'Scotland':'scotland','North West England':'north-west-england','Yorkshire & North East England':'yorkshire-north-east-england',
  'Midlands':'midlands','Wales':'wales','East of England':'east-of-england','London':'london',
  'South East England':'south-east-england','South West England':'south-west-england',
};
const out = [];
const seen = new Set();
let i = 0;
for (const r of bd.regions) for (const b of r.breweries) {
  const a = assign(b.location, r.region);
  let slug = slugify(b.brewery);
  while (seen.has(slug)) slug += '-x';
  seen.add(slug);
  out.push({
    slug, brewery: b.brewery, title: b.brewery, tour_name: b.tour_name, url: b.url,
    city: a.city, on_guide: a.onGuide, region: r.region, location: b.location,
    price_gbp: (b.price_gbp && /^\d/.test(String(b.price_gbp))) ? String(b.price_gbp).replace(/^£/, '') : null,
    notes: b.notes, image: 'brew-' + (i++ % 8 + 1),   // rotate 8 generic brewery photos for variety
  });
}
void REGION_IMG;
fs.writeFileSync(path.join(ROOT, 'content', 'brewery-experiences.json'), JSON.stringify(out, null, 2) + '\n');
const guideCities = {};
for (const e of out.filter(e => e.on_guide)) (guideCities[e.city] = guideCities[e.city] || []).push(e.brewery);
console.log(`wrote ${out.length} brewery experiences`);
console.log(`on a city guide: ${out.filter(e => e.on_guide).length} | by region only: ${out.filter(e => !e.on_guide).length}`);
console.log('\nGuide-city assignments (review for accuracy):');
for (const [c, l] of Object.entries(guideCities).sort((a,b)=>b[1].length-a[1].length)) console.log(`  ${c}: ${l.join(', ')}`);
