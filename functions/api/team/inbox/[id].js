// /api/team/inbox/:id — one conversation, only if it is assigned to the caller.
//   GET    the conversation, its timeline and a read-only voucher check
//   PATCH  { status } — triage. Assignment and deletion stay with the admin.

import {
  TYPES, STATUSES, CHANNELS, FIELD_LABELS, siteLabel, brandFor, voucherCheck, logEvent, hideEmails,
} from '../../../_lib/inbox.js';

/** The scope check: id AND owner, in one query. */
export async function mine(env, id, me) {
  if (!/^\d+$/.test(String(id))) return null;
  return env.DB.prepare('SELECT * FROM enquiries WHERE id = ? AND assigned_to = ?').bind(Number(id), me).first();
}

export async function onRequestGet({ params, env, data }) {
  const enquiry = await mine(env, params.id, data.teamMemberId);
  if (!enquiry) return Response.json({ error: 'Conversation not found.' }, { status: 404 });

  const { results: messages } = await env.DB.prepare(
    'SELECT id, direction, channel, body, author, created_at FROM enquiry_messages WHERE enquiry_id = ? ORDER BY id',
  ).bind(enquiry.id).all();

  if (enquiry.unread) await env.DB.prepare('UPDATE enquiries SET unread = 0 WHERE id = ?').bind(enquiry.id).run();

  let vouchers = { matches: [], unmatched: [] };
  try {
    vouchers = await voucherCheck(env, enquiry, (messages || []).filter(m => m.direction === 'in').map(m => m.body));
  } catch (err) {
    console.error('voucher check failed', err);
  }

  let fields = {};
  try { fields = JSON.parse(enquiry.fields || '{}') || {}; } catch { fields = {}; }

  // The customer's email address is never sent to a team member — not as a
  // field, and not left sitting inside a message body or a voucher record.
  const clean = messages || [];
  for (const m of clean) m.body = hideEmails(m.body, enquiry.email);
  for (const m of vouchers.matches || []) m.holder_email = null;

  return Response.json({
    enquiry: {
      id: enquiry.id, name: enquiry.name, phone: enquiry.phone,
      type: enquiry.type, status: enquiry.status, site: enquiry.site, page: enquiry.page,
      voucher_code: enquiry.voucher_code, created_at: enquiry.created_at, unread: 0,
      fields: Object.entries(fields).map(([k, v]) => ({ key: k, label: FIELD_LABELS[k] || k, value: v })),
      site_label: siteLabel(enquiry.site),
      brand: brandFor(enquiry.site),
      channel_label: CHANNELS[enquiry.channel] || enquiry.channel,
    },
    messages: clean,
    vouchers,
    labels: { types: TYPES, statuses: STATUSES },
  });
}

export async function onRequestPatch({ params, request, env, data }) {
  const enquiry = await mine(env, params.id, data.teamMemberId);
  if (!enquiry) return Response.json({ error: 'Conversation not found.' }, { status: 404 });

  let body;
  try { body = await request.json(); } catch { return Response.json({ error: 'Invalid request.' }, { status: 400 }); }
  if (!STATUSES[body.status]) return Response.json({ error: 'Unknown status.' }, { status: 400 });
  if (body.status === enquiry.status) return Response.json({ ok: true });

  await env.DB.prepare(
    `UPDATE enquiries SET status = ?, closed_at = CASE WHEN ? = 'closed' THEN datetime('now') ELSE NULL END
      WHERE id = ? AND assigned_to = ?`,
  ).bind(body.status, body.status, enquiry.id, data.teamMemberId).run();
  await logEvent(env, enquiry.id, `Marked as ${STATUSES[body.status]}`, data.team?.email || 'team');

  return Response.json({ ok: true });
}
