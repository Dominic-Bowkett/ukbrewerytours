// POST /api/team/inbox/:id/note  { body } — an internal note on a conversation
// assigned to the caller. Visible to them and to the admin, never to the customer.

export async function onRequestPost({ params, request, env, data }) {
  if (!/^\d+$/.test(String(params.id))) return Response.json({ error: 'Conversation not found.' }, { status: 404 });
  const enquiry = await env.DB.prepare('SELECT id FROM enquiries WHERE id = ? AND assigned_to = ? AND is_notification = 0 AND deleted_at IS NULL')
    .bind(Number(params.id), data.teamMemberId).first();
  if (!enquiry) return Response.json({ error: 'Conversation not found.' }, { status: 404 });

  let body;
  try { body = await request.json(); } catch { return Response.json({ error: 'Invalid request.' }, { status: 400 }); }
  const text = String(body.body ?? '').trim().slice(0, 5000);
  if (!text) return Response.json({ error: 'Write a note first.' }, { status: 400 });

  await env.DB.prepare(
    'INSERT INTO enquiry_messages (enquiry_id, direction, channel, body, author) VALUES (?,?,?,?,?)',
  ).bind(enquiry.id, 'note', 'admin', text, data.team?.email || 'team').run();

  return Response.json({ ok: true });
}
