// Authors + validates the internal-link plan for the blog cluster, then writes
// seo/interlink-plan.json. Relevance-first, both-directions, anchors varied.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const B = s => `/blog/${s}/`;
const G = s => `/tours/${s}/`;      // city guide
const T = s => `/tours/${s}/`;      // own tour (same path shape)

// Directed edges: source slug -> [{to, anchor}]. Anchors vary; keep them descriptive.
const PLAN = {
  // ---- 2026 news cluster (top up outbound; they already have ~1 link each) ----
  'state-of-uk-craft-beer-2026': [
    { to: B('cask-ale-comeback-2026'), anchor: 'cask ale is in double-digit growth' },
    { to: B('drink-local-independent-breweries'), anchor: 'supporting independent breweries' },
    { to: B('why-brewery-tours-booming-2026'), anchor: 'brewery tours and beer experiences are booming' },
    { to: B('alcohol-free-craft-beer-uk'), anchor: 'the rise of alcohol-free beer' },
  ],
  'cask-ale-comeback-2026': [
    { to: B('state-of-uk-craft-beer-2026'), anchor: 'the wider state of UK craft beer' },
    { to: B('difference-between-beer-and-lager'), anchor: 'what sets ale apart' },
    { to: B('why-stout-is-booming-2026'), anchor: 'stout is booming too' },
    { to: B('drink-local-independent-breweries'), anchor: 'independent brewers' },
  ],
  'why-stout-is-booming-2026': [
    { to: B('calories-in-pint-of-guinness'), anchor: 'calories in a pint of Guinness' },
    { to: B('difference-between-beer-and-lager'), anchor: 'how beer styles differ' },
    { to: B('cask-ale-comeback-2026'), anchor: "cask ale's comeback" },
    { to: B('baby-guinness'), anchor: 'the Baby Guinness' },
  ],
  'craft-lager-rise-uk': [
    { to: B('difference-between-beer-and-lager'), anchor: 'the difference between beer and lager' },
    { to: B('new-ipa-lower-abv-more-bitter'), anchor: 'how IPA is changing' },
    { to: B('state-of-uk-craft-beer-2026'), anchor: 'across UK craft beer' },
    { to: B('alcohol-free-craft-beer-uk'), anchor: 'alcohol-free craft lager' },
  ],
  'new-ipa-lower-abv-more-bitter': [
    { to: B('craft-lager-rise-uk'), anchor: 'the rise of craft lager' },
    { to: B('alcohol-free-craft-beer-uk'), anchor: 'lower-strength and alcohol-free beers' },
    { to: B('why-stout-is-booming-2026'), anchor: 'why stout is booming' },
  ],
  'why-brewery-tours-booming-2026': [
    { to: B('brewery-tours-near-me'), anchor: 'brewery tours near you' },
    { to: B('best-uk-beer-cities-2026'), anchor: "the UK's best beer cities" },
    { to: B('drink-local-independent-breweries'), anchor: 'drinking local' },
    { to: B('indie-beer-week-2026-guide'), anchor: 'Indie Beer Week' },
  ],
  'indie-beer-week-2026-guide': [
    { to: B('drink-local-independent-breweries'), anchor: 'why independent breweries matter' },
    { to: B('state-of-uk-craft-beer-2026'), anchor: 'the state of UK craft beer' },
    { to: B('why-brewery-tours-booming-2026'), anchor: 'brewery tours and tap takeovers' },
  ],
  'drink-local-independent-breweries': [
    { to: B('state-of-uk-craft-beer-2026'), anchor: 'the pressures on UK breweries' },
    { to: B('indie-beer-week-2026-guide'), anchor: 'Indie Beer Week' },
    { to: B('why-stout-is-booming-2026'), anchor: 'independent stout brewers' },
    { to: B('brewery-tours-near-me'), anchor: 'a brewery tour near you' },
  ],
  'alcohol-free-craft-beer-uk': [
    { to: B('new-ipa-lower-abv-more-bitter'), anchor: 'lower-ABV IPAs' },
    { to: B('craft-lager-rise-uk'), anchor: 'craft lager' },
    { to: B('state-of-uk-craft-beer-2026'), anchor: 'one of craft beer’s fastest-growing categories' },
  ],
  'best-uk-beer-cities-2026': [
    { to: B('why-brewery-tours-booming-2026'), anchor: 'why beer experiences are booming' },
    { to: B('brewery-tours-near-me'), anchor: 'find a brewery tour near you' },
    { to: B('drink-local-independent-breweries'), anchor: 'support independent breweries' },
    { to: B('indie-beer-week-2026-guide'), anchor: 'Indie Beer Week' },
  ],

  // ---- evergreen / education (adds inbound to news + fixes some orphans) ----
  'difference-between-beer-and-lager': [
    { to: B('craft-lager-rise-uk'), anchor: 'the rise of craft lager' },
    { to: B('new-ipa-lower-abv-more-bitter'), anchor: 'how IPA is evolving' },
    { to: B('why-stout-is-booming-2026'), anchor: 'the stout revival' },
    { to: B('cask-ale-comeback-2026'), anchor: "cask ale's comeback" },
  ],
  'calories-in-pint-of-guinness': [
    { to: B('why-stout-is-booming-2026'), anchor: 'why stout is booming in 2026' },
    { to: B('baby-guinness'), anchor: 'the Baby Guinness shot' },
    { to: B('difference-between-beer-and-lager'), anchor: 'beer versus lager' },
  ],
  'baby-guinness': [
    { to: B('calories-in-pint-of-guinness'), anchor: 'calories in a pint of Guinness' },
    { to: B('why-stout-is-booming-2026'), anchor: 'the stout boom' },
  ],
  'beer-gardens-london': [
    { to: B('best-uk-beer-cities-2026'), anchor: "the UK's best beer cities" },
    { to: B('camden-town-brewery-tours'), anchor: 'Camden Town brewery tours' },
    { to: G('london'), anchor: 'London brewery tours' },
  ],
  'brewery-tours-near-me': [
    { to: B('why-brewery-tours-booming-2026'), anchor: 'why brewery tours are booming' },
    { to: B('best-uk-beer-cities-2026'), anchor: 'the best UK cities for beer' },
    { to: B('drink-local-independent-breweries'), anchor: 'supporting local, independent breweries' },
  ],
  'brighton-brewery-tours': [
    { to: B('best-uk-beer-cities-2026'), anchor: "Britain's best beer cities" },
    { to: B('why-brewery-tours-booming-2026'), anchor: 'the boom in brewery tours' },
    { to: B('drink-local-independent-breweries'), anchor: 'independent breweries' },
  ],
  'camden-town-brewery-tours': [
    { to: G('london'), anchor: 'London brewery tours' },
    { to: B('best-uk-beer-cities-2026'), anchor: 'the best UK beer cities' },
    { to: B('beer-gardens-london'), anchor: "London's best beer gardens" },
  ],
  'glasgow-brewery-tours': [
    { to: G('glasgow'), anchor: 'Glasgow brewery tours' },
    { to: T('glasgow-beer-tasting'), anchor: 'our Glasgow beer tasting' },
    { to: B('best-uk-beer-cities-2026'), anchor: "the UK's best beer cities" },
  ],
  'leeds-brewery-tour': [
    { to: G('leeds'), anchor: 'Leeds brewery tours' },
    { to: B('best-uk-beer-cities-2026'), anchor: 'the best UK beer cities' },
    { to: B('why-brewery-tours-booming-2026'), anchor: 'why brewery tours are booming' },
  ],
  'brewery-tour-kent': [
    { to: G('kent'), anchor: 'Kent brewery tours' },
    { to: T('kent-hop-farm-tour-at-hukins-hops'), anchor: 'the Kent hop farm tour' },
    { to: B('best-uk-beer-cities-2026'), anchor: "the UK's best beer destinations" },
  ],
  'hawkstone-brewery-tours': [
    { to: B('drink-local-independent-breweries'), anchor: 'supporting independent breweries' },
    { to: B('brewery-tours-near-me'), anchor: 'brewery tours near you' },
    { to: B('why-brewery-tours-booming-2026'), anchor: 'the rise of brewery experiences' },
  ],
  'anspach-and-hobday-brewery': [
    { to: T('bermondsey-beer-tasting-tour'), anchor: 'our Bermondsey beer tasting tour' },
    { to: B('drink-local-independent-breweries'), anchor: 'independent breweries' },
    { to: B('bianca-road-brewery'), anchor: 'nearby Bianca Road Brewery' },
  ],
  'bianca-road-brewery': [
    { to: T('bermondsey-beer-tasting-tour'), anchor: 'the Bermondsey beer mile tour' },
    { to: B('anspach-and-hobday-brewery'), anchor: 'Anspach & Hobday' },
    { to: B('drink-local-independent-breweries'), anchor: 'independent London breweries' },
  ],
};

