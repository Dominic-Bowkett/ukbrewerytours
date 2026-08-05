// GET /api/pay/:token
//
// The only public window onto a payment request. The token is the entire
// authority: 128 unguessable bits, scoped to one request, granting view + pay
// and nothing else. It sits outside /api/admin/ and /api/team/, so neither
// session gate applies (and neither should).
//
// THE RESPONSE SHAPE BELOW IS A WHITELIST, NOT A CONVENIENCE. A pay link gets
// forwarded, pasted into shared inboxes and logged by mail scanners, so the
// payload must NOT carry:
//   * fee_pence / fee_bps / fee_source / net — the platform's cut is
//     commercial-in-confidence between us and the member, and the client must
//     only ever see one number;
//   * stripe_account_id — identifies the member's Stripe legal entity;
//   * the row id — the token is the only public handle, and exposing the id
//     invites correlation with the team API and with Stripe metadata;
//   * stripe_checkout_session_id / payment_intent / charge id — strong handles
//     on a live payment;
//   * client_email — echoing it turns a leaked link into a CONFIRMED address
//     disclosure; the page never needs it, so it is not sent at all;
//   * internal_note / created_by / the member's email / the member id;
//   * anything about any other request to the same client.
//
// Everything here is `no-store`: the token is in the path, so a cached copy is a
// cached payment link.

import {
  verifyPayToken, TOKEN_RE, settlePaid, recordEvent, payabilityOf,
} from '../../_lib/connect.js';
import { retrieveSession, retrievePaymentIntent, StripeError } from '../../_lib/stripe.js';

const PRIVATE = {
  'Cache-Control': 'no-store, private',
  // The token is in the path, so it would ride along in any outbound Referer.
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Content-Type-Options': 'nosniff',
};

// One reply for unknown, draft, scheduled and cancelled. Nothing here should
// help anyone tell a wrong token from a withdrawn one.
const notFound = () => Response.json(
  { error: 'This payment link is not valid or has been withdrawn.' },
  { status: 404, headers: PRIVATE },
);

export async function onRequestGet(ctx) {
  const { params, request, env } = ctx;
  if (!env.ADMIN_SESSION_SECRET) {
    return Response.json({ error: 'Not configured.' }, { status: 503, headers: PRIVATE });
  }

  const token = String(params.token || '').toLowerCase();
  if (!TOKEN_RE.test(token)) return notFound();

  const row = await env.DB.prepare(`
    SELECT r.*,
           m.active                   AS member_active,
           m.stripe_charges_enabled,
           m.stripe_account_state,
           m.stripe_platform_payments,
           m.stripe_account_id        AS member_account_id
      FROM payment_requests r
      JOIN team_members m ON m.id = r.team_member_id
     WHERE r.public_token = ?`).bind(token).first();

  if (!row) return notFound();

  // Belt and braces: the token must be the HMAC of THIS row's id, so a corrupted
  // or hand-edited public_token column cannot hand out a link to a different
  // request. Constant-time compare.
  if (!(await verifyPayToken(row.id, token, env.ADMIN_SESSION_SECRET))) return notFound();

  // Not yet sent, or withdrawn — the client should not be holding this link.
  // 'cancelling' is included: a cancel in flight has not yet expired the Stripe
  // session, so the page must not offer to start a payment either way.
  if (['draft', 'scheduled', 'sending', 'cancelling', 'cancelled'].includes(row.status)) return notFound();

  const url = new URL(request.url);
  let paid = row.status === 'paid' || row.status === 'refunded';

  // Returning from Stripe. The webhook is the source of truth, but it may not
  // have landed in the ~1s before the redirect completes — and if the Connect
  // endpoint is misconfigured, or its retries have been exhausted, this is the
  // thing that stops a real payment showing as unpaid forever. Gated on ?paid=1
  // so an ordinary page view never costs a Stripe round trip.
  if (!paid && url.searchParams.get('paid') === '1' && row.stripe_checkout_session_id) {
    try {
      const session = await retrieveSession(env, row.stripe_checkout_session_id, row.stripe_account_id);
      if (session.payment_status === 'paid') {
        paid = true;
        // Settlement (and the receipt) must not block the render — but it MUST
        // happen, so it goes through the same settlePaid() the webhook uses.
        ctx.waitUntil((async () => {
          try {
            const pi = session.payment_intent
              ? await retrievePaymentIntent(env, session.payment_intent, row.stripe_account_id)
              : null;
            await settlePaid(env, { row, session, paymentIntent: pi, source: 'pay-page-reconcile' });
          } catch (err) {
            console.error('reconcile settle failed', row.id, err);
          }
        })());
      }
    } catch (err) {
      // Never block the page on this; the webhook and the sweep catch up.
      if (!(err instanceof StripeError && err.isTransient)) console.error('pay reconcile failed', row.id, err);
    }
  }

  // First open flips the view counters for the member's dashboard. 'viewed' is
  // not a status in this schema precisely so that this write can never take a
  // live request out of the payable set. Never fatal.
  ctx.waitUntil((async () => {
    try {
      await env.DB.prepare(
        `UPDATE payment_requests
            SET viewed_at = COALESCE(viewed_at, datetime('now')),
                last_viewed_at = datetime('now'),
                view_count = view_count + 1
          WHERE id = ?`,
      ).bind(row.id).run();
      if (!row.viewed_at) {
        await recordEvent(env, {
          requestId: row.id, teamMemberId: row.team_member_id, type: 'viewed', actor: 'client',
          ip: request.headers.get('CF-Connecting-IP'),
        });
      }
    } catch (err) {
      console.error('view touch failed', row.id, err);
    }
  })());

  // Payability is re-derived from live member state on every view — see
  // payabilityOf() in _lib/connect.js for why the snapshot alone is not enough.
  const payable = payabilityOf(row);

  return Response.json({
    // 'paid'   — settled, show the receipt state
    // 'open'   — pay button live
    // 'closed' — visible but not payable; `closed_reason` is a fixed enum the
    //            page maps to copy, never a raw error string.
    status: paid ? 'paid' : (payable.ok ? 'open' : 'closed'),
    closed_reason: paid || payable.ok ? null : payable.reason,

    // Something quotable on the phone. Derived from the token they already hold,
    // or the member's own booking reference — neither is a database id.
    reference: row.reference || token.slice(0, 8).toUpperCase(),

    client_name: row.client_name,
    tour_name: row.tour_name,
    tour_date: row.tour_date,
    tour_time: row.tour_time,
    details: row.tour_details,

    // GROSS only. There is no field here from which the fee split can be derived.
    amount_pence: row.amount_pence,
    currency: row.currency,

    // Whose name the charge appears in — the client is buying from the member.
    seller_name: row.member_display_name || 'UK Brewery Tours',
    terms: row.terms_snapshot,
    paid_at: paid ? row.paid_at : null,
    expires_at: paid ? null : row.expires_at,
  }, { headers: PRIVATE });
}
