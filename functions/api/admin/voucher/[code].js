// GET /api/admin/voucher/:code — full detail plus redemption, refund and
// delivery history.

import { normaliseCode } from '../../../_lib/codes.js';

export async function onRequestGet({ params, env }) {
  const code = normaliseCode(decodeURIComponent(params.code || ''));

  const voucher = await env.DB.prepare(`
    SELECT v.*, o.purchaser_name, o.purchaser_email, o.recipient_name, o.recipient_email,
           o.send_to_self, o.message, o.tour_name, o.tour_slug, o.total_pence,
           o.quantity, o.is_demo, o.created_at AS order_created_at,
           o.widget_id, o.widget_origin, w.name AS widget_name,
           o.email_sent, o.status AS order_status
    FROM vouchers v JOIN orders o ON o.id = v.order_id
    LEFT JOIN widgets w ON w.id = o.widget_id
    WHERE v.code = ?`).bind(code).first();

  if (!voucher) return Response.json({ error: 'Voucher not found.' }, { status: 404 });

  const { results: redemptions } = await env.DB.prepare(
    'SELECT amount_pence, balance_after_pence, redeemed_by, note, created_at FROM redemptions WHERE voucher_id=? ORDER BY id DESC',
  ).bind(voucher.id).all();

  const { results: refunds } = await env.DB.prepare(
    'SELECT amount_pence, stripe_refund_id, reason, note, refunded_by, created_at FROM refunds WHERE voucher_id=? ORDER BY id DESC',
  ).bind(voucher.id).all();

  // Tolerated separately: code and D1 migrations deploy independently, so this
  // table can be missing for a few minutes. History is worth losing; the redeem
  // and refund screen this feeds is not.
  let deliveries = [];
  try {
    ({ results: deliveries } = await env.DB.prepare(
      'SELECT sent_to, recipient_name, kind, address_updated, previous_email, note, sent_by, created_at FROM deliveries WHERE order_id=? ORDER BY id DESC',
    ).bind(voucher.order_id).all());
  } catch (err) {
    console.error('delivery history unavailable', voucher.order_id, err);
  }

  return Response.json({ voucher, redemptions, refunds, deliveries });
}
