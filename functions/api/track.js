// POST /api/track — anonymous funnel counter for the voucher conversion report.
//
// Records a single 'open' event: the site's voucher pop-up opening, or an
// embedded voucher widget being rendered. No cookies, no identifiers beyond
// the IP kept solely for a flood cap. Always answers 200 — analytics must
// never break, block, or slow the page that sends them.

const MAX_PER_HOUR = 60; // per IP — generous for humans, stops junk floods

const clean = (s, max) => String(s ?? '').trim().slice(0, max);

export async function onRequestPost({ request, env }) {
  const ok = Response.json({ ok: true });

  let body;
  try {
    body = await request.json();
  } catch {
    return ok;
  }

  if (body.event !== 'open') return ok;

  const widgetId = clean(body.widgetId, 40) || null;
  const page = clean(body.page, 300) || null;
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

  try {
    // A widget id must be a real, active VOUCHER widget — otherwise junk ids
    // would invent rows in the conversion report.
    if (widgetId) {
      const w = await env.DB.prepare('SELECT kind, status FROM widgets WHERE id = ?').bind(widgetId).first();
      if (!w || w.kind !== 'voucher') return ok;
    }

    const { n } = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM widget_events WHERE ip = ? AND created_at > datetime('now','-1 hour')",
    ).bind(ip).first();
    if (n >= MAX_PER_HOUR) return ok;

    await env.DB.prepare(
      'INSERT INTO widget_events (event, widget_id, page, ip) VALUES (?,?,?,?)',
    ).bind('open', widgetId, page, ip).run();
  } catch (err) {
    // Missing table, D1 hiccup — the customer's page must never notice.
    console.error('track failed', err);
  }

  return ok;
}
