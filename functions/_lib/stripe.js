// Stripe via the REST API — no SDK, so the site stays dependency-free and
// well inside the free-tier CPU budget.
//
// Two worlds live in this file:
//   * the PLATFORM calls (gift vouchers) — unchanged, no Stripe-Account header;
//   * the CONNECT calls (team payment requests) — every one of which carries
//     `Stripe-Account: acct_…`, making the charge, the funds, the refund and the
//     chargeback liability the connected account's, with our cut taken as
//     `application_fee_amount`. Drop that header and the identical body would
//     create the charge on the platform instead.

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

/**
 * Refund part or all of a payment back to the customer's card.
 * `idempotencyKey` stops a double-click or retry from refunding twice.
 *
 * `stripeAccount` + `refundApplicationFee` exist for Connect direct charges: the
 * refund must be created ON the connected account, and without the fee reversal
 * the platform would keep 20% of a booking that never happened, out of the
 * member's pocket. See createConnectRefund() for the Connect-shaped wrapper.
 */
export async function createRefund(env, {
  paymentIntent, amountPence, reason, idempotencyKey, stripeAccount, refundApplicationFee,
}) {
  const p = new URLSearchParams();
  p.set('payment_intent', paymentIntent);
  if (amountPence) p.set('amount', String(amountPence));
  // Stripe only accepts this fixed set; anything else is a validation error.
  if (reason && ['duplicate', 'fraudulent', 'requested_by_customer'].includes(reason)) {
    p.set('reason', reason);
  }
  // Stripe reverses the fee pro-rata on a partial refund.
  if (refundApplicationFee) p.set('refund_application_fee', 'true');

  const res = await fetch('https://api.stripe.com/v1/refunds', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      ...(stripeAccount ? { 'Stripe-Account': stripeAccount } : {}),
    },
    body: p.toString(),
  });

  const json = await res.json();
  if (!res.ok) throw new Error(json?.error?.message || `Stripe refund failed (${res.status})`);
  return json;
}

function toHex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time string compare — avoids leaking match position via timing. */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
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


/* ========================================================================== *
 * STRIPE CONNECT — direct charges on a team member's connected account.
 * ========================================================================== */

const API = 'https://api.stripe.com/v1';

/**
 * Typed Stripe failure, so callers can tell "the card network hiccupped, retry"
 * from "this connected account can no longer take our money" — the second must
 * raise an alert and show the client a different message, never the same
 * "please try again shortly" that hides a permanent outage.
 */
export class StripeError extends Error {
  constructor(message, { status = 0, code = null, type = null, param = null } = {}) {
    super(message);
    this.name = 'StripeError';
    this.status = status;
    this.code = code;
    this.type = type;
    this.param = param;
  }

  /** The connected account cannot accept this charge — never a transient retry. */
  get isAccountProblem() {
    if (this.status === 401 || this.status === 403) return true;
    const codes = [
      'account_invalid',
      'account_country_invalid_address',
      'platform_account_required',
      'insufficient_capabilities_for_transfer',
      'application_fees_not_allowed',
      'charges_not_allowed',
      'amount_too_small',
      'amount_too_large',
    ];
    if (this.code && codes.includes(this.code)) return true;
    // Capability failures come back as invalid_request_error with a prose message.
    return this.type === 'invalid_request_error'
      && /capabilit|application_fee|not\s+activated|cannot\s+currently\s+make\s+charges/i.test(this.message || '');
  }

