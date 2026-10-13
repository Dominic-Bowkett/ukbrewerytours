// /pay-now/:token — the link in a payment request emailed from the inbox.
//
//   GET   a small page: what it is for, the amount, a Pay button. Not a straight
//         redirect: mail scanners open every link in an email, and each visit
//         would otherwise make a Stripe session.
//   POST  makes a fresh Checkout Session and sends the browser to Stripe, so
//         the link works however long after the email it is opened.
//   GET ?paid=<session id>  Stripe's return. Confirms with Stripe and records
//         the payment (the webhook does the same; whichever is first wins).
//
// Needs '/pay-now/*' in docs/_routes.json (written by build.js).

import { brandFor } from '../_lib/inbox.js';
import { checkoutFor, markPaid, pounds } from '../_lib/inbox-payments.js';
import { retrieveSession } from '../_lib/stripe.js';

const TOKEN_RE = /^[0-9a-f]{32}$/;

async function find(env, params) {
  const parts = (Array.isArray(params.token) ? params.token : [params.token]).filter(Boolean);
  const token = String(parts[0] || '').toLowerCase();
  if (parts.length !== 1 || !TOKEN_RE.test(token)) return null;
  const pay = await env.DB.prepare('SELECT * FROM inbox_payments WHERE token = ?').bind(token).first();
  if (!pay) return null;
  const enquiry = await env.DB.prepare('SELECT site FROM enquiries WHERE id = ?').bind(pay.enquiry_id).first();
  return { pay, brand: brandFor(enquiry?.site || 'ukbrewerytours.com') };
}

export async function onRequestGet({ params, request, env }) {
  const found = await find(env, params);
  if (!found) return page(404, 'UK Brewery Tours', 'Link not found', '<p>This payment link is not recognised. Please reply to our email and we’ll sort it out.</p>');
  let { pay, brand } = found;
  const url = new URL(request.url);

  const sessionId = url.searchParams.get('paid');
  if (sessionId && pay.status !== 'paid' && /^cs_[A-Za-z0-9_]+$/.test(sessionId)) {
    try {
      const session = await retrieveSession(env, sessionId);
      if (Number(session?.metadata?.inbox_payment_id) === pay.id) {
        await markPaid(env, session);
        pay = await env.DB.prepare('SELECT * FROM inbox_payments WHERE id = ?').bind(pay.id).first();
      }
    } catch (err) {
      console.error('pay-now return check failed', err);
    }
  }

  const amount = pounds(pay.amount_pence);
  if (pay.status === 'paid') {
    return page(200, brand, 'Thank you — payment received',
      `<p class="big">${amount}</p><p>${esc(pay.description)}</p><p class="muted">A receipt is on its way to your inbox. Nothing more to do.</p>`);
  }
  if (sessionId) {
    // Back from Stripe before the payment has settled — rare, and it will.
    return page(200, brand, 'Payment processing',
      `<p class="big">${amount}</p><p>Thanks — your payment is being confirmed. A receipt will follow by email.</p>`);
  }
  if (pay.status === 'cancelled') {
    return page(410, brand, 'This link is no longer active',
      '<p>This payment request has been withdrawn. If you still need to pay, reply to our email and we’ll send a fresh link.</p>');
  }

  const note = url.searchParams.get('cancelled') ? '<p class="muted">Payment wasn’t completed — you can try again below.</p>' : '';
  return page(200, brand, 'Make a payment', `
    ${note}
    <p class="muted">${esc(pay.description)}</p>
    <p class="big">${amount}</p>
    <form method="post"><button type="submit">Pay ${amount} securely</button></form>
    <p class="muted small">Card, Apple Pay or Google Pay · processed by Stripe</p>`);
}

export async function onRequestPost({ params, env }) {
  const found = await find(env, params);
  if (!found) return page(404, 'UK Brewery Tours', 'Link not found', '<p>This payment link is not recognised.</p>');
  const { pay, brand } = found;
  // Already paid or withdrawn: the GET page says so.
  if (pay.status !== 'open') return Response.redirect(`https://www.ukbrewerytours.com/pay-now/${pay.token}`, 303);
  try {
    const session = await checkoutFor(env, pay, brand);
    return Response.redirect(session.url, 303);
  } catch (err) {
    console.error('pay-now checkout failed', err);
    return page(502, brand, 'Something went wrong', '<p>We couldn’t open the payment page just now. Please try again in a minute, or reply to our email.</p>');
  }
}

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function page(status, brand, title, inner) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow">
<title>${esc(title)} — ${esc(brand)}</title>
<style>
  body { margin: 0; background: #f7f1e5; font-family: 'Segoe UI', Helvetica, Arial, sans-serif; color: #201611; }
  .wrap { max-width: 440px; margin: 0 auto; padding: 32px 16px; }
  .card { background: #fffcf5; border-radius: 14px; overflow: hidden; box-shadow: 0 6px 24px rgba(32,22,17,.08); }
  .head { background: #201611; color: #fffcf5; padding: 18px 24px; font-weight: 700; }
  .body { padding: 26px 24px 28px; text-align: center; }
  h1 { font-size: 1.25rem; margin: 0 0 14px; }
  p { line-height: 1.6; margin: 0 0 12px; }
  .big { font-size: 2.2rem; font-weight: 800; margin: 6px 0 16px; }
  .muted { color: #6b5c4f; } .small { font-size: .85rem; margin-top: 14px; }
  button { background: #e0932f; color: #2b1a05; border: 0; border-radius: 999px; padding: 14px 30px; font: inherit; font-weight: 700; font-size: 1rem; cursor: pointer; width: 100%; }
  button:hover { background: #d0831f; }
</style></head><body><div class="wrap"><div class="card">
<div class="head">🍺 ${esc(brand)}</div>
<div class="body"><h1>${esc(title)}</h1>${inner}</div>
</div></div></body></html>`;
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, private',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex, nofollow',
      'X-Content-Type-Options': 'nosniff',
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    },
  });
}
