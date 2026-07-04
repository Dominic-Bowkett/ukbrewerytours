# UK Brewery Tours — static site

Full redesign of [ukbrewerytours.com](https://www.ukbrewerytours.com), built as a dependency-free static site hosted on GitHub Pages.

## How it works

```
content/        ← all editable content
  site.json     ← brand info, WhatsApp number, featured tours, redirect map
  tours.json    ← one object per tour (name, price, schedule, images…)
  blog/*.md     ← blog posts (frontmatter + markdown)
  pages.md      ← reference copy captured from the old site
pages/          ← page bodies (home, about, contact, tours, blog, vouchers, groups, returns)
templates/      ← layout shell, product template, blog template, redirect stub
assets/         ← css, js, downloaded images
build.js        ← generator: node build.js → writes docs/
docs/           ← generated site (what GitHub Pages serves) — do not edit by hand
```

**To make a change:** edit `content/`, `pages/` or `templates/`, then run:

```
node build.js
git add -A && git commit -m "update" && git push
```

## Adding / editing tours

Edit `content/tours.json`. Each active tour gets a page at `/tours/<old_slug>/`,
appears on the city grid at `/tours/`, and gets a redirect from the old
`/listing/<old_slug>/` URL automatically. Set `"active": false` to unpublish
(add a redirect for its URL to `site.json` if you do).

## Adding a blog post

Add `content/blog/<slug>.md` with the same frontmatter as the existing posts
(`title`, `slug`, `description`, `date`, `hero_image`, and `old_url` only if it
migrates an old post). Rebuild.

## SEO / redirects

- Old WordPress URLs (dated blog posts, `/listing/…`, junk pages) are redirected
  with instant `meta refresh` + `rel=canonical` stubs — the closest thing to a 301
  GitHub Pages supports. The map lives in `content/site.json` → `redirects`,
  plus automatic entries for tours and migrated posts.
- Old demo-content URLs (hiking boots, tents left over from the WP theme) are
  deliberately **not** redirected — they 404 so Google drops them.
- `docs/404.html` catch-all: unknown `/listing/*` → `/tours/`, unknown dated
  URLs → `/blog/`.
- `sitemap.xml` and `robots.txt` are regenerated on every build (new URLs only).

## Going live (DNS)

The site is pinned to `www.ukbrewerytours.com` via `docs/CNAME`. At your DNS provider:

1. `www` CNAME → `dominic-bowkett.github.io`
2. Apex `ukbrewerytours.com` A records → `185.199.108.153`, `185.199.109.153`,
   `185.199.110.153`, `185.199.111.153`
3. In the repo: Settings → Pages → tick **Enforce HTTPS** once the certificate is issued.

Until DNS is switched, the old WordPress site stays live — nothing breaks.

## Contact form

The form on `/contact/` posts to [formsubmit.co](https://formsubmit.co) →
`info@ukbrewerytours.com`. The **first** submission triggers a confirmation email
to that inbox — click it once to activate the form.
