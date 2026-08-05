// POST /api/stripe-connect-webhook
//
// Separate from /api/stripe-webhook, for four reasons:
//
//  1. Different signing secret. A Connect endpoint is registered in Stripe as
//     "listen to events on connected accounts" and issued its own whsec_. One
//     handler cannot verify both without trying two secrets in turn, which would
//     destroy the guarantee about WHICH channel an event arrived on.
//  2. Connect events carry `event.account`; platform events do not. That field
//     is an AUTHORISATION input here, so it must be present.
//  3. Objects referenced by a Connect event live on the connected account, so
//     every read-back needs the Stripe-Account header. The platform handler
//     never sends one, and mixing the two means querying the wrong ledger and
//     silently getting a 404.
//  4. Every connected account's events land on this one URL. Team members hold
//     STANDARD accounts — full dashboard, full API access to their own account —
//     so the payload is signed by Stripe but otherwise UNTRUSTED. This handler
//     is not written the way the voucher one is, and it should not be.
//
// NOTHING HERE SILENTLY DROPS A PAYMENT. Every path that declines to settle
// records the money in `unmatched_payments` and emails NOTIFY_EMAIL. A 200 with
// only a console.error is invisible in Stripe's dashboard AND invisible to us,
// which is how a systematic mismatch discards real charges for days.
//
// Statements follow helper E in migrations/0004_connect.sql.

import {
  verifyWebhook, safeEqual, retrievePaymentIntent, retrieveAccount, StripeError,
} from '../_lib/stripe.js';
import {
  settlePaid, settleCharge, sessionMismatch, sessionNonce, recordEvent,
  recordUnmatched, alertOps, money, newId,
} from '../_lib/connect.js';

// 200 for anything we have finished with, so Stripe stops retrying.
const ok = msg => new Response(msg, { status: 200 });

export async function onRequestPost({ request, env }) {
  if (!env.STRIPE_CONNECT_WEBHOOK_SECRET) {
    // 500, not 200: an unconfigured endpoint must show up as FAILING in the
    // Stripe dashboard rather than quietly swallowing every payment.
    console.error('STRIPE_CONNECT_WEBHOOK_SECRET is not set');
    return new Response('not configured', { status: 500 });
  }

  const raw = await request.text();
  const event = await verifyWebhook(
    raw,
    request.headers.get('stripe-signature'),
    env.STRIPE_CONNECT_WEBHOOK_SECRET,   // NOT STRIPE_WEBHOOK_SECRET
  );
  if (!event) return new Response('Invalid signature', { status: 400 });

  // No `account` means a platform event pointed at the wrong endpoint.
  if (!event.account) {
    await alertOps(env, {
      subject: 'Platform event delivered to the Connect endpoint',
      lines: [`Event: ${event.id}`, `Type: ${event.type}`, 'Check the endpoint configuration in Stripe.'],
    });
    return ok('not a connect event');
  }

  // Live/test mismatch, from EXPLICIT configuration — never by sniffing the key
  // prefix. A key rotated to a restricted key (rk_live_…) would invert a prefix
  // test and discard 100% of live events with nobody the wiser.
  const live = await liveMode(env);
  if (live !== null && Boolean(event.livemode) !== live) {
    await alertOps(env, {
      subject: 'Connect webhook livemode mismatch — event NOT processed',
      lines: [
        `Event: ${event.id} (${event.type})`,
        `event.livemode=${event.livemode}, configured live_mode=${live}`,
        'If this is a real payment: fix platform_settings.live_mode / STRIPE_LIVE_MODE and REPLAY the event from Stripe.',
      ],
    });
    return ok('livemode mismatch');
  }

  /* ------------------------------------------------------------- idempotency */
  // The dedupe row is a COMPLETION marker, never an arrival marker. "Insert the
  // marker, and 0 rows changed means already processed" is two D1 statements
  // with no transaction: crash in between and every Stripe retry for the next
  // three days sees the marker, returns 200 and does nothing — the payment then
  // exists on the connected account and nowhere else. Only processed_at
  // short-circuits; every downstream write is status-guarded and replay-safe.
  await env.DB.prepare(
    `INSERT INTO stripe_connect_events (id, stripe_account_id, type, livemode, attempts, claimed_at)
     VALUES (?1, ?2, ?3, ?4, 1, datetime('now'))
     ON CONFLICT(id) DO UPDATE
        SET attempts = attempts + 1, claimed_at = datetime('now')
      WHERE stripe_connect_events.processed_at IS NULL`,
  ).bind(event.id, event.account, event.type, event.livemode ? 1 : 0).run();

  const seen = await env.DB.prepare('SELECT processed_at FROM stripe_connect_events WHERE id = ?')
    .bind(event.id).first();
  if (seen?.processed_at) return ok('already processed');

  let result;
  try {
    result = await route(env, event);
  } catch (err) {
    console.error('connect webhook handler threw', event.id, event.type, err);
    await env.DB.prepare('UPDATE stripe_connect_events SET last_error = ? WHERE id = ?')
      .bind(String(err.message || err).slice(0, 500), event.id).run();
    // 500 => Stripe retries, and nothing was marked processed.
    return new Response('handler error', { status: 500 });
  }

  if (result.retry) {
    await env.DB.prepare('UPDATE stripe_connect_events SET last_error = ? WHERE id = ?')
      .bind(result.message || 'retry', event.id).run();
    return new Response(result.message || 'retry', { status: 500 });
  }

  // Completion marker LAST.
  await env.DB.prepare(
    `UPDATE stripe_connect_events
        SET processed_at = datetime('now'), outcome = ?2, payment_request_id = COALESCE(?3, payment_request_id)
      WHERE id = ?1 AND processed_at IS NULL`,
  ).bind(event.id, result.outcome || 'ignored', result.requestId || null).run();

  return ok(result.message || 'ok');
}

