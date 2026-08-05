// POST /api/admin/refund — refund money to the customer's card (full or partial).
// Body: { code, amount?, full?: true, reason?, note? }
//
// Refunding also removes the value from the voucher balance, so a refunded
// voucher can't still be spent on a tour.

import { normaliseCode, formatMoney } from '../../_lib/codes.js';
import { createRefund } from '../../_lib/stripe.js';

export async function onRequestPost({ request, env, data }) {
  if (!env.STRIPE_SECRET_KEY) {
    return Response.json({ error: 'Stripe is not configured.' }, { status: 503 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const code = normaliseCode(body.code || '');
  if (!code) return Response.json({ error: 'Enter a voucher code.' }, { status: 400 });

  const voucher = await env.DB.prepare(`
    SELECT v.*, o.stripe_payment_intent, o.purchaser_email
    FROM vouchers v JOIN orders o ON o.id = v.order_id
    WHERE v.code = ?`).bind(code).first();

  if (!voucher) return Response.json({ error: 'Voucher not found.' }, { status: 404 });
  if (voucher.status === 'pending') {
    return Response.json({ error: 'This voucher was never paid for — nothing to refund.' }, { status: 409 });
  }
  if (!voucher.stripe_payment_intent) {
    return Response.json({ error: 'No Stripe payment is linked to this voucher, so it cannot be refunded automatically.' }, { status: 409 });
  }

  // Refundable = what was paid, less anything already refunded. Redeemed value
  // is deliberately still refundable — that call is the operator's to make.
  const alreadyRefunded = voucher.refunded_pence || 0;
  const maxRefund = voucher.amount_pence - alreadyRefunded;
  if (maxRefund <= 0) {
    return Response.json({ error: 'This voucher has already been fully refunded.' }, { status: 409 });
  }

  const full = body.full === true || body.full === 'true';
  const amountPence = full ? maxRefund : Math.round(Number(body.amount) * 100);

  if (!Number.isFinite(amountPence) || amountPence <= 0) {
    return Response.json({ error: 'Enter an amount to refund.' }, { status: 400 });
  }
  if (amountPence > maxRefund) {
    return Response.json({ error: `Amount exceeds the refundable ${formatMoney(maxRefund)}.` }, { status: 400 });
  }

  // Refund through Stripe first: if it fails, nothing is written locally.
  let refund;
  try {
    refund = await createRefund(env, {
      paymentIntent: voucher.stripe_payment_intent,
      amountPence,
      reason: body.reason,
      // Same voucher + same running total = same key, so retries can't double-refund.
      idempotencyKey: `refund-${voucher.id}-${alreadyRefunded}-${amountPence}`,
    });
  } catch (err) {
    console.error('stripe refund failed', code, err);
    return Response.json({ error: `Stripe refused the refund: ${err.message}` }, { status: 502 });
  }

  const refundedTotal = alreadyRefunded + amountPence;
  // Take the refunded value off the balance so it can't also be spent.
  const newBalance = Math.max(0, voucher.balance_pence - amountPence);
  const fullyRefunded = refundedTotal >= voucher.amount_pence;
  const newStatus = fullyRefunded
    ? 'refunded'
    : (newBalance === 0 ? 'redeemed' : (newBalance < voucher.amount_pence ? 'partially_redeemed' : voucher.status));

  await env.DB.batch([
    env.DB.prepare('UPDATE vouchers SET refunded_pence=?, balance_pence=?, status=? WHERE id=?')
      .bind(refundedTotal, newBalance, newStatus, voucher.id),
    env.DB.prepare(
      `INSERT INTO refunds (voucher_id, order_id, amount_pence, stripe_refund_id, reason, note, refunded_by)
       VALUES (?,?,?,?,?,?,?)`,
    ).bind(
      voucher.id, voucher.order_id, amountPence, refund.id || null,
      body.reason || null,
      String(body.note || '').trim().slice(0, 300) || null,
      data?.user?.email || 'admin',
    ),
  ]);

  return Response.json({
    ok: true,
    code,
    refunded_pence: amountPence,
    refunded_total_pence: refundedTotal,
    balance_pence: newBalance,
    status: newStatus,
    stripe_refund_id: refund.id,
  });
}
