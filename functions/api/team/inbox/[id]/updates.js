// GET /api/team/inbox/:id/updates?after=<message id>&seen=1
// The team portal's live poll — same contract as the admin's, scoped to the owner.

import { voucherCheck } from '../../../../_lib/inbox.js';

export async function onRequestGet({ params, request, env, data }) {
  if (!/^\d+$/.test(String(params.id))) return Response.json({ error: 'Conversation not found.' }, { status: 404 });
  const url = new URL(request.url);
  const id = Number(params.id);
  const after = Math.max(0, parseInt(url.searchParams.get('after') || '0', 10) || 0);

  const enquiry = await env.DB.prepare(
    'SELECT id, status, type, unread, voucher_code FROM enquiries WHERE id = ? AND assigned_to = ?',
  ).bind(id, data.teamMemberId).first();
  if (!enquiry) return Response.json({ error: 'Conversation not found.' }, { status: 404 });

  const { results } = await env.DB.prepare(
    'SELECT id, direction, channel, body, author, created_at FROM enquiry_messages WHERE enquiry_id = ? AND id > ? ORDER BY id',
  ).bind(id, after).all();
  const messages = results || [];

  if (enquiry.unread && url.searchParams.get('seen') === '1') {
    await env.DB.prepare('UPDATE enquiries SET unread = 0 WHERE id = ?').bind(id).run();
  }

  let vouchers = null;
  if (messages.some(m => m.direction === 'in')) {
    try {
      const { results: inbound } = await env.DB.prepare(
        "SELECT body FROM enquiry_messages WHERE enquiry_id = ? AND direction = 'in'",
      ).bind(id).all();
      vouchers = await voucherCheck(env, enquiry, (inbound || []).map(r => r.body));
    } catch (err) {
      console.error('voucher re-check failed', err);
    }
  }

  return Response.json({ status: enquiry.status, type: enquiry.type, messages, vouchers });
}
