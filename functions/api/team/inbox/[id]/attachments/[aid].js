// GET /api/team/inbox/:id/attachments/:aid — a photo or file on a conversation
// assigned to the caller. Same scope check as the conversation itself: id AND
// owner, so nothing on anyone else's conversation can be reached by guessing.

import { mine } from '../../[id].js';
import { serveAttachment } from '../../../../../_lib/attachments.js';

export async function onRequestGet({ params, request, env, data }) {
  const enquiry = await mine(env, params.id, data.teamMemberId);
  if (!enquiry || !/^\d+$/.test(String(params.aid))) return new Response('Not found.', { status: 404 });
  const att = await env.DB.prepare(
    'SELECT * FROM enquiry_attachments WHERE id = ? AND enquiry_id = ?',
  ).bind(Number(params.aid), enquiry.id).first();
  if (!att) return new Response('Not found.', { status: 404 });
  return serveAttachment(env, att, { download: new URL(request.url).searchParams.get('download') === '1' });
}
