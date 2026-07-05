#!/usr/bin/env node
/**
 * UK Brewery Tours — static site builder.
 * Reads content/ + templates/ + pages/, writes the deployable site to docs/.
 * No dependencies — run with: node build.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'docs');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

const site = JSON.parse(read('content/site.json'));
const tours = JSON.parse(read('content/tours.json'));
const activeTours = tours.filter(t => t.active);
const WHATSAPP = `https://wa.me/${site.whatsapp}`;
const WA_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5.1-1.3A10 10 0 1 0 12 2Zm5.4 14.1c-.2.6-1.2 1.2-1.7 1.2-.4.1-1 .1-1.6-.1a13 13 0 0 1-5.8-5.1c-.6-1-.9-2-.9-2.7 0-.8.4-1.4.7-1.7.3-.3.6-.4.8-.4h.6c.2 0 .4 0 .6.5l.9 2.1c.1.2.1.4 0 .6l-.4.6-.3.3c-.1.2-.2.3 0 .6.2.3.9 1.4 1.9 2.3 1.3 1.2 2.4 1.5 2.7 1.7.3.1.5.1.7-.1l1-1.2c.2-.3.4-.2.7-.1l2 1c.3.1.5.2.6.4 0 .1 0 .7-.2 1.2Z"/></svg>';
// Group-booking WhatsApp button — identical green button used on every tour & experience page.
const groupBtn = (name) => `<a class="btn btn-whatsapp" href="${WHATSAPP}?text=${encodeURIComponent(`Hi! I'd like to enquire about a group booking for the ${name}.`)}">${WA_ICON} Group booking enquiry</a>`;
const TOUR_DISCLAIMER = '<p class="tour-disclaimer">Tours, itineraries and pricing may be subject to change. Please confirm with the organiser, or <a href="/contact/">get in touch</a> and we’ll happily check for you.</p>';
const YEAR = '2026';

/* ---------- helpers ---------- */

const esc = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const IMG_DIR = path.join(ROOT, 'assets', 'img');
const localImgs = new Set(fs.existsSync(IMG_DIR) ? fs.readdirSync(IMG_DIR) : []);

/** Map a wp-content image URL to a locally-downloaded copy when we have one. */
function localizeUrl(url) {
  if (!url) return url;
  if (!/wp-content\/uploads/.test(url)) return url;
  const base = decodeURIComponent(url.split('/').pop().split('?')[0]);
  const stripped = base.replace(/-\d+x\d+(?=\.\w+$)/, '');
  if (localImgs.has(stripped)) return '/assets/img/' + stripped;
  if (localImgs.has(base)) return '/assets/img/' + base;
  return url; // fall back to the old host until the image is downloaded
}

/** Rewrite old internal links inside migrated content to the new URL structure. */
function rewriteLink(href) {
  if (!href) return href;
  let p = href.replace(/^https?:\/\/(www\.)?ukbrewerytours\.com/, '');
  if (p === href && /^https?:/.test(href)) return href; // external
  if (!p.startsWith('/')) return href;
  if (!p.endsWith('/') && !/\.[a-z]+$/i.test(p) && !p.includes('#')) p += '/';
  if (site.redirects[p]) return site.redirects[p];
  const m = p.match(/^\/listing\/([^/]+)\/$/);
  if (m && activeTours.some(t => t.old_slug === m[1])) return `/tours/${m[1]}/`;
  const b = p.match(/^\/\d{4}\/\d{2}\/\d{2}\/([^/]+)\/$/);
  if (b) {
    const post = posts.find(x => x.old_url === p);
    if (post) return `/blog/${post.slug}/`;
    return '/blog/';
  }
  return p;
}

