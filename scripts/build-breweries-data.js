// Build content/breweries.json (direct-booking UK breweries, grouped by region) from the
// research workflow journal. These link straight to each brewery's own booking page (no affiliate).
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const journal = process.argv[2];
const results = fs.readFileSync(journal, 'utf8').split(/\r?\n/).filter(Boolean)
  .map(l => { try { return JSON.parse(l); } catch { return null; } })
  .filter(o => o && o.type === 'result' && o.result && Array.isArray(o.result.breweries));

// short region label
function shortRegion(name) {
  const m = name.match(/^([^(]+)/);
  return (m ? m[1] : name).replace(/\s*&\s*$/, '').trim();
}
const ORDER = ['Scotland', 'North West', 'Yorkshire', 'Midlands', 'Wales', 'East of England', 'London', 'South East', 'South West'];
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

const regions = results.map(r => {
  const region = shortRegion(r.result.region);
  return {
    region,
    slug: slug(region),
    breweries: r.result.breweries.map(b => ({
      brewery: b.brewery,
      tour_name: b.tour_name,
      url: b.url,
      location: b.location,
      city: (b.location || '').split(',')[0].trim(),
      price_gbp: b.price_gbp || null,
      notes: b.notes || '',
    })),
  };
}).sort((a, b) => {
  const ai = ORDER.findIndex(o => a.region.startsWith(o));
  const bi = ORDER.findIndex(o => b.region.startsWith(o));
  return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
});

const total = regions.reduce((n, r) => n + r.breweries.length, 0);
fs.writeFileSync(path.join(ROOT, 'content', 'breweries.json'),
  JSON.stringify({ total, regions }, null, 2) + '\n', 'utf8');
console.log(`wrote content/breweries.json: ${total} breweries in ${regions.length} regions`);
console.log(regions.map(r => `${r.region} (${r.breweries.length})`).join(', '));
console.log('region slugs:', regions.map(r => r.slug).join(', '));
