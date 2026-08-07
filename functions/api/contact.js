// POST /api/contact — website enquiry form.
// Forwards to info@ via Resend with reply-to set to the sender, and sends the
// sender a confirmation. Public and unauthenticated, so it is rate limited and
// carries a honeypot; without those it would be an open relay for spam.

import { sendEmail, enquiryEmailHtml, enquiryAutoReplyHtml } from '../_lib/email.js';

const MAX_PER_HOUR = 5;   // per IP
const isEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim());
const clean = (s, max) => String(s ?? '').trim().slice(0, max);

export async function onRequestPost({ request, env }) {
  if (!env.RESEND_API_KEY) {
    return Response.json({ error: 'Messaging is not configured. Please email us directly.' }, { status: 503 });
  }

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
  const message = clean(body.message, 5000);
  let page = clean(body.page, 200);

  // Embedded contact widgets (the form iframed on other websites).
  const widgetId = clean(body.widgetId, 40);
  let widget = null;
  let widgetOrigin = null;
  if (widgetId) {
    widget = await env.DB.prepare('SELECT * FROM widgets WHERE id = ?').bind(widgetId).first();
    if (!widget || widget.kind !== 'contact' || widget.status !== 'active') {
      return Response.json({ error: 'This contact form is temporarily unavailable. Please email info@ukbrewerytours.com.' }, { status: 403 });
    }
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
  if (message.length < 10) return Response.json({ error: 'Please tell us a little more.' }, { status: 400 });

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
    if ((results?.[0]?.n || 0) >= MAX_PER_HOUR) {
      return Response.json({ error: "You've sent several messages already — please email us directly." }, { status: 429 });
    }
  } catch (err) {
    // A missing table must not block genuine enquiries.
    console.error('enquiry rate-limit check failed', err);
  }

  try {
    await sendEmail(env, {
      to: env.NOTIFY_EMAIL || 'info@ukbrewerytours.com',
      subject: widget ? `Enquiry via ${widget.name} — ${name}` : `Website enquiry — ${name}`,
      html: enquiryEmailHtml({ name, email, message, page, widget, widgetOrigin }),
      replyTo: email,
    });
  } catch (err) {
    console.error('enquiry send failed', err);
    return Response.json({ error: 'Could not send your message. Please email info@ukbrewerytours.com directly.' }, { status: 502 });
  }

  // Log after the important email has gone out.
  try {
    await env.DB.prepare(
      'INSERT INTO enquiries (name, email, message, page, ip, widget_id, widget_origin) VALUES (?,?,?,?,?,?,?)',
    ).bind(name, email, message, page || null, ip, widget ? widget.id : null, widgetOrigin).run();
  } catch (err) {
    console.error('enquiry log failed', err);
  }

  // Courtesy confirmation — never fail the request over it.
  try {
    await sendEmail(env, {
      to: email,
      subject: 'We got your message — UK Brewery Tours',
      html: enquiryAutoReplyHtml({ name, message }),
      replyTo: 'info@ukbrewerytours.com',
    });
  } catch (err) {
    console.error('enquiry auto-reply failed', err);
  }

  return Response.json({ ok: true });
}
