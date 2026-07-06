// Remove Viator experiences flagged "discontinued" by the availability workflow.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const OUT = process.argv[2];
const DRY = process.argv.includes('--dry');
const parsed = JSON.parse(fs.readFileSync(OUT, 'utf8'));
const items = (parsed.result && parsed.result.items) || [];
const dead = new Set(items.filter(i => i.status === 'discontinued').map(i => i.slug));

console.log('flagged discontinued:', dead.size);
for (const i of items.filter(i => i.status === 'discontinued')) console.log('  ✗', i.slug, '—', i.evidence);
console.log('\nuncertain (kept, review manually):');
for (const i of items.filter(i => i.status === 'uncertain')) console.log('  ?', i.slug, '—', i.evidence);

if (!dead.size) { console.log('\nnothing to remove.'); process.exit(0); }

const dir = path.join(ROOT, 'content', 'viator');
let removed = 0;
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
  const p = path.join(dir, f);
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  const before = d.viator_experiences.length;
  d.viator_experiences = d.viator_experiences.filter(e => !dead.has(e.slug));
  const gone = before - d.viator_experiences.length;
  if (gone && !DRY) {
    if (d.viator_experiences.length) fs.writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
    else fs.unlinkSync(p); // no experiences left in this city
  }
  removed += gone;
}
console.log(`\n${DRY ? '[DRY] would remove' : 'removed'} ${removed} discontinued Viator experiences`);
