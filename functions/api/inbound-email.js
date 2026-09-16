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
  verifySvix, parseAddress, tokenFromRecipients, stripQuoted, htmlToText, isAutomated,
} from '../_lib/inbound.js';
import {
  TOKEN_RE, appendCustomerMessage, alertAdmin, createEnquiry, voucherCheck, cleanFields,
} from '../_lib/inbox.js';

const MAX_BODY = 20000;

export async function onRequestPost({ request, env }) {
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
    await ingest(env, event.data || {});
  } catch (err) {
    console.error('inbound email ingest failed', err);
  }
  return Response.json({ ok: true });
}

async function ingest(env, data) {
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
  const headers = full.headers || {};
  if (isAutomated(headers, from.email)) {
    console.log('inbound: ignoring automated mail from', from.email);
    return;
  }

  // Resend's webhook is metadata-only, so the body normally comes from the API
  // call above; a payload that does carry one (or a replayed test) still works.
  let body = stripQuoted(full.text || data.text || htmlToText(full.html || data.html)).slice(0, MAX_BODY);
  const attachments = (full.attachments || data.attachments || []).map(a => a.filename).filter(Boolean);
  if (attachments.length) body += `\n\n[Attachments: ${attachments.join(', ')} — in the ${from.email} email]`;
  if (!body.trim()) body = '(no message body)';

  // 1. The reply address names the conversation.
  const token = tokenFromRecipients(data.to, data.received_for, data.cc, full.to, full.reply_to);
  let enquiry = null;
  if (token && TOKEN_RE.test(token)) {
    enquiry = await env.DB.prepare('SELECT * FROM enquiries WHERE token = ?').bind(token).first();
  }

  // 2. Otherwise the sender's most recent conversation, if it is still live.
  if (!enquiry && from.email) {
    enquiry = await env.DB.prepare(
      `SELECT * FROM enquiries WHERE lower(email) = ? AND last_message_at > datetime('now','-90 days')
        ORDER BY COALESCE(last_message_at, created_at) DESC LIMIT 1`,
    ).bind(from.email).first();
  }

  if (enquiry) {
    await appendCustomerMessage(env, enquiry, { body, channel: 'email', author: from.name || enquiry.name });
    await stampEmailId(env, enquiry.id, messageId);
  } else {
    // 3. A new conversation, started by email.
    const created = await createEnquiry(env, {
      name: from.name || 'Email enquiry',
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
    });
    enquiry = { id: created.id, token: created.token, name: from.name, email: from.email, type: 'general', channel: 'email', site: 'ukbrewerytours.com', subject };
    await env.DB.prepare('UPDATE enquiries SET subject = ? WHERE id = ?').bind(`Re: ${subject}`.slice(0, 200), created.id).run();
    await stampEmailId(env, created.id, messageId);
  }

  try {
    const { matches, unmatched } = await voucherCheck(env, enquiry, [body, subject]);
    await alertAdmin(env, enquiry, { body, followUp: true, matches, unmatched });
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

/** Subject-line hints when an email starts a conversation from nothing. */
function guessType(subject) {
  const s = String(subject || '').toLowerCase();
  if (/voucher|redeem|gift card/.test(s)) return /buy|purchase|order/.test(s) ? 'voucher' : 'redemption';
  if (/group|private|stag|hen|corporate|team building/.test(s)) return 'group';
  if (/book|availab|date|ticket/.test(s)) return 'booking';
  return 'general';
}
