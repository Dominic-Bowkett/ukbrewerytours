// Builds seo/link-map.json (the internal-linking source of truth) for ukbrewerytours.com.
// Ahrefs is unavailable on this plan, so primary keywords are assigned by search intent
// (title/slug) per the system's documented fallback — no invented Ahrefs metrics.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

// --- Blog posts: primary keyword + cluster + one-line topic (intent-based) ---
const BLOG = {
  // 2026 craft-beer-trends news cluster (the 10 new posts)
  'state-of-uk-craft-beer-2026':      { kw: 'state of uk craft beer', cluster: 'beer-trends-2026', topic: 'SIBA data: closures vs cask growth; the health of UK craft beer in 2026', anchors: ['state of UK craft beer in 2026', 'UK craft beer in 2026'] },
  'cask-ale-comeback-2026':           { kw: 'cask ale comeback', cluster: 'beer-trends-2026', topic: 'why cask/real ale is growing again', anchors: ['cask ale comeback', 'the return of cask ale'] },
  'why-stout-is-booming-2026':        { kw: 'stout beer trend', cluster: 'beer-trends-2026', topic: 'stout is the breakout beer of 2026', anchors: ['why stout is booming', 'the stout boom'] },
  'craft-lager-rise-uk':              { kw: 'craft lager uk', cluster: 'beer-trends-2026', topic: 'the rise of UK craft lager', anchors: ['craft lager', 'the rise of craft lager'] },
  'new-ipa-lower-abv-more-bitter':    { kw: 'ipa trends', cluster: 'beer-trends-2026', topic: 'how IPA is changing: lower ABV, more bitterness', anchors: ['the new IPA', 'how IPA is changing'] },
  'why-brewery-tours-booming-2026':   { kw: 'brewery tours popularity', cluster: 'beer-trends-2026', topic: 'why brewery tours and beer experiences are booming', anchors: ['brewery tours are booming', 'why brewery tours are booming'] },
  'indie-beer-week-2026-guide':       { kw: 'indie beer week 2026', cluster: 'beer-trends-2026', topic: 'guide to Indie Beer Week + the Indie Beer campaign', anchors: ['Indie Beer Week 2026', 'Indie Beer Week'] },
  'drink-local-independent-breweries':{ kw: 'independent breweries uk', cluster: 'beer-trends-2026', topic: 'the case for supporting independent/local breweries', anchors: ['supporting independent breweries', 'why drinking local matters'] },
  'alcohol-free-craft-beer-uk':       { kw: 'alcohol-free craft beer', cluster: 'beer-trends-2026', topic: 'the no/low alcohol beer boom', anchors: ['alcohol-free craft beer', 'low and no beer'] },
  'best-uk-beer-cities-2026':         { kw: 'best uk beer cities', cluster: 'beer-trends-2026', topic: '10 UK cities every beer lover should visit', anchors: ['best UK beer cities', 'UK cities for beer lovers'] },
  // Evergreen education
  'difference-between-beer-and-lager':{ kw: 'difference between beer and lager', cluster: 'beer-education', topic: 'beer vs lager explained', anchors: ['difference between beer and lager', 'beer vs lager'] },
  'calories-in-pint-of-guinness':     { kw: 'calories in a pint of guinness', cluster: 'beer-education', topic: 'how many calories in a pint of Guinness', anchors: ['calories in a pint of Guinness', 'Guinness calories'] },
  'baby-guinness':                    { kw: 'baby guinness', cluster: 'beer-education', topic: 'the Baby Guinness shot recipe', anchors: ['Baby Guinness', 'the Baby Guinness shot'] },
  'beer-gardens-london':              { kw: 'beer gardens london', cluster: 'city-london', topic: "London's best beer gardens", anchors: ['London beer gardens', "London's best beer gardens"] },
  // City brewery-tour posts
  'brighton-brewery-tours':           { kw: 'brighton brewery tours', cluster: 'city-brighton', topic: 'Brighton brewery tours gift voucher / scene', anchors: ['Brighton brewery tours', 'brewery tours in Brighton'] },
  'camden-town-brewery-tours':        { kw: 'camden brewery tours', cluster: 'city-london', topic: 'Camden Town brewery tours', anchors: ['Camden Town brewery tours', 'Camden brewery tours'] },
  // NB: /tours/glasgow/ (city guide) owns "glasgow brewery tours"; this informational post takes a distinct variant to avoid cannibalisation
  'glasgow-brewery-tours':            { kw: 'glasgow craft beer scene', cluster: 'city-glasgow', topic: 'Glasgow brewery tours guide / craft beer scene', anchors: ["Glasgow's craft beer scene", 'brewery tours in Glasgow'] },
  'leeds-brewery-tour':               { kw: 'leeds brewery tour', cluster: 'city-leeds', topic: 'Leeds brewery tour guide', anchors: ['Leeds brewery tour', 'brewery tours in Leeds'] },
  'brewery-tour-kent':                { kw: 'brewery tour kent', cluster: 'city-kent', topic: 'Kent brewery tour guide', anchors: ['Kent brewery tour', 'brewery tours in Kent'] },
  'brewery-tours-near-me':            { kw: 'brewery tours near me', cluster: 'pillar', topic: 'nationwide brewery tours near you (pillar)', anchors: ['brewery tours near you', 'brewery tours near me'] },
  'hawkstone-brewery-tours':          { kw: 'hawkstone brewery', cluster: 'brewery-profile', topic: 'Hawkstone brewery tours', anchors: ['Hawkstone brewery', 'Hawkstone brewery tours'] },
  'anspach-and-hobday-brewery':       { kw: 'anspach and hobday', cluster: 'brewery-profile', topic: 'Anspach & Hobday (Bermondsey brewery)', anchors: ['Anspach & Hobday', 'Anspach and Hobday'] },
  'bianca-road-brewery':              { kw: 'bianca road brewery', cluster: 'brewery-profile', topic: 'Bianca Road (Bermondsey brewery)', anchors: ['Bianca Road Brewery', 'Bianca Road'] },
};

