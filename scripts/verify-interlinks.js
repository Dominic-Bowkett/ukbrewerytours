// Post-interlinking verification. Reads content/blog/*.md, extracts internal links,
// checks the plan landed, flags self/broken links, and updates seo/link-map.json counts.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const plan = JSON.parse(fs.readFileSync(path.join(ROOT, 'seo', 'interlink-plan.json'), 'utf8'));
const blogDir = path.join(ROOT, 'content', 'blog');
const posts = fs.readdirSync(blogDir).filter(f => f.endsWith('.md')).map(f => f.replace('.md', ''));

// valid internal targets
const validTargets = new Set([
  ...posts.map(s => `/blog/${s}/`),
  ...fs.readdirSync(path.join(ROOT, 'content', 'gyg')).map(f => `/tours/${f.replace('.json','')}/`),
  ...JSON.parse(fs.readFileSync(path.join(ROOT, 'content', 'tours.json'), 'utf8')).filter(t => t.active).map(t => `/tours/${t.old_slug}/`),
]);

// extract internal links per post from body (skip frontmatter)
function bodyLinks(slug) {
  const s = fs.readFileSync(path.join(blogDir, slug + '.md'), 'utf8');
  const body = s.slice(s.indexOf('---', 3) + 3);
  const links = [...body.matchAll(/\]\((\/[^)#]*)\)/g)].map(m => m[1]);
  return links;
}

const linkGraph = {};       // src -> Set(targets)
for (const slug of posts) linkGraph[slug] = new Set(bodyLinks(slug));

// 1) plan coverage
const missing = [], selfLinks = [], broken = [];
for (const [src, edges] of Object.entries(plan)) {
  for (const e of edges) if (!linkGraph[src].has(e.to)) missing.push(`${src} -> ${e.to}`);
}
// 2) self + broken across ALL posts
for (const slug of posts) {
  for (const t of linkGraph[slug]) {
    if (t === `/blog/${slug}/`) selfLinks.push(`${slug} -> self`);
    if (t.startsWith('/blog/') && !validTargets.has(t)) broken.push(`${slug} -> ${t}`);
    if (t.startsWith('/tours/') && !validTargets.has(t) && !/\/tours\/$/.test(t) && !/experiences/.test(t)) broken.push(`${slug} -> ${t} (?)`);
  }
}

// 3) inbound counts to the 10 new posts
const NEW = ['state-of-uk-craft-beer-2026','cask-ale-comeback-2026','why-stout-is-booming-2026','craft-lager-rise-uk','new-ipa-lower-abv-more-bitter','why-brewery-tours-booming-2026','indie-beer-week-2026-guide','drink-local-independent-breweries','alcohol-free-craft-beer-uk','best-uk-beer-cities-2026'];
const inbound = {};
for (const slug of posts) for (const t of linkGraph[slug]) { const m = t.match(/^\/blog\/(.+)\/$/); if (m) inbound[m[1]] = (inbound[m[1]] || 0) + 1; }

console.log('=== PLAN COVERAGE ===');
console.log(missing.length ? 'MISSING edges (' + missing.length + '):\n  ' + missing.join('\n  ') : 'all planned edges present');
console.log('\n=== INTEGRITY ===');
console.log('self-links:', selfLinks.length ? selfLinks.join(', ') : 'none');
console.log('broken internal targets:', broken.length ? broken.join(', ') : 'none');
console.log('\n=== INBOUND to 10 new posts ===');
for (const s of NEW) console.log(`  ${(inbound[s]||0) >= 3 ? 'ok ' : 'LOW'} ${String(inbound[s]||0).padStart(2)}  ${s}`);

// 4) update link-map counts
const map = JSON.parse(fs.readFileSync(path.join(ROOT, 'seo', 'link-map.json'), 'utf8'));
const outCount = {}; for (const slug of posts) outCount[`/blog/${slug}/`] = linkGraph[slug].size;
const inCountAll = {};
for (const slug of posts) for (const t of linkGraph[slug]) inCountAll[t] = (inCountAll[t] || 0) + 1;
for (const p of map.pages) {
  if (outCount[p.url] != null) p.outbound_internal = outCount[p.url];
  if (inCountAll[p.url] != null) p.inbound_internal = inCountAll[p.url];
}
if (!process.argv.includes('--no-write')) {
  fs.writeFileSync(path.join(ROOT, 'seo', 'link-map.json'), JSON.stringify(map, null, 2) + '\n', 'utf8');
  console.log('\nupdated seo/link-map.json inbound/outbound counts');
}
const fail = missing.length || selfLinks.length || broken.length;
process.exit(fail ? 1 : 0);
