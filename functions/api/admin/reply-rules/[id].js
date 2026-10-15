// /api/admin/reply-rules/:id — PATCH (same fields as POST, or just { enabled }) / DELETE.

import { TYPES } from '../../../_lib/inbox.js';

const text = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const csv = (v, max = 500) => text(v, max).split(',').map(s => s.trim()).filter(Boolean).join(', ');
const intOrNull = v => (v === '' || v === null || v === undefined ? null : Math.round(Number(v)));

/** Validate a rule from the form. Returns the clean row, or { error }. */
export function cleanRule(b) {
  const name = text(b.name, 80);
  const body = String(b.body ?? '').replace(/\r\n/g, '\n').trim().slice(0, 8000);
  if (!name) return { error: 'Give the rule a name.' };
  if (body.length < 5) return { error: 'Write the reply text.' };
  const types = (Array.isArray(b.types) ? b.types : csv(b.types).split(', ')).filter(t => TYPES[t]).join(',');
  const min = intOrNull(b.min_group);
  const max = intOrNull(b.max_group);
  if (min !== null && (!Number.isInteger(min) || min < 1)) return { error: 'Minimum group size must be a whole number.' };
  if (max !== null && (!Number.isInteger(max) || max < 1)) return { error: 'Maximum group size must be a whole number.' };
  if (min !== null && max !== null && min > max) return { error: 'The minimum group size is bigger than the maximum.' };
  const priority = intOrNull(b.priority);
  return {
    name,
    body,
    enabled: b.enabled === false || b.enabled === 0 || b.enabled === '0' ? 0 : 1,
    priority: Number.isInteger(priority) ? priority : 100,
    action: b.action === 'send' ? 'send' : 'draft',
    types: types || null,
    cities: csv(b.cities) || null,
    min_group: min,
    max_group: max,
    keywords: csv(b.keywords, 1000) || null,
  };
}

export async function onRequestPatch({ params, request, env }) {
  let body;
  try { body = await request.json(); } catch { return Response.json({ error: 'Invalid request.' }, { status: 400 }); }
  const id = Number(params.id);
  // A bare on/off toggle from the list.
  if (Object.keys(body).length === 1 && 'enabled' in body) {
    await env.DB.prepare("UPDATE reply_rules SET enabled = ?, updated_at = datetime('now') WHERE id = ?").bind(body.enabled ? 1 : 0, id).run();
    return Response.json({ ok: true });
  }
  const r = cleanRule(body);
  if (r.error) return Response.json({ error: r.error }, { status: 400 });
  const res = await env.DB.prepare(
    `UPDATE reply_rules SET name = ?, enabled = ?, priority = ?, action = ?, types = ?, cities = ?, min_group = ?,
       max_group = ?, keywords = ?, body = ?, updated_at = datetime('now') WHERE id = ?`,
  ).bind(r.name, r.enabled, r.priority, r.action, r.types, r.cities, r.min_group, r.max_group, r.keywords, r.body, id).run();
  if (!res.meta.changes) return Response.json({ error: 'Rule not found.' }, { status: 404 });
  return Response.json({ ok: true });
}

export async function onRequestDelete({ params, env }) {
  await env.DB.prepare('DELETE FROM reply_rules WHERE id = ?').bind(Number(params.id)).run();
  return Response.json({ ok: true });
}