/** Tiny markdown → HTML converter (headings, lists, tables, images, links, emphasis). */
function mdToHtml(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let list = null, table = [];

  const inline = s => esc(s)
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => `<img src="${localizeUrl(src)}" alt="${alt}" loading="lazy">`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, txt, href) => `<a href="${rewriteLink(href)}">${txt}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');

  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const flushTable = () => {
    if (!table.length) return;
    const rows = table.filter(r => !/^\s*\|?[\s\-:|]+\|?\s*$/.test(r));
    const cells = r => r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => inline(c.trim()));
    let html = '<div style="overflow-x:auto"><table>';
    rows.forEach((r, i) => {
      const tag = i === 0 ? 'th' : 'td';
      html += '<tr>' + cells(r).map(c => `<${tag}>${c}</${tag}>`).join('') + '</tr>';
    });
    html += '</table></div>';
    out.push(html);
    table = [];
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^\s*\|.*\|\s*$/.test(line)) { closeList(); table.push(line); continue; }
    flushTable();
    if (!line.trim()) { closeList(); continue; }
    let m;
    if ((m = line.match(/^(#{1,6})\s+(.*)/))) {
      closeList();
      const lvl = Math.min(m[1].length + 1, 4); // demote: post H1 comes from frontmatter
      out.push(`<h${lvl}>${inline(m[2])}</h${lvl}>`);
    } else if ((m = line.match(/^\s*[-*]\s+(.*)/))) {
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
      out.push(`<li>${inline(m[1])}</li>`);
    } else if ((m = line.match(/^\s*\d+\.\s+(.*)/))) {
      if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
      out.push(`<li>${inline(m[1])}</li>`);
    } else if ((m = line.match(/^>\s?(.*)/))) {
      closeList();
      out.push(`<blockquote><p>${inline(m[1])}</p></blockquote>`);
    } else if (/^(---|\*\*\*)\s*$/.test(line)) {
      closeList();
    } else {
      closeList();
      out.push(`<p>${inline(line.trim())}</p>`);
    }
  }
  closeList(); flushTable();
  return out.join('\n');
}

/** Parse a blog markdown file with frontmatter. */
function parsePost(file) {
  const raw = read('content/blog/' + file);
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error('No frontmatter in ' + file);
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].replace(/^"(.*)"$/, '$1').trim();
  }
  return { ...meta, body: m[2].trim(), file };
}

const posts = fs.readdirSync(path.join(ROOT, 'content', 'blog'))
  .filter(f => f.endsWith('.md')).map(parsePost)
  .sort((a, b) => (b.date || '').localeCompare(a.date || ''));

function fill(tpl, map) {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in map ? map[k] : ''));
}

const humanDate = iso => {
  if (!iso) return '';
  const [y, mo, d] = iso.split('-').map(Number);
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return `${d} ${months[mo - 1]} ${y}`;
};

/** Derive weekday tags from a free-text schedule, for the day filter. */
function parseDays(schedule) {
  if (!schedule) return [];
  const s = schedule.toLowerCase();
  const map = [['monday', 'Mon'], ['tuesday', 'Tue'], ['wednesday', 'Wed'], ['thursday', 'Thu'], ['friday', 'Fri'], ['saturday', 'Sat'], ['sunday', 'Sun']];
  const days = new Set();
  for (const [full, code] of map) if (s.includes(full)) days.add(code);
  if (s.includes('weekend')) { days.add('Sat'); days.add('Sun'); }
  if (s.includes('daily') || s.includes('every day')) map.forEach(([, c]) => days.add(c));
  return [...days];
}
const DAY_ORDER = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/* ---------- GetYourGuide partner data + city guides ---------- */

const AFF_QS = 'partner_id=YK95MF9&utm_medium=travel_agent';
const affUrl = u => u + (u.includes('?') ? '&' : '?') + AFF_QS;

// Stamp our DesignMyNight rep_id onto any designmynight.com booking link (incl. subdomains).
const DMN_REP = site.designmynight_rep_id;
function decorateBooking(url) {
  if (url && DMN_REP && /designmynight\.com/i.test(url) && !url.includes('rep_id=')) {
    return url + (url.includes('?') ? '&' : '?') + 'rep_id=' + DMN_REP;
  }
  return url;
}
const gygSlug = u => u.replace(/\/$/, '').split('/').pop().replace(/-t\d+$/, '');
const GYG_IMG_DIR = path.join(ROOT, 'assets', 'img', 'gyg');
const gygImgs = new Set(fs.existsSync(GYG_IMG_DIR) ? fs.readdirSync(GYG_IMG_DIR) : []);
const gygImage = slug => gygImgs.has(slug + '.jpg') ? `/assets/img/gyg/${slug}.jpg` : '/assets/img/hero-static.jpg';

const CITY_IMG_DIR = path.join(ROOT, 'assets', 'img', 'city');
const cityImgs = new Set(fs.existsSync(CITY_IMG_DIR) ? fs.readdirSync(CITY_IMG_DIR) : []);
/** Best available wide banner image for a city: bespoke → our tour photo → partner photo → default. */
function cityHeroImage(name) {
  const slug = name.toLowerCase();
  if (cityImgs.has(slug + '.jpg')) return `/assets/img/city/${slug}.jpg`;
  const own = activeTours.find(t => t.city === name && t.images && t.images[0]);
  if (own) return localizeUrl(own.images[0].url);
  const g = cityGuides.find(c => c.name === name);
  const gt = g && (g.gyg_tours || [])[0];
  if (gt) return gygImage(gt.slug || gygSlug(gt.url));
  return '/assets/img/hero-static.jpg';
}

const gygDir = path.join(ROOT, 'content', 'gyg');
const cityGuides = fs.existsSync(gygDir)
  ? fs.readdirSync(gygDir).filter(f => f.endsWith('.json')).map(f => JSON.parse(read('content/gyg/' + f)))
  : [];
const cityOrder = [...site.city_order, 'Edinburgh', 'Newcastle', 'Nottingham', 'York'];
cityGuides.sort((a, b) => {
  const ia = cityOrder.indexOf(a.name), ib = cityOrder.indexOf(b.name);
  return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
});
const guideFor = name => cityGuides.find(c => c.name === name);

// Partner sources: GetYourGuide + DesignMyNight. Each has its own image dir, affiliate
// link builder and CTA/label. Experiences from both share one on-site listing system.
const dmnImgDir = path.join(ROOT, 'assets', 'img', 'dmn');
const dmnImgs = new Set(fs.existsSync(dmnImgDir) ? fs.readdirSync(dmnImgDir) : []);
const SOURCES = {
  gyg: { name: 'GetYourGuide', imgs: gygImgs, dir: 'gyg', book: u => affUrl(u), rel: 'sponsored noopener', cta: 'Book on GetYourGuide ↗' },
  dmn: { name: 'DesignMyNight', imgs: dmnImgs, dir: 'dmn', book: u => decorateBooking(u), rel: 'noopener', cta: 'Book on DesignMyNight ↗' },
};
const dmnSlug = u => u.replace(/\/$/, '').split('/').pop().split('?')[0];
const expImage = e => {
  const s = SOURCES[e.source];
  return s.imgs.has(e.slug + '.jpg') ? `/assets/img/${s.dir}/${e.slug}.jpg` : '/assets/img/hero-static.jpg';
};

// Our own tours' external booking URLs (canonical) — used to drop partner duplicates of our tours.
const ownBookingUrls = new Set(activeTours.filter(t => t.booking_url).map(t => t.booking_url.split('?')[0].replace(/\/$/, '')));

// GetYourGuide experiences (from content/gyg/*.json gyg_tours).
const allGyg = [];
for (const g of cityGuides) {
  for (const t of (g.gyg_tours || [])) {
    allGyg.push({ ...t, source: 'gyg', slug: t.slug || gygSlug(t.url), city: g.name });
  }
}
// DesignMyNight experiences (from content/dmn/*.json dmn_experiences).
const dmnDir = path.join(ROOT, 'content', 'dmn');
const allDmn = [];
if (fs.existsSync(dmnDir)) {
  for (const f of fs.readdirSync(dmnDir).filter(f => f.endsWith('.json'))) {
    const d = JSON.parse(read('content/dmn/' + f));
    for (const t of (d.dmn_experiences || [])) {
      allDmn.push({ ...t, source: 'dmn', slug: t.slug || dmnSlug(t.url), city: t.city || d.name });
    }
  }
}

// Combine, drop partner listings that duplicate our own tours, and de-dupe slugs.
const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const ownByCity = {};
for (const t of activeTours) (ownByCity[t.city] = ownByCity[t.city] || []).push(norm(t.name));
const seenSlugs = new Set();
const allExperiences = [];
for (const e of [...allGyg, ...allDmn]) {
  const canon = (e.url || '').split('?')[0].replace(/\/$/, '');
  if (ownBookingUrls.has(canon)) continue;      // same booking URL as one of our tours — skip
  const en = norm(e.title);
  if ((ownByCity[e.city] || []).some(tn => en.includes(tn) || tn.includes(en))) continue; // our own tour, listed by a partner
  if (seenSlugs.has(e.slug)) continue;          // avoid duplicate on-site pages
  seenSlugs.add(e.slug);
  allExperiences.push(e);
}
const expByCity = {};
for (const e of allExperiences) (expByCity[e.city] = expByCity[e.city] || []).push(e);

/** Card for a partner experience — links to our on-site listing page (not straight to the partner). */
function partnerCard(g) {
  const img = expImage(g);
  const rating = g.rating ? `★ ${g.rating}${g.reviews ? ` (${Number(g.reviews).toLocaleString('en-GB')})` : ''}` : null;
  const meta = [g.duration, rating].filter(Boolean).join(' · ');
  return `<a class="tour-card partner" href="/tours/experiences/${g.slug}/" data-card data-city="${esc(g.city)}" data-name="${esc(g.title.toLowerCase())}" data-days="">
    <div class="thumb"><img src="${img}" alt="${esc(g.title)}" loading="lazy"><span class="city-tag">${esc(g.city)}</span><span class="partner-flag">Partner</span></div>
    <div class="body">
      <h3>${esc(g.title)}</h3>
      ${meta ? `<p class="meta">${esc(meta)}</p>` : ''}
      <div class="price-row"><span class="price">${g.price_gbp ? `£${g.price_gbp}` : 'See prices'} ${g.price_gbp ? '<small>from</small>' : ''}</span><span class="go">View details →</span></div>
    </div>
  </a>`;
}
const DISCLOSURE = `<p class="disclosure">Experiences marked "Partner" are operated by third parties and booked through our partners (GetYourGuide and DesignMyNight); we may earn a commission at no extra cost to you.</p>`;

/* ---------- components ---------- */

function tourCard(t) {
  const img = localizeUrl((t.images && t.images[0] && t.images[0].url) || '');
  const price = t.price ? `£${t.price} <small>pp</small>` : `<small>price on enquiry</small>`;
  const meta = [t.duration, t.schedule && t.schedule.split('(')[0].trim()].filter(Boolean).join(' · ');
  const days = parseDays(t.schedule).join(',');
  return `<a class="tour-card" href="/tours/${t.old_slug}/" data-card data-city="${esc(t.city)}" data-name="${esc(t.name.toLowerCase())}" data-days="${days}">
    <div class="thumb"><img src="${img}" alt="${esc(t.name)}" loading="lazy"><span class="city-tag">${esc(t.city)}</span></div>
    <div class="body">
      <h3>${esc(t.name)}</h3>
      <p class="meta">${esc(meta)}</p>
      <div class="price-row"><span class="price">${price}</span><span class="go">View tour →</span></div>
    </div>
  </a>`;
}

function postCard(p) {
  const img = localizeUrl(p.hero_image);
  const thumb = img
    ? `<div class="thumb"><img src="${img}" alt="" loading="lazy"></div>`
    : `<div class="thumb" style="display:flex;align-items:center;justify-content:center;font-size:3rem">🍺</div>`;
  return `<a class="post-card" href="/blog/${p.slug}/">
    ${thumb}
    <div class="body">
      <span class="date">${humanDate(p.date)}</span>
      <h3>${esc(p.title)}</h3>
      <p>${esc(p.description)}</p>
      <span class="read">Read article →</span>
    </div>
  </a>`;
}

/* ---------- page assembly ---------- */

const layout = read('templates/layout.html');

function writePage(outPath, { title, description, content, nav, ogImage, jsonld, robots }) {
  const canonical = site.base_url + ('/' + outPath).replace(/\/index\.html$/, '/');
  const navKeys = ['tours', 'vouchers', 'groups', 'blog', 'about'];
  const navMap = {};
  for (const k of navKeys) navMap['nav_' + k] = nav === k ? 'aria-current="page"' : '';
  let og = ogImage || '/assets/img/hms-hops.jpg';
  if (og.startsWith('/')) og = site.base_url + og;
  const blocks = Array.isArray(jsonld) ? jsonld : (jsonld ? [jsonld] : []);
  const html = fill(layout, {
    title, description: esc(description), canonical, og_image: og,
    content, whatsapp_url: WHATSAPP, year: YEAR,
    robots: robots ? `<meta name="robots" content="${robots}">` : '',
    structured_data: blocks.map(b => `<script type="application/ld+json">${JSON.stringify(b)}</script>`).join('\n  '),
    ...navMap,
  });
  const abs = path.join(OUT, outPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, html);
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

/* assets */
fs.cpSync(path.join(ROOT, 'assets'), path.join(OUT, 'assets'), { recursive: true });
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');
fs.writeFileSync(path.join(OUT, 'CNAME'), 'www.ukbrewerytours.com\n');

/* ----- computed blocks shared by pages ----- */

const featuredCards = site.featured
  .map(slug => activeTours.find(t => t.old_slug === slug)).filter(Boolean)
  .map(tourCard).join('\n');

const citiesWithTours = site.city_order.filter(c => activeTours.some(t => t.city === c));

// All cities across our tours + partner experiences, in preferred order, for filters + tiles.
const allCityNames = [...new Set([...activeTours.map(t => t.city), ...allExperiences.map(t => t.city)])]
  .sort((a, b) => {
    const ia = cityOrder.indexOf(a), ib = cityOrder.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
  });

// "Explore by city" tiles — the key cities (those with a bespoke banner), in preferred order.
const tileCities = allCityNames.filter(c => guideFor(c) && cityImgs.has(c.toLowerCase() + '.jpg'));
const exploreTiles = tileCities.map(c => {
  const g = guideFor(c);
  const own = activeTours.filter(t => t.city === c).length;
  const exp = (expByCity[c] || []).length;
  const n = own + exp;
  return `<a class="city-tile" href="/tours/${g.slug}/" style="background-image:url('${cityHeroImage(c)}')">
    <span class="city-tile-scrim"></span>
    <span class="city-tile-body"><span class="city-tile-name">${c}</span><span class="city-tile-count">${n} tour${n === 1 ? '' : 's'} &amp; experience${n === 1 ? '' : 's'}</span></span>
  </a>`;
}).join('\n');

const cityOptions = allCityNames.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');

// One merged grid: our own tours and partner experiences together, grouped by
// city (our own first within each city) so a city's options sit side by side.
const mergedTours = [
  ...activeTours.map(t => ({ city: t.city, own: 1, html: tourCard(t) })),
  ...allExperiences.map(t => ({ city: t.city, own: 0, html: partnerCard(t) })),
].sort((a, b) => {
  const ia = cityOrder.indexOf(a.city), ib = cityOrder.indexOf(b.city);
  return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || (b.own - a.own) || a.city.localeCompare(b.city);
});
const allToursGrid = mergedTours.map(m => m.html).join('\n');

const blogCards = posts.map(postCard).join('\n');

const pageTokens = {
  featured_cards: featuredCards,
  explore_tiles: exploreTiles,
  city_options: cityOptions,
  all_tours_grid: allToursGrid,
  disclosure: DISCLOSURE,
  blog_cards: blogCards,
  wa_icon: WA_ICON,
  whatsapp_url: WHATSAPP,
  email: site.email,
  google_rating: site.google_rating,
  google_reviews: site.google_reviews,
  tour_count: String(activeTours.length),
  partner_count: String(allExperiences.length),
  total_count: String(activeTours.length + allExperiences.length),
  city_count: String(citiesWithTours.length),
};

/* ----- static pages from pages/ ----- */

const staticPages = [
  { src: 'home.html', out: 'index.html', nav: '', title: 'UK Brewery Tours | Award-Winning Brewery Tours & Beer Tastings Since 2014', description: 'Award-winning brewery tours and craft beer tasting experiences across the UK — London, Bristol, Manchester, Leeds and more. Small groups, expert guides, gift vouchers that never expire.', jsonld: { '@context': 'https://schema.org', '@type': 'Organization', name: 'UK Brewery Tours', url: site.base_url, email: site.email, foundingDate: '2014', description: 'Award-winning brewery tours and beer tasting events across the UK.' } },
  { src: 'about.html', out: 'about/index.html', nav: 'about', title: 'About Us | UK Brewery Tours', description: 'Founded on London\'s Bermondsey Beer Mile in 2014, UK Brewery Tours runs award-winning brewery tours and beer tastings in cities across the UK.' },
  { src: 'contact.html', out: 'contact/index.html', nav: '', title: 'Contact Us | UK Brewery Tours', description: 'Get in touch with UK Brewery Tours — WhatsApp, email or contact form. Questions about tours, group bookings and gift vouchers answered within hours.' },
  { src: 'tours.html', out: 'tours/index.html', nav: 'tours', title: 'Brewery Tours & Beer Tastings Across the UK | UK Brewery Tours', description: `Browse ${activeTours.length} brewery tours and beer tasting experiences in ${citiesWithTours.length} UK cities — London, Bristol, Manchester, Liverpool, Leeds and more.` },
  { src: 'blog.html', out: 'blog/index.html', nav: 'blog', title: 'Beer Blog | UK Brewery Tours', description: 'Craft beer guides, brewery profiles and beer knowledge from the UK Brewery Tours team — from the Bermondsey Beer Mile to the best beer gardens in London.' },
  { src: 'gift-vouchers.html', out: 'gift-vouchers/index.html', nav: 'vouchers', title: 'Brewery Tour Gift Vouchers — Never Expire | UK Brewery Tours', description: 'Monetary gift vouchers for brewery tours anywhere in the UK. Instant email delivery, never expire, refundable up to 12 months. The perfect gift for beer lovers.' },
  { src: 'group-tours.html', out: 'group-tours/index.html', nav: 'groups', title: 'Private Group Brewery Tours from £29pp | UK Brewery Tours', description: 'Private brewery tours and beer tastings for corporate teams, stags, hens and groups — available in most UK cities from £29 per person.' },
  { src: 'returns-policy.html', out: 'returns-policy/index.html', nav: '', title: 'Returns Policy | UK Brewery Tours', description: 'Gift voucher returns and refunds policy for UK Brewery Tours.' },
];

for (const p of staticPages) {
  const content = fill(read('pages/' + p.src), pageTokens);
  writePage(p.out, { ...p, content });
}

/* ----- product pages ----- */

const productTpl = read('templates/product.html');
const ICONS = {
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>',
  calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/></svg>',
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21s-7-5.5-7-11a7 7 0 1 1 14 0c0 5.5-7 11-7 11Z"/><circle cx="12" cy="10" r="2.5"/></svg>',
};

for (const t of activeTours) {
  const imgs = (t.images || []).map(i => localizeUrl(i.url));
  const hero = imgs[0] || '/assets/img/hms-hops.jpg';
  const thumbs = imgs.length > 1
    ? `<div class="thumbs">` + imgs.slice(0, 4).map((u, i) =>
        `<button type="button" class="${i === 0 ? 'active' : ''}" data-src="${u}" aria-label="View photo ${i + 1}"><img src="${u}" alt="" loading="lazy"></button>`).join('') + `</div>`
    : '';
  const facts = [
    t.duration && `<li>${ICONS.clock}<span><strong>Duration</strong>${esc(t.duration)}</span></li>`,
    t.schedule && `<li>${ICONS.calendar}<span><strong>When</strong>${esc(t.schedule)}</span></li>`,
    t.meeting_point && `<li>${ICONS.pin}<span><strong>Meeting point</strong>${esc(t.meeting_point)}</span></li>`,
  ].filter(Boolean).join('\n');

  const includesBlock = (t.includes || []).length
    ? `<h2 style="margin-top:44px">What's included</h2>
       <ul class="includes-list">${t.includes.map(i => `<li>${esc(i)}</li>`).join('')}</ul>` : '';
  const breweriesBlock = (t.breweries || []).length
    ? `<h2 style="margin-top:44px">Breweries &amp; venues you'll visit</h2>
       <div class="brewery-chips">${t.breweries.map(b => `<span class="chip chip-light">${esc(b)}</span>`).join('')}</div>` : '';
  const meetingBlock = t.meeting_point
    ? `<h2 style="margin-top:44px">Where we meet</h2>
       <p class="prose">${esc(t.meeting_point)} — full joining instructions are sent with your booking confirmation.</p>` : '';

  const related = activeTours.filter(x => x !== t)
    .sort((a, b) => (b.city === t.city) - (a.city === t.city)).slice(0, 3);

  const priceLine = t.price
    ? `<span class="price">£${t.price}</span><span class="pp">per person</span>`
    : `<span class="pp" style="font-size:1.05rem;font-weight:600">Price on enquiry</span>`;

  const ctaButtons = t.booking_url
    ? `<a class="btn btn-primary" href="${decorateBooking(t.booking_url)}" target="_blank" rel="noopener">Buy tickets</a>
       ${groupBtn(t.name)}`
    : `${groupBtn(t.name)}`;

  let content = fill(productTpl, {
    name: esc(t.name), city: esc(t.city), price: t.price || '',
    hero_image: hero, thumbs, facts,
    whatsapp_url: WHATSAPP,
    cta_buttons: ctaButtons,
    tour_disclaimer: TOUR_DISCLAIMER,
    description_html: mdToHtml(t.description_md || t.summary || ''),
    includes_block: includesBlock, breweries_block: breweriesBlock, meeting_block: meetingBlock,
    related_cards: related.map(tourCard).join('\n'),
  });
  content = content.replace('<div class="price-line">\n        <span class="price">£' + (t.price || '') + '</span><span class="pp">per person</span>\n      </div>',
    `<div class="price-line">${priceLine}</div>`);

  const jsonld = {
    '@context': 'https://schema.org', '@type': 'Product',
    name: t.name, description: t.summary || undefined,
    image: hero.startsWith('/') ? site.base_url + hero : hero,
    brand: { '@type': 'Organization', name: 'UK Brewery Tours' },
    ...(t.price ? { offers: { '@type': 'Offer', price: t.price, priceCurrency: 'GBP', availability: 'https://schema.org/InStock', url: `${site.base_url}/tours/${t.old_slug}/` } } : {}),
  };

  writePage(`tours/${t.old_slug}/index.html`, {
    title: `${t.name}${t.price ? ` — £${t.price}` : ''} | UK Brewery Tours`,
    description: (t.summary || '').slice(0, 158),
    content, nav: 'tours', ogImage: hero, jsonld,
  });
}

/* ----- blog posts ----- */

const postTpl = read('templates/blog-post.html');
for (const p of posts) {
  const heroLocal = localizeUrl(p.hero_image);
  const heroBlock = heroLocal ? `<div class="post-hero-img"><img src="${heroLocal}" alt="${esc(p.title)}"></div>` : '';
  const content = fill(postTpl, {
    title: esc(p.title), description: esc(p.description),
    date_human: humanDate(p.date), hero_block: heroBlock,
    content: mdToHtml(p.body),
  });
  writePage(`blog/${p.slug}/index.html`, {
    title: `${p.title} | UK Brewery Tours`,
    description: p.description, content, nav: 'blog', ogImage: heroLocal || undefined,
    jsonld: { '@context': 'https://schema.org', '@type': 'BlogPosting', headline: p.title, datePublished: p.date, dateModified: p.date, author: { '@type': 'Organization', name: 'UK Brewery Tours' }, image: heroLocal ? (heroLocal.startsWith('/') ? site.base_url + heroLocal : heroLocal) : undefined, mainEntityOfPage: `${site.base_url}/blog/${p.slug}/` },
  });
}

/* ----- city guide pages (with hero banner) ----- */

for (const g of cityGuides) {
  const own = activeTours.filter(t => t.city === g.name);
  const banner = cityHeroImage(g.name);
  const gygTours = (expByCity[g.name] || []);
  const ownCount = own.length, expCount = gygTours.length;

  // A short punchy hero tagline (first sentence of the intro, trimmed).
  const firstSentence = (g.intro_md || '').split(/(?<=[.!?])\s/)[0].replace(/\s+/g, ' ').trim();
  const heroTag = firstSentence.length > 150 ? firstSentence.slice(0, 147) + '…' : firstSentence;
  const countBits = [
    ownCount ? `${ownCount} of our tour${ownCount > 1 ? 's' : ''}` : null,
    expCount ? `${expCount} partner experience${expCount > 1 ? 's' : ''}` : null,
  ].filter(Boolean).join(' · ');

  const content = `<section class="city-hero" style="background-image:url('${banner}')">
  <div class="city-hero-scrim"></div>
  <div class="container">
    <nav class="breadcrumbs city-crumbs" aria-label="Breadcrumb">
      <a href="/">Home</a><span class="sep">/</span><a href="/tours/">Tours</a><span class="sep">/</span>${g.name}
    </nav>
    <span class="kicker">${g.name} · city guide</span>
    <h1>${g.name} brewery tours &amp; beer experiences</h1>
    ${heroTag ? `<p class="lede">${esc(heroTag)}</p>` : ''}
    ${countBits ? `<div class="city-hero-stats">${countBits}</div>` : ''}
    <div class="hero-ctas">
      <a class="btn btn-primary" href="#tours">See ${g.name} tours</a>
      <a class="btn btn-outline-light" href="/group-tours/">Private group tours</a>
    </div>
  </div>
