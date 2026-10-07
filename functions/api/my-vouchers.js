// GET /api/my-vouchers?order=<id>&t=<token>
// Public but unguessable: the token is an HMAC of the order id, so a customer
// can only ever see their own vouchers. Returns just what the printable
// voucher needs — no email addresses, no payment details.

import { verifyOrderToken } from '../_lib/auth.js';
import { voucherHolderName, isSendToSelf } from '../_lib/email.js';

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const orderId = url.searchParams.get('order') || '';
  const token = url.searchParams.get('t') || '';

  const deny = () => Response.json({ error: 'This link is not valid.' }, { status: 403 });

  if (!env.ADMIN_SESSION_SECRET) return Response.json({ error: 'Not configured.' }, { status: 503 });
  if (!(await verifyOrderToken(orderId, token, env.ADMIN_SESSION_SECRET))) return deny();

  const order = await env.DB.prepare(
    'SELECT id, status, quantity, recipient_name, purchaser_name, send_to_self, message, tour_name, tour_slug FROM orders WHERE id = ?',
  ).bind(orderId).first();

  // Unpaid orders must never expose a code.
  if (!order || order.status !== 'paid') return deny();

  const { results: vouchers } = await env.DB.prepare(
    "SELECT code, amount_pence, balance_pence, status FROM vouchers WHERE order_id = ? AND status != 'pending' ORDER BY id",
  ).bind(orderId).all();

  if (!vouchers.length) return deny();

  // "For …" on the printed sheet. A send-to-self order shows the buyer's own
  // name unless admin made it out to someone else, in which case the buyer
  // signs the message as the giver.
  const holderName = voucherHolderName(order) || null;
  const selfNamed = isSendToSelf(order) && !order.recipient_name;

  return Response.json({
    order: {
      recipient_name: holderName,
      from_name: selfNamed ? null : (order.purchaser_name || null),
      message: order.message,
      tour_name: order.tour_name,
      tour_slug: order.tour_slug,
    },
    vouchers,
  }, {
    // Contains voucher codes — never let a shared cache hold on to it.
    headers: { 'Cache-Control': 'private, no-store' },
  });
}
