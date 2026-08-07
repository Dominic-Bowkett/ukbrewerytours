// /api/admin/widgets — embeddable voucher widgets.
//   GET   list, newest first, with per-widget sales totals
//   POST  create one; returns the row ready for the embed-code screen
// Auth comes from the /api/admin/* middleware.

import { generateWidgetId, parseWidgetInput, WIDGET_STATS_SQL } from '../../_lib/widgets.js';

export async function onRequestGet({ env }) {
  const { results } = await env.DB.prepare(`
    SELECT w.*, ${WIDGET_STATS_SQL}
    FROM widgets w
    ORDER BY w.created_at DESC, w.id`).all();
  return Response.json({ widgets: results });
}

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid request.' }, { status: 400 });
  }

  // Kind is fixed at creation: 'voucher' sells gift vouchers, 'contact'
  // collects messages for info@. Updates never change it.
  const kind = body.kind === 'contact' ? 'contact' : 'voucher';
  const parsed = parseWidgetInput(body, kind);
  if (parsed.error) return Response.json({ error: parsed.error }, { status: 400 });
  const f = parsed.fields;

  const id = generateWidgetId();
  await env.DB.prepare(`
    INSERT INTO widgets (id, kind, name, heading, blurb, accent_color, preset_amounts,
                         allow_custom, allowed_origins, status, gift_message)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(id, kind, f.name, f.heading, f.blurb, f.accent_color, f.preset_amounts,
    f.allow_custom, f.allowed_origins, f.status, f.gift_message).run();

  const widget = await env.DB.prepare(`
    SELECT w.*, ${WIDGET_STATS_SQL} FROM widgets w WHERE w.id = ?`).bind(id).first();
  return Response.json({ widget }, { status: 201 });
}
