// POST /api/admin/resend — send the voucher email again, optionally to a
// corrected address. Body: { code, email?, name?, updateAddress?: true, note? }
//
// The common case is a buyer who mistyped the recipient's address at checkout:
// the payment is fine and the codes are live, only the delivery went astray.
// Nothing is charged, no code is reissued — it is the same email again.

import { normaliseCode } from '../../_lib/codes.js';
import { sendEmail, voucherEmailHtml } from '../../_lib/email.js';
import { orderToken } from '../../_lib/auth.js';

const isEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim());
const clean = (s, max) => String(s ?? '').trim().slice(0, max);

export async function onRequestPost({ request, env, data }) {
  if (!env.RESEND_API_KEY) {
    return Response.json({ error: 'Email is not configured.' }, { status: 503 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const code = normaliseCode(body.code || '');
  if (!code) return Response.json({ error: 'Enter a voucher code.' }, { status: 400 });

  const voucher = await env.DB.prepare(
    'SELECT order_id FROM vouchers WHERE code = ?',
  ).bind(code).first();
  if (!voucher) return Response.json({ error: 'Voucher not found.' }, { status: 404 });

  const order = await env.DB.prepare('SELECT * FROM orders WHERE id = ?')
    .bind(voucher.order_id).first();
  if (!order) return Response.json({ error: 'Order not found.' }, { status: 404 });

  // An unpaid order has no live code, so there is nothing legitimate to send.
  if (order.status !== 'paid') {
    return Response.json({ error: 'This order was never paid for — there is no voucher to send.' }, { status: 409 });
  }

  const toSelf = order.send_to_self === 1;
  const currentEmail = toSelf ? order.purchaser_email : order.recipient_email;

  const sendTo = (clean(body.email, 200) || currentEmail || '').toLowerCase();
  if (!isEmail(sendTo)) return Response.json({ error: 'Enter a valid email address to send to.' }, { status: 400 });

  const name = clean(body.name, 100);
  const updateAddress = body.updateAddress === true || body.updateAddress === 'true';
  if (updateAddress && toSelf) {
    return Response.json({
      error: 'This voucher was bought for the buyer themselves, so there is no separate delivery address to change. Resend without ticking that box.',
    }, { status: 400 });
  }

  // Correct the order first: if the send fails, the record still points at the
  // address the operator confirmed, and a retry uses it.
  const addressChanged = updateAddress
    && (sendTo !== (order.recipient_email || '').toLowerCase() || (name && name !== (order.recipient_name || '')));

  if (addressChanged) {
    await env.DB.prepare(
      'UPDATE orders SET recipient_email=?, recipient_name=? WHERE id=?',
    ).bind(sendTo, name || order.recipient_name || null, order.id).run();
    order.recipient_email = sendTo;
    if (name) order.recipient_name = name;
  } else if (name && !toSelf) {
    // Name given for this send only — greet them correctly without rewriting the order.
    order.recipient_name = name;
  }

  const { results: vouchers } = await env.DB
    .prepare('SELECT code, amount_pence FROM vouchers WHERE order_id=? ORDER BY id')
    .bind(order.id).all();

  const origin = env.BASE_URL || new URL(request.url).origin;
  const token = await orderToken(order.id, env.ADMIN_SESSION_SECRET);
  const printUrl = `${origin}/my-vouchers/?order=${order.id}&t=${token}`;

  try {
    await sendEmail(env, {
      to: sendTo,
      subject: toSelf
        ? `Your UK Brewery Tours gift voucher${vouchers.length > 1 ? 's' : ''}`
        : `${order.purchaser_name || 'Someone'} has sent you a UK Brewery Tours gift voucher`,
      html: voucherEmailHtml({ order, vouchers, printUrl }),
      replyTo: 'info@ukbrewerytours.com',
    });
  } catch (err) {
    console.error('voucher resend failed', order.id, err);
    return Response.json({ error: 'The email could not be sent. Try again in a moment.' }, { status: 502 });
  }

  // A resend after a failed first attempt counts as delivered, so the Stripe
  // webhook retry does not send a second copy.
  await env.DB.prepare('UPDATE orders SET email_sent=1 WHERE id=?').bind(order.id).run();

  await env.DB.prepare(
    `INSERT INTO deliveries (order_id, sent_to, recipient_name, kind, address_updated, previous_email, note, sent_by)
     VALUES (?,?,?,'resend',?,?,?,?)`,
  ).bind(
    order.id,
    sendTo,
    order.recipient_name || null,
    addressChanged ? 1 : 0,
    addressChanged ? (currentEmail || null) : null,
    clean(body.note, 300) || null,
    data?.user?.email || 'admin',
  ).run();

  return Response.json({
    ok: true,
    sent_to: sendTo,
    address_updated: addressChanged,
    voucher_count: vouchers.length,
  });
}
