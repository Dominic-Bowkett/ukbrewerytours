// GET /api/admin/voucher/:code — full detail plus redemption history.

import { normaliseCode } from '../../../_lib/codes.js';

export async function onRequestGet({ params, env }) {
  const code = normaliseCode(decodeURIComponent(params.code || ''));

  const voucher = await env.DB.prepare(`
    SELECT v.*, o.purchaser_name, o.purchaser_email, o.recipient_name, o.recipient_email,
           o.send_to_self, o.message, o.tour_name, o.tour_slug, o.total_pence,
           o.quantity, o.is_demo, o.created_at AS order_created_at
    FROM vouchers v JOIN orders o ON o.id = v.order_id
    WHERE v.code = ?`).bind(code).first();

  if (!voucher) return Response.json({ error: 'Voucher not found.' }, { status: 404 });

  const { results: redemptions } = await env.DB.prepare(
    'SELECT amount_pence, balance_after_pence, redeemed_by, note, created_at FROM redemptions WHERE voucher_id=? ORDER BY id DESC',
  ).bind(voucher.id).all();

  return Response.json({ voucher, redemptions });
}