</section>
${(ownCount || expCount) ? `<section class="section" id="tours">
  <div class="container">
    <div class="section-head">
      <span class="kicker">Tours &amp; experiences</span>
      <h2>Brewery tours &amp; experiences in ${g.name}</h2>
      <p>${ownCount ? 'Our own guided tours plus hand-picked' : 'Hand-picked'} brewery tours, tastings and food &amp; drink experiences${ownCount ? '' : ', bookable through our partner GetYourGuide'} — all in one place.</p>
    </div>
    <div class="card-grid">${[...own.map(tourCard), ...gygTours.map(partnerCard)].join('\n')}</div>
    ${expCount ? DISCLOSURE : ''}
  </div>
</section>` : ''}
<section class="section band-cream" style="border-top:1px solid var(--line)">
  <div class="container">
    <div class="section-head"><span class="kicker">Eat &amp; drink in ${g.name}</span><h2>Where to drink in ${g.name}</h2></div>
    <div class="prose">
${mdToHtml(g.intro_md || '')}
    </div>
  </div>
</section>
<section class="section band-dark">
  <div class="container cta-banner">
    <h2>Planning a group day out in ${g.name}?</h2>
    <p class="mt-2">We run private brewery tours and beer tastings for stags, hens, birthdays and corporate teams in most UK cities — from £29 per person.</p>
    <p class="mt-3"><a class="btn btn-primary" href="/group-tours/">Plan a group tour</a> <a class="btn btn-outline-light" href="/tours/">Browse all tours</a></p>
  </div>
