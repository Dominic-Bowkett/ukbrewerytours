// Merge the enrichment workflow's journal results into content/gyg/*.json:
// adds slug, image_url (source GYG CDN), description_md, highlights, meeting_point.
// Usage: node scripts/merge-gyg-enrich.js <journal.jsonl path>
const fs = require('fs');
const path = require('path');

const journalPath = process.argv[2];
const gygSlug = u => u.replace(/\/$/, '').split('/').pop().replace(/-t\d+$/, '');

const byUrl = {};
if (journalPath && fs.existsSync(journalPath)) {
  for (const line of fs.readFileSync(journalPath, 'utf8').trim().split('\n')) {
    try {
      const o = JSON.parse(line);
      if (o.type === 'result' && o.result && o.result.url) byUrl[o.result.url] = o.result;
    } catch {}
  }
}

const dir = path.join(__dirname, '..', 'content', 'gyg');
const noImage = [];
let merged = 0, total = 0;
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
  const p = path.join(dir, f);
  const g = JSON.parse(fs.readFileSync(p, 'utf8'));
  for (const t of (g.gyg_tours || [])) {
    total++;
    t.slug = t.slug || gygSlug(t.url);
    const e = byUrl[t.url];
    if (e) {
      merged++;
      if (e.image_url) t.image_url = e.image_url;
      if (e.description_md) t.description_md = e.description_md;
      if (Array.isArray(e.highlights) && e.highlights.length) t.highlights = e.highlights;
      if (e.meeting_point) t.meeting_point = e.meeting_point;
    }
    if (!t.image_url) noImage.push(`${g.name}/${t.slug}`);
  }
  fs.writeFileSync(p, JSON.stringify(g, null, 2) + '\n');
}
console.log(`Merged ${merged}/${total} tours.`);
console.log(`Tours needing a generated image (${noImage.length}):`);
noImage.forEach(s => console.log('  ' + s));
