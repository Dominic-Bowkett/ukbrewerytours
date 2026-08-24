// POST /api/admin/resend — correct the delivery email on an order and resend
// the voucher email. Body: { code, email? }
//
// The email covers the whole order (one email lists every code on it), same as
// the original send. Only paid orders qualify — pending orders have no live
// codes to deliver.

import { normaliseCode } from '../../_lib/codes.js';
import { sendEmail, voucherEmailHtml } from '../../_lib/email.js';
import { orderToken } from '../../_lib/auth.js';

const isEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim());

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const code = normaliseCode(body.code || '');
  if (!code) return Response.json({ error: 'Enter a voucher code.' }, { status: 400 });

  const voucher = await env.DB.prepare('SELECT * FROM vouchers WHERE code=?').bind(code).first();
  if (!voucher) return Response.json({ error: 'Voucher not found.' }, { status: 404 });

  const order = await env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(voucher.order_id).first();
  if (!order || order.status !== 'paid') {
    return Response.json({ error: 'This order has not been paid for — there is nothing to send.' }, { status: 409 });
  }

  // Optional new delivery address. send_to_self orders deliver to the
  // purchaser, so that is the field a typo lives in.
  const newEmail = String(body.email || '').trim();
  if (newEmail) {
    if (!isEmail(newEmail) || /[\r\n]/.test(newEmail)) {
      return Response.json({ error: 'That does not look like a valid email address.' }, { status: 400 });
    }
    const field = order.send_to_self === 1 ? 'purchaser_email' : 'recipient_email';
    if (newEmail !== order[field]) {
      await env.DB.prepare(`UPDATE orders SET ${field}=? WHERE id=?`).bind(newEmail, order.id).run();
      order[field] = newEmail;
    }
  }

  const deliverTo = order.send_to_self === 1 ? order.purchaser_email : order.recipient_email;
  if (!deliverTo) return Response.json({ error: 'No delivery email on this order.' }, { status: 400 });

  const { results: vouchers } = await env.DB
    .prepare('SELECT code, amount_pence FROM vouchers WHERE order_id=? ORDER BY id')
    .bind(order.id).all();

  const origin = env.BASE_URL || new URL(request.url).origin;
  const token = await orderToken(order.id, env.ADMIN_SESSION_SECRET);
  const printUrl = `${origin}/my-vouchers/?order=${order.id}&t=${token}`;

  try {
    await sendEmail(env, {
      to: deliverTo,
      subject: order.send_to_self === 1
        ? `Your UK Brewery Tours gift voucher${vouchers.length > 1 ? 's' : ''}`
        : `${order.purchaser_name || 'Someone'} has sent you a UK Brewery Tours gift voucher`,
      html: voucherEmailHtml({ order, vouchers, printUrl }),
      replyTo: 'info@ukbrewerytours.com',
    });
  } catch (err) {
    // The address change (if any) has been saved — only the send failed.
    console.error('admin resend failed', order.id, err);
    return Response.json({ error: 'The email could not be sent — the address change was saved. Try again in a minute.' }, { status: 502 });
  }

  // If the original delivery failed this also settles the webhook retry loop.
  await env.DB.prepare('UPDATE orders SET email_sent=1 WHERE id=?').bind(order.id).run();

  return Response.json({ ok: true, sent_to: deliverTo, codes: vouchers.length });
}
