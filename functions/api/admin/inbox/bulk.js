// POST /api/admin/inbox/bulk  { ids: [..], action }
//
// The same thing done to several conversations at once, from the checkboxes in
// the list. Actions:
//   delete   move to the bin (the usual seven days to change your mind)
//   restore  take out of the bin
//   forever  delete for good — only things already in the bin
//   read / unread / close
// Each conversation gets the same timeline entry it would get one at a time.

import { deleteConversations, logEvent, BIN_DAYS } from '../../../_lib/inbox.js';

const MAX = 500;

export async function onRequestPost({ request, env, data }) {
  let body;
  try { body = await request.json(); } catch { return Response.json({ error: 'Invalid request.' }, { status: 400 }); }

  const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map(Number).filter(n => Number.isInteger(n) && n > 0))];
  if (!ids.length) return Response.json({ error: 'Nothing selected.' }, { status: 400 });
  if (ids.length > MAX) return Response.json({ error: `That is too many at once — ${MAX} at most.` }, { status: 400 });

  const who = data?.user?.email || 'admin';
  const action = String(body.action || '');

  // Work only on what exists and is in the right place for the action.
  const rows = [];
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const { results } = await env.DB.prepare(
      `SELECT id, deleted_at, status FROM enquiries WHERE id IN (${chunk.map(() => '?').join(',')})`,
    ).bind(...chunk).all();
    rows.push(...(results || []));
  }
  const live = rows.filter(r => !r.deleted_at).map(r => r.id);
  const binned = rows.filter(r => r.deleted_at).map(r => r.id);

  const run = async (sql, list, event) => {
    for (let i = 0; i < list.length; i += 90) {
      const chunk = list.slice(i, i + 90);
      await env.DB.prepare(sql.replace('(?)', `(${chunk.map(() => '?').join(',')})`)).bind(...chunk).run();
    }
    if (event) for (const id of list) await logEvent(env, id, event, who);
    return list.length;
  };

  let done = 0;
  switch (action) {
    case 'delete':
      done = await run("UPDATE enquiries SET deleted_at = datetime('now') WHERE id IN (?)", live, 'Moved to the bin');
      return Response.json({ ok: true, done, ids: live, bin_days: BIN_DAYS });
    case 'restore':
      done = await run('UPDATE enquiries SET deleted_at = NULL WHERE id IN (?)', binned, 'Restored from the bin');
      return Response.json({ ok: true, done, ids: binned });
    case 'forever':
      // Never straight from the inbox: forever is only for what is already binned.
      await deleteConversations(env, binned);
      return Response.json({ ok: true, done: binned.length, ids: binned });
    case 'read':
      done = await run('UPDATE enquiries SET unread = 0 WHERE id IN (?)', live);
      break;
    case 'unread':
      done = await run('UPDATE enquiries SET unread = 1 WHERE id IN (?)', live);
      break;
    case 'close': {
      const open = rows.filter(r => !r.deleted_at && r.status !== 'closed').map(r => r.id);
      done = await run("UPDATE enquiries SET status = 'closed', closed_at = datetime('now'), unread = 0 WHERE id IN (?)", open, 'Marked as Closed');
      break;
    }
    default:
      return Response.json({ error: 'Unknown action.' }, { status: 400 });
  }
  return Response.json({ ok: true, done });
}
