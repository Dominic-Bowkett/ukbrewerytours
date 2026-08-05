// GET /api/admin/vouchers?q=&status=&page=  — searchable voucher list + totals.

const PER_PAGE = 50;

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();
  const status = (url.searchParams.get('status') || '').trim();
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);

  const where = [];
  const binds = [];

  // `pending` vouchers are abandoned checkouts — hidden unless explicitly asked for.
  if (status) {
    where.push('v.status = ?');
    binds.push(status);
  } else {
    where.push("v.status != 'pending'");
  }

  if (q) {
    where.push(`(v.code LIKE ? OR o.purchaser_email LIKE ? OR o.recipient_email LIKE ?
                 OR o.purchaser_name LIKE ? OR o.recipient_name LIKE ?)`);
    const like = `%${q}%`;
    binds.push(like, like, like, like, like);
  }

  const { results } = await env.DB.prepare(`
    SELECT v.id, v.code, v.amount_pence, v.balance_pence, v.status, v.created_at, v.paid_at,
           o.purchaser_name, o.purchaser_email, o.recipient_name, o.recipient_email,
           o.send_to_self, o.tour_name, o.is_demo
    FROM vouchers v JOIN orders o ON o.id = v.order_id
    WHERE ${where.join(' AND ')}
    ORDER BY v.id DESC
    LIMIT ? OFFSET ?`,
  ).bind(...binds, PER_PAGE + 1, (page - 1) * PER_PAGE).all();

  const stats = await env.DB.prepare(`
    SELECT COUNT(*) AS total,
           COALESCE(SUM(amount_pence), 0) AS issued_pence,
           COALESCE(SUM(balance_pence), 0) AS outstanding_pence
    FROM vouchers WHERE status != 'pending'`).first();

  return Response.json({
    vouchers: results.slice(0, PER_PAGE),
    page,
    hasMore: results.length > PER_PAGE,
    stats,
  });
}