async function route(env, event) {
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      return handlePaid(env, event);
    case 'checkout.session.expired':
    case 'checkout.session.async_payment_failed':
      return handleSessionClosed(env, event);
    case 'charge.refunded':
      return handleRefunded(env, event);
    case 'charge.dispute.created':
      return handleDispute(env, event);
    case 'account.updated':
    case 'capability.updated':
      return handleAccountUpdated(env, event);
    case 'account.application.deauthorized':
      return handleDeauthorized(env, event);
    default:
      return { message: 'ignored', outcome: 'ignored' };
  }
}

/** Explicit configuration; null means "not configured — do not gate on it". */
async function liveMode(env) {
  if (env.STRIPE_LIVE_MODE === 'true') return true;
  if (env.STRIPE_LIVE_MODE === 'false') return false;
  try {
    const s = await env.DB.prepare('SELECT live_mode FROM platform_settings WHERE id = 1').first();
    if (s && (s.live_mode === 0 || s.live_mode === 1)) return s.live_mode === 1;
  } catch { /* fall through */ }
  return null;
}

const loadRequest = (env, id) => env.DB.prepare(
  'SELECT * FROM payment_requests WHERE id = ?',
).bind(id).first();

/* -------------------------------------------------------------- resolution */

/**
 * Resolve a Checkout Session to one of our requests, and to the figures it was
 * created with.
 *
 * Order matters, and the fallback is the security-critical part. These are
 * Standard connected accounts: the member holds their own Stripe key and can
 * create a Checkout Session on their own account carrying our
 * client_reference_id and NO application_fee_amount, and Stripe will deliver the
 * completed event straight to this endpoint. Resolving on metadata alone
 * therefore lets a member settle their own £2,000 request with a 30p charge, or
 * with zero fee to the platform.
 *
 * So the fallback demands `payreq_nonce` — 32 hex derived from checkout_lock_id
 * under the platform secret, compared in constant time — and the caller then
 * enforces account, amount, currency AND the expected application_fee_amount.
 *
 * `expected` is the SESSION's own snapshot where we have one, so a charge is
 * proved against the figures its own session was created with.
 */
