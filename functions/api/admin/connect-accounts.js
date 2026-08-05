// GET /api/admin/connect-accounts?q=
// Live list of Stripe connected accounts, so admin can pick which one a team
// member charges on. Read-only: this endpoint never creates or modifies an
// account, it only mirrors what Stripe already knows.
//
// Most of the accounts have no business_profile.name set, so the label falls
// back through display name -> business name -> email -> id, and whichever team
// member already holds an account is marked so the same one is not assigned twice.

import { stripeApi } from '../../_lib/stripe.js';

export async function onRequestGet({ request, env }) {
  if (!env.STRIPE_SECRET_KEY) {
    return Response.json({ error: 'Stripe is not configured.' }, { status: 503 });
  }

  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim().toLowerCase();
  const onlyReady = url.searchParams.get('ready') === '1';

  let stripeAccounts;
  try {
    // 100 is Stripe's max page size; the platform has ~41, so one page is enough.
    const res = await stripeApi(env, '/accounts?limit=100');
    stripeAccounts = res.data || [];
  } catch (err) {
    console.error('connect-accounts list failed', err);
    return Response.json({ error: `Could not reach Stripe: ${err.message}` }, { status: 502 });
  }

  // Which accounts are already assigned, so the UI can say so.
  const { results: assigned } = await env.DB.prepare(
    'SELECT stripe_account_id, id, name, email, active FROM team_members WHERE stripe_account_id IS NOT NULL',
  ).all();
  const byAccount = new Map(assigned.map(m => [m.stripe_account_id, m]));

  const accounts = stripeAccounts.map((a) => {
    const caps = a.capabilities || {};
    // Direct charges with an application fee need both of these active.
    const chargeReady = a.charges_enabled === true && caps.card_payments === 'active';
    const feeReady = caps.platform_payments === 'active' || caps.transfers === 'active';
    const member = byAccount.get(a.id) || null;

    return {
      id: a.id,
      label: a.settings?.dashboard?.display_name
        || a.business_profile?.name
        || a.email
        || a.id,
      email: a.email || null,
      type: a.type,
      country: a.country,
      currency: a.default_currency,
      charges_enabled: a.charges_enabled === true,
      charge_ready: chargeReady,
      fee_ready: feeReady,
      usable: chargeReady && feeReady,
      assigned_to: member ? { id: member.id, name: member.name, email: member.email, active: member.active === 1 } : null,
    };
  });

  const filtered = accounts.filter((a) => {
    if (onlyReady && !a.usable) return false;
    if (!q) return true;
    return [a.id, a.label, a.email].filter(Boolean).some(v => String(v).toLowerCase().includes(q));
  });

  // Usable first, then already-assigned, then alphabetical — the order an
  // operator actually wants when choosing an account.
  filtered.sort((a, b) =>
    (b.usable - a.usable)
    || ((b.assigned_to ? 1 : 0) - (a.assigned_to ? 1 : 0))
    || String(a.label).localeCompare(String(b.label)));

  return Response.json({
    accounts: filtered,
    total: accounts.length,
    usable: accounts.filter(a => a.usable).length,
    assigned: byAccount.size,
  }, { headers: { 'Cache-Control': 'private, no-store' } });
}
