// GET /api/recent-sales — the latest paid voucher sales, anonymised for the
// site's social-proof pop-up. No names, no emails, no codes: just the face
// value, quantity and how long ago each order was paid. The pop-up handles an
// empty list by never appearing, so this always answers 200 with { sales }.

export async function onRequestGet({ env }) {
  let sales = [];
  try {
    const { results } = await env.DB.prepare(
      `SELECT amount_pence, quantity,
              CAST((julianday('now') - julianday(COALESCE(paid_at, created_at))) * 1440 AS INTEGER) AS mins_ago
         FROM orders
        WHERE status = 'paid' AND is_demo = 0
        ORDER BY COALESCE(paid_at, created_at) DESC
        LIMIT 5`,
    ).all();
    sales = (results || []).map(r => ({
      amount_pence: r.amount_pence,
      quantity: r.quantity,
      mins_ago: Math.max(0, r.mins_ago || 0),
    }));
  } catch (err) {
    // D1 hiccup — the pop-up simply doesn't show. Never break the page.
    console.error('recent-sales failed', err);
  }
  return Response.json({ sales }, {
    headers: { 'Cache-Control': 'public, max-age=300' },
  });
}