async function resolveRequest(env, event, session) {
  // 1. The session ledger: every session this platform ever minted.
  const s = await env.DB.prepare('SELECT * FROM payment_request_sessions WHERE id = ?')
    .bind(session.id).first();
  if (s) {
    if (s.stripe_account_id !== event.account) return { reason: 'session account mismatch' };
    const row = await loadRequest(env, s.payment_request_id);
    if (!row) return { reason: 'session points at a missing request' };
    return {
      row,
      via: 'session',
      sessionRow: s,
      expected: {
        stripe_account_id: s.stripe_account_id,
        amount_pence: s.amount_pence,
        currency: s.currency,
        fee_pence: s.fee_pence,
      },
    };
  }

  // 2. The request's current session pointer, scoped to the account.
  const byColumn = await env.DB.prepare(
    'SELECT * FROM payment_requests WHERE stripe_checkout_session_id = ? AND stripe_account_id = ?',
  ).bind(session.id, event.account).first();
  if (byColumn) return { row: byColumn, via: 'session_column', expected: expectedFromRow(byColumn) };

  // 3. Metadata fallback — nonce required, and then everything else too.
  const claimedId = session.client_reference_id || session.metadata?.payment_request_id || null;
  const nonce = session.metadata?.payreq_nonce || null;
  if (!claimedId) return { reason: 'unknown session' };
  if (!nonce) return { reason: 'no nonce on a session we did not mint', claimedId };

  const cand = await loadRequest(env, claimedId);
  if (!cand) return { reason: 'unknown request id in metadata', claimedId };

  // Accept the nonce derived from the CURRENT lock, or any nonce we ever minted
  // for this request. Both are values only the platform can produce.
  let nonceOk = false;
  if (cand.checkout_lock_id && env.ADMIN_SESSION_SECRET) {
    const expected = await sessionNonce(cand.id, cand.checkout_lock_id, env.ADMIN_SESSION_SECRET);
    nonceOk = safeEqual(nonce, expected);
  }
  if (!nonceOk) {
    const hit = await env.DB.prepare(
      'SELECT nonce FROM payment_request_sessions WHERE payment_request_id = ? AND nonce = ?',
    ).bind(cand.id, nonce).first();
    nonceOk = Boolean(hit) && safeEqual(nonce, hit.nonce);
  }
  if (!nonceOk) return { reason: 'nonce mismatch', claimedId };

  return { row: cand, via: 'nonce', expected: expectedFromRow(cand) };
}

const expectedFromRow = row => ({
  stripe_account_id: row.stripe_account_id,
  amount_pence: row.amount_pence,
  currency: row.currency,
  fee_pence: row.fee_pence || 0,
});

/* -------------------------------------------------------------------- paid */

