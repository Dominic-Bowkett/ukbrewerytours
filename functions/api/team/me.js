// GET /api/team/me — who am I? Used by the /team/ shell to bounce to login and
// to explain itself when the account cannot currently trade.
//
// Reads only ctx.data.team, which the gate built from the verified session and a
// fresh read of the member row, so this endpoint cannot be pointed at another
// member: there is no id in the request to point with.
//
// It is one of the few routes reachable while must_change_password = 1 or the
// connected account is not charge-ready — otherwise the dashboard would get a
// bare 403 with nothing to tell the member.

import { bpsToPercent, DEFAULT_FEE_BPS } from '../../_lib/fees.js';
import { isChargeReady } from '../../_lib/team-auth.js';

export async function onRequestGet({ env, data }) {
  const m = data.team;

  // Display only. The fee that is actually charged is resolved and FROZEN
  // server-side at send time by _lib/fees.js — never from anything sent here,
  // and never recomputed afterwards.
  let defaultFeeBps = DEFAULT_FEE_BPS;
  try {
    const settings = await env.DB.prepare(
      'SELECT default_fee_bps FROM platform_settings WHERE id = 1',
    ).first();
    if (Number.isInteger(settings?.default_fee_bps)) defaultFeeBps = settings.default_fee_bps;
  } catch (err) {
    // Never fail the identity call over the settings row; fall back to the
    // platform default rather than showing a 0% fee by accident.
    console.error('team me: settings read failed', err);
  }

  const feeBps = Number.isInteger(m.fee_bps) ? m.fee_bps : defaultFeeBps;

  return Response.json({
    name: m.name,
    email: m.email,
    company: m.company_name || null,
    replyTo: m.reply_to_email || null,

    // Enough to confirm the right account is linked, without handing the shell
    // the full acct_ id it has no use for.
    connected: Boolean(m.stripe_account_id),
    accountHint: m.stripe_account_id ? `…${m.stripe_account_id.slice(-6)}` : null,
    accountLabel: m.stripe_account_label || null,

    // The gate's own verdict, so the UI and the API can never disagree about
    // whether this member may raise a payment request.
    chargeReady: isChargeReady(m),
    accountState: m.stripe_account_state,
    chargesEnabled: m.stripe_charges_enabled === 1,
    // TEXT 'active', not a 0/1 flag — the column is the capability's state as
    // Stripe reports it, and there is no _active twin of it to read.
    platformPaymentsActive: m.stripe_platform_payments === 'active',
    accountCheckedAt: m.stripe_account_checked_at || null,

    // bps is the storage vocabulary everywhere (12.5% is not an integer
    // percent); percent is only for display.
    feeBps,
    feePercent: bpsToPercent(feeBps),
    feeSource: Number.isInteger(m.fee_bps) ? 'member' : 'platform',

    mustChangePassword: m.must_change_password === 1,
    lastLoginAt: m.last_login_at || null,
  }, {
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  });
}
