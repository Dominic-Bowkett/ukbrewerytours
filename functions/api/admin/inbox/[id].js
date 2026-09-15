// /api/admin/inbox/:id
//   GET     the conversation, its full timeline and a voucher check. Marks it read.
//   PATCH   { status?, type? } — triage. Each change is logged on the timeline.
//   DELETE  remove a conversation outright (spam).

import {
  TYPES, STATUSES, CHANNELS, FIELD_LABELS, siteLabel, brandFor, threadUrl, voucherCheck, logEvent,
} from '../../../_lib/inbox.js';

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
    vouchers = await voucherCheck(env, enquiry, (messages || []).filter(m => m.direction === 'in').map(m => m.body));
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

  if (sets.length) {
    await env.DB.prepare(`UPDATE enquiries SET ${sets.join(', ')} WHERE id = ?`).bind(...args, enquiry.id).run();
    for (const e of events) await logEvent(env, enquiry.id, e, who);
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
