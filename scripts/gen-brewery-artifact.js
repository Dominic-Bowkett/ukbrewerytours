// Reads the research workflow journal and emits (1) a self-contained Artifact HTML
// body and (2) a CSV, grouping direct-booking breweries by region.
const fs = require('fs');
const path = require('path');

const journal = process.argv[2];
const outHtml = process.argv[3];
const outCsv = process.argv[4];

const results = fs.readFileSync(journal, 'utf8').split(/\r?\n/).filter(Boolean)
  .map(l => { try { return JSON.parse(l); } catch { return null; } })
  .filter(o => o && o.type === 'result' && o.result && Array.isArray(o.result.breweries));

// Short region labels + optional sub-label from the parenthetical
function splitRegion(name) {
  const m = name.match(/^([^(]+?)\s*\(([^)]*)\)\s*(.*)$/);
  if (m) {
    let main = m[1].trim();
    if (m[3] && m[3].trim()) main = (main + ' ' + m[3].trim()).replace(/\s*&\s*$/, '').trim();
    return { main, sub: m[2].trim() };
  }
  return { main: name.trim(), sub: '' };
}

// Deterministic region order (roughly N→S, then NI)
const ORDER = ['Scotland', 'North West', 'Yorkshire', 'Midlands', 'Wales', 'East of England', 'London', 'South East', 'South West'];
const regions = results.map(r => {
  const { main, sub } = splitRegion(r.result.region);
  return { raw: r.result.region, main, sub, breweries: r.result.breweries };
}).sort((a, b) => {
  const ai = ORDER.findIndex(o => a.main.startsWith(o));
  const bi = ORDER.findIndex(o => b.main.startsWith(o));
  return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
});

const total = regions.reduce((n, r) => n + r.breweries.length, 0);

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const slugify = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const price = p => {
  if (p == null || p === '') return { txt: 'POA', poa: true };
  const s = String(p).trim();
  if (/^\d/.test(s)) return { txt: '£' + s.replace(/^£/, ''), poa: false };
  return { txt: s, poa: /enquir|poa|vary|free/i.test(s) };
};

// ---- CSV ----
const csvRows = [['Region', 'Brewery', 'Tour name', 'URL', 'Location', 'Price (£pp)', 'Notes']];
for (const r of regions) for (const b of r.breweries)
  csvRows.push([r.main, b.brewery, b.tour_name, b.url, b.location, b.price_gbp, b.notes]);
const csv = csvRows.map(row => row.map(c => '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"').join(',')).join('\r\n');
fs.writeFileSync(outCsv, csv, 'utf8');

// ---- HTML ----
const nav = regions.map(r =>
  `<a href="#${slugify(r.main)}"><span class="nav-name">${esc(r.main)}</span><span class="nav-n">${r.breweries.length}</span></a>`
).join('\n');

const sections = regions.map(r => {
  const rows = r.breweries.map(b => {
    const pr = price(b.price_gbp);
    const host = (() => { try { return new URL(b.url).hostname.replace(/^www\./, ''); } catch { return ''; } })();
    return `      <li class="entry">
        <div class="entry-head">
          <div class="entry-id">
            <h3 class="brewery">${esc(b.brewery)}</h3>
            <a class="tour" href="${esc(b.url)}" target="_blank" rel="noopener">${esc(b.tour_name)}<span class="ext" aria-hidden="true">↗</span></a>
            <div class="host">${esc(host)}</div>
          </div>
          <div class="entry-meta">
            <span class="loc">${esc(b.location)}</span>
            <span class="price${pr.poa ? ' poa' : ''}">${esc(pr.txt)}</span>
          </div>
        </div>
        <p class="notes">${esc(b.notes)}</p>
      </li>`;
  }).join('\n');
  return `  <section class="region" id="${slugify(r.main)}">
    <header class="region-head">
      <h2>${esc(r.main)}</h2>
      ${r.sub ? `<p class="region-sub">${esc(r.sub)}</p>` : ''}
      <span class="region-count">${r.breweries.length} breweries</span>
    </header>
    <ul class="entries">
${rows}
    </ul>
  </section>`;
}).join('\n\n');

