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

/* ---------- GetYourGuide partner data + city guides ---------- */

const AFF_QS = 'partner_id=YK95MF9&utm_medium=travel_agent';
const affUrl = u => u + (u.includes('?') ? '&' : '?') + AFF_QS;
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

function partnerCard(g) {
  const rating = g.rating ? `★ ${g.rating}${g.reviews ? ` (${Number(g.reviews).toLocaleString('en-GB')})` : ''}` : null;
  const meta = [g.duration, rating].filter(Boolean).join(' · ');
  return `<a class="partner-card" href="${affUrl(g.url)}" target="_blank" rel="sponsored noopener">
    <span class="partner-tag">Partner · GetYourGuide</span>
    <h3>${esc(g.title)}</h3>
    ${meta ? `<p class="meta">${esc(meta)}</p>` : ''}
    ${g.summary ? `<p class="sum">${esc(g.summary)}</p>` : ''}
    <div class="price-row">
      <span class="price">${g.price_gbp ? `From £${g.price_gbp}` : 'See prices'}</span>
      <span class="btn btn-primary btn-sm">Buy tickets ↗</span>
    </div>
  </a>`;
}
const DISCLOSURE = `<p class="disclosure">Tours marked "Partner" are operated by third parties and booked through GetYourGuide; we may earn a commission at no extra cost to you.</p>`;

/* ---------- components ---------- */