async function handlePaid(env, event) {
  const session = event.data.object;

  if (session.payment_status !== 'paid') {
    // Completed with a delayed payment method. Stripe never emits
    // checkout.session.expired for a COMPLETE session, so without this the row
    // looks re-payable once the cached URL ages out and the client can be
    // charged twice.
    const found = await resolveRequest(env, event, session);
    if (found.row) {
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE payment_requests SET status='processing', updated_at=datetime('now')
            WHERE id=? AND status IN ('sent','sending')`,
        ).bind(found.row.id),
        env.DB.prepare(
          "UPDATE payment_request_sessions SET status='processing' WHERE id=? AND status='open'",
        ).bind(session.id),
      ]);
      await recordEvent(env, {
        requestId: found.row.id, teamMemberId: found.row.team_member_id,
        type: 'payment_processing', actor: 'stripe', stripeEventId: event.id,
        detail: `Checkout completed with payment_status=${session.payment_status}`,
      });
      return { message: 'processing', outcome: 'ignored', requestId: found.row.id };
    }
    return { message: 'processing, unknown request', outcome: 'ignored' };
  }

  const found = await resolveRequest(env, event, session);

  if (!found.row) {
    await recordUnmatched(env, {
      eventId: event.id, account: event.account, sessionId: session.id,
      paymentIntent: session.payment_intent || null,
      clientReferenceId: found.claimedId || session.client_reference_id || null,
      amountPence: session.amount_total ?? null, currency: session.currency || null,
      reason: found.reason,
    });
    return { message: `unmatched (${found.reason})`, outcome: 'unmatched' };
  }

  const row = found.row;
  const viaFallback = found.via === 'nonce';

  // The PaymentIntent carries the charge id AND the application fee actually
  // taken. On the fallback path the fee is an AUTHORISATION input, so failing to
  // read it means refusing to settle. On the primary path it is reconciliation,
  // and a read failure must never block a real payment.
  let pi = null;
  let piError = null;
  if (session.payment_intent) {
    try {
      pi = await retrievePaymentIntent(env, session.payment_intent, event.account);
    } catch (err) {
      piError = err;
      console.error('payment_intent read failed', row.id, err);
    }
  }

  if (viaFallback && !pi) {
    await recordUnmatched(env, {
      eventId: event.id, account: event.account, sessionId: session.id,
      paymentIntent: session.payment_intent || null,
      clientReferenceId: row.id,
      amountPence: session.amount_total ?? null, currency: session.currency || null,
      reason: 'fee unverifiable on a fallback match',
    });
    // Retry while the failure could be transient: we must not settle blind, and
    // we must not give up on money either.
    const transient = !piError || (piError instanceof StripeError && piError.isTransient);
    return transient
      ? { retry: true, message: 'fee unverifiable' }
      : { message: 'fee unverifiable', outcome: 'rejected', requestId: row.id };
  }

  const mismatch = sessionMismatch(found.expected, session, event.account, { paymentIntent: pi });

  if (mismatch) {
    // An account mismatch is never legitimate on any path: a different connected
    // account is trying to settle this request. On the FALLBACK path ANY
    // mismatch is refused — that is the whole point of the check, and it is what
    // stops a self-minted session settling a request for 30p or with no fee.
    if (mismatch === 'account' || viaFallback) {
      await recordUnmatched(env, {
        eventId: event.id, account: event.account, sessionId: session.id,
        paymentIntent: session.payment_intent || null,
        chargeId: pi?.latest_charge || null,
        clientReferenceId: row.id,
        amountPence: session.amount_total ?? null, currency: session.currency || null,
        feePence: pi?.application_fee_amount ?? null,
        reason: `${mismatch} mismatch — refused`,
      });
      await recordEvent(env, {
        requestId: row.id, teamMemberId: row.team_member_id, type: 'alert', actor: 'stripe',
        stripeEventId: event.id, detail: `settlement refused: ${mismatch} mismatch`,
        data: {
          expected_amount: found.expected.amount_pence, received_amount: session.amount_total,
          expected_fee: found.expected.fee_pence, received_fee: pi?.application_fee_amount ?? null,
          expected_account: found.expected.stripe_account_id, event_account: event.account,
        },
      });
      return { message: `rejected (${mismatch})`, outcome: 'rejected', requestId: row.id };
    }

    // Primary path — a session id we minted. The money is real and provably
    // ours to record. Recording it and shouting beats discarding it.
    await alertOps(env, {
      subject: `Paid session does not match what we asked for (${mismatch})`,
      requestId: row.id,
      lines: [
        `Session: ${session.id} on ${event.account}`,
        `Expected: ${money(found.expected.amount_pence)} ${found.expected.currency}, fee ${money(found.expected.fee_pence)}`,
        `Received: ${money(session.amount_total ?? 0)} ${session.currency}, fee ${money(pi?.application_fee_amount ?? 0)}`,
        'The payment IS being recorded. Reconcile the difference by hand.',
      ],
    });
    await recordEvent(env, {
      requestId: row.id, teamMemberId: row.team_member_id, type: 'alert', actor: 'stripe',
      stripeEventId: event.id, detail: `${mismatch} mismatch on a session we minted`,
      data: {
        expected_amount: found.expected.amount_pence, received_amount: session.amount_total,
        expected_fee: found.expected.fee_pence, received_fee: pi?.application_fee_amount ?? null,
      },
    });
  }

  // Charge ids on EVERY delivery, not only the winning one — otherwise a receipt
  // failure, or a redirect reconcile that won the race, leaves the row without a
  // charge id and no refund or dispute can ever be matched to it.
  await settleCharge(env, { row, paymentIntent: pi });

  // A payment that arrived on a session the row no longer names still points the
  // row at the session that was actually paid.
  await env.DB.prepare(
    'UPDATE payment_requests SET stripe_checkout_session_id = COALESCE(stripe_checkout_session_id, ?1) WHERE id = ?2',
  ).bind(session.id, row.id).run();

  const outcome = await settlePaid(env, { row, session, paymentIntent: pi, source: 'connect-webhook' });

  if (outcome.emailFailed) {
    // Money is recorded; only delivery failed. 500 makes Stripe retry, and
    // paid_email_sent was released back to 0, so the retry re-attempts JUST the
    // email — never the money write, which is status-guarded.
    return { retry: true, message: 'email failed' };
  }
  return { message: 'ok', outcome: 'settled', requestId: row.id };
}

/* --------------------------------------------------- session closed unpaid */

async function handleSessionClosed(env, event) {
  const session = event.data.object;

  await env.DB.prepare("UPDATE payment_request_sessions SET status='expired' WHERE id=? AND status <> 'complete'")
    .bind(session.id).run();

  // Release the cached URL so the client can start a fresh session, and bring a
  // 'processing' row (a failed delayed payment) back to 'sent'. Guarded on
  // status so a paid, cancelled or refunded row is never touched.
  await env.DB.prepare(
    `UPDATE payment_requests
        SET stripe_checkout_session_id = NULL,
            stripe_checkout_url = NULL,
            stripe_checkout_expires_at = NULL,
            checkout_lock_id = NULL,
            status = CASE WHEN status = 'processing' THEN 'sent' ELSE status END,
            updated_at = datetime('now')
      WHERE stripe_checkout_session_id = ?
        AND stripe_account_id = ?
        AND status IN ('sent','processing')`,
  ).bind(session.id, event.account).run();

  const row = await env.DB.prepare(
    `SELECT pr.id, pr.team_member_id
       FROM payment_request_sessions s
       JOIN payment_requests pr ON pr.id = s.payment_request_id
      WHERE s.id = ? AND s.stripe_account_id = ?`,
  ).bind(session.id, event.account).first();
  if (row) {
    await recordEvent(env, {
      requestId: row.id, teamMemberId: row.team_member_id, type: 'checkout_expired',
      actor: 'stripe', stripeEventId: event.id, detail: `Session ${session.id} closed unpaid`,
    });
  }

  return { message: 'session closed', outcome: 'ignored', requestId: row?.id || null };
}

/* ----------------------------------------------------------------- refunds */

async function handleRefunded(env, event) {
  const charge = event.data.object;

  const row = await env.DB.prepare(
    `SELECT * FROM payment_requests
      WHERE stripe_account_id = ?1 AND (stripe_charge_id = ?2 OR stripe_payment_intent = ?3)`,
  ).bind(event.account, charge.id, charge.payment_intent || '').first();

  if (!row) {
    await recordUnmatched(env, {
      eventId: event.id, account: event.account,
      paymentIntent: charge.payment_intent || null, chargeId: charge.id,
      amountPence: charge.amount_refunded ?? null, currency: charge.currency || null,
      reason: 'refund for a charge we do not know',
    });
    return { message: 'unknown charge', outcome: 'unmatched' };
  }

  // charge.amount_refunded is a RUNNING TOTAL. Never add it — reconcile to the
  // absolute value, and only upward, so replaying the event is a no-op and a
  // refund issued in the Stripe dashboard is picked up just as well as ours.
  await env.DB.prepare(
    `UPDATE payment_requests
        SET refunded_pence = ?1,
            refunded_at = COALESCE(refunded_at, datetime('now')),
            status = CASE WHEN ?1 >= COALESCE(amount_paid_pence, amount_pence)
                          THEN 'refunded' ELSE status END,
            stripe_charge_id = COALESCE(stripe_charge_id, ?2),
            updated_at = datetime('now')
      WHERE id = ?3 AND refunded_pence < ?1`,
  ).bind(charge.amount_refunded || 0, charge.id, row.id).run();

  // One row per Stripe refund. UNIQUE(stripe_refund_id) makes it idempotent and
  // stops the admin path and this webhook double-counting the same refund.
  for (const r of charge.refunds?.data || []) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO payment_request_refunds
         (id, payment_request_id, stripe_refund_id, stripe_account_id, amount_pence, reason, refunded_by, status)
       VALUES (?,?,?,?,?,?, 'stripe', 'succeeded')`,
    ).bind(
      newId(), row.id, r.id, event.account, r.amount,
      ['duplicate', 'fraudulent', 'requested_by_customer'].includes(r.reason) ? r.reason : null,
    ).run();
  }

  await recordEvent(env, {
    requestId: row.id, teamMemberId: row.team_member_id, type: 'refunded', actor: 'stripe',
    stripeEventId: event.id, detail: `Refunded total ${money(charge.amount_refunded || 0)}`,
  });

  // If our fee was never reversed, the platform is holding 20% of a booking that
  // did not happen, out of the member's pocket. That must be visible.
  const fresh = await env.DB.prepare(
    'SELECT fee_collected_pence, fee_pence, fee_refunded_pence, refunded_pence FROM payment_requests WHERE id = ?',
  ).bind(row.id).first();
  if (fresh && fresh.refunded_pence > 0 && (fresh.fee_refunded_pence || 0) === 0
      && (fresh.fee_collected_pence ?? fresh.fee_pence ?? 0) > 0) {
    await alertOps(env, {
      subject: 'Refund recorded with no application-fee reversal',
      requestId: row.id,
      lines: [
        `Refunded: ${money(fresh.refunded_pence)}`,
        `Fee still held by the platform: ${money(fresh.fee_collected_pence ?? fresh.fee_pence)}`,
        'If this refund was issued in the Stripe dashboard, reverse the application fee there too.',
      ],
    });
  }

  return { message: 'refund recorded', outcome: 'settled', requestId: row.id };
}

