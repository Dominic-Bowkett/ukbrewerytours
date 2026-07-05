// Consumes the viator-verify workflow output + scripts/viator-clean.json and writes
// content/viator/<city>.json (viator_experiences). Keeps only verified products.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const VERIFY_OUT = process.argv[2];
const clean = JSON.parse(fs.readFileSync(path.join(__dirname, 'viator-clean.json'), 'utf8'));
const vres = JSON.parse(fs.readFileSync(VERIFY_OUT, 'utf8')).result;
const verifiedByCode = new Map();
for (const c of vres.results) if (c.verified) verifiedByCode.set(c.code, c.found_url || null);

// canonical city normalisation → our guide cities
const GUIDE_CITIES = ['London','Manchester','Edinburgh','Glasgow','Liverpool','Bristol','Leeds','York','Birmingham','Cardiff','Newcastle','Nottingham','Sheffield','Kent'];
function canonCity(raw) {
  const s = (raw || '').trim();
  const near = s.match(/near\s+([A-Za-z]+)/i);
  if (near) { const hit = GUIDE_CITIES.find(c => c.toLowerCase() === near[1].toLowerCase()); if (hit) return hit; }
  for (const c of GUIDE_CITIES) if (new RegExp('\\b' + c + '\\b', 'i').test(s)) return c;
  return s;
}
const citySlug = c => c.toLowerCase().replace(/[^a-z0-9]+/g, '-');
const viatorSlug = u => {
  const parts = u.split('?')[0].replace(/\/$/, '').split('/');
  const code = (parts.pop() || '').toLowerCase();
  const name = (parts.pop() || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  return (name ? name + '-' : '') + (code.split('-').pop() || code);
};

function summary(type, city, title) {
  const t = title.replace(/^[^:]+:\s*/, ''); // drop "City:" prefix if present
  switch (type) {
    case 'beer-brewery': return `Discover ${city}'s craft beer scene on this brewery and beer-tasting experience, ${t.charAt(0).toLowerCase() + t.slice(1)}. Booked through our partner Viator — check live dates, the full itinerary and prices on their site.`;
    case 'food': return `A guided food-and-drink experience in ${city}, taking in local flavours, independent spots and hidden gems. Booked through our partner Viator — see the full itinerary, live availability and prices on their site.`;
    case 'distillery-spirits': return `A gin, whisky and spirits experience in ${city} with distillery visits and expert-led tastings. Booked through our partner Viator — see full details, live availability and prices on their site.`;
    default: return `A drinks-focused tasting experience in ${city}. Booked through our partner Viator — see the full details, live availability and prices on their site.`;
  }
}

// Cross-partner duplicates of existing GetYourGuide/DesignMyNight listings — drop (same venue/operator).
const DROP_CODES = new Set([
  'd739-44081p3',    // Pickering's Gin — already on DesignMyNight
  'd740-50572p6',    // Tennent's Brewery (admission) — already on GetYourGuide
  'd740-50572p1',    // Tennent's Brewery (masterclass) — already on GetYourGuide
  'd940-387205p1',   // Liverpool Brewery Bus Tour — already on GetYourGuide
  'd26342-62324p4',  // Leeds Indian Food Tour — already on GetYourGuide
  'd4293-5597939p4', // Bristol Wine & Cider — already on GetYourGuide
  'd22776-339867p1', // Birmingham Slogging Gangs walking tour — already on GetYourGuide
  'd22776-339867p2', // Birmingham Gangs evening pub tour — already on GetYourGuide
]);

const byCity = {};
const imageKeys = new Set();
let kept = 0, dropped = 0, dedup = 0;
for (const p of clean) {
  if (!verifiedByCode.has(p.code)) { dropped++; continue; }
  if (DROP_CODES.has(p.code)) { dedup++; continue; }
  const url = (verifiedByCode.get(p.code) || p.url).split('?')[0].replace(/viator\.com\/[a-z]{2}-[A-Z]{2}\/tours\//, 'viator.com/tours/');
  const city = canonCity(p.city);
  const image = `${citySlug(city)}-${p.type}`;
  imageKeys.add(image);
  const exp = {
    title: p.title.replace(/^[A-Za-z ]+:\s*/, m => m).trim(),
    url, city, type: p.type, image,
    slug: viatorSlug(url),
    summary: summary(p.type, city, p.title),
    ...(p.duration ? { duration: p.duration } : {}),
  };
  (byCity[city] = byCity[city] || []).push(exp);
  kept++;
}

const outDir = path.join(ROOT, 'content', 'viator');
fs.mkdirSync(outDir, { recursive: true });
// clear old
for (const f of fs.existsSync(outDir) ? fs.readdirSync(outDir) : []) if (f.endsWith('.json')) fs.unlinkSync(path.join(outDir, f));
for (const [city, exps] of Object.entries(byCity)) {
  fs.writeFileSync(path.join(outDir, citySlug(city) + '.json'), JSON.stringify({ name: city, viator_experiences: exps }, null, 2) + '\n', 'utf8');
}

console.log(`verified kept: ${kept} | dropped unverified: ${dropped} | dropped as GYG/DMN duplicates: ${dedup}`);
console.log('cities:', Object.entries(byCity).map(([c, e]) => `${c}(${e.length})`).join(', '));
console.log('\nimage keys to generate (' + imageKeys.size + '):');
console.log([...imageKeys].sort().join('\n'));
fs.writeFileSync(path.join(__dirname, 'viator-image-keys.json'), JSON.stringify([...imageKeys].sort(), null, 2));
