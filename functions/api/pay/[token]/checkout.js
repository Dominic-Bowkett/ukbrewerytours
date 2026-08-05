// POST /api/pay/:token/checkout
// Returns the Stripe Checkout URL for one payment request.
//
// The request body is never read. Amount, currency, platform fee, connected
// account and even the return URLs come from the row the token resolves to, so
// there is no input for the client to bend. The only thing they supply is
// possession of the link.
//
// THE DOUBLE-CHARGE DEFENCE, in the order it fires:
//
//   1. READ BACK FIRST. If the row already names a session, we ask Stripe what
//      happened to it rather than trusting our own status column. This is the
//      fix for the worst failure in the feature: when the webhook never lands
//      (endpoint unregistered, wrong whsec_, retries exhausted after three days,
//      a run of 500s) the row stays 'sent', and the naive design would happily
//      mint a SECOND session and take a SECOND real payment once the cached URL
//      aged out. Now the client is told it is already paid, and the payment is
//      settled here through the same settlePaid() the webhook uses.
//
//   2. FAIL CLOSED. If that read-back errors we return 503 and mint nothing.
//      Never create a new payable URL while the fate of the previous one is
//      unknown.
//
//   3. SINGLE-FLIGHT LOCK. A conditional UPDATE claims checkout_lock_id BEFORE
//      the Stripe call (helper D in migrations/0004_connect.sql). Two tabs, or a
//      double-tap on mobile, produce exactly one winner; the loser re-reads and
//      follows. UNIQUE on stripe_checkout_session_id cannot do this job — it
//      stops the same id being stored twice, not two DIFFERENT sessions being
//      created, and the loser's session stays live and payable.
//
//   4. IDEMPOTENCY-KEY = pr-cs-<request id>-<lock id>, with every Stripe
//      parameter derived from the row and the lock (hence no expires_at, see
//      createDirectCheckoutSession). A lock that holds no session is RE-USED
//      rather than replaced, so if the Stripe POST times out after Stripe created
//      the session, the retry replays THAT session instead of orphaning a live,
//      payable URL nothing points at.
//
//   5. EVERY session is recorded in payment_request_sessions before its URL is
//      handed out, so any webhook — including one for a session the row no
//      longer names — resolves to a request instead of becoming unattributable
//      money. idx_prs_one_open backs the lock up with a UNIQUE partial index:
//      a second payable session becomes a constraint error, not a race.

import {
  verifyPayToken, TOKEN_RE, randomId, sessionNonce, sqlTime, payabilityOf,
  settlePaid, recordEvent, alertOps,
} from '../../../_lib/connect.js';
import {
  createDirectCheckoutSession, retrieveSession, retrievePaymentIntent,
  expireCheckoutSession, StripeError,
} from '../../../_lib/stripe.js';

