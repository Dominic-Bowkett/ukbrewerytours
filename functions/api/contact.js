// POST /api/contact — every way a customer can get in touch lands here: the
// contact, group booking and voucher redemption forms on ukbrewerytours.com,
// the embedded contact widgets on other sites, and the first message of a live
// chat. Each becomes a conversation in the admin inbox, Dom gets an alert with a
// link to it, and the sender gets a confirmation with a link back to the thread.
//
// Public and unauthenticated, so it is rate limited and carries a honeypot;
// without those it would be an open relay for spam.

import { sendEmail, enquiryAutoReplyHtml } from '../_lib/email.js';
import {
  createEnquiry, alertAdmin, voucherCheck, cleanType, cleanFields, inferType,
  siteFromUrl, brandFor, threadUrl, replyAddress,
} from '../_lib/inbox.js';

// New conversations per IP per hour. Override with the CONTACT_MAX_PER_HOUR
// variable (local testing sets it high; production leaves it at 5).
const maxPerHour = env => {
  const n = Number(env.CONTACT_MAX_PER_HOUR);
  return Number.isFinite(n) && n > 0 ? n : 5;
};
const isEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim());
const clean = (s, max) => String(s ?? '').trim().slice(0, max);

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid request.' }, { status: 400 });
  }

  // Honeypot: real people never fill this in.
  if (clean(body.company, 100)) return Response.json({ ok: true });

  const name = clean(body.name, 100);
  const email = clean(body.email, 200);
  // Optional — keep only sane characters.
  const phone = clean(body.phone, 40).replace(/[^\d+()\-.\s]/g, '').trim();
  const message = clean(body.message, 5000);
  let page = clean(body.page, 200);
  const isChat = body.channel === 'chat';

  // Embedded contact widgets (the form iframed on other websites).
  const widgetId = clean(body.widgetId, 40);
  let widget = null;
  let widgetOrigin = null;
  if (widgetId) {
    widget = await env.DB.prepare('SELECT * FROM widgets WHERE id = ?').bind(widgetId).first();
    if (!widget || widget.kind !== 'contact' || widget.status !== 'active') {
      return Response.json({ error: 'This contact form is temporarily unavailable. Please email info@ukbrewerytours.com.' }, { status: 403 });
    }
  }

  // Widgets and the chat run in an iframe served from here, so the page the
  // customer is actually on arrives as hostUrl.
  if (widget || isChat) {
    try {
      const u = new URL(String(body.hostUrl || ''));
      if (u.protocol === 'https:' || u.protocol === 'http:') {
        page = u.href.slice(0, 200);
        widgetOrigin = u.origin;
      }
    } catch { /* no usable host page — attribution just stays blank */ }
  }

  if (!name) return Response.json({ error: 'Please enter your name.' }, { status: 400 });
  if (!isEmail(email)) return Response.json({ error: 'Please enter a valid email address.' }, { status: 400 });
  if (message.length < (isChat ? 2 : 10)) {
    return Response.json({ error: isChat ? 'Please type a message.' : 'Please tell us a little more.' }, { status: 400 });
  }

  // Header injection guard — a newline in these would let a sender forge headers.
  if (/[\r\n]/.test(name) || /[\r\n]/.test(email)) {
    return Response.json({ error: 'Invalid characters in name or email.' }, { status: 400 });
  }

  // Rate limit per IP. D1 is already bound, so no extra service is needed.
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  try {
    const { results } = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM enquiries WHERE ip = ? AND created_at > datetime('now','-1 hour')",
    ).bind(ip).all();
    if ((results?.[0]?.n || 0) >= maxPerHour(env)) {
      return Response.json({ error: "You've sent several messages already — please email us directly." }, { status: 429 });
    }
  } catch (err) {
    console.error('enquiry rate-limit check failed', err);
  }

  const site = siteFromUrl(widgetOrigin || page || request.url);
  const type = cleanType(body.type) || inferType(page);
  const fields = cleanFields(body.fields);
  const voucherCode = clean(body.voucher_code, 200).replace(/[\r\n]+/g, ' ') || null;
  const channel = isChat ? 'chat' : widget ? 'widget' : 'form';

  // Stored first: the inbox is the record now, so a failed email must never
  // lose the enquiry.
  let created;
  try {
    created = await createEnquiry(env, {
      name, email, phone, message, page, ip,
      widgetId: widget ? widget.id : null, widgetOrigin,
      type, channel, site, fields, voucherCode,
    });
  } catch (err) {
    console.error('enquiry insert failed', err);
    return Response.json({ error: 'Could not send your message. Please email info@ukbrewerytours.com directly.' }, { status: 502 });
  }

  const enquiry = {
    id: created.id, token: created.token, name, email, phone, page, type, channel, site,
    voucher_code: voucherCode, fields: Object.keys(fields).length ? JSON.stringify(fields) : null,
  };

  try {
    const { matches, unmatched } = await voucherCheck(env, enquiry, [message]);
    await alertAdmin(env, enquiry, { body: message, matches, unmatched });
  } catch (err) {
    console.error('enquiry alert failed', err);
  }

  // Courtesy confirmation — never fail the request over it.
  if (env.RESEND_API_KEY) {
    try {
      await sendEmail(env, {
        to: email,
        subject: `We got your message — ${brandFor(site)}`,
        html: enquiryAutoReplyHtml({
          name, message, threadLink: threadUrl(created.token), brand: brandFor(site), chat: isChat,
        }),
        replyTo: replyAddress(env, created.token),
      });
    } catch (err) {
      console.error('enquiry auto-reply failed', err);
    }
  }

  return Response.json({ ok: true, token: created.token });
}