function tourCard(t) {
  const img = localizeUrl((t.images && t.images[0] && t.images[0].url) || '');
  const price = t.price ? `£${t.price} <small>per person</small>` : `<small>price on enquiry</small>`;
  const meta = [t.duration, t.schedule && t.schedule.split('(')[0].trim()].filter(Boolean).join(' · ');
  return `<a class="tour-card" href="/tours/${t.old_slug}/">
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

function writePage(outPath, { title, description, content, nav, ogImage, jsonld }) {
  const canonical = site.base_url + ('/' + outPath).replace(/\/index\.html$/, '/');
  const navKeys = ['tours', 'vouchers', 'groups', 'blog', 'about'];
  const navMap = {};
  for (const k of navKeys) navMap['nav_' + k] = nav === k ? 'aria-current="page"' : '';
  let og = ogImage || '/assets/img/hms-hops.jpg';
  if (og.startsWith('/')) og = site.base_url + og;
  const html = fill(layout, {
    title, description: esc(description), canonical, og_image: og,
    content, whatsapp_url: WHATSAPP, year: YEAR,
    structured_data: jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld)}</script>` : '',
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
const partnerOnlyGuides = cityGuides.filter(g => !citiesWithTours.includes(g.name) && (g.gyg_tours || []).length);
const cityNav = [...citiesWithTours, ...partnerOnlyGuides.map(g => g.name)]
  .map(c => `<a href="#${c.toLowerCase()}">${c}</a>`).join('\n');

const citySections = citiesWithTours.map(c => {
  const ct = activeTours.filter(t => t.city === c);
  const guide = guideFor(c);
  const explore = guide ? `<a class="explore" href="/tours/${guide.slug}/">${c} city guide →</a>` : '';
  const gyg = guide && (guide.gyg_tours || []).length
    ? `<h3 class="partner-head">Also bookable in ${c} — via our partner GetYourGuide</h3>
       <div class="card-grid">${guide.gyg_tours.map(partnerCard).join('\n')}</div>`
    : '';
  return `<section class="city-section" id="${c.toLowerCase()}">
  <div class="container">
    <h2>${c} <span class="count">${ct.length} tour${ct.length > 1 ? 's' : ''}</span>${explore}</h2>
    <div class="card-grid">${ct.map(tourCard).join('\n')}</div>
    ${gyg}
  </div>
</section>`;
}).join('\n') + partnerOnlyGuides.map(g => `
<section class="city-section" id="${g.slug}">
  <div class="container">
    <h2>${g.name} <span class="count">partner tours</span><a class="explore" href="/tours/${g.slug}/">${g.name} city guide →</a></h2>
    <div class="card-grid">${g.gyg_tours.map(partnerCard).join('\n')}</div>
  </div>
</section>`).join('\n') + `
<div class="container" style="padding-top:34px">${DISCLOSURE}</div>`;

const blogCards = posts.map(postCard).join('\n');

const pageTokens = {
  featured_cards: featuredCards,
  city_nav: cityNav,
  city_sections: citySections,
  blog_cards: blogCards,
  whatsapp_url: WHATSAPP,
  email: site.email,
  google_rating: site.google_rating,
  google_reviews: site.google_reviews,
  tour_count: String(activeTours.length),
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

  const waHref = `${WHATSAPP}?text=${encodeURIComponent(`Hi! I'd like to book the ${t.name}.`)}`;
  const waIcon = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5.1-1.3A10 10 0 1 0 12 2Zm5.4 14.1c-.2.6-1.2 1.2-1.7 1.2-.4.1-1 .1-1.6-.1a13 13 0 0 1-5.8-5.1c-.6-1-.9-2-.9-2.7 0-.8.4-1.4.7-1.7.3-.3.6-.4.8-.4h.6c.2 0 .4 0 .6.5l.9 2.1c.1.2.1.4 0 .6l-.4.6-.3.3c-.1.2-.2.3 0 .6.2.3.9 1.4 1.9 2.3 1.3 1.2 2.4 1.5 2.7 1.7.3.1.5.1.7-.1l1-1.2c.2-.3.4-.2.7-.1l2 1c.3.1.5.2.6.4 0 .1 0 .7-.2 1.2Z"/></svg>';
  const ctaButtons = t.booking_url
    ? `<a class="btn btn-primary" href="${t.booking_url}" target="_blank" rel="noopener">Buy tickets</a>
       <a class="btn btn-outline" href="${waHref}">${waIcon} Ask us on WhatsApp</a>`
    : `<a class="btn btn-primary" href="${waHref}">${waIcon} Book via WhatsApp</a>
       <a class="btn btn-outline" href="/gift-vouchers/">Buy as a gift voucher</a>`;

  let content = fill(productTpl, {
    name: esc(t.name), city: esc(t.city), price: t.price || '',
    hero_image: hero, thumbs, facts,
    whatsapp_url: WHATSAPP,
    cta_buttons: ctaButtons,
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

/* ----- city guide pages ----- */

for (const g of cityGuides) {
  const own = activeTours.filter(t => t.city === g.name);
  const gygCards = (g.gyg_tours || []).map(partnerCard).join('\n');
  const heroImg = own[0] && own[0].images && own[0].images[0]
    ? localizeUrl(own[0].images[0].url) : '/assets/img/hero-static.jpg';

  const content = `<section class="page-hero">
  <div class="container">
    <nav class="breadcrumbs" style="padding:0 0 18px" aria-label="Breadcrumb">
      <a href="/">Home</a><span class="sep">/</span><a href="/tours/">Tours</a><span class="sep">/</span>${g.name}
    </nav>
    <span class="kicker">City guide</span>
    <h1>${g.name} brewery tours &amp; beer experiences</h1>
  </div>
</section>
${own.length ? `<section class="section" style="padding-bottom:34px">
  <div class="container">
    <div class="section-head"><span class="kicker">Our tours</span><h2>Our ${g.name} tours</h2></div>
    <div class="card-grid">${own.map(tourCard).join('\n')}</div>
  </div>
</section>` : ''}
<section class="section" style="padding-top:44px;padding-bottom:34px">
  <div class="container">
    <div class="section-head"><span class="kicker">Eat &amp; drink</span><h2>Food &amp; drink in ${g.name}</h2></div>
    <div class="prose">
${mdToHtml(g.intro_md || '')}
    </div>
  </div>
</section>
${gygCards ? `<section class="section" style="padding-top:44px">
  <div class="container">
    <div class="section-head">
      <span class="kicker">More to book</span>
      <h2>More ${g.name} tours &amp; experiences</h2>
      <p>Hand-picked experiences from our partner GetYourGuide.</p>
    </div>
    <div class="card-grid">${gygCards}</div>
    ${DISCLOSURE}
  </div>
</section>` : ''}
<section class="section band-dark">
  <div class="container cta-banner">
    <h2>Planning a group day out in ${g.name}?</h2>
    <p class="mt-2">We run private brewery tours and beer tastings for stags, hens, birthdays and corporate teams in most UK cities — from £29 per person.</p>
    <p class="mt-3"><a class="btn btn-primary" href="/group-tours/">Plan a group tour</a> <a class="btn btn-outline-light" href="/tours/">Browse all tours</a></p>
  </div>
</section>`;

  writePage(`tours/${g.slug}/index.html`, {
    title: `${g.name} Brewery Tours & Beer Experiences | UK Brewery Tours`,
    description: g.meta_description || `Brewery tours, beer tastings and food & drink experiences in ${g.name}.`,
    content, nav: 'tours', ogImage: heroImg,
  });
}

/* ----- redirect stubs ----- */

const redirectTpl = read('templates/redirect.html');
const allRedirects = { ...site.redirects };
for (const t of activeTours) allRedirects[`/listing/${t.old_slug}/`] = `/tours/${t.old_slug}/`;
for (const p of posts) if (p.old_url) allRedirects[p.old_url] = `/blog/${p.slug}/`;

let stubCount = 0;
for (const [from, to] of Object.entries(allRedirects)) {
  if (from === to) continue;
  const stub = fill(redirectTpl, { target: to, target_abs: site.base_url + to });
  const abs = path.join(OUT, from.replace(/^\//, ''), 'index.html');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, stub);
  stubCount++;
}

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

console.log(`Built ${urls.length} pages, ${stubCount} redirect stubs → docs/`);
