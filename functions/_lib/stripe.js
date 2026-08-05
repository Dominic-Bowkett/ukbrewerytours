// Stripe via the REST API — no SDK, so the site stays dependency-free and
// well inside the free-tier CPU budget.

const enc = new TextEncoder();

export async function createCheckoutSession(env, {
  orderId, amountPence, quantity, purchaserEmail, tourName, successUrl, cancelUrl,
}) {
  const p = new URLSearchParams();
  p.set('mode', 'payment');
  p.set('success_url', successUrl);
  p.set('cancel_url', cancelUrl);
  p.set('client_reference_id', orderId);
  p.set('customer_email', purchaserEmail);
  p.set('metadata[order_id]', orderId);
  p.set('line_items[0][quantity]', String(quantity));
  p.set('line_items[0][price_data][currency]', 'gbp');
  p.set('line_items[0][price_data][unit_amount]', String(amountPence));
  p.set('line_items[0][price_data][product_data][name]', 'UK Brewery Tours gift voucher');
  p.set(
    'line_items[0][price_data][product_data][description]',
    tourName ? `Recommended for: ${tourName}` : 'Redeemable against any UK Brewery Tours experience',
  );

  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: p.toString(),
  });

  const json = await res.json();
  if (!res.ok) throw new Error(`Stripe ${res.status}: ${json?.error?.message || 'checkout session failed'}`);
  return json;
}

function toHex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify a Stripe webhook signature (t=<ts>,v1=<hex>) over the RAW body.
 * Returns the parsed event, or null if the signature/timestamp is not valid.
 */
export async function verifyWebhook(rawBody, sigHeader, secret, toleranceSeconds = 300) {
  if (!sigHeader || !secret) return null;

  let timestamp = null;
  const signatures = [];
  for (const part of sigHeader.split(',')) {
    const [k, v] = part.split('=');
    if (k === 't') timestamp = v;
    else if (k === 'v1') signatures.push(v);
  }
  if (!timestamp || !signatures.length) return null;

  // Reject replays of old events.
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > toleranceSeconds) return null;

  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = toHex(await crypto.subtle.sign('HMAC', key, enc.encode(`${timestamp}.${rawBody}`)));
  if (!signatures.some(s => safeEqual(s, expected))) return null;

  try {
    return JSON.parse(rawBody);
  } catch {
    return null;
  }
}
