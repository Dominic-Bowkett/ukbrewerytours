// Editorial pass on GYG partner tours: drop anything with a rating below 3.5
// (keeps unrated/new listings, which have no rating yet). Reports removals.
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'content', 'gyg');
let removed = 0;
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
  const p = path.join(dir, f);
  const g = JSON.parse(fs.readFileSync(p, 'utf8'));
  const before = (g.gyg_tours || []).length;
  g.gyg_tours = (g.gyg_tours || []).filter(t => {
    const r = t.rating == null ? null : parseFloat(t.rating);
    if (r != null && r < 3.5) {
      console.log(`  drop ${g.name}: "${t.title}" (rating ${t.rating})`);
      removed++;
      return false;
    }
    return true;
  });
  if ((g.gyg_tours || []).length !== before) {
    fs.writeFileSync(p, JSON.stringify(g, null, 2) + '\n');
  }
}
console.log(`Removed ${removed} low-rated tours.`);
