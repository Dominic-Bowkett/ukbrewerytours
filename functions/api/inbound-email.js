// POST /api/inbound-email — Resend's email.received webhook.
//
// Every email we send carries a Reply-To of reply-<token>@<INBOUND_REPLY_DOMAIN>,
// so a customer's reply names its own conversation and lands back on that thread.
// Mail to an address with no token (or an unknown one) is matched to the sender's
// most recent open conversation, and otherwise starts a new one.
//
// Public, but signed: Svix headers are verified against INBOUND_WEBHOOK_SECRET
// before anything is read. Retries are deduped on the message id.

import {
  verifySvix, parseAddress, tokenFromRecipients, stripQuoted, htmlToText, notificationReason, siteMail,
} from '../_lib/inbound.js';
import {
  TOKEN_RE, appendCustomerMessage, alertAdmin, createEnquiry, voucherCheck, cleanFields,
} from '../_lib/inbox.js';
import { saveInbound } from '../_lib/attachments.js';

const MAX_BODY = 20000;

export async function onRequestPost({ request, env, waitUntil }) {
  if (!env.INBOUND_WEBHOOK_SECRET) {
    return Response.json({ error: 'Inbound email is not configured.' }, { status: 503 });
  }

  const raw = await request.text();
  if (!(await verifySvix(request, raw, env.INBOUND_WEBHOOK_SECRET))) {
    return Response.json({ error: 'Bad signature.' }, { status: 401 });
  }

  let event;
  try { event = JSON.parse(raw); } catch { return Response.json({ ok: true }); }
  if (event?.type !== 'email.received') return Response.json({ ok: true, ignored: event?.type || 'unknown' });

  // Anything after this point answers 200: a failure we retry into is worse than
  // one we can see in the logs, and Resend retries on any non-2xx.
  try {
    await ingest(env, event.data || {}, waitUntil);
  } catch (err) {
    console.error('inbound email ingest failed', err);
  }
  return Response.json({ ok: true });
}