</section>`;

  const crumbLd = {
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: site.base_url + '/' },
      { '@type': 'ListItem', position: 2, name: 'Tours', item: site.base_url + '/tours/' },
      { '@type': 'ListItem', position: 3, name: g.name, item: `${site.base_url}/tours/${g.slug}/` },
    ],
  };

  writePage(`tours/${g.slug}/index.html`, {
    title: `${g.name} Brewery Tours & Beer Tasting | Book Online | UK Brewery Tours`,
    description: g.meta_description || `Brewery tours, beer tastings and food & drink experiences in ${g.name}. Compare and book top-rated tours online.`,
    content, nav: 'tours', ogImage: banner, jsonld: crumbLd,
  });
}

/* ----- partner experience listing pages (GetYourGuide + DesignMyNight) ----- */

for (const t of allExperiences) {
  const src = SOURCES[t.source];
  const img = expImage(t);
  const guide = guideFor(t.city);
  const ratingStr = t.rating ? `★ ${t.rating}${t.reviews ? ` · ${Number(t.reviews).toLocaleString('en-GB')} reviews` : ''}` : null;
  const chips = [t.duration && `<span class="exp-chip">${ICONS.clock}${esc(t.duration)}</span>`,
    ratingStr && `<span class="exp-chip star">${esc(ratingStr)}</span>`,
    `<span class="exp-chip">${ICONS.pin}${esc(t.city)}</span>`].filter(Boolean).join('');
  const highlights = (t.highlights || []).length
    ? `<h2>Highlights</h2><ul class="includes-list">${t.highlights.map(h => `<li>${esc(h)}</li>`).join('')}</ul>` : '';
  const meeting = t.meeting_point
    ? `<h2>Meeting point</h2><p>${esc(t.meeting_point)}</p>` : '';
  const desc = mdToHtml(t.description_md || t.summary || '');
  const related = (expByCity[t.city] || []).filter(x => x.slug !== t.slug).slice(0, 3);
  const bookUrl = src.book(t.url);
  const priceLine = t.price_gbp
    ? `<span class="price">£${t.price_gbp}</span><span class="pp">per person from</span>`
    : `<span class="pp" style="font-weight:600;font-size:1.05rem">See live prices</span>`;

  const content = `<section class="exp-hero" style="background-image:url('${img}')">
  <div class="exp-hero-scrim"></div>
  <div class="container">
    <nav class="breadcrumbs city-crumbs" aria-label="Breadcrumb">
      <a href="/">Home</a><span class="sep">/</span><a href="/tours/">Tours</a><span class="sep">/</span><a href="/tours/${guide ? guide.slug : ''}/">${esc(t.city)}</a><span class="sep">/</span>Experience
    </nav>
    <span class="partner-flag-lg">Partner experience · ${src.name}</span>
    <h1>${esc(t.title)}</h1>
    <div class="exp-chips">${chips}</div>
  </div>
