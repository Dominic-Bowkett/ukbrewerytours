// POST /api/team/inbox/:id/reply  { body, status? }
//
// The team member's reply goes out from THEIR address (inbox_from_email, e.g.
// london@ukbrewerytours.com) rather than info@, and is saved on the conversation
// so the admin sees exactly what the customer was told.

import { sendEmail, inboxReplyHtml } from '../../../../_lib/email.js';
import { STATUSES, brandFor, threadUrl, senderFor } from '../../../../_lib/inbox.js';

export async function onRequestPost({ params, request, env, data }) {
  const me = data.teamMemberId;
  if (!/^\d+$/.test(String(params.id))) return Response.json({ error: 'Conversation not found.' }, { status: 404 });
  const enquiry = await env.DB.prepare('SELECT * FROM enquiries WHERE id = ? AND assigned_to = ?')
    .bind(Number(params.id), me).first();
  if (!enquiry) return Response.json({ error: 'Conversation not found.' }, { status: 404 });
  if (!env.RESEND_API_KEY) return Response.json({ error: 'Email is not configured.' }, { status: 503 });

  let body;
  try { body = await request.json(); } catch { return Response.json({ error: 'Invalid request.' }, { status: 400 }); }

  const text = String(body.body ?? '').replace(/\r\n/g, '\n').trim().slice(0, 20000);
  if (text.length < 2) return Response.json({ error: 'Write a reply first.' }, { status: 400 });
  const status = STATUSES[body.status] ? body.status : 'waiting';

  const last = await env.DB.prepare(
    "SELECT body FROM enquiry_messages WHERE enquiry_id = ? AND direction = 'in' ORDER BY id DESC LIMIT 1",
  ).bind(enquiry.id).first();

  const subject = enquiry.subject || `Your enquiry — ${brandFor(enquiry.site)}`;
  const { from, replyTo } = senderFor(data.team);
  let sent;
  try {
    sent = await sendEmail(env, {
      from,
      replyTo,
      to: enquiry.email,
      subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
      html: inboxReplyHtml({
        body: text, quoted: last?.body, quotedName: enquiry.name,
        threadLink: threadUrl(enquiry.token), brand: brandFor(enquiry.site),
      }),
    });
  } catch (err) {
    console.error('team reply send failed', err);
    return Response.json({ error: `The email could not be sent: ${String(err.message || err).slice(0, 200)}` }, { status: 502 });
  }

  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO enquiry_messages (enquiry_id, direction, channel, body, author, email_id) VALUES (?,?,?,?,?,?)',
    ).bind(enquiry.id, 'out', 'email', text, data.team?.email || 'team', sent?.id || null),
    env.DB.prepare(
      `UPDATE enquiries SET status = ?, unread = 0, alerted_at = NULL, last_message_at = datetime('now'),
         closed_at = CASE WHEN ? = 'closed' THEN datetime('now') ELSE NULL END
       WHERE id = ? AND assigned_to = ?`,
    ).bind(status, status, enquiry.id, me),
  ]);
  if (status !== enquiry.status) {
    await env.DB.prepare(
      'INSERT INTO enquiry_messages (enquiry_id, direction, channel, body, author) VALUES (?,?,?,?,?)',
    ).bind(enquiry.id, 'event', 'admin', `Marked as ${STATUSES[status]}`, data.team?.email || 'team').run();
  }

  return Response.json({ ok: true, sent_to: enquiry.email, sent_from: replyTo, status });
}