  /** Worth retrying: rate limits, Stripe 5xx, network-level failures. */
  get isTransient() {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

/**
 * One transport for every Connect call.
 *
 * `account` sets the Stripe-Account header — THE line that makes a call a direct
 * charge on the connected account rather than a platform charge. Objects created
 * that way live on the connected account, so every later read-back (session,
 * PaymentIntent, refund, expire) must pass the same account or Stripe answers
 * 404 from the platform's own ledger.
 */
export async function stripeApi(env, path, { method = 'GET', params, account, idempotencyKey } = {}) {
  if (!env.STRIPE_SECRET_KEY) {
    throw new StripeError('Stripe is not configured', { status: 503, code: 'not_configured' });
  }

  const headers = { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` };
  if (account) headers['Stripe-Account'] = account;
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  if (params) headers['Content-Type'] = 'application/x-www-form-urlencoded';

  let res;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers,
      body: params ? params.toString() : undefined,
    });
  } catch (err) {
    // Stripe unreachable. status 0 => isTransient, so the caller fails CLOSED
    // (no new session, no state change) rather than guessing.
    throw new StripeError(`Stripe unreachable: ${err.message}`, { status: 0, code: 'network_error' });
  }

  let json = null;
  try {
    json = await res.json();
  } catch { /* Stripe always sends JSON; a non-JSON body is itself the error. */ }

  if (!res.ok) {
    const e = json?.error || {};
    throw new StripeError(e.message || `Stripe ${res.status} on ${path}`, {
      status: res.status, code: e.code || e.decline_code || null, type: e.type || null, param: e.param || null,
    });
  }
  return json;
}

/**
 * Create the Checkout Session for one payment request, as a DIRECT charge.
 *
 * Every money field is read from the stored row. There is deliberately no
 * parameter here a client could reach: no amount, no currency, no fee, no
 * account, and the callers never read the request body.
 *
 * `expires_at` is deliberately NOT sent, and that is load-bearing. Stripe's
 * Idempotency-Key only replays a request whose parameters are IDENTICAL, so a
 * clock-derived expiry would make the retry fail with "keys for idempotent
 * requests can only be used with the same parameters" — exactly when we need the
 * replay most: after a timeout, when Stripe may already have created a live,
 * payable session we never recorded. With every parameter derived from the row
 * and the lock id, the retry returns THE SAME session instead of orphaning one.
 * Stripe's own 24h default applies, and the caller stores the returned
 * `expires_at` verbatim.
 */
export async function createDirectCheckoutSession(env, {
  req, nonce, successUrl, cancelUrl, idempotencyKey,
}) {
  const p = new URLSearchParams();
  p.set('mode', 'payment');
  p.set('success_url', successUrl);
  p.set('cancel_url', cancelUrl);
  p.set('client_reference_id', req.id);
  p.set('customer_email', req.client_email);
  p.set('locale', 'en-GB');

  // Pinned. Left unset, the methods offered are whatever the CONNECTED account
  // has enabled — Bacs, Klarna, BNPL — and a delayed method returns a session
  // that is complete-but-unpaid, which Stripe never expires. Card only means the
  // session is resolved by the time the client is redirected back.
  p.set('payment_method_types[0]', 'card');

  // `payreq_nonce` is minted by us and stored on the row BEFORE this call. The
  // webhook's metadata fallback requires it, which is what stops a connected
  // account (Standard accounts hold their own API keys) from creating its own
  // session with our client_reference_id and settling its own request with no
  // application fee.
  p.set('metadata[payment_request_id]', req.id);
  p.set('metadata[payreq_nonce]', nonce);

  p.set('line_items[0][quantity]', '1');
  p.set('line_items[0][price_data][currency]', req.currency);
  p.set('line_items[0][price_data][unit_amount]', String(req.amount_pence));
  p.set('line_items[0][price_data][product_data][name]', String(req.tour_name).slice(0, 250));
  const desc = [
    req.tour_date ? `Date: ${req.tour_date}${req.tour_time ? ` ${req.tour_time}` : ''}` : null,
    req.tour_details,
  ].filter(Boolean).join(' — ').slice(0, 400);
  if (desc) p.set('line_items[0][price_data][product_data][description]', desc);

  // Our cut, taken automatically at capture, read verbatim from the FROZEN
  // column — never recomputed here, so an admin changing a member's percent
  // tomorrow cannot alter a request already sitting in a client's inbox.
  // Omitted rather than sent as 0 when the rate is zero.
  if (req.fee_pence > 0) {
    p.set('payment_intent_data[application_fee_amount]', String(req.fee_pence));
  }
  p.set('payment_intent_data[description]',
    `${req.tour_name}${req.tour_date ? ` — ${req.tour_date}` : ''}`.slice(0, 200));
  p.set('payment_intent_data[metadata][payment_request_id]', req.id);
  p.set('payment_intent_data[metadata][payreq_nonce]', nonce);

  // Deliberately NOT set: transfer_data[destination] and on_behalf_of. Those
  // make it a DESTINATION charge on the platform, putting us back in as merchant
  // of record with the refund and chargeback liability. For a direct charge the
  // connected account is expressed by the Stripe-Account header alone.
  // Also not set: receipt_email — we send our own branded receipt, and Stripe's
  // would arrive from the connected account as a second, conflicting one.

  return stripeApi(env, '/checkout/sessions', {
    method: 'POST',
    params: p,
    account: req.stripe_account_id,
    idempotencyKey,
  });
}

export const retrieveSession = (env, id, account) =>
  stripeApi(env, `/checkout/sessions/${encodeURIComponent(id)}`, { account });

export const retrievePaymentIntent = (env, id, account) =>
  stripeApi(env, `/payment_intents/${encodeURIComponent(id)}`, { account });

/**
 * Close a session at Stripe so its URL stops being payable.
 *
 * MUST be called before a request is cancelled or expired locally: a Checkout
 * Session lives up to 24h, so flipping our status alone leaves a live, payable
 * URL in the client's inbox and the resulting charge lands with our row already
 * out of the payable set.
 *
 * Returns { expired: true } or { expired: false, reason } — 'completed' means the
 * client already paid and the caller MUST abort the cancel and re-read the row.
 */
export async function expireCheckoutSession(env, { sessionId, account }) {
  try {
    await stripeApi(env, `/checkout/sessions/${encodeURIComponent(sessionId)}/expire`, {
      method: 'POST',
      params: new URLSearchParams(),
      account,
      idempotencyKey: `expire-${sessionId}`,
    });
    return { expired: true };
  } catch (err) {
    const msg = String(err.message || '');
    // Already expired is success; already completed is emphatically not.
    if (/already\s+expired|not\s+in\s+the\s+`?open`?\s+state/i.test(msg) && !/complete/i.test(msg)) {
      return { expired: true, reason: 'already_expired' };
    }
    if (/complete/i.test(msg)) return { expired: false, reason: 'completed' };
    if (err instanceof StripeError && err.status === 404) return { expired: true, reason: 'unknown_session' };
    throw err;
  }
}

/**
 * Refund a DIRECT charge, on the connected account, reversing our fee.
 * `refund_application_fee` claws the platform's cut back out of the platform
 * balance; `reverse_transfer` is destination-charge only and must NOT be sent.
 */
export function createConnectRefund(env, {
  paymentIntent, account, amountPence, reason, idempotencyKey, refundApplicationFee = true,
}) {
  const p = new URLSearchParams();
  p.set('payment_intent', paymentIntent);
  if (amountPence) p.set('amount', String(amountPence));
  if (refundApplicationFee) p.set('refund_application_fee', 'true');
  if (reason && ['duplicate', 'fraudulent', 'requested_by_customer'].includes(reason)) p.set('reason', reason);
  return stripeApi(env, '/refunds', { method: 'POST', params: p, account, idempotencyKey });
}

/** Platform-level read. Takes NO Stripe-Account header and sends no email. */
export const retrieveAccount = (env, id) =>
  stripeApi(env, `/accounts/${encodeURIComponent(id)}`);