async function handleDispute(env, event) {
  const dispute = event.data.object;
  const row = await env.DB.prepare(
    `SELECT id, team_member_id FROM payment_requests
      WHERE stripe_account_id = ?1 AND (stripe_charge_id = ?2 OR stripe_payment_intent = ?3)`,
  ).bind(event.account, dispute.charge || '', dispute.payment_intent || '').first();

  if (row) {
    await recordEvent(env, {
      requestId: row.id, teamMemberId: row.team_member_id, type: 'alert', actor: 'stripe',
      stripeEventId: event.id,
      detail: `Dispute opened: ${money(dispute.amount || 0)} (${dispute.reason || 'unknown'})`,
    });
  }
  await alertOps(env, {
    subject: 'Chargeback opened on a connected account',
    requestId: row?.id || null,
    lines: [
      `Account: ${event.account}`,
      `Charge: ${dispute.charge || '—'}`,
      `Amount: ${money(dispute.amount || 0)} — ${dispute.reason || 'unknown'}`,
      'Liability sits with the connected account on a direct charge, but the application fee can be clawed back.',
    ],
  });
  return { message: 'dispute noted', outcome: 'ignored', requestId: row?.id || null };
}

/* ----------------------------------------------------------- account state */

/**
 * charges_enabled is NOT "can this member take our money". A Standard account
 * can have charges_enabled = true while the platform_payments capability goes
 * inactive: ordinary charges still work and only application_fee_amount is
 * refused, so the member keeps sending requests happily and the client hits an
 * error at the moment of payment with nobody alerted.
 */
