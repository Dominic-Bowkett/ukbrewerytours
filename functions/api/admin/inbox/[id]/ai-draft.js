// POST /api/admin/inbox/:id/ai-draft — Claude drafts the next reply for this
// conversation. Returned to the reply box, never sent.

import { aiDraft } from '../../../../_lib/autoreply.js';

export async function onRequestPost({ params, env }) {
  if (!/^\d+$/.test(String(params.id))) return Response.json({ error: 'Conversation not found.' }, { status: 404 });
  const enquiry = await env.DB.prepare('SELECT * FROM enquiries WHERE id = ? AND deleted_at IS NULL').bind(Number(params.id)).first();
  if (!enquiry) return Response.json({ error: 'Conversation not found.' }, { status: 404 });
  const { results: messages } = await env.DB.prepare(
    'SELECT direction, body, created_at FROM enquiry_messages WHERE enquiry_id = ? ORDER BY id',
  ).bind(enquiry.id).all();
  const draft = await aiDraft(env, enquiry, messages);
  if (draft.error) return Response.json({ error: draft.error }, { status: 400 });
  return Response.json({ ok: true, text: draft.text });
}
