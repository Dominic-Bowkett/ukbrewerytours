// GET /messages/:token — the customer's own view of a conversation, linked from
// every email we send them. Same chat UI as the pop-up, full page.
//
// ROUTING: build.js adds "/messages/*" to docs/_routes.json; without it this
// path is served by the static asset handler and the emailed link 404s.

import { chatHtml } from '../_lib/chat-ui.js';
import { TOKEN_RE } from '../_lib/inbox.js';

const SITE_PROFILE = {
  'londonbrewerytour.com': 'london',
  'bristolbrewerytours.com': 'bristol',
};

const HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  // The token is in the path: keep it out of caches and out of Referer.
  'Cache-Control': 'no-store, private',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
};

export async function onRequestGet({ params, env }) {
  const parts = (Array.isArray(params.token) ? params.token : [params.token]).filter(Boolean);
  const token = String(parts[0] || '').toLowerCase();

  let enquiry = null;
  if (parts.length === 1 && TOKEN_RE.test(token)) {
    enquiry = await env.DB.prepare('SELECT site FROM enquiries WHERE token = ? AND deleted_at IS NULL').bind(token).first();
  }

  if (!enquiry) {
    return new Response(`<!DOCTYPE html><html lang="en-GB"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>Conversation not found — UK Brewery Tours</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f7f1e5;font:16px/1.6 system-ui,sans-serif;color:#241a12;padding:20px}
.c{background:#fff;border-radius:14px;padding:32px;max-width:440px;text-align:center}h1{font-size:1.3rem;margin:0 0 10px}a{color:#b3701d}</style></head>
<body><div class="c"><h1>We couldn't find that conversation</h1>
<p>The link may be incomplete. Email <a href="mailto:info@ukbrewerytours.com">info@ukbrewerytours.com</a> and we'll pick it up from there.</p></div></body></html>`,
    { status: 404, headers: HEADERS });
  }

  return new Response(chatHtml({ mode: 'page', profileKey: SITE_PROFILE[enquiry.site] || 'ukbt', token }), { headers: HEADERS });
}