async function handleAccountUpdated(env, event) {
  const obj = event.data.object;
  const accountId = event.type === 'capability.updated'
    ? (obj.account || event.account)
    : (obj.id || event.account);

  let acct = obj;
  if (event.type === 'capability.updated') {
    try {
      acct = await retrieveAccount(env, accountId);
    } catch (err) {
      console.error('account re-read failed', accountId, err);
      return { retry: true, message: 'account read failed' };
    }
  }

  const caps = acct.capabilities || {};
  const platformPayments = caps.platform_payments || caps.transfers || null;
  const cardPayments = caps.card_payments || null;
  const canCharge = (acct.charges_enabled === true && platformPayments === 'active') ? 1 : 0;

  const res = await env.DB.prepare(
    `UPDATE team_members
        SET stripe_charges_enabled = ?1,
            stripe_payouts_enabled = ?2,
            stripe_platform_payments = ?3,
            stripe_card_payments = ?4,
            stripe_account_state = ?5,
            stripe_account_checked_at = datetime('now'),
            updated_at = datetime('now')
      WHERE stripe_account_id = ?6 AND stripe_account_state <> 'deauthorized'`,
  ).bind(
    canCharge,
    acct.payouts_enabled ? 1 : 0,
    normaliseCapability(platformPayments),
    normaliseCapability(cardPayments),
    canCharge ? 'active' : 'restricted',
    accountId,
  ).run();

  if (res.meta.changes && !canCharge) {
    const { results } = await env.DB.prepare(
      `SELECT id, client_name, amount_pence FROM payment_requests
        WHERE stripe_account_id = ? AND status IN ('scheduled','sent','processing')`,
    ).bind(accountId).all();
    await alertOps(env, {
      subject: 'Connected account can no longer take payments',
      lines: [
        `Account: ${accountId}`,
        `charges_enabled=${acct.charges_enabled}, platform_payments=${platformPayments}, card_payments=${cardPayments}`,
        `Outstanding requests now unpayable: ${results.length}`,
        ...results.slice(0, 20).map(r => `  ${r.id} — ${r.client_name} — ${money(r.amount_pence)}`),
        'Their pay links now render as unavailable rather than throwing a Stripe error at the client.',
      ],
    });
  }
  return { message: 'account synced', outcome: 'ignored' };
}

