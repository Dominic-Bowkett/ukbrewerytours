// Removes DesignMyNight experiences flagged "remove" (past / unbookable) by the
// date-check agents. Reads dmn-result-{0,1,2}.json from the scratchpad.
const fs = require('fs');
const path = require('path');
const scratch = process.argv[2];

const remove = new Set();
for (let i = 0; i < 3; i++) {
  const f = path.join(scratch, `dmn-result-${i}.json`);
  if (!fs.existsSync(f)) { console.error('MISSING', f); process.exit(1); }
  for (const r of JSON.parse(fs.readFileSync(f, 'utf8'))) {
    if (r.decision === 'remove') remove.add(r.slug);
  }
}
console.log('Flagged for removal:', remove.size);

const dir = path.join(__dirname, '..', 'content', 'dmn');
let removed = 0, kept = 0;
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
  const p = path.join(dir, f);
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  const before = (j.dmn_experiences || []).length;
  j.dmn_experiences = (j.dmn_experiences || []).filter(e => {
    if (remove.has(e.slug)) { removed++; return false; }
    kept++; return true;
  });
  fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
  if ((j.dmn_experiences.length) !== before) console.log(`  ${f}: ${before} -> ${j.dmn_experiences.length}`);
}
console.log(`Removed ${removed} past DMN experiences; ${kept} remain.`);
