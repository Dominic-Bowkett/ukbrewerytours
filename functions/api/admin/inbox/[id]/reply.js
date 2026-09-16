// POST /api/admin/inbox/:id/reply  { body, status? }
// Emails the customer from info@ukbrewerytours.com and saves the reply on the
// thread. status is what the conversation becomes afterwards (default: waiting).

import { sendEmail, inboxReplyHtml } from '../../../../_lib/email.js';
import { STATUSES, brandFor, threadUrl, replyAddress } from '../../../../_lib/inbox.js';

export async function onRequestPost({ params, request, env, data }) {
  if (!/^\d+$/.test(String(params.id))) return Response.json({ error: 'Conversation not found.' }, { status: 404 });
  const enquiry = await env.DB.prepare('SELECT * FROM enquiries WHERE id = ?').bind(Number(params.id)).first();
  if (!enquiry) return Response.json({ error: 'Conversation not found.' }, { status: 404 });
  if (!env.RESEND_API_KEY) return Response.json({ error: 'Email is not configured.' }, { status: 503 });

  let body;
  try { body = await request.json(); } catch { return Response.json({ error: 'Invalid request.' }, { status: 400 }); }

  const text = String(body.body ?? '').replace(/\r\n/g, '\n').trim().slice(0, 20000);
  if (text.length < 2) return Response.json({ error: 'Write a reply first.' }, { status: 400 });
  // Phone callers do not always leave an email, so there is nobody to reply to.
  if (!String(enquiry.email || '').trim()) {
    return Response.json({
      error: enquiry.phone
        ? `No email address on this one — they left a phone number instead: ${enquiry.phone}`
        : 'No email address on this one, so there is nobody to reply to.',
    }, { status: 400 });
  }
  const status = STATUSES[body.status] ? body.status : 'waiting';
  const who = data?.user?.email || 'admin';

  // Quote the customer's latest message, as a mail client would.
  const last = await env.DB.prepare(
    "SELECT body FROM enquiry_messages WHERE enquiry_id = ? AND direction = 'in' ORDER BY id DESC LIMIT 1",
  ).bind(enquiry.id).first();

  const subject = enquiry.subject || `Your enquiry — ${brandFor(enquiry.site)}`;
  let sent;
  try {
    sent = await sendEmail(env, {
      to: enquiry.email,
      subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
      html: inboxReplyHtml({
        body: text, quoted: last?.body, quotedName: enquiry.name,
        threadLink: threadUrl(enquiry.token), brand: brandFor(enquiry.site),
      }),
      replyTo: replyAddress(env, enquiry.token),
    });
  } catch (err) {
    console.error('inbox reply send failed', err);
    return Response.json({ error: `The email could not be sent: ${String(err.message || err).slice(0, 200)}` }, { status: 502 });
  }

  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO enquiry_messages (enquiry_id, direction, channel, body, author, email_id) VALUES (?,?,?,?,?,?)',
    ).bind(enquiry.id, 'out', 'email', text, who, sent?.id || null),
    // alerted_at is cleared so the customer's next message alerts straight away.
    env.DB.prepare(
      `UPDATE enquiries SET status = ?, unread = 0, alerted_at = NULL, last_message_at = datetime('now'),
         closed_at = CASE WHEN ? = 'closed' THEN datetime('now') ELSE NULL END
       WHERE id = ?`,
    ).bind(status, status, enquiry.id),
  ]);
  if (status !== enquiry.status) {
    await env.DB.prepare(
      'INSERT INTO enquiry_messages (enquiry_id, direction, channel, body, author) VALUES (?,?,?,?,?)',
    ).bind(enquiry.id, 'event', 'admin', `Marked as ${STATUSES[status]}`, who).run();
  }

  return Response.json({ ok: true, sent_to: enquiry.email, status });
}
