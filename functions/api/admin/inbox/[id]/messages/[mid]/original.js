// GET /api/admin/inbox/:id/messages/:mid/original
// A received email as it was sent — layout, inline photos and all — rather
// than the plain text the timeline shows. Rendered sandboxed, scripts off.

import { serveOriginal } from '../../../../../../_lib/attachments.js';

const BASE = '/api/admin/inbox';

export async function onRequestGet({ params, env }) {
  if (!/^\d+$/.test(String(params.id)) || !/^\d+$/.test(String(params.mid))) {
    return new Response('Not found.', { status: 404 });
  }
  const message = await env.DB.prepare(
    'SELECT id, html_key FROM enquiry_messages WHERE id = ? AND enquiry_id = ?',
  ).bind(Number(params.mid), Number(params.id)).first();
  return serveOriginal(env, message, BASE, Number(params.id));
}
