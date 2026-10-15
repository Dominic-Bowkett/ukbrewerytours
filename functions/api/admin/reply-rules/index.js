// /api/admin/reply-rules — stock replies and the rules that pick them.
//   GET   every rule, in the order they are checked
//   POST  { name, action, types, cities, min_group, max_group, keywords, body, priority, enabled }
// See _lib/autoreply.js for how a rule is matched against a new conversation.

import { cleanRule } from './[id].js';

export async function onRequestGet({ env }) {
  const { results } = await env.DB.prepare('SELECT * FROM reply_rules ORDER BY priority, id').all();
  return Response.json({ rules: results || [] }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return Response.json({ error: 'Invalid request.' }, { status: 400 }); }
  const r = cleanRule(body);
  if (r.error) return Response.json({ error: r.error }, { status: 400 });
  const res = await env.DB.prepare(
    `INSERT INTO reply_rules (name, enabled, priority, action, types, cities, min_group, max_group, keywords, body)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).bind(r.name, r.enabled, r.priority, r.action, r.types, r.cities, r.min_group, r.max_group, r.keywords, r.body).run();
  return Response.json({ ok: true, id: res.meta.last_row_id });
}