const css = `
:root{
  --paper:#FBFAF6; --panel:#FFFFFF; --ink:#211B14; --ink-soft:#4A4237;
  --meta:#7A7063; --rule:#E7E0D2; --rule-soft:#F0EBDF;
  --amber:#9A571A; --amber-deep:#7C4514; --hop:#3D6630; --hop-deep:#2E4E24;
  --chip:#F2EDE1;
}
*{box-sizing:border-box}
body{margin:0}
.wrap{
  --serif:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,"Times New Roman",serif;
  --sans:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  --mono:"SFMono-Regular",ui-monospace,"Cascadia Code",Consolas,"Liberation Mono",monospace;
  background:var(--paper); color:var(--ink); font-family:var(--sans);
  line-height:1.55; -webkit-font-smoothing:antialiased;
  padding:clamp(20px,5vw,64px) clamp(16px,5vw,40px) 80px;
}
.sheet{max-width:1000px;margin:0 auto}

/* Masthead */
.mast{border-bottom:2px solid var(--ink);padding-bottom:22px;margin-bottom:8px}
.eyebrow{font-family:var(--mono);font-size:.72rem;letter-spacing:.22em;text-transform:uppercase;
  color:var(--amber-deep);margin:0 0 14px}
.mast h1{font-family:var(--serif);font-weight:600;font-size:clamp(2rem,5.2vw,3.25rem);
  line-height:1.02;letter-spacing:-.01em;margin:0;text-wrap:balance;max-width:16ch}
.lede{font-size:1.05rem;color:var(--ink-soft);max-width:64ch;margin:16px 0 0}
.lede a{color:var(--hop-deep)}

/* Stat rail */
.stats{display:flex;flex-wrap:wrap;gap:0;margin:26px 0 4px;border:1px solid var(--rule);
  border-radius:3px;overflow:hidden;background:var(--panel)}
.stat{flex:1 1 150px;padding:16px 20px;border-right:1px solid var(--rule)}
.stat:last-child{border-right:0}
.stat .n{font-family:var(--serif);font-size:1.9rem;line-height:1;font-variant-numeric:tabular-nums}
.stat .k{font-family:var(--mono);font-size:.68rem;letter-spacing:.16em;text-transform:uppercase;
  color:var(--meta);margin-top:8px}

/* Callout */
.note{display:flex;gap:12px;align-items:flex-start;margin:22px 0 6px;padding:14px 18px;
  background:#FBF4E7;border:1px solid #EAD9B6;border-left:3px solid var(--amber);border-radius:3px;
  font-size:.92rem;color:var(--ink-soft)}
.note b{color:var(--amber-deep)}

/* Region jump nav */
.jump{position:sticky;top:0;z-index:5;background:rgba(251,250,246,.93);
  backdrop-filter:blur(8px);border-bottom:1px solid var(--rule);
  margin:30px 0 0;padding:12px 0;display:flex;flex-wrap:wrap;gap:6px}
.jump a{display:inline-flex;align-items:center;gap:7px;text-decoration:none;color:var(--ink-soft);
  font-size:.82rem;padding:6px 11px;border:1px solid var(--rule);border-radius:999px;
  background:var(--panel);transition:border-color .15s,color .15s}
.jump a:hover{border-color:var(--hop);color:var(--hop-deep)}
.jump .nav-n{font-family:var(--mono);font-size:.72rem;color:var(--meta);
  background:var(--chip);border-radius:999px;padding:1px 7px;font-variant-numeric:tabular-nums}

/* Regions */
.region{margin-top:52px;scroll-margin-top:70px}
.region-head{display:flex;align-items:baseline;flex-wrap:wrap;gap:8px 14px;
  border-bottom:1px solid var(--ink);padding-bottom:10px;margin-bottom:4px}
.region-head h2{font-family:var(--serif);font-weight:600;font-size:1.7rem;margin:0;letter-spacing:-.01em}
.region-sub{margin:0;color:var(--meta);font-size:.9rem;flex:1 1 auto}
.region-count{font-family:var(--mono);font-size:.7rem;letter-spacing:.12em;text-transform:uppercase;
  color:var(--amber-deep)}

/* Entries */
.entries{list-style:none;margin:0;padding:0}
.entry{padding:20px 0;border-bottom:1px solid var(--rule-soft)}
.entry:last-child{border-bottom:0}
.entry-head{display:flex;justify-content:space-between;gap:18px;align-items:flex-start;flex-wrap:wrap}
.entry-id{min-width:0;flex:1 1 60%}
.brewery{font-family:var(--serif);font-size:1.22rem;font-weight:600;margin:0 0 3px;line-height:1.2}
.tour{display:inline-block;color:var(--hop-deep);text-decoration:none;font-weight:600;font-size:.98rem;
  border-bottom:1px solid rgba(61,102,48,.35);padding-bottom:1px}
.tour:hover{border-bottom-color:var(--hop)}
.tour .ext{font-size:.78em;margin-left:3px;color:var(--hop);vertical-align:1px}
.host{font-family:var(--mono);font-size:.72rem;color:var(--meta);margin-top:5px}
.entry-meta{display:flex;flex-direction:column;align-items:flex-end;gap:7px;text-align:right;flex:0 0 auto}
.loc{font-size:.82rem;color:var(--ink-soft);max-width:24ch}
.price{font-family:var(--mono);font-variant-numeric:tabular-nums;font-weight:600;font-size:.9rem;
  color:#fff;background:var(--hop-deep);padding:3px 10px;border-radius:3px;white-space:nowrap}
.price.poa{background:var(--chip);color:var(--meta);font-weight:500}
.notes{margin:11px 0 0;color:var(--ink-soft);font-size:.92rem;max-width:74ch}

/* Footer */
.foot{margin-top:60px;padding-top:20px;border-top:2px solid var(--ink);
  font-size:.82rem;color:var(--meta);display:flex;justify-content:space-between;flex-wrap:wrap;gap:10px}
.foot .mono{font-family:var(--mono);letter-spacing:.04em}

@media (max-width:620px){
  .entry-head{flex-direction:column;gap:8px}
  .entry-meta{flex-direction:row;align-items:center;text-align:left;gap:12px}
  .loc{max-width:none}
  .stat{flex-basis:50%;border-bottom:1px solid var(--rule)}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
`;

