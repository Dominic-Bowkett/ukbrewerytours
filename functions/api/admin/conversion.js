// GET /api/admin/conversion?days=30 — the voucher funnel per source.
//
// One row for the site's own pop-up (widget_id null) and one per voucher
// widget. Opens come from widget_events; checkouts and purchases come from
// orders (every order row is a started Stripe checkout; 'paid' = purchased).
// Demo purchases are excluded throughout. days=0 means all time.

// Funnel counts start here. Orders before this date predate open-tracking,
// so including them would show purchases with no matching opens and nonsense
// conversion rates. Earlier orders/vouchers still exist everywhere else in
// the admin — this epoch only scopes the conversion dashboard.
const TRACKING_EPOCH = '2026-08-16';

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  let days = parseInt(url.searchParams.get('days') || '30', 10);
  if (![0, 7, 30, 90].includes(days)) days = 30;

  // Bound in as a modifier string — only from the fixed set above.
  const since = days ? `-${days} days` : null;
  const sinceWhere = col => `AND ${col} >= '${TRACKING_EPOCH}'`
    + (since ? ` AND ${col} > datetime('now', ?)` : '');
  const bind = stmt => (since ? stmt.bind(since) : stmt);

  const { results: opens } = await bind(env.DB.prepare(`
    SELECT widget_id, COUNT(*) AS opens
    FROM widget_events
    WHERE event = 'open' ${sinceWhere('created_at')}
    GROUP BY widget_id`)).all();

  // Where those opens happened — per source, busiest pages first. Capped well
  // above anything the UI shows so one noisy source can't crowd out the rest.
  const { results: pageRows } = await bind(env.DB.prepare(`
    SELECT widget_id, COALESCE(page, '(unknown)') AS page, COUNT(*) AS opens
    FROM widget_events
    WHERE event = 'open' ${sinceWhere('created_at')}
    GROUP BY widget_id, page
    ORDER BY opens DESC
    LIMIT 500`)).all();

  const { results: orders } = await bind(env.DB.prepare(`
    SELECT widget_id,
           COUNT(*) AS checkouts,
           SUM(status = 'paid') AS paid,
           SUM(CASE WHEN status = 'paid' THEN total_pence ELSE 0 END) AS revenue_pence
    FROM orders
    WHERE is_demo = 0 ${sinceWhere('created_at')}
    GROUP BY widget_id`)).all();

  const { results: widgets } = await env.DB.prepare(
    "SELECT id, name, status FROM widgets WHERE kind = 'voucher'").all();

  // Compose: site row always present; widget rows for anything with a pulse.
  const byKey = new Map();
  const row = key => {
    if (!byKey.has(key)) byKey.set(key, { key, opens: 0, checkouts: 0, paid: 0, revenue_pence: 0 });
    return byKey.get(key);
  };
  row('site');
  for (const w of widgets) row(w.id);
  for (const o of opens) Object.assign(row(o.widget_id || 'site'), { opens: o.opens });
  for (const p of pageRows) {
    const r = row(p.widget_id || 'site');
    (r.pages = r.pages || []).push({ page: p.page, opens: p.opens });
  }
  for (const o of orders) {
    const r = row(o.widget_id || 'site');
    r.checkouts = o.checkouts;
    r.paid = o.paid || 0;
    r.revenue_pence = o.revenue_pence || 0;
  }

  const names = new Map(widgets.map(w => [w.id, w]));
  const rows = [...byKey.values()].map(r => ({
    ...r,
    pages: (r.pages || []).slice(0, 15),
    name: r.key === 'site'
      ? 'ukbrewerytours.com — voucher pop-up'
      : (names.get(r.key)?.name || `${r.key} (deleted widget)`),
    paused: r.key !== 'site' && names.get(r.key)?.status === 'paused',
  }));

  // Site first, then widgets by opens.
  rows.sort((a, b) => (a.key === 'site' ? -1 : b.key === 'site' ? 1 : b.opens - a.opens));

  const totals = rows.reduce((t, r) => ({
    opens: t.opens + r.opens,
    checkouts: t.checkouts + r.checkouts,
    paid: t.paid + r.paid,
    revenue_pence: t.revenue_pence + r.revenue_pence,
  }), { opens: 0, checkouts: 0, paid: 0, revenue_pence: 0 });

  return Response.json({ days, rows, totals });
}
