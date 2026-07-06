// Assign each direct-booking brewery to a guide city where it clearly belongs
// (so it shows on that city guide + the tours filter), else keep its own town.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const GUIDES = ['London','Manchester','Edinburgh','Glasgow','Liverpool','Bristol','Leeds','York','Birmingham','Cardiff','Newcastle','Nottingham','Sheffield','Kent','Lewes','Burnley','Blandford Forum'];

// area/county/suburb -> guide city (checked as lowercase substrings of the full location)
const AREA = {
  'greater manchester':'Manchester','salford':'Manchester','stockport':'Manchester','bury':'Manchester','bolton':'Manchester','oldham':'Manchester','rochdale':'Manchester','ashton-under-lyne':'Manchester',
  'city of edinburgh':'Edinburgh','midlothian':'Edinburgh','loanhead':'Edinburgh','leith':'Edinburgh','musselburgh':'Edinburgh','abbeyhill':'Edinburgh',
  'city of glasgow':'Glasgow','paisley':'Glasgow',
  'merseyside':'Liverpool','birkenhead':'Liverpool','wirral':'Liverpool','baltic triangle':'Liverpool',
  'tyne & wear':'Newcastle','tyne and wear':'Newcastle','gateshead':'Newcastle',"hoult":'Newcastle',
  'west yorkshire':'Leeds','shipley':'Leeds','holbeck':'Leeds',
  'south yorkshire':'Sheffield',
  'nottinghamshire':'Nottingham',
  'city of bristol':'Bristol',
};

function assign(loc) {
  const s = (loc || '').toLowerCase();
  // 1) explicit "(City)" or "near City"
  for (const g of GUIDES) {
    const gl = g.toLowerCase();
    if (new RegExp('\\(' + gl + '\\)').test(s) || new RegExp('near ' + gl).test(s)) return { city: g, onGuide: true };
  }
  // 2) guide-city name appears as a word
  for (const g of GUIDES) {
    if (new RegExp('\\b' + g.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(s)) return { city: g, onGuide: true };
  }
  // 3) area/county/suburb map
  for (const [k, v] of Object.entries(AREA)) if (s.includes(k)) return { city: v, onGuide: true };
  // 4) fallback: primary town, no guide
  return { city: (loc || '').split(',')[0].trim(), onGuide: false };
}

const bd = JSON.parse(fs.readFileSync(path.join(ROOT, 'content', 'breweries.json'), 'utf8'));
const rows = [];
for (const r of bd.regions) for (const b of r.breweries) rows.push({ ...b, region: r.region, ...assign(b.location) });

const onGuide = rows.filter(r => r.onGuide);
const byCity = {};
for (const r of onGuide) (byCity[r.city] = byCity[r.city] || []).push(r.brewery);
console.log(`total ${rows.length} | mapped to a guide city: ${onGuide.length} | own-town only: ${rows.length - onGuide.length}`);
console.log('\nBy guide city:');
for (const [c, list] of Object.entries(byCity).sort((a,b)=>b[1].length-a[1].length)) console.log(`  ${c} (${list.length}): ${list.join(', ')}`);
console.log('\nOwn-town only (not on any guide):', rows.filter(r=>!r.onGuide).map(r=>`${r.brewery} [${r.city}]`).join(' | '));