const html = `<div class="wrap">
<style>${css}</style>
<div class="sheet">
  <header class="mast">
    <p class="eyebrow">Research dossier · Independent &amp; direct-booking breweries</p>
    <h1>UK breweries that sell tours on their own websites</h1>
    <p class="lede">${total} brewery-run tours across the UK — the Harvey's / Fuller's kind that book directly through their own sites rather than through GetYourGuide or DesignMyNight. Compiled to review for possible partnerships or listings. Every tour name links straight to its booking page.</p>
  </header>

  <div class="stats">
    <div class="stat"><div class="n">${total}</div><div class="k">Tours found</div></div>
    <div class="stat"><div class="n">${regions.length}</div><div class="k">UK regions</div></div>
    <div class="stat"><div class="n">100%</div><div class="k">Direct booking</div></div>
    <div class="stat"><div class="n">£12–47</div><div class="k">Typical price pp</div></div>
  </div>

  <div class="note"><span aria-hidden="true">⚑</span><div><b>How to read this.</b> These breweries sell direct, so they can't be added through our existing affiliate feeds — each would need a direct arrangement (affiliate, referral or listing). Prices are indicative and were correct at time of research; always confirm on the brewery's page. A CSV of the same data is saved in the repo at <code>scripts/brewery-research.csv</code>.</div></div>

  <nav class="jump" aria-label="Jump to region">
${nav}
  </nav>

${sections}

  <footer class="foot">
    <span>UK Brewery Tours — brewery research dossier</span>
    <span class="mono">${total} tours · ${regions.length} regions</span>
  </footer>
</div>
</div>`;

fs.writeFileSync(outHtml, html, 'utf8');
console.log(`wrote ${outHtml} (${total} breweries, ${regions.length} regions)`);
console.log(`wrote ${outCsv}`);
