// GET /api/admin/payment-requests?q=&status=&member=&page=
//
// Every payment request across the whole team, which the team endpoints
// deliberately cannot show: /api/team/requests is scoped to the signed-in
// member. This is the platform-wide view — who charged what, on which
// connected account, how much fee it earned, and what has been refunded.

const PER_PAGE = 50;

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();
  const status = (url.searchParams.get('status') || '').trim();
  const member = (url.searchParams.get('member') || '').trim();
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);

  const where = [];
  const binds = [];

  // Drafts are half-written requests a member never sent — noise here.
  if (status) {
    where.push('r.status = ?');
    binds.push(status);
  } else {
    where.push("r.status <> 'draft'");
  }

  if (member) {
    where.push('r.team_member_id = ?');
    binds.push(member);
  }

  if (q) {
    where.push(`(r.client_name LIKE ? OR r.client_email LIKE ? OR r.tour_name LIKE ?
                 OR r.reference LIKE ? OR m.name LIKE ?)`);
    const like = `%${q}%`;
    binds.push(like, like, like, like, like);
  }

  const { results } = await env.DB.prepare(`
    SELECT r.id, r.public_token, r.client_name, r.client_email, r.tour_name, r.tour_date,
           r.amount_pence, r.fee_pence, r.fee_bps, r.currency, r.status, r.payment_kind,
           r.amount_paid_pence, r.fee_collected_pence, r.refunded_pence, r.fee_refunded_pence,
           r.unexpected_payment, r.sent_at, r.paid_at, r.refunded_at, r.created_at,
           r.stripe_account_id, r.stripe_payment_intent,
           m.id AS member_id, m.name AS member_name, m.email AS member_email
      FROM payment_requests r
      JOIN team_members m ON m.id = r.team_member_id
     WHERE ${where.join(' AND ')}
     ORDER BY COALESCE(r.paid_at, r.sent_at, r.created_at) DESC
     LIMIT ? OFFSET ?`,
  ).bind(...binds, PER_PAGE + 1, (page - 1) * PER_PAGE).all();

  // Platform totals, across every member. fee_collected_pence is what Stripe
  // actually took, so it is the honest number rather than what was quoted.
  const totals = await env.DB.prepare(`
    SELECT
      COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN status='paid' THEN amount_paid_pence ELSE 0 END), 0) AS paid_pence,
      COALESCE(SUM(CASE WHEN status='paid' THEN COALESCE(fee_collected_pence, fee_pence) ELSE 0 END), 0) AS fee_pence,
      COALESCE(SUM(refunded_pence), 0) AS refunded_pence,
      COALESCE(SUM(fee_refunded_pence), 0) AS fee_refunded_pence,
      COALESCE(SUM(CASE WHEN status IN ('sent','processing') THEN amount_pence ELSE 0 END), 0) AS outstanding_pence,
      SUM(CASE WHEN unexpected_payment = 1 THEN 1 ELSE 0 END) AS needs_attention
    FROM payment_requests
    WHERE status <> 'draft'`).first();

  // For the member filter dropdown.
  const { results: members } = await env.DB.prepare(
    'SELECT id, name FROM team_members ORDER BY active DESC, name',
  ).all();

  return Response.json({
    requests: results.slice(0, PER_PAGE),
    page,
    hasMore: results.length > PER_PAGE,
    totals,
    members,
  }, { headers: { 'Cache-Control': 'private, no-store' } });
}
