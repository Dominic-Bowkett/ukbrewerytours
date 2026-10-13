// DELETE /api/admin/inbox/bin — empty the bin now, without waiting out the seven days.
//
// The slow path (BIN_DAYS, then the scheduler) is the safety net. This is the
// deliberate override, and it is the only place in the inbox that destroys more
// than one conversation at a time — hence the count in the reply, so the admin
// can see afterwards exactly how much went.

import { deleteConversations } from '../../../_lib/inbox.js';

export async function onRequestDelete({ env }) {
  const { results } = await env.DB.prepare(
    'SELECT id FROM enquiries WHERE deleted_at IS NOT NULL LIMIT 1000',
  ).all();

  const ids = (results || []).map(r => r.id);
  if (!ids.length) return Response.json({ ok: true, deleted: 0 });

  await deleteConversations(env, ids);
  return Response.json({ ok: true, deleted: ids.length });
}
