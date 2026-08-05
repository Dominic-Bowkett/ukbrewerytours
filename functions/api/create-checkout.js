// POST /api/create-checkout
// Validates the voucher form, reserves the order + codes as `pending`, and
// returns a Stripe Checkout URL for the browser to redirect to.

import { generateCode } from '../_lib/codes.js';
import { createCheckoutSession } from '../_lib/stripe.js';

const MIN_PENCE = 1000;      // £10 minimum purchase
const MAX_PENCE = 100000;    // £1000 ceiling per voucher — sanity guard
const MAX_QTY = 20;

const isEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim());
const clean = (s, max) => String(s ?? '').trim().slice(0, max);

const bad = msg => Response.json({ error: msg }, { status: 400 });

export async function onRequestPost({ request, env }) {
  if (!env.STRIPE_SECRET_KEY) return Response.json({ error: 'Payments are not configured yet.' }, { status: 503 });

  let body;
  try {
    body = await request.json();
  } catch {
    return bad('Invalid request.');
  }

  // --- validate ---
  const amountPence = Math.round(Number(body.amount) * 100);
  if (!Number.isFinite(amountPence)) return bad('Enter a voucher amount.');
  if (amountPence < MIN_PENCE) return bad('The minimum voucher amount is £10.');
  if (amountPence > MAX_PENCE) return bad('For vouchers over £1000, please contact us directly.');

  // `?? 1` not `|| 1`: a literal 0 must fail validation, not fall back to 1.
  const quantity = Math.round(Number(body.quantity ?? 1));
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QTY) return bad(`Choose between 1 and ${MAX_QTY} vouchers.`);

  const purchaserName = clean(body.purchaserName, 100);
  const purchaserEmail = clean(body.purchaserEmail, 200).toLowerCase();
  if (!purchaserName) return bad('Enter your name.');
  if (!isEmail(purchaserEmail)) return bad('Enter a valid email address.');

  const sendToSelf = body.sendToSelf === true || body.sendToSelf === 'true';
  const recipientName = clean(body.recipientName, 100);
  const recipientEmail = clean(body.recipientEmail, 200).toLowerCase();
  if (!sendToSelf) {
    if (!recipientName) return bad("Enter the recipient's name.");
    if (!isEmail(recipientEmail)) return bad("Enter the recipient's email address.");
  }

  const message = clean(body.message, 1000);
  const tourSlug = clean(body.tourSlug, 120);
  const tourName = clean(body.tourName, 200);
  const isDemo = body.demo === true || body.demo === 'true';

  const orderId = crypto.randomUUID();
  const totalPence = amountPence * quantity;

  // --- create the Stripe session first: if it fails, no orphan rows ---
  const origin = new URL(request.url).origin;
  let session;
  try {
    session = await createCheckoutSession(env, {
      orderId,
      amountPence,
      quantity,
      purchaserEmail,
      tourName,
      successUrl: `${origin}/gift-vouchers/thank-you/?order=${orderId}`,
      cancelUrl: `${origin}${isDemo ? '/demo/gift-voucher/' : '/gift-vouchers/'}?cancelled=1`,
    });
  } catch (err) {
    console.error('stripe checkout failed', err);
    return Response.json({ error: 'Could not start checkout. Please try again.' }, { status: 502 });
  }

  // --- reserve the order and its voucher codes ---
  const stmts = [
    env.DB.prepare(
      `INSERT INTO orders (id, stripe_session_id, status, quantity, amount_pence, total_pence,
        purchaser_name, purchaser_email, recipient_name, recipient_email, send_to_self,
        message, tour_slug, tour_name, is_demo)
       VALUES (?,?,'pending',?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      orderId, session.id, quantity, amountPence, totalPence,
      purchaserName, purchaserEmail,
      sendToSelf ? null : recipientName,
      sendToSelf ? null : recipientEmail,
      sendToSelf ? 1 : 0,
      message || null, tourSlug || null, tourName || null,
      isDemo ? 1 : 0,
    ),
  ];

  // Codes are generated up front so the webhook stays fast and idempotent.
  const seen = new Set();
  while (seen.size < quantity) seen.add(generateCode());
  for (const code of seen) {
    stmts.push(env.DB.prepare(
      `INSERT INTO vouchers (order_id, code, amount_pence, balance_pence, status)
       VALUES (?,?,?,?,'pending')`,
    ).bind(orderId, code, amountPence, amountPence));
  }

  try {
    await env.DB.batch(stmts);
  } catch (err) {
    // Astronomically unlikely (code collision across orders) — retry is the user's cheapest fix.
    console.error('order insert failed', err);
    return Response.json({ error: 'Could not start checkout. Please try again.' }, { status: 500 });
  }

  return Response.json({ url: session.url, orderId });
}
