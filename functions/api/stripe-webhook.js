// POST /api/stripe-webhook
// Stripe's payment confirmation. Marks the order paid, activates the voucher
// codes, then emails the voucher + receipt.
//
// Idempotency: Stripe retries on non-2xx. `orders.status` guards the DB write
// and `orders.email_sent` guards the emails, so a retry never double-sends.

import { verifyWebhook } from '../_lib/stripe.js';
import { sendEmail, voucherEmailHtml, receiptEmailHtml, saleNotificationHtml } from '../_lib/email.js';
import { orderToken } from '../_lib/auth.js';

export async function onRequestPost({ request, env }) {
  const raw = await request.text();
  const event = await verifyWebhook(raw, request.headers.get('stripe-signature'), env.STRIPE_WEBHOOK_SECRET);
  if (!event) return new Response('Invalid signature', { status: 400 });

  if (event.type !== 'checkout.session.completed') return new Response('ignored', { status: 200 });

  const session = event.data.object;
  const order = await env.DB.prepare('SELECT * FROM orders WHERE stripe_session_id = ?')
    .bind(session.id).first();

  // Unknown session — nothing to do, but 200 so Stripe stops retrying.
  if (!order) {
    console.error('webhook for unknown session', session.id);
    return new Response('unknown order', { status: 200 });
  }

  // Mark paid once. A retry after a successful mark skips straight to email.
  if (order.status !== 'paid') {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE orders SET status='paid', paid_at=datetime('now'), stripe_payment_intent=?
         WHERE id=? AND status!='paid'`,
      ).bind(session.payment_intent || null, order.id),
      env.DB.prepare(
        `UPDATE vouchers SET status='active', paid_at=datetime('now')
         WHERE order_id=? AND status='pending'`,
      ).bind(order.id),
    ]);
  }

  if (order.email_sent === 1) return new Response('already sent', { status: 200 });

  const { results: vouchers } = await env.DB
    .prepare('SELECT code, amount_pence FROM vouchers WHERE order_id=? ORDER BY id')
    .bind(order.id).all();

  try {
    const deliverTo = order.send_to_self === 1 ? order.purchaser_email : order.recipient_email;

    // Signed link to the printable version — unguessable, and scoped to this order.
    const origin = env.BASE_URL || new URL(request.url).origin;
    const token = await orderToken(order.id, env.ADMIN_SESSION_SECRET);
    const printUrl = `${origin}/my-vouchers/?order=${order.id}&t=${token}`;

    await sendEmail(env, {
      to: deliverTo,
      subject: order.send_to_self === 1
        ? `Your UK Brewery Tours gift voucher${vouchers.length > 1 ? 's' : ''}`
        : `${order.purchaser_name || 'Someone'} has sent you a UK Brewery Tours gift voucher`,
      html: voucherEmailHtml({ order, vouchers, printUrl }),
      replyTo: 'info@ukbrewerytours.com',
    });

    // Receipt to the purchaser — skipped when it would duplicate the voucher email.
    if (order.send_to_self !== 1) {
      await sendEmail(env, {
        to: order.purchaser_email,
        subject: 'Receipt — your UK Brewery Tours gift voucher',
        html: receiptEmailHtml({ order, vouchers }),
      });
    }

    await env.DB.prepare('UPDATE orders SET email_sent=1 WHERE id=?').bind(order.id).run();

    // Internal heads-up. Deliberately after email_sent is set and swallowed on
    // failure — a missed notification must never re-trigger the customer emails.
    try {
      const widget = order.widget_id
        ? await env.DB.prepare('SELECT name FROM widgets WHERE id = ?').bind(order.widget_id).first()
        : null;
      await sendEmail(env, {
        to: env.NOTIFY_EMAIL || 'info@ukbrewerytours.com',
        subject: `New voucher sale — ${(order.total_pence / 100).toFixed(2)} GBP (${order.purchaser_name || order.purchaser_email})`,
        html: saleNotificationHtml({ order, vouchers, widget }),
        replyTo: order.purchaser_email,
      });
    } catch (err) {
      console.error('sale notification failed (customer emails were sent)', order.id, err);
    }
  } catch (err) {
    // Payment is recorded; only delivery failed. 500 makes Stripe retry, and
    // email_sent=0 means the retry re-attempts just the email.
    console.error('voucher email failed', order.id, err);
    return new Response('email failed', { status: 500 });
  }

  return new Response('ok', { status: 200 });
}
