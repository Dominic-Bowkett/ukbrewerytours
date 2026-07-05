// Reads the expand-thin-tours workflow output and writes the verified
// description_md back into content/tours.json (matched by old_slug).
const fs = require('fs');
const path = require('path');

const OUT = process.argv[2];
const TOURS = path.join(__dirname, '..', 'content', 'tours.json');
const DRY = process.argv.includes('--dry');

const parsed = JSON.parse(fs.readFileSync(OUT, 'utf8'));
const posts = (parsed.result && parsed.result.full) || [];
const tours = JSON.parse(fs.readFileSync(TOURS, 'utf8'));

const wc = s => (s || '').split(/\s+/).filter(Boolean).length;
let applied = 0, problems = [];

for (const p of posts) {
  const t = tours.find(x => x.old_slug === p.slug);
  if (!t) { problems.push(`NO MATCH: ${p.slug}`); continue; }
  const md = (p.description_md || '').trim();
  const words = wc(md);
  const hasLede = !/^#/.test(md);                       // starts with a paragraph, not a heading
  const hasWhat = /(^|\n)#\s+What you'll do/i.test(md);
  const hasGtk  = /(^|\n)#\s+Good to know/i.test(md);
  const flags = [];
  if (words < 300 || words > 480) flags.push(`words=${words}`);
  if (!hasLede) flags.push('no-lede');
  if (!hasWhat) flags.push('no-#Whatyoulldo');
  if (!hasGtk)  flags.push('no-#Goodtoknow');
  const status = flags.length ? 'CHECK(' + flags.join(',') + ')' : 'ok';
  console.log(`${status.padEnd(22)} ${p.slug.padEnd(36)} ${words}w`);
  if (flags.length) problems.push(`${p.slug}: ${flags.join(',')}`);
  if (!DRY) { t.description_md = md; applied++; }
}

if (!DRY) {
  fs.writeFileSync(TOURS, JSON.stringify(tours, null, 2) + '\n', 'utf8');
  console.log(`\napplied ${applied}/${posts.length} → content/tours.json`);
} else {
  console.log('\n--- DRY RUN ---');
}
if (problems.length) console.log('FLAGS:\n' + problems.join('\n'));