const NO_STORE = {
  'Cache-Control': 'no-store, private',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

const json = (body, status = 200) => Response.json(body, { status, headers: NO_STORE });

const notFound = () => json({ error: 'This payment link is not valid or has been withdrawn.' }, 404);
const alreadyPaid = () => json({ error: 'This payment has already been made.', paid: true }, 409);
const processing = () => json(
  { error: 'Your payment is still being processed. We will email you as soon as it clears.', processing: true }, 409,
);
// Deliberately distinct from a transient failure: the client is told to contact
// the organiser rather than to keep retrying something that will never work.
const unavailable = () => json(
  { error: 'This payment link is temporarily unavailable. Please contact the organiser.', unavailable: true }, 503,
);
const tryAgain = () => json({ error: 'Could not start the payment just now. Please try again in a moment.' }, 503);

export async function onRequestPost(ctx) {
  const { params, request, env } = ctx;
  if (!env.STRIPE_SECRET_KEY || !env.ADMIN_SESSION_SECRET) {
    return json({ error: 'Payments are not configured yet.' }, 503);
  }

  const token = String(params.token || '').toLowerCase();
  if (!TOKEN_RE.test(token)) return notFound();

  const row = await loadRow(env, token);
  if (!row) return notFound();
  if (!(await verifyPayToken(row.id, token, env.ADMIN_SESSION_SECRET))) return notFound();

  // Already settled. Told plainly: the token holder is entitled to know.
  if (row.status === 'paid' || row.status === 'refunded') return alreadyPaid();
  if (row.status === 'processing') return processing();
  // Not live yet, or withdrawn — indistinguishable from a bad token.
  if (['draft', 'scheduled', 'sending', 'cancelling', 'cancelled'].includes(row.status)) return notFound();

  const payable = payabilityOf(row);
  if (!payable.ok) return payable.reason === 'expired' ? notFound() : unavailable();

  const nowSecs = Math.floor(Date.now() / 1000);

  /* --------------------------------------------------------- 1 + 2: read back */
  if (row.stripe_checkout_session_id) {
    let session;
    try {
      session = await retrieveSession(env, row.stripe_checkout_session_id, row.stripe_account_id);
    } catch (err) {
      console.error('session read-back failed', row.id, err);
      if (err instanceof StripeError && err.isAccountProblem) {
        await flagAccountProblem(env, row, err);
        return unavailable();
      }
      // Unknown prior state => mint nothing. A second live session is far worse
      // than a client seeing "try again".
      return tryAgain();
    }

    if (session.payment_status === 'paid') {
      ctx.waitUntil(settleFromSession(env, row, session));
      return alreadyPaid();
    }

    if (session.status === 'complete') {
      // Complete but unpaid: a delayed payment method is in flight. Stripe never
      // expires a completed session, so nothing may mint over it — the row goes
      // to 'processing' and stays out of the payable set until it resolves.
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE payment_requests SET status='processing', updated_at=datetime('now')
            WHERE id=? AND status='sent'`,
        ).bind(row.id),
        env.DB.prepare(
          "UPDATE payment_request_sessions SET status='processing' WHERE id=? AND status='open'",
        ).bind(session.id),
      ]);
      return processing();
    }

    if (session.status === 'open') {
      // THE re-use path, and the reason two tabs cannot double-pay: both are
      // driven onto the SAME session, which Stripe can only complete once.
      if (session.url && session.expires_at > nowSecs + 60) return json({ url: session.url });

      // About to expire: close it explicitly before minting a replacement, so
      // there is never a moment with two payable URLs for one request.
      try {
        const res = await expireCheckoutSession(env, { sessionId: session.id, account: row.stripe_account_id });
        if (!res.expired) {
          // Stripe refused because the session is already COMPLETE: the client
          // paid in the seconds we were deciding to replace it.
          ctx.waitUntil(settleFromSessionId(env, row, session.id));
          return alreadyPaid();
        }
      } catch (err) {
        console.error('expire before re-mint failed', row.id, err);
        return tryAgain();
      }
    }

    // Expired (by Stripe's 24h ceiling, or by us just now). Free the slot so
    // idx_prs_one_open admits the replacement, and clear the stale cache.
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE payment_request_sessions SET status='expired' WHERE id=? AND status='open'",
      ).bind(session.id),
      env.DB.prepare(
        `UPDATE payment_requests
            SET stripe_checkout_session_id=NULL, stripe_checkout_url=NULL,
                stripe_checkout_expires_at=NULL, updated_at=datetime('now')
          WHERE id=? AND stripe_checkout_session_id=? AND status='sent'`,
      ).bind(row.id, session.id),
    ]);
    row.stripe_checkout_session_id = null;
  }

  /* ---------------------------------------------------------- 3 + 4: the lock */
  // Re-use the existing lock when it holds no session: that is exactly the
  // "the Stripe POST may have succeeded" case, and re-using it keeps the
  // Idempotency-Key (and the derived nonce) stable, so Stripe replays the
  // original session rather than creating a second payable one.
  const reuseLock = Boolean(row.checkout_lock_id) && !row.stripe_checkout_session_id;
  const lockId = reuseLock ? row.checkout_lock_id : randomId();

  const lock = await env.DB.prepare(
    `UPDATE payment_requests
        SET checkout_lock_id = ?1, checkout_lock_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?2
        AND status = 'sent'
        AND stripe_checkout_session_id IS NULL
        AND (checkout_lock_id IS NULL
             OR checkout_lock_id = ?1
             OR checkout_lock_at <= datetime('now','-2 minutes'))`,
  ).bind(lockId, row.id).run();

  if (lock.meta.changes !== 1) return followTheWinner(env, row.id);

  /* ------------------------------------------------------------------ 5: mint */
  const nonce = await sessionNonce(row.id, lockId, env.ADMIN_SESSION_SECRET);
  const origin = env.BASE_URL || new URL(request.url).origin;

  let session;
  try {
    session = await createDirectCheckoutSession(env, {
      req: row,
      nonce,
      // Server-derived. Never taken from the body, a query parameter or Referer —
      // an open redirect out of a payment flow is a phishing gift.
      successUrl: `${origin}/pay/${token}?paid=1`,
      cancelUrl: `${origin}/pay/${token}?cancelled=1`,
      idempotencyKey: `pr-cs-${row.id}-${lockId}`,
    });
  } catch (err) {
    console.error('connect checkout failed', row.id, err);
    // The lock is deliberately left in place: it ages out in two minutes, and
    // while it stands a retry re-uses the same Idempotency-Key.
    if (err instanceof StripeError && err.isAccountProblem) {
      await flagAccountProblem(env, row, err);
      return unavailable();
    }
    return tryAgain();
  }

  const expiresAtSql = session.expires_at ? sqlTime(session.expires_at * 1000) : null;

  // Record the session BEFORE handing out the URL, in one D1 batch — the only
  // transaction primitive available here. If the UPDATE matches nothing (another
  // writer moved the row) the session row still lands, so the webhook can always
  // attribute the charge.
  let results;
  try {
    results = await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO payment_request_sessions
           (id, payment_request_id, stripe_account_id, nonce, amount_pence, currency,
            fee_pence, status, checkout_url, expires_at, created_by_lock)
         VALUES (?,?,?,?,?,?,?, 'open', ?,?,?)`,
      ).bind(
        session.id, row.id, row.stripe_account_id, nonce, row.amount_pence, row.currency,
        row.fee_pence || 0, session.url, expiresAtSql, lockId,
      ),
      env.DB.prepare(
        `UPDATE payment_requests
            SET stripe_checkout_session_id = ?1,
                stripe_checkout_url = ?2,
                stripe_checkout_expires_at = ?3,
                checkout_lock_id = NULL,
                updated_at = datetime('now')
          WHERE id = ?4 AND status = 'sent'
            AND checkout_lock_id = ?5
            AND stripe_checkout_session_id IS NULL`,
      ).bind(session.id, session.url, expiresAtSql, row.id, lockId),
    ]);
  } catch (err) {
    // idx_prs_one_open fired: another payable session already exists for this
    // request. Close the one we just made rather than leaving two live.
    console.error('session persist failed', row.id, err);
    await killOrphan(env, row, session);
    return followTheWinner(env, row.id);
  }

  if (results[1].meta.changes !== 1) {
    await killOrphan(env, row, session);
    return followTheWinner(env, row.id);
  }

  ctx.waitUntil(recordEvent(env, {
    requestId: row.id, teamMemberId: row.team_member_id, type: 'checkout_created', actor: 'client',
    ip: request.headers.get('CF-Connecting-IP'),
    data: { session_id: session.id, amount_pence: row.amount_pence, fee_pence: row.fee_pence },
  }));

  return json({ url: session.url });
}

