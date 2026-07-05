// Parse the workflow output and write each post to content/blog/<slug>.md
const fs = require('fs');
const path = require('path');

const OUT_FILE = process.argv[2];
const BLOG_DIR = path.join(__dirname, '..', 'content', 'blog');
const DRY = process.argv.includes('--dry');

const raw = fs.readFileSync(OUT_FILE, 'utf8');
const parsed = JSON.parse(raw);
const posts = parsed.result && parsed.result.full ? parsed.result.full : [];

console.log('Posts found:', posts.length);
let anyShort = false;
for (const p of posts) {
  const bodyLen = (p.body_md || '').length;
  const words = (p.body_md || '').split(/\s+/).filter(Boolean).length;
  const short = words < 900;
  if (short) anyShort = true;
  console.log(`${short ? 'SHORT!' : 'ok    '} ${p.slug.padEnd(34)} ${String(words).padStart(5)}w ${String(bodyLen).padStart(6)}ch  date=${p.date}`);
}

if (DRY) {
  console.log('\n--- DRY RUN, no files written ---');
  if (anyShort) console.log('WARNING: at least one post looks truncated.');
  process.exit(0);
}

if (anyShort) {
  console.log('\nABORT: a post looks truncated; not writing. Recover from journal first.');
  process.exit(1);
}

for (const p of posts) {
  const fm = [
    '---',
    `title: ${JSON.stringify(p.title)}`,
    `slug: ${p.slug}`,
    `description: ${JSON.stringify(p.description)}`,
    `date: "${p.date}"`,
    `hero_image: "/assets/img/blog-${p.slug}.jpg"`,
    '---',
    '',
  ].join('\n');
  const body = p.body_md.trim() + '\n';
  const file = path.join(BLOG_DIR, `${p.slug}.md`);
  fs.writeFileSync(file, fm + body, 'utf8');
  console.log('wrote', path.basename(file));
}

// Emit image prompts for the generation step
const prompts = posts.map(p => ({ slug: p.slug, prompt: p.image_prompt }));
fs.writeFileSync(path.join(__dirname, 'blog-image-prompts.json'), JSON.stringify(prompts, null, 2), 'utf8');
console.log('\nwrote scripts/blog-image-prompts.json (', prompts.length, 'prompts )');
