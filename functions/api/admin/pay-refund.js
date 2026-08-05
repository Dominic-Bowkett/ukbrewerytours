// POST /api/admin/pay-refund — refund a team payment request.
// Body: { id, amount?, full?: true, reason? }
//
// Admin only (functions/api/admin/_middleware.js). Team members cannot refund:
// a direct charge is on THEIR account, so the refund also reverses OUR fee, and
// that is a platform decision.
//
// Two things this route exists to get right:
//   * the refund is created ON the connected account (Stripe-Account header) —
//     a platform-scoped refund of a direct charge is simply not found;
//   * `refund_application_fee=true`, so the platform's 20% goes back with it.
//     Without it Stripe debits the connected account the full amount and the
//     platform keeps a fee it did not earn, out of the member's pocket.
// Both live in refundPaymentRequest(); this handler is validation plus the
// audit trail.

import { refundPaymentRequest, money } from '../../_lib/connect.js';

const NO_STORE = { 'Cache-Control': 'no-store' };
const bad = (error, status = 400) => Response.json({ error }, { status, headers: NO_STORE });

export async function onRequestPost({ request, env, data }) {
  if (!env.STRIPE_SECRET_KEY) return bad('Stripe is not configured.', 503);

  let body;
  try {
    body = await request.json();
  } catch {
    return bad('Invalid request.');
  }

  const id = String(body.id || '').trim();
  if (!id) return bad('Which request?');

  const row = await env.DB.prepare('SELECT * FROM payment_requests WHERE id = ?').bind(id).first();
  if (!row) return bad('Payment request not found.', 404);
  if (!row.stripe_account_id) return bad('This request has no connected account recorded.', 409);

  const paid = row.amount_paid_pence ?? row.amount_pence;
  const max = paid - (row.refunded_pence || 0);
  if (max <= 0) return bad('This request has already been fully refunded.', 409);

  const full = body.full === true || body.full === 'true';
  const amountPence = full ? max : Math.round(Number(body.amount) * 100);
  if (!Number.isFinite(amountPence) || amountPence <= 0) return bad('Enter an amount to refund.');
  if (amountPence > max) return bad(`Amount exceeds the refundable ${money(max)}.`);

  const res = await refundPaymentRequest(env, {
    row,
    amountPence,
    reason: body.reason || null,
    note: String(body.note || '').trim().slice(0, 300) || null,
    actor: `admin:${data?.user?.email || 'admin'}`,
  });

  if (!res.ok) return bad(res.error, 409);

  return Response.json({
    ok: true,
    id: row.id,
    refunded_pence: amountPence,
    refunded_total_pence: res.refundedTotal,
    stripe_refund_id: res.stripeRefundId,
  }, { headers: NO_STORE });
}
