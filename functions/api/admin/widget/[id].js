// /api/admin/widget/:id — one embeddable voucher widget.
//   GET     detail + sales totals
//   PUT     update settings (including pause/resume via status)
//   DELETE  remove it — the embed on the host site goes dead, so the UI
//           confirms hard first. Past orders keep their widget_id string.

import { parseWidgetInput, WIDGET_STATS_SQL } from '../../../_lib/widgets.js';

async function load(env, id) {
  return env.DB.prepare(`
    SELECT w.*, ${WIDGET_STATS_SQL} FROM widgets w WHERE w.id = ?`).bind(id).first();
}

export async function onRequestGet({ params, env }) {
  const widget = await load(env, String(params.id || ''));
  if (!widget) return Response.json({ error: 'Widget not found.' }, { status: 404 });
  return Response.json({ widget });
}

export async function onRequestPut({ params, request, env }) {
  const id = String(params.id || '');
  const existing = await env.DB.prepare('SELECT id FROM widgets WHERE id = ?').bind(id).first();
  if (!existing) return Response.json({ error: 'Widget not found.' }, { status: 404 });

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const parsed = parseWidgetInput(body);
  if (parsed.error) return Response.json({ error: parsed.error }, { status: 400 });
  const f = parsed.fields;

  await env.DB.prepare(`
    UPDATE widgets SET name=?, heading=?, blurb=?, accent_color=?, preset_amounts=?,
                       allow_custom=?, allowed_origins=?, status=?, updated_at=datetime('now')
    WHERE id=?`,
  ).bind(f.name, f.heading, f.blurb, f.accent_color, f.preset_amounts,
    f.allow_custom, f.allowed_origins, f.status, id).run();

  return Response.json({ widget: await load(env, id) });
}

export async function onRequestDelete({ params, env }) {
  const id = String(params.id || '');
  const res = await env.DB.prepare('DELETE FROM widgets WHERE id = ?').bind(id).run();
  if (!res.meta.changes) return Response.json({ error: 'Widget not found.' }, { status: 404 });
  return Response.json({ ok: true });
}
