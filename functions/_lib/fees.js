// Platform fee resolution for team payment requests (Stripe Connect direct charges).
//
// The fee is INCLUDED, never added: a £100 tour means the client pays £100, the
// platform takes `application_fee_amount`, and the connected account keeps the
// rest (less Stripe's own processing fee, which Standard accounts bear).
//
// Percentages are integer basis points throughout — 2000 = 20.00% — so the whole
// money path stays in integers, as it is everywhere else in this codebase.

export const MAX_BPS = 10000;          // 100%
export const DEFAULT_FEE_BPS = 2000;   // 20%, the platform fallback
export const STRIPE_MIN_PENCE = 30;    // Stripe's GBP minimum charge

/**
 * Resolve the fee for a request: request override -> team member -> platform default.
 *
 * Called ONCE, at send time, and the result is written to payment_requests
 * (fee_bps, fee_pence, fee_source, fee_frozen_at) and never recomputed. Everything
 * downstream — the Checkout Session's application_fee_amount, the member's
 * statement, reconciliation — reads the frozen columns, so an admin changing the
 * default fee tomorrow cannot restate the terms of a request a client already has.
 *
 * @param {{fee_bps_override?: number|null}} request
 * @param {{fee_bps?: number|null}} member
 * @param {{default_fee_bps?: number|null}} settings   row from platform_settings
 */
export function resolveFeeBps(request, member, settings) {
  if (isBps(request?.fee_bps_override)) {
    return { feeBps: request.fee_bps_override, source: 'request' };
  }
  if (isBps(member?.fee_bps)) {
    return { feeBps: member.fee_bps, source: 'member' };
  }
  if (isBps(settings?.default_fee_bps)) {
    return { feeBps: settings.default_fee_bps, source: 'platform' };
  }
  // Settings row missing or corrupt — fall back rather than charge a 0% fee by accident.
  return { feeBps: DEFAULT_FEE_BPS, source: 'platform' };
}

function isBps(v) {
  return Number.isInteger(v) && v >= 0 && v <= MAX_BPS;
}

/**
 * Fee in pence, rounded half-up. Computed once and stored; never derived on the
 * fly, because a later rounding change would silently alter historic splits.
 * Clamped so `application_fee_amount` can never exceed the charge — Stripe rejects
 * that, and it would mean the connected account nets a negative amount.
 */
export function feePence(amountPence, feeBps) {
  if (!Number.isInteger(amountPence) || amountPence < STRIPE_MIN_PENCE) {
    throw new Error(`amount_pence must be an integer >= ${STRIPE_MIN_PENCE}`);
  }
  if (!isBps(feeBps)) throw new Error('fee_bps must be an integer between 0 and 10000');
  const fee = Math.round((amountPence * feeBps) / MAX_BPS);
  return Math.min(fee, amountPence);
}

/**
 * The full frozen snapshot written at send time. Terms and the connected account
 * id are frozen for the same reason as the fee: the client page and the email must
 * keep showing what was actually agreed.
 */
export function freezeTerms({ request, member, settings }) {
  const { feeBps, source } = resolveFeeBps(request, member, settings);
  if (!member?.stripe_account_id) {
    throw new Error(`team member ${member?.id} has no Stripe account assigned`);
  }
  if (!member.active) throw new Error(`team member ${member.id} is not active`);
  return {
    fee_bps: feeBps,
    fee_pence: feePence(request.amount_pence, feeBps),
    fee_source: source,
    stripe_account_id: member.stripe_account_id,
    member_display_name: member.company_name || member.name,
    terms_snapshot: member.terms_override || settings?.default_terms || null,
  };
}

/** Display helper — the API and UI talk in percent, storage stays in bps. */
export const bpsToPercent = bps => bps / 100;
export const percentToBps = pct => Math.round(pct * 100);
