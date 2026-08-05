// GET /pay/:token — the branded page the client actually opens.
//
// ROUTING NOTE (this file is dead code without it): docs/_routes.json decides
// which paths reach the Functions runtime at all. It currently reads
//   {"version":1,"include":["/api/*"],"exclude":[]}
// so /pay/<token> would be served as a STATIC file — i.e. a 404 from the static
// asset handler, and this handler would never run. build.js writes that file,
// so the include list is widened there (see the `_routes.json` write in
// build.js) to ["/api/*", "/pay/*", "/team/*"].
//
// The shell deliberately inlines NO request data. It fetches /api/pay/<token>,
// which is the single place the public whitelist is enforced — one surface, one
// review. A catch-all ([[token]]) is used so /pay/abc and /pay/abc/ both land
// here rather than one of them falling through to the static 404.

const TOKEN_RE = /^[0-9a-f]{32}$/;

export async function onRequestGet({ params }) {
  const parts = (Array.isArray(params.token) ? params.token : [params.token]).filter(Boolean);
  const token = String(parts[0] || '').toLowerCase();

  if (parts.length !== 1 || !TOKEN_RE.test(token)) {
    return new Response(notFoundHtml(), {
      status: 404,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' },
    });
  }

  return new Response(shell(token), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // The token is in the path: keep it out of caches and out of Referer.
      'Cache-Control': 'no-store, private',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex, nofollow',
      'X-Content-Type-Options': 'nosniff',
      // No inline script anywhere on this page, so 'unsafe-inline' is not
      // needed. Stripe Checkout is a top-level redirect, not an embed.
      'Content-Security-Policy': [
        "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:", "connect-src 'self'", "object-src 'none'",
        "base-uri 'none'", "frame-ancestors 'none'", "form-action 'self'",
      ].join('; '),
    },
  });
}

function shell(token) {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">
<title>Payment request — UK Brewery Tours</title>
<link rel="stylesheet" href="/assets/css/style.css">
</head><body class="pay-body">
<main id="pay" class="pay-card" data-token="${token}">
  <p class="pay-loading">Loading your payment request…</p>
</main>
<script src="/assets/js/pay.js" defer></script>
</body></html>`;
}

function notFoundHtml() {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Not found — UK Brewery Tours</title>
<link rel="stylesheet" href="/assets/css/style.css">
</head><body class="pay-body"><main class="pay-card">
<h1>Payment link not found</h1>
<p>This link is not valid, or it has been withdrawn. Please check the link in your email, or contact whoever sent it.</p>
</main></body></html>`;
}