// ---- validation ----
const posts = fs.readdirSync(path.join(ROOT, 'content', 'blog')).filter(f => f.endsWith('.md')).map(f => f.replace('.md', ''));
const validTargets = new Set([
  ...posts.map(B),
  ...fs.readdirSync(path.join(ROOT, 'content', 'gyg')).map(f => G(f.replace('.json', ''))),
  ...JSON.parse(fs.readFileSync(path.join(ROOT, 'content', 'tours.json'), 'utf8')).filter(t => t.active).map(t => T(t.old_slug)),
]);
const NEW_POSTS = ['state-of-uk-craft-beer-2026','cask-ale-comeback-2026','why-stout-is-booming-2026','craft-lager-rise-uk','new-ipa-lower-abv-more-bitter','why-brewery-tours-booming-2026','indie-beer-week-2026-guide','drink-local-independent-breweries','alcohol-free-craft-beer-uk','best-uk-beer-cities-2026'];

const errors = [], inbound = {};
for (const [src, edges] of Object.entries(PLAN)) {
  if (!posts.includes(src)) errors.push(`unknown source: ${src}`);
  const seen = new Set();
  for (const e of edges) {
    if (!validTargets.has(e.to)) errors.push(`${src} -> INVALID target ${e.to}`);
    if (e.to === B(src)) errors.push(`${src} -> SELF link`);
    if (seen.has(e.to)) errors.push(`${src} -> DUPLICATE ${e.to}`);
    seen.add(e.to);
    inbound[e.to] = (inbound[e.to] || 0) + 1;
  }
}
console.log('sources:', Object.keys(PLAN).length, '| total edges:', Object.values(PLAN).reduce((n, e) => n + e.length, 0));
console.log('\nInbound to the 10 NEW posts (target >=3):');
let under = 0;
for (const s of NEW_POSTS) { const n = inbound[B(s)] || 0; if (n < 3) under++; console.log(`  ${n >= 3 ? 'ok ' : 'LOW'} ${String(n).padStart(2)}  ${s}`); }

if (errors.length) { console.log('\nERRORS:\n' + errors.join('\n')); process.exit(1); }
if (under) { console.log(`\n${under} new posts under 3 inbound`); process.exit(1); }

fs.writeFileSync(path.join(ROOT, 'seo', 'interlink-plan.json'), JSON.stringify(PLAN, null, 2) + '\n', 'utf8');
console.log('\nAll valid. Wrote seo/interlink-plan.json');
