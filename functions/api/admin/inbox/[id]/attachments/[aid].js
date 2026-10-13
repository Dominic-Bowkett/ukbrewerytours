// GET /api/admin/inbox/:id/attachments/:aid  (?download=1 to save rather than view)
// One attachment from a conversation — a photo a customer emailed in, or a
// file we sent. Behind the admin session like everything under /api/admin.

import { serveAttachment } from '../../../../../_lib/attachments.js';

export async function onRequestGet({ params, request, env }) {
  if (!/^\d+$/.test(String(params.id)) || !/^\d+$/.test(String(params.aid))) {
    return new Response('Not found.', { status: 404 });
  }
  const att = await env.DB.prepare(
    'SELECT * FROM enquiry_attachments WHERE id = ? AND enquiry_id = ?',
  ).bind(Number(params.aid), Number(params.id)).first();
  if (!att) return new Response('Not found.', { status: 404 });
  return serveAttachment(env, att, { download: new URL(request.url).searchParams.get('download') === '1' });
}