async function ingest(env, data, waitUntil) {
  const messageId = String(data.message_id || data.email_id || '').slice(0, 200);
  if (messageId) {
    const seen = await env.DB.prepare('SELECT 1 AS x FROM enquiry_messages WHERE email_id = ?').bind(messageId).first();
    if (seen) return;                                   // webhook retry
  }

  // The webhook carries metadata only; the body comes from the API. Reading a
  // received email needs a full-access key, which the sending key may not be —
  // hence a separate INBOUND_API_KEY, falling back to the sending one.
  const apiKey = env.INBOUND_API_KEY || env.RESEND_API_KEY;
  let full = {};
  if (data.email_id && apiKey) {
    try {
      const res = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(data.email_id)}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) full = await res.json();
      else console.error('inbound fetch failed', res.status, (await res.text()).slice(0, 200));
    } catch (err) {
      console.error('inbound fetch error', err);
    }
  }

  const from = parseAddress(full.from || data.from);
  const subject = String(full.subject || data.subject || '(no subject)').slice(0, 200);
  // Normally from the API call above; a webhook payload that carries its own
  // headers (or a replayed test) is just as good.
  const headers = full.headers || data.headers || {};

  // Stripe receipts, DesignMyNight bookings, Google security mail, bounces,
  // out-of-office replies: filed as notifications, never alerted on, never shown
  // to a team member. `reason` is null when a person wrote the message.
  // The site's own mail to info@ (voucher sales, ops alerts) comes back this way
  // too; sales get a folder of their own.
  const own = siteMail(from.email, subject, env.FROM_EMAIL);
  const reason = own ? own.reason : notificationReason(headers, from.email, env.NOTIFICATION_SENDERS);

  // Resend's webhook is metadata-only, so the body normally comes from the API
  // call above; a payload that does carry one (or a replayed test) still works.
  let body = stripQuoted(full.text || data.text || htmlToText(full.html || data.html)).slice(0, MAX_BODY);
  // The files themselves are fetched and kept once the message is saved (see
  // keepFiles); only the alert email names them.
  const attachments = full.attachments || data.attachments || [];
  const attachmentNames = attachments.map(a => a.filename || 'photo');
  if (!body.trim()) {
    body = attachments.length
      ? `📎 Sent ${attachments.length === 1 ? 'an attachment' : `${attachments.length} attachments`}`
      : '(no message body)';
  }

  // 1. The reply address names the conversation.
  const token = tokenFromRecipients(data.to, data.received_for, data.cc, full.to, full.reply_to);
  let enquiry = null;
  if (token && TOKEN_RE.test(token)) {
    enquiry = await env.DB.prepare('SELECT * FROM enquiries WHERE token = ? AND deleted_at IS NULL').bind(token).first();
  }

  // 2. Otherwise the sender's most recent conversation, if it is still live.
  //    People only: a Stripe receipt must never land on a customer's thread
  //    just because the two addresses happen to match.
  if (!enquiry && !reason && from.email) {
    enquiry = await env.DB.prepare(
      `SELECT * FROM enquiries WHERE lower(email) = ? AND last_message_at > datetime('now','-90 days')
         AND is_notification = 0 AND deleted_at IS NULL
        ORDER BY COALESCE(last_message_at, created_at) DESC LIMIT 1`,
    ).bind(from.email).first();
  }

  if (enquiry) {
    // An out-of-office or a bounce belongs on the thread it answers, but it is
    // not the customer coming back: file it quietly.
    await appendCustomerMessage(env, enquiry, {
      body, channel: 'email', author: from.name || enquiry.name, silent: Boolean(reason),
    });
    await stampEmailId(env, enquiry.id, messageId);
    keepFiles(env, enquiry.id, data.email_id, full.html || data.html, attachments.length, waitUntil);
    if (reason) return;
  } else {
    // 3. A new conversation, started by email — or a notification, filed away.
    const created = await createEnquiry(env, {
      name: own?.name || from.name || 'Email enquiry',
      email: from.email,
      phone: null,
      message: body,
      page: null,
      ip: null,
      widgetId: null,
      widgetOrigin: null,
      type: guessType(subject),
      channel: 'email',
      site: 'ukbrewerytours.com',
      fields: cleanFields({}),
      voucherCode: null,
      subject,
      notification: reason,
      notificationKind: own?.kind || null,
    });
    await stampEmailId(env, created.id, messageId);
    keepFiles(env, created.id, data.email_id, full.html || data.html, attachments.length, waitUntil);
    if (reason) return;
    enquiry = { id: created.id, token: created.token, name: from.name, email: from.email, type: 'general', channel: 'email', site: 'ukbrewerytours.com', subject };
  }

  try {
    const { matches, unmatched } = await voucherCheck(env, enquiry, [body, subject]);
    const alertBody = attachmentNames.length ? `${body}\n\n📎 ${attachmentNames.join(', ')}` : body;
    await alertAdmin(env, enquiry, { body: alertBody, followUp: true, matches, unmatched });
  } catch (err) {
    console.error('inbound alert failed', err);
  }
}

/** Record the source message id on the message just written, for retry dedupe. */
async function stampEmailId(env, enquiryId, messageId) {
  if (!messageId) return;
  await env.DB.prepare(
    `UPDATE enquiry_messages SET email_id = ?
      WHERE id = (SELECT MAX(id) FROM enquiry_messages WHERE enquiry_id = ? AND direction = 'in')`,
  ).bind(messageId, enquiryId).run();
}

/**
 * Keep the email's attachments and original HTML against the message just
 * written. Runs after the response — downloading a few photos can outlast
 * Resend's webhook timeout. The Resend id is stored on the message either way,
 * so anything that fails here can be fetched again (POST /api/admin/inbox/attachments-backfill).
 */
function keepFiles(env, enquiryId, inboundId, html, count, waitUntil) {
  if (!inboundId) return;
  const job = (async () => {
    const msg = await env.DB.prepare(
      "SELECT MAX(id) AS id FROM enquiry_messages WHERE enquiry_id = ? AND direction = 'in'",
    ).bind(enquiryId).first();
    if (!msg?.id) return;
    await env.DB.prepare('UPDATE enquiry_messages SET inbound_id = ? WHERE id = ?').bind(String(inboundId), msg.id).run();
    if (!count && !html) return;
    await saveInbound(env, { enquiryId, messageId: msg.id, inboundId: String(inboundId), html: html || null });
  })().catch(err => console.error('saving inbound attachments failed', err));
  if (waitUntil) waitUntil(job);
}

/** Subject-line hints when an email starts a conversation from nothing. */
function guessType(subject) {
  const s = String(subject || '').toLowerCase();
  if (/voucher|redeem|gift card/.test(s)) return /buy|purchase|order/.test(s) ? 'voucher' : 'redemption';
  if (/group|private|stag|hen|corporate|team building/.test(s)) return 'group';
  if (/book|availab|date|ticket/.test(s)) return 'booking';
  return 'general';
}
