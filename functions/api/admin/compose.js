// POST /api/admin/compose
//   { to, cc?, bcc?, subject, body, reply_to?, type?, save_contact? }
//
// Starts a conversation from our side: an email to someone who has not written
// in. It becomes a normal conversation in the inbox, so the reply comes back to
// the same thread rather than disappearing into a mailbox somewhere.
//
// Admin only. A team member replies to what they have been given and nothing else.

import { sendEmail, inboxReplyHtml } from '../../_lib/email.js';
import { TYPES, brandFor, newToken, threadUrl, replyAddress, logEvent } from '../../_lib/inbox.js';
import { isEmail, parseRecipients, upsertContact } from '../../_lib/contacts.js';

const SITE = 'ukbrewerytours.com';

export async function onRequestPost({ request, env, data }) {
  if (!env.RESEND_API_KEY) return Response.json({ error: 'Email is not configured.' }, { status: 503 });

  let body;
  try { body = await request.json(); } catch { return Response.json({ error: 'Invalid request.' }, { status: 400 }); }

  const to = parseRecipients(body.to);
  const cc = parseRecipients(body.cc);
  const bcc = parseRecipients(body.bcc);
  if (!to.length) return Response.json({ error: 'Who is this going to? Add at least one email address.' }, { status: 400 });

  const subject = String(body.subject ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
  if (subject.length < 2) return Response.json({ error: 'Give the email a subject.' }, { status: 400 });

  const text = String(body.body ?? '').replace(/\r\n/g, '\n').trim().slice(0, 20000);
  if (text.length < 2) return Response.json({ error: 'Write the email first.' }, { status: 400 });

  // By default the reply comes back to this conversation. An override is for the
  // times that is not wanted (handing a supplier to someone else's mailbox) —
  // the reply then lands there and never reaches the thread.
  const token = newToken();
  const replyTo = body.reply_to ? String(body.reply_to).trim().toLowerCase() : '';
  if (replyTo && !isEmail(replyTo)) {
    return Response.json({ error: 'That reply-to address does not look right.' }, { status: 400 });
  }

  const type = TYPES[body.type] ? body.type : 'general';
  const who = data?.user?.email || 'admin';

  // Their name on the conversation: what was typed, the address book, or the
  // address itself. Nothing here is shown to them — it is how the thread reads.
  const known = await env.DB.prepare('SELECT name, phone FROM contacts WHERE lower(email) = ?').bind(to[0]).first();
  const name = String(body.name ?? '').trim().slice(0, 120)
    || known?.name
    || to[0].split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  let sent;
  try {
    sent = await sendEmail(env, {
      to,
      cc,
      bcc,
      subject,
      html: inboxReplyHtml({ body: text, threadLink: threadUrl(token), brand: brandFor(SITE) }),
      replyTo: replyTo || replyAddress(env, token),
    });
  } catch (err) {
    console.error('compose send failed', err);
    return Response.json({ error: `The email could not be sent: ${String(err.message || err).slice(0, 200)}` }, { status: 502 });
  }

  // Written only once the email is away, so a failed send leaves no conversation
  // claiming to have contacted someone.
  const res = await env.DB.prepare(
    `INSERT INTO enquiries (name, email, phone, message, type, channel, site, status, unread, token, subject, last_message_at)
     VALUES (?,?,?,?,?,'email',?,'waiting',0,?,?,datetime('now'))`,
  ).bind(name, to[0], known?.phone || null, text, type, SITE, token, subject).run();
  const id = res.meta.last_row_id;

  await env.DB.prepare(
    'INSERT INTO enquiry_messages (enquiry_id, direction, channel, body, author, email_id) VALUES (?,?,?,?,?,?)',
  ).bind(id, 'out', 'email', text, who, sent?.id || null).run();

  // Who else got it, and where a reply will land: invisible in the email itself,
  // so the timeline is the only place it is recorded.
  const also = [
    to.length > 1 ? `also to ${to.slice(1).join(', ')}` : '',
    cc.length ? `cc ${cc.join(', ')}` : '',
    bcc.length ? `bcc ${bcc.join(', ')}` : '',
    replyTo ? `replies go to ${replyTo}, not this conversation` : '',
  ].filter(Boolean);
  await logEvent(env, id, `Emailed ${to[0]}${also.length ? ` — ${also.join(' · ')}` : ''}`, who);

  // Add anyone new to the address book if that was asked for, then record on
  // every card involved that they have just been written to.
  if (body.save_contact) {
    for (const address of to) {
      try {
        await upsertContact(env, { email: address, name: address === to[0] ? name : '' });
      } catch (err) {
        console.error('save contact failed', err);
      }
    }
  }
  const stamp = [...new Set([...to, ...cc])];
  await env.DB.prepare(
    `UPDATE contacts SET last_emailed_at = datetime('now')
      WHERE lower(email) IN (${stamp.map(() => '?').join(',')})`,
  ).bind(...stamp).run();

  return Response.json({ ok: true, id, sent_to: to, cc, bcc, subject });
}