const map = { site: 'ukbrewerytours.com', updated: 'FALLBACK-INTENT (Ahrefs plan insufficient)', pages: [] };

// hubs
map.pages.push({ url: '/tours/', primary_keyword: 'uk brewery tours', cluster: 'pillar', role: 'hub' });
map.pages.push({ url: '/blog/', primary_keyword: 'brewery tours blog', cluster: 'blog', role: 'hub' });

// blog posts
for (const [slug, m] of Object.entries(BLOG)) {
  map.pages.push({
    url: `/blog/${slug}/`, primary_keyword: m.kw, cluster: m.cluster,
    role: m.cluster === 'pillar' ? 'hub' : 'spoke', topic: m.topic,
    preferred_anchors: m.anchors, inbound_internal: 0, outbound_internal: 0,
    banned_anchors: ['click here', 'read more', 'this page', 'here'],
  });
}

// city guides (hubs) — from content/gyg/*.json
const gygDir = path.join(ROOT, 'content', 'gyg');
for (const f of fs.readdirSync(gygDir).filter(f => f.endsWith('.json'))) {
  const slug = f.replace('.json', '');
  const g = JSON.parse(fs.readFileSync(path.join(gygDir, f), 'utf8'));
  const city = g.name || slug;
  map.pages.push({ url: `/tours/${slug}/`, primary_keyword: `${city.toLowerCase()} brewery tours`, cluster: `city-${slug}`, role: 'hub' });
}

// own tours (spokes). Keyword overrides where a tour name would clash with a city-guide hub.
const TOUR_KW_OVERRIDE = { 'lewes-brewery-tours': 'lewes craft beer tour & tasting' };
const tours = JSON.parse(fs.readFileSync(path.join(ROOT, 'content', 'tours.json'), 'utf8')).filter(t => t.active);
for (const t of tours) {
  map.pages.push({ url: `/tours/${t.old_slug}/`, primary_keyword: TOUR_KW_OVERRIDE[t.old_slug] || t.name.toLowerCase(), cluster: `city-${t.city.toLowerCase().replace(/\s+/g, '-')}`, role: 'spoke' });
}

// cannibalisation guard
const byKw = {};
for (const p of map.pages) (byKw[p.primary_keyword] ||= []).push(p.url);
const conflicts = Object.entries(byKw).filter(([, urls]) => urls.length > 1);

fs.mkdirSync(path.join(ROOT, 'seo'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'seo', 'link-map.json'), JSON.stringify(map, null, 2) + '\n', 'utf8');
console.log(`link-map: ${map.pages.length} pages (${Object.keys(BLOG).length} blog, 17 guides, ${tours.length} tours, 2 hubs)`);
console.log('CANNIBALISATION conflicts:', conflicts.length ? '' : 'none');
for (const [kw, urls] of conflicts) console.log(`  "${kw}" → ${urls.join(' , ')}`);