// The CHECK on team_members only permits these three values.
const normaliseCapability = v => (['active', 'pending', 'inactive'].includes(v) ? v : null);

/** The member clicked "Disconnect" in their own Stripe dashboard. */
async function handleDeauthorized(env, event) {
  const accountId = event.account;
  await env.DB.prepare(
    `UPDATE team_members
        SET stripe_charges_enabled = 0,
            stripe_platform_payments = 'inactive',
            stripe_account_state = 'deauthorized',
            deauthorized_at = datetime('now'),
            active = 0,
            session_epoch = session_epoch + 1,
            stripe_account_checked_at = datetime('now'),
            updated_at = datetime('now')
      WHERE stripe_account_id = ?`,
  ).bind(accountId).run();

  const { results } = await env.DB.prepare(
    `SELECT id, client_name, amount_pence, status FROM payment_requests
      WHERE stripe_account_id = ? AND status IN ('draft','scheduled','sent','processing')`,
  ).bind(accountId).all();

  await alertOps(env, {
    subject: 'Connected account disconnected the platform',
    lines: [
      `Account: ${accountId} — the member has been deactivated and their sessions revoked.`,
      `Requests left stranded: ${results.length}`,
      ...results.slice(0, 20).map(r => `  ${r.id} — ${r.status} — ${r.client_name} — ${money(r.amount_pence)}`),
      'Their pay links now render as unavailable. Cancel or re-issue them deliberately.',
    ],
  });
  return { message: 'deauthorized', outcome: 'ignored' };
}
