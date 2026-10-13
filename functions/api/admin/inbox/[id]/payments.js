// /api/admin/inbox/:id/payments
//   POST  { amount, description, body?, send?, status? }
//         Create a payment request. With send (the default, when there is an
//         email address) it goes to the customer as a reply on this thread —
//         your message plus a Pay button. Without, it is only created, for the
//         link to be copied into a text or WhatsApp.
//   PATCH { payment_id, cancel: true } — the link stops working.
//
// Logged on the conversation only; vouchers are untouched.

import { sendEmail, inboxReplyHtml } from '../../../../_lib/email.js';
import { STATUSES, brandFor, threadUrl, replyAddress, logEvent } from '../../../../_lib/inbox.js';
import {
  MIN_PENCE, MAX_PENCE, pounds, parsePounds, createPaymentRequest, paymentsFor,
} from '../../../../_lib/inbox-payments.js';

async function load(env, id) {
  if (!/^\d+$/.test(String(id))) return null;
  return env.DB.prepare('SELECT * FROM enquiries WHERE id = ? AND deleted_at IS NULL').bind(Number(id)).first();
}

export async function onRequestPost({ params, request, env, data }) {
  const enquiry = await load(env, params.id);
  if (!enquiry) return Response.json({ error: 'Conversation not found.' }, { status: 404 });
  if (!env.STRIPE_SECRET_KEY) return Response.json({ error: 'Stripe is not configured.' }, { status: 503 });

  let body;
  try { body = await request.json(); } catch { return Response.json({ error: 'Invalid request.' }, { status: 400 }); }

  const amountPence = parsePounds(body.amount);
  if (!amountPence || amountPence < MIN_PENCE) return Response.json({ error: `The smallest payment is ${pounds(MIN_PENCE)}.` }, { status: 400 });
  if (amountPence > MAX_PENCE) return Response.json({ error: `That is more than ${pounds(MAX_PENCE)} — check the amount.` }, { status: 400 });
  const description = String(body.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Top-up payment';

  const hasEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(enquiry.email || ''));
  const send = body.send !== false && hasEmail;
  const text = String(body.body ?? '').replace(/\r\n/g, '\n').trim().slice(0, 20000);
  if (send && text.length < 2) return Response.json({ error: 'Write the message to go with the link.' }, { status: 400 });
  if (send && !env.RESEND_API_KEY) return Response.json({ error: 'Email is not configured.' }, { status: 503 });

  const who = data?.user?.email || 'admin';
  const pay = await createPaymentRequest(env, enquiry, { amountPence, description, who });
  const amount = pounds(amountPence);

  if (!send) {
    await logEvent(env, enquiry.id, `💷 Payment link made for ${amount} — ${description} (not emailed)`, who);
    return Response.json({ ok: true, url: pay.url, sent: false, payments: await paymentsFor(env, enquiry.id) });
  }

  const subject = enquiry.subject || `Your enquiry — ${brandFor(enquiry.site)}`;
  let sent;
  try {
    sent = await sendEmail(env, {
      to: enquiry.email,
      subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
      html: inboxReplyHtml({
        body: text,
        threadLink: threadUrl(enquiry.token),
        brand: brandFor(enquiry.site),
        pay: { url: pay.url, amount, description },
      }),
      replyTo: replyAddress(env, enquiry.token),
    });
  } catch (err) {
    // Nothing reached the customer, so the request should not linger as if it had.
    await env.DB.prepare("UPDATE inbox_payments SET status = 'cancelled', cancelled_at = datetime('now') WHERE id = ?").bind(pay.id).run();
    console.error('payment request email failed', err);
    return Response.json({ error: `The email could not be sent: ${String(err.message || err).slice(0, 200)}` }, { status: 502 });
  }

  const status = STATUSES[body.status] ? body.status : 'waiting';
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO enquiry_messages (enquiry_id, direction, channel, body, author, email_id) VALUES (?,?,?,?,?,?)',
    ).bind(enquiry.id, 'out', 'email', `${text}\n\n💷 Pay ${amount} — ${description}`, who, sent?.id || null),
    env.DB.prepare(
      `UPDATE enquiries SET status = ?, unread = 0, alerted_at = NULL, last_message_at = datetime('now'),
         closed_at = CASE WHEN ? = 'closed' THEN datetime('now') ELSE NULL END
       WHERE id = ?`,
    ).bind(status, status, enquiry.id),
  ]);
  await logEvent(env, enquiry.id, `💷 Payment link sent for ${amount} — ${description}`, who);

  return Response.json({ ok: true, url: pay.url, sent: true, payments: await paymentsFor(env, enquiry.id) });
}

export async function onRequestPatch({ params, request, env, data }) {
  if (!/^\d+$/.test(String(params.id))) return Response.json({ error: 'Conversation not found.' }, { status: 404 });
  let body;
  try { body = await request.json(); } catch { return Response.json({ error: 'Invalid request.' }, { status: 400 }); }
  if (!body.cancel) return Response.json({ error: 'Nothing to change.' }, { status: 400 });

  const pay = await env.DB.prepare('SELECT * FROM inbox_payments WHERE id = ? AND enquiry_id = ?')
    .bind(Number(body.payment_id), Number(params.id)).first();
  if (!pay) return Response.json({ error: 'Payment request not found.' }, { status: 404 });
  if (pay.status === 'paid') return Response.json({ error: 'That one has been paid — refund it in Stripe instead.' }, { status: 409 });

  if (pay.status === 'open') {
    await env.DB.prepare("UPDATE inbox_payments SET status = 'cancelled', cancelled_at = datetime('now') WHERE id = ? AND status = 'open'")
      .bind(pay.id).run();
    await logEvent(env, pay.enquiry_id, `Payment link for ${pounds(pay.amount_pence)} cancelled — it no longer works`, data?.user?.email || 'admin');
  }
  return Response.json({ ok: true, payments: await paymentsFor(env, pay.enquiry_id) });
}
