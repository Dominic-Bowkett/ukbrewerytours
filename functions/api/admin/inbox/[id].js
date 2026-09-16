// /api/admin/inbox/:id
//   GET     the conversation, its full timeline and a voucher check. Marks it read.
//   PATCH   { status?, type? } — triage. Each change is logged on the timeline.
//   DELETE  remove a conversation outright (spam).

import {
  TYPES, STATUSES, CHANNELS, FIELD_LABELS, siteLabel, brandFor, threadUrl, voucherCheck, logEvent, teamUrl, hideEmails,
} from '../../../_lib/inbox.js';
import { sendEmail, assignmentEmailHtml } from '../../../_lib/email.js';

async function findEnquiry(env, id) {
  if (!/^\d+$/.test(String(id))) return null;
  return env.DB.prepare('SELECT * FROM enquiries WHERE id = ?').bind(Number(id)).first();
}

export async function onRequestGet({ params, env }) {
  const enquiry = await findEnquiry(env, params.id);
  if (!enquiry) return Response.json({ error: 'Conversation not found.' }, { status: 404 });

  const { results: messages } = await env.DB.prepare(
    'SELECT id, direction, channel, body, author, created_at FROM enquiry_messages WHERE enquiry_id = ? ORDER BY id',
  ).bind(enquiry.id).all();

  if (enquiry.unread) {
    await env.DB.prepare('UPDATE enquiries SET unread = 0 WHERE id = ?').bind(enquiry.id).run();
  }

  let vouchers = { matches: [], unmatched: [] };
  try {
    // A Stripe receipt is full of code-shaped strings and none of them are ours.
    if (!enquiry.is_notification) {
      vouchers = await voucherCheck(env, enquiry, (messages || []).filter(m => m.direction === 'in').map(m => m.body));
    }
  } catch (err) {
    console.error('voucher check failed', err);
  }

  let fields = {};
  try { fields = JSON.parse(enquiry.fields || '{}') || {}; } catch { fields = {}; }

  let widgetName = null;
  if (enquiry.widget_id) {
    const w = await env.DB.prepare('SELECT name FROM widgets WHERE id = ?').bind(enquiry.widget_id).first();
    widgetName = w?.name || null;
  }

  let assigneeName = null;
  if (enquiry.assigned_to) {
    const m = await env.DB.prepare('SELECT name FROM team_members WHERE id = ?').bind(enquiry.assigned_to).first();
    assigneeName = m?.name || null;
  }

  const { ip, token, ...safe } = enquiry;
  return Response.json({
    enquiry: {
      ...safe,
      unread: 0,
      fields: Object.entries(fields).map(([k, v]) => ({ key: k, label: FIELD_LABELS[k] || k, value: v })),
      site_label: siteLabel(enquiry.site),
      brand: brandFor(enquiry.site),
      channel_label: CHANNELS[enquiry.channel] || enquiry.channel,
      widget_name: widgetName,
      assignee_name: assigneeName,
      thread_url: threadUrl(token),
    },
    messages: messages || [],
    vouchers,
    labels: { types: TYPES, statuses: STATUSES },
  }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function onRequestPatch({ params, request, env, data }) {
  const enquiry = await findEnquiry(env, params.id);
  if (!enquiry) return Response.json({ error: 'Conversation not found.' }, { status: 404 });

  let body;
  try { body = await request.json(); } catch { return Response.json({ error: 'Invalid request.' }, { status: 400 }); }

  const who = data?.user?.email || 'admin';
  const sets = [];
  const args = [];
  const events = [];

  if (body.status !== undefined && body.status !== enquiry.status) {
    if (!STATUSES[body.status]) return Response.json({ error: 'Unknown status.' }, { status: 400 });
    sets.push('status = ?', "closed_at = CASE WHEN ? = 'closed' THEN datetime('now') ELSE NULL END");
    args.push(body.status, body.status);
    events.push(`Marked as ${STATUSES[body.status]}`);
  }
  if (body.type !== undefined && body.type !== enquiry.type) {
    if (!TYPES[body.type]) return Response.json({ error: 'Unknown enquiry type.' }, { status: 400 });
    sets.push('type = ?');
    args.push(body.type);
    events.push(`Type changed to ${TYPES[body.type]}`);
  }
  if (body.unread !== undefined) {
    sets.push('unread = ?');
    args.push(body.unread ? 1 : 0);
  }

  // Move a notification into the inbox, or file a conversation away as one.
  // Filing something away takes it off a team member's desk with it — they can
  // no longer see it, so leaving it assigned would only be misleading.
  if (body.is_notification !== undefined && Boolean(body.is_notification) !== (enquiry.is_notification === 1)) {
    const filed = Boolean(body.is_notification);
    sets.push('is_notification = ?', 'notification_reason = ?');
    args.push(filed ? 1 : 0, filed ? 'filed by hand' : null);
    events.push(filed ? 'Filed away as a notification' : 'Moved into the inbox');
    if (filed && enquiry.assigned_to && body.assigned_to === undefined) {
      sets.push('assigned_to = NULL', 'assigned_at = NULL', 'assigned_by = ?');
      args.push(who);
      events.push('Unassigned — a notification has no owner');
    }
  }

  // Assignment. null hands it back to the admin; otherwise it must be an active
  // member with inbox access, who then sees this conversation and nothing else.
  let newOwner = null;
  if (body.assigned_to !== undefined && (body.assigned_to || null) !== (enquiry.assigned_to || null)) {
    // Unless this same request is promoting it, a team member cannot be handed
    // something they would not be able to see.
    if (body.assigned_to && enquiry.is_notification && body.is_notification !== false) {
      return Response.json({ error: 'Move this into the inbox before assigning it.' }, { status: 400 });
    }
    if (body.assigned_to) {
      newOwner = await env.DB.prepare(
        'SELECT id, name, email, active, inbox_access, notify_email FROM team_members WHERE id = ?',
      ).bind(String(body.assigned_to)).first();
      if (!newOwner || newOwner.active !== 1 || newOwner.inbox_access !== 1) {
        return Response.json({ error: 'That team member cannot take conversations.' }, { status: 400 });
      }
      sets.push('assigned_to = ?', "assigned_at = datetime('now')", 'assigned_by = ?');
      args.push(newOwner.id, who);
      events.push(`Assigned to ${newOwner.name}`);
    } else {
      sets.push('assigned_to = NULL', 'assigned_at = NULL', 'assigned_by = ?');
      args.push(who);
      events.push('Unassigned — back to the admin inbox');
    }
    // Alert them next time the customer writes, even if we alerted recently.
    sets.push('alerted_at = NULL');
  }

  if (sets.length) {
    await env.DB.prepare(`UPDATE enquiries SET ${sets.join(', ')} WHERE id = ?`).bind(...args, enquiry.id).run();
    for (const e of events) await logEvent(env, enquiry.id, e, who);
  }

  if (newOwner && env.RESEND_API_KEY) {
    try {
      const last = await env.DB.prepare(
        "SELECT body FROM enquiry_messages WHERE enquiry_id = ? AND direction = 'in' ORDER BY id DESC LIMIT 1",
      ).bind(enquiry.id).first();
      await sendEmail(env, {
        // Their login email may be a username with no mailbox behind it.
        to: newOwner.notify_email || newOwner.email,
        subject: `Assigned to you: ${TYPES[body.type || enquiry.type] || 'Enquiry'} — ${enquiry.name}`,
        html: assignmentEmailHtml({
          enquiry,
          typeLabel: TYPES[body.type || enquiry.type] || 'Enquiry',
          siteName: siteLabel(enquiry.site),
          link: teamUrl(enquiry.id),
          // The team member never sees the customer's email address.
          body: hideEmails(last?.body || enquiry.message, enquiry.email),
          assignedBy: who,
        }),
      });
    } catch (err) {
      console.error('assignment email failed', err);
    }
  }

  return Response.json({ ok: true });
}

export async function onRequestDelete({ params, env }) {
  const enquiry = await findEnquiry(env, params.id);
  if (!enquiry) return Response.json({ error: 'Conversation not found.' }, { status: 404 });
  await env.DB.batch([
    env.DB.prepare('DELETE FROM enquiry_messages WHERE enquiry_id = ?').bind(enquiry.id),
    env.DB.prepare('DELETE FROM enquiries WHERE id = ?').bind(enquiry.id),
  ]);
  return Response.json({ ok: true });
}
