// GET /api/admin/inbox/:id/updates?after=<message id>&seen=1
//
// What's new in the conversation the admin has open. Polled every few seconds
// while it is on screen, so it stays cheap: the header row plus an indexed range
// read of messages after the last one the page already shows. The voucher check
// only re-runs when a new customer message could have added a code.

import { voucherCheck } from '../../../../_lib/inbox.js';

export async function onRequestGet({ params, request, env }) {
  if (!/^\d+$/.test(String(params.id))) return Response.json({ error: 'Conversation not found.' }, { status: 404 });
  const url = new URL(request.url);
  const id = Number(params.id);
  const after = Math.max(0, parseInt(url.searchParams.get('after') || '0', 10) || 0);

  const [head, fresh] = await env.DB.batch([
    env.DB.prepare('SELECT id, status, type, unread, voucher_code, deleted_at FROM enquiries WHERE id = ?').bind(id),
    env.DB.prepare(
      'SELECT id, direction, channel, body, author, created_at FROM enquiry_messages WHERE enquiry_id = ? AND id > ? ORDER BY id',
    ).bind(id, after),
  ]);
  const enquiry = head.results?.[0];
  if (!enquiry) return Response.json({ error: 'Conversation not found.' }, { status: 404 });

  const messages = fresh.results || [];
  const newInbound = messages.some(m => m.direction === 'in');

  // The conversation is on screen, so a customer message is read as it arrives.
  if (enquiry.unread && !enquiry.deleted_at && url.searchParams.get('seen') === '1') {
    await env.DB.prepare('UPDATE enquiries SET unread = 0 WHERE id = ?').bind(id).run();
  }

  let vouchers = null;
  if (newInbound) {
    try {
      const { results } = await env.DB.prepare(
        "SELECT body FROM enquiry_messages WHERE enquiry_id = ? AND direction = 'in'",
      ).bind(id).all();
      vouchers = await voucherCheck(env, enquiry, (results || []).map(r => r.body));
    } catch (err) {
      console.error('voucher re-check failed', err);
    }
  }

  return Response.json(
    { status: enquiry.status, type: enquiry.type, messages, vouchers },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
