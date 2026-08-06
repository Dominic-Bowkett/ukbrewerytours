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

/**
 * Styles are inlined rather than linked to /assets/css/style.css.
 *
 * Every built page links that file with a ?v=<hash> that build.js computes, so
 * a change busts the cache. A Function cannot see that hash, so the bare URL
 * this page used was served from cache — the page rendered completely unstyled
 * for a paying client even though the stylesheet on disk was correct.
 *
 * Inlining also means the page paints immediately with no second request, on
 * the one page where a client is deciding whether to trust us with a card.
 */
const PAY_CSS = `
:root{--stout:#201611;--cream:#f7f1e5;--paper:#fffdf7;--ink:#241a12;--ink-soft:#6b5a49;
--line:#e6dac4;--amber:#e0932f;--amber-deep:#a65d0d;--amber-soft:#f6e3c2;--green:#45523a;
--green-soft:#e7ead9;--radius:14px;--radius-sm:9px}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Inter,-apple-system,"Segoe UI",sans-serif;font-size:1.0625rem;line-height:1.65;
color:var(--ink);background:var(--cream);-webkit-font-smoothing:antialiased}
.pay-body{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:32px 16px}
.pay-card{width:100%;max-width:520px;background:var(--paper);border-radius:var(--radius);
box-shadow:0 2px 4px rgba(36,26,18,.08),0 24px 48px -20px rgba(36,26,18,.32);padding:40px 38px}
.pay-loading{color:var(--ink-soft);text-align:center}
.pay-seller{font-size:.78rem;letter-spacing:.16em;text-transform:uppercase;color:var(--amber-deep);
font-weight:600;margin-bottom:10px}
.pay-title{font-family:Fraunces,Georgia,serif;font-weight:600;font-size:1.65rem;line-height:1.25;
letter-spacing:-.01em;margin-bottom:6px}
.pay-date{color:var(--ink-soft);font-size:.95rem;margin-bottom:20px}
.pay-amount{font-family:Fraunces,Georgia,serif;font-weight:600;font-size:2.6rem;line-height:1;
margin:22px 0;padding:20px;text-align:center;background:var(--amber-soft);border-radius:var(--radius-sm)}
.pay-details{font-size:.97rem;line-height:1.7;margin-bottom:22px;white-space:pre-line}
.pay-button{display:block;width:100%;padding:17px 24px;border:0;border-radius:999px;
background:var(--amber);color:#2b1a05;font:inherit;font-size:1.05rem;font-weight:600;cursor:pointer}
.pay-button:hover:not(:disabled){background:#cf8526}
.pay-button:disabled{opacity:.6;cursor:default}
.pay-secure{text-align:center;font-size:.82rem;color:var(--ink-soft);margin-top:14px}
.pay-paid{background:var(--green-soft);color:var(--green);border-radius:var(--radius-sm);
padding:16px 18px;font-size:.97rem;line-height:1.6;text-align:center}
.pay-error{background:#fbeceb;color:#96271f;border-radius:var(--radius-sm);padding:14px 16px;
font-size:.93rem;line-height:1.6}
.pay-terms{margin-top:26px;padding-top:22px;border-top:1px solid var(--line);font-size:.87rem;
line-height:1.65;color:var(--ink-soft)}
.pay-terms h2{font-family:Fraunces,Georgia,serif;font-size:.95rem;color:var(--ink);margin-bottom:8px}
.pay-terms p{white-space:pre-line}
.pay-ref{margin-top:22px;font-size:.78rem;color:var(--ink-soft);text-align:center;
font-family:ui-monospace,Consolas,monospace}
@media(max-width:520px){.pay-card{padding:28px 22px}.pay-title{font-size:1.4rem}
.pay-amount{font-size:2.1rem;padding:16px}}
`;

const HEAD = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>${PAY_CSS}</style>`;

function shell(token) {
  return `<!doctype html><html lang="en"><head>
${HEAD}
<title>Payment request — UK Brewery Tours</title>
</head><body class="pay-body">
<main id="pay" class="pay-card" data-token="${token}">
  <p class="pay-loading">Loading your payment request…</p>
</main>
<script src="/assets/js/pay.js" defer></script>
</body></html>`;
}

function notFoundHtml() {
  return `<!doctype html><html lang="en"><head>
${HEAD}
<title>Not found — UK Brewery Tours</title>
</head><body class="pay-body"><main class="pay-card">
<h1 class="pay-title">Payment link not found</h1>
<p>This link is not valid, or it has been withdrawn. Please check the link in your email, or contact whoever sent it.</p>
</main></body></html>`;
}
