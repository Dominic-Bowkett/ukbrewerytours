// POST /api/admin/names — correct the names on an order.
// Body: { code, recipient_name?, purchaser_name? }
//
// recipient_name is the name printed on the voucher ("For …"). On a send-to-self
// order it is normally empty (the buyer's own name is used); setting it turns
// the voucher into one made out to someone else while the buyer keeps the
// email — e.g. a customer who bought it under their own name to hand over in
// person. Clearing it puts the buyer's name back.
//
// Saving only changes the order. The customer's existing print link reads live
// data so it updates on its own; use Delivery → "Save & resend" to email a
// fresh copy.

import { normaliseCode } from '../../_lib/codes.js';

const cleanName = s => String(s ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 80);

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const code = normaliseCode(body.code || '');
  if (!code) return Response.json({ error: 'Enter a voucher code.' }, { status: 400 });

  const voucher = await env.DB.prepare('SELECT order_id FROM vouchers WHERE code=?').bind(code).first();
  if (!voucher) return Response.json({ error: 'Voucher not found.' }, { status: 404 });

  const order = await env.DB.prepare(
    'SELECT id, purchaser_name, recipient_name, send_to_self FROM orders WHERE id=?',
  ).bind(voucher.order_id).first();
  if (!order) return Response.json({ error: 'Order not found.' }, { status: 404 });

  const sets = [];
  const args = [];
  const changed = {};

  if ('recipient_name' in body) {
    const name = cleanName(body.recipient_name);
    // A gift to someone else must keep a recipient name; only send-to-self
    // orders may fall back to the buyer's own name.
    if (!name && Number(order.send_to_self) !== 1) {
      return Response.json({ error: 'A gift needs the recipient’s name.' }, { status: 400 });
    }
    const value = name || null;
    if (value !== (order.recipient_name || null)) {
      sets.push('recipient_name=?'); args.push(value); changed.recipient_name = value;
    }
  }

  if ('purchaser_name' in body) {
    const name = cleanName(body.purchaser_name);
    if (!name) return Response.json({ error: 'Enter the buyer’s name.' }, { status: 400 });
    if (name !== (order.purchaser_name || '')) {
      sets.push('purchaser_name=?'); args.push(name); changed.purchaser_name = name;
    }
  }

  if (sets.length) {
    await env.DB.prepare(`UPDATE orders SET ${sets.join(', ')} WHERE id=?`).bind(...args, order.id).run();
  }

  return Response.json({ ok: true, changed });
}