</section>
<section class="section" style="padding-top:44px">
  <div class="container product-top">
    <div class="prose">
      <h2>About this experience</h2>
      ${desc}
      ${highlights}
      ${meeting}
    </div>
    <aside class="booking-card">
      <div class="price-line">${priceLine}</div>
      <a class="btn btn-primary" href="${bookUrl}" target="_blank" rel="${src.rel}">${src.cta}</a>
      ${groupBtn(t.title)}
      <a class="btn btn-outline" href="/gift-vouchers/" data-giftup-open>🎁 Buy a gift voucher</a>
      <p class="note">${ratingStr ? esc(ratingStr) + ' · ' : ''}${guide ? `<a href="/tours/${guide.slug}/">More ${esc(t.city)} tours</a>` : `<a href="/tours/">All tours</a>`}</p>
      ${TOUR_DISCLAIMER}
      <p class="disclosure" style="margin-top:12px">Booked via ${src.name}, our partner. We may earn a commission at no extra cost to you. Group enquiries are handled directly by us.</p>
    </aside>
  </div>
</section>
${related.length ? `<section class="section band-dark">
  <div class="container">
    <div class="section-head"><span class="kicker">More in ${esc(t.city)}</span><h2>You might also like</h2></div>
    <div class="card-grid">${related.map(partnerCard).join('\n')}</div>
  </div>
</section>` : ''}`;

  writePage(`tours/experiences/${t.slug}/index.html`, {
    title: `${t.title} | UK Brewery Tours`,
    description: (t.summary || t.description_md || '').replace(/\s+/g, ' ').slice(0, 158),
    content, nav: 'tours', ogImage: img,
    robots: 'noindex,follow',
  });
}

/* ----- redirect stubs ----- */

const redirectTpl = read('templates/redirect.html');
const allRedirects = { ...site.redirects };
for (const t of activeTours) allRedirects[`/listing/${t.old_slug}/`] = `/tours/${t.old_slug}/`;
for (const p of posts) if (p.old_url) allRedirects[p.old_url] = `/blog/${p.slug}/`;

let stubCount = 0;
const redirectLines = [];
for (const [from, to] of Object.entries(allRedirects)) {
  if (from === to) continue;
  const stub = fill(redirectTpl, { target: to, target_abs: site.base_url + to });
  const abs = path.join(OUT, from.replace(/^\//, ''), 'index.html');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, stub);
  redirectLines.push(`${from} ${to} 301`);
  stubCount++;
}
// Cloudflare Pages _redirects file — real 301s (better than the meta-refresh stubs).
fs.writeFileSync(path.join(OUT, '_redirects'), redirectLines.join('\n') + '\n');

/* ----- 404, sitemap, robots ----- */

const notFound = fill(layout, {
  title: 'Page not found | UK Brewery Tours',
  description: 'Sorry, that page has moved or no longer exists.',
  canonical: site.base_url + '/404.html', og_image: site.base_url + '/assets/img/hms-hops.jpg',
  whatsapp_url: WHATSAPP, year: YEAR, structured_data: '',
  nav_tours: '', nav_vouchers: '', nav_groups: '', nav_blog: '', nav_about: '',
  content: `<section class="section center"><div class="container">
    <div class="kicker">404</div>
    <h1>That one's been drunk dry</h1>
    <p class="lede mt-2">The page you're looking for has moved or no longer exists. Try one of these instead:</p>
    <p class="mt-3"><a class="btn btn-primary" href="/tours/">Browse tours</a> <a class="btn btn-outline" href="/blog/">Read the blog</a></p>
  </div></section>
  <script>
    (function () {
      var p = location.pathname;
      if (/^\\/listing\\//.test(p)) location.replace('/tours/');
      else if (/^\\/20\\d\\d\\//.test(p)) location.replace('/blog/');
    })();
  </script>`,
});
fs.writeFileSync(path.join(OUT, '404.html'), notFound);

const urls = [
  '/', '/about/', '/contact/', '/tours/', '/gift-vouchers/', '/group-tours/', '/blog/', '/returns-policy/',
  ...cityGuides.map(g => `/tours/${g.slug}/`),
  ...activeTours.map(t => `/tours/${t.old_slug}/`),
  ...posts.map(p => `/blog/${p.slug}/`),
];
fs.writeFileSync(path.join(OUT, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  urls.map(u => `  <url><loc>${site.base_url}${u}</loc></url>`).join('\n') + '\n</urlset>\n');

fs.writeFileSync(path.join(OUT, 'robots.txt'),
  `User-agent: *\nAllow: /\n\nSitemap: ${site.base_url}/sitemap.xml\n`);

// Build stamp — visit /version.txt on the live site to confirm which build is deployed.
fs.writeFileSync(path.join(OUT, 'version.txt'),
  `UK Brewery Tours — build ${new Date().toISOString()}\n` +
  `${activeTours.length} own tours, ${allExperiences.length} partner experiences, ${cityGuides.length} city guides\n`);

console.log(`Built ${urls.length} pages, ${stubCount} redirect stubs → docs/`);