/* --------------------------------------------------------------- helpers */

function loadRow(env, token) {
  // The member is JOINed on purpose: the frozen stripe_account_id decides how an
  // already-minted session SETTLES, never whether a new charge may be made.
  return env.DB.prepare(`
    SELECT r.*,
           m.active                   AS member_active,
           m.stripe_charges_enabled,
           m.stripe_account_state,
           m.stripe_platform_payments,
           m.stripe_account_id        AS member_account_id
      FROM payment_requests r
      JOIN team_members m ON m.id = r.team_member_id
     WHERE r.public_token = ?`).bind(token).first();
}

async function settleFromSession(env, row, session) {
  try {
    const pi = session.payment_intent
      ? await retrievePaymentIntent(env, session.payment_intent, row.stripe_account_id)
      : null;
    await settlePaid(env, { row, session, paymentIntent: pi, source: 'checkout-readback' });
  } catch (err) {
    // The webhook and the reconciliation sweep are the backstops.
    console.error('read-back settle failed', row.id, err);
  }
}

async function settleFromSessionId(env, row, sessionId) {
  try {
    const session = await retrieveSession(env, sessionId, row.stripe_account_id);
    if (session.payment_status === 'paid') await settleFromSession(env, row, session);
  } catch (err) {
    console.error('read-back settle failed', row.id, err);
  }
}

/** We minted a session we could not record. Close it so it can never be paid. */
async function killOrphan(env, row, session) {
  try {
    await expireCheckoutSession(env, { sessionId: session.id, account: row.stripe_account_id });
    await env.DB.prepare("UPDATE payment_request_sessions SET status='expired' WHERE id=? AND status='open'")
      .bind(session.id).run();
  } catch (err) {
    // A live payable session nobody points at is real money at risk, so this
    // one alerts rather than logging.
    await alertOps(env, {
      subject: 'Orphaned Checkout Session could not be expired',
      requestId: row.id,
      lines: [
        `Session: ${session.id}`, `Account: ${row.stripe_account_id}`,
        String(err.message || err),
        'ACTION: expire it in the Stripe dashboard before the client pays it.',
      ],
    });
  }
}

/** Someone else moved the row underneath us: re-read and do what they did. */
async function followTheWinner(env, id) {
  const fresh = await env.DB.prepare(
    'SELECT status, stripe_checkout_url FROM payment_requests WHERE id = ?',
  ).bind(id).first();

  if (!fresh) return notFound();
  if (fresh.status === 'paid' || fresh.status === 'refunded') return alreadyPaid();
  if (fresh.status === 'processing') return processing();
  if (fresh.status === 'sent' && fresh.stripe_checkout_url) return json({ url: fresh.stripe_checkout_url });
  return tryAgain();
}

/**
 * The connected account cannot take this charge — lost capability, restricted,
 * or the platform was disconnected. Stop pretending it is transient: mark the
 * member so every pay link for that account renders "unavailable" instead of
 * throwing a Stripe error at the moment of payment, and alert.
 */
async function flagAccountProblem(env, row, err) {
  try {
    await env.DB.prepare(
      `UPDATE team_members
          SET stripe_charges_enabled = 0,
              stripe_account_state = 'restricted',
              stripe_account_checked_at = datetime('now'),
              updated_at = datetime('now')
        WHERE id = ? AND stripe_account_id = ?`,
    ).bind(row.team_member_id, row.stripe_account_id).run();
  } catch (dbErr) {
    console.error('could not flag account problem', row.id, dbErr);
  }
  await recordEvent(env, {
    requestId: row.id, teamMemberId: row.team_member_id, type: 'payment_failed', actor: 'stripe',
    detail: 'the connected account refused the charge',
    data: { code: err.code, status: err.status, message: err.message },
  });
  await alertOps(env, {
    subject: 'Connected account cannot take payments',
    requestId: row.id,
    lines: [
      `Account: ${row.stripe_account_id}`,
      `Stripe: ${err.code || err.type || err.status} — ${err.message}`,
      'Every outstanding pay link for this member now renders as unavailable.',
      'ACTION: check capabilities (card_payments, platform_payments) in the Stripe dashboard.',
    ],
  });
}
