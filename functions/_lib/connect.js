// Settlement logic shared by every path that can learn a payment request was
// paid: the Connect webhook, the return-from-Stripe reconcile on the pay page,
// and the scheduler's reconciliation sweep.
//
// The rule this file exists to enforce: reaching status='paid' is what sends the
// receipt, NOT which code path got there. Anything else means the one scenario
// the reconcile exists for — the webhook never arriving — leaves a client
// charged with no receipt, forever, because nothing will ever re-drive it.
//
// Every statement here is copied from the "SHARED SQL HELPERS" section at the
// foot of migrations/0004_connect.sql, which is the authority for the schema and
// for the concurrency-critical guards.

import { safeEqual, expireCheckoutSession, createConnectRefund } from './stripe.js';
import { sendEmail } from './email.js';

const enc = new TextEncoder();

/* ------------------------------------------------------------ ids and time */

const toHex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

async function hmacHex(secret, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

/** uuid, matching every primary key in this schema. */
export const newId = () => crypto.randomUUID();
/** 128 bits with no dashes, for lock ids. */
export const randomId = () => crypto.randomUUID().replace(/-/g, '');

/**
 * 'YYYY-MM-DD HH:MM:SS' UTC — the ONLY timestamp format this schema accepts.
 * Never write an ISO-8601 value with 'T'/'Z' into send_at / expires_at: 'T'
 * (0x54) sorts above ' ' (0x20), so `send_at <= datetime('now')` would be false
 * forever and the row would sit unsent, silently. The LIKE CHECKs in
 * 0004_connect.sql turn that mistake into a write error; this is the value that
 * satisfies them.
 */
export const nowSql = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
export const sqlTime = ms => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

/* ------------------------------------------------------------------ tokens */

/**
 * The public /pay/<token> link: 32 hex chars (128 bits) of an HMAC over the
 * request id. Same construction as orderToken() in _lib/auth.js, with a
 * different domain prefix, so a pay token can never collide with — or be
 * replayed as — an order token. Deterministic, so it is re-derivable rather than
 * a value we could lose, and re-derivation is also how the handlers prove that a
 * stored public_token really belongs to the row it was found on.
 */
export async function payToken(requestId, secret) {
  if (!secret) throw new Error('ADMIN_SESSION_SECRET is not set');
  return (await hmacHex(secret, `payreq:${requestId}`)).slice(0, 32);
}

export async function verifyPayToken(requestId, token, secret) {
  if (!requestId || !token || !secret) return false;
  return safeEqual(token, await payToken(requestId, secret));
}

export const TOKEN_RE = /^[0-9a-f]{32}$/;

/**
 * The `payreq_nonce` echoed in Checkout Session metadata.
 *
 * Derived from the checkout lock id under the platform secret rather than being
 * a random value, for one reason: payment_request_sessions is keyed on Stripe's
 * own cs_ id, so a random nonce could only be stored AFTER the Stripe call —
 * which is precisely the window (Stripe created the session, our write was lost)
 * where the webhook's fallback has to work. checkout_lock_id IS written before
 * the call, so deriving from it means the nonce is always recomputable and still
 * unguessable: a connected account, which holds its own Stripe key and can put
 * our client_reference_id on a session of its own, cannot produce this value.
 */
export async function sessionNonce(requestId, lockId, secret) {
  if (!secret) throw new Error('ADMIN_SESSION_SECRET is not set');
  return (await hmacHex(secret, `payreq-nonce:${requestId}:${lockId}`)).slice(0, 32);
}

/* ------------------------------------------------------------------- email */

// Hard constraint enforced in code, not in a runbook: this is the Stripe account
// email of the first connected account, and nothing in this build may mail it.
// Belt and braces — 0004_connect.sql also seeds it into email_suppressions, so
// the guarantee survives a missed code path or a copy-pasted handler.
const NEVER_EMAIL = new Set(['hello@alehunters.co.uk']);

export async function mayEmail(env, address) {
  const a = String(address || '').trim().toLowerCase();
  if (!a || !a.includes('@')) return false;
  if (NEVER_EMAIL.has(a)) {
    console.warn('email suppressed (hard block)');
    return false;
  }
  try {
    const hit = await env.DB.prepare('SELECT 1 AS x FROM email_suppressions WHERE email = ?').bind(a).first();
    if (hit) {
      console.warn('email suppressed (suppression list)');
      return false;
    }
  } catch (err) {
    // A D1 blip must not silently unblock a suppressed address.
    console.error('suppression check failed — refusing to send', err);
    return false;
  }
  return true;
}

const STOUT = '#201611';
const CREAM = '#f7f1e5';
const AMBER = '#e0932f';
const PAPER = '#fffcf5';
const INK_SOFT = '#6b5c4f';

const esc = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const money = pence => `£${((pence || 0) / 100).toFixed(2)}`;

function payShell(inner) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:${CREAM};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CREAM};padding:24px 12px;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:${PAPER};border-radius:14px;overflow:hidden;font-family:'Segoe UI',Helvetica,Arial,sans-serif;color:${STOUT};">
      <tr><td style="background:${STOUT};padding:22px 28px;">
        <span style="color:${PAPER};font-size:19px;font-weight:700;">🍺 UK Brewery Tours</span>
      </td></tr>
      ${inner}
      <tr><td style="background:${CREAM};padding:20px 28px;font-size:12px;color:${INK_SOFT};line-height:1.6;">
        UK Brewery Tours · <a href="mailto:info@ukbrewerytours.com" style="color:${INK_SOFT};">info@ukbrewerytours.com</a>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

/** Receipt to the client. Shows the gross only — never the platform's cut. */
export function paymentReceiptHtml({ row }) {
  const line = (label, value) => `<tr>
      <td style="padding:7px 0;font-size:14px;color:${INK_SOFT};">${label}</td>
      <td style="padding:7px 0;font-size:14px;text-align:right;font-weight:600;">${value}</td>
    </tr>`;

  return payShell(`<tr><td style="padding:30px 28px;">
    <h1 style="margin:0 0 8px;font-size:22px;">Payment received</h1>
    <p style="margin:0 0 22px;font-size:15px;line-height:1.7;">
      Thanks ${esc(row.client_name)} — your payment to
      <strong>${esc(row.member_display_name || 'UK Brewery Tours')}</strong> has gone through.
    </p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e7ddcd;border-bottom:1px solid #e7ddcd;margin-bottom:20px;">
      ${line('Tour', esc(row.tour_name))}
      ${row.tour_date ? line('Date', esc(row.tour_date) + (row.tour_time ? ` at ${esc(row.tour_time)}` : '')) : ''}
      ${line('Amount paid', `<span style="font-size:17px;">${money(row.amount_paid_pence ?? row.amount_pence)}</span>`)}
      ${row.reference ? line('Reference', esc(row.reference)) : ''}
    </table>
    ${row.terms_snapshot ? `<div style="background:${CREAM};border-radius:10px;padding:16px 18px;font-size:13px;line-height:1.7;color:${INK_SOFT};">
      ${esc(row.terms_snapshot).replace(/\n/g, '<br>')}
    </div>` : ''}
    <p style="margin:24px 0 0;font-size:14px;line-height:1.7;">Cheers,<br>${esc(row.member_display_name || 'UK Brewery Tours')}</p>
  </td></tr>`);
}

/** Internal heads-up to the member who raised the request. */
export function memberPaidHtml({ row }) {
  const gross = row.amount_paid_pence ?? row.amount_pence;
  const fee = row.fee_collected_pence ?? row.fee_pence ?? 0;
  return payShell(`<tr><td style="padding:30px 28px;">
    <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:${INK_SOFT};">Payment received</div>
    <h1 style="margin:6px 0 4px;font-size:26px;">${money(gross)}</h1>
    <p style="margin:0 0 18px;font-size:14px;color:${INK_SOFT};">
      ${esc(row.client_name)} — ${esc(row.tour_name)}${row.tour_date ? ` on ${esc(row.tour_date)}` : ''}
    </p>
    <p style="margin:0;font-size:14px;line-height:1.8;">
      Platform fee: ${money(fee)}<br>
      Net to your Stripe account: ${money(gross - fee)}
      <span style="color:${INK_SOFT};">(less Stripe's own processing fee)</span>
    </p>
  </td></tr>`);
}

/**
 * Ops alert. Every money path that decides NOT to do the obvious thing calls
 * this: a silent console.error behind a webhook that returns 200 is invisible in
 * Stripe's dashboard AND invisible to us, which is how a systematic mismatch
 * quietly discards real payments for days.
 *
 * Never throws — an alert that fails must not roll back a settled payment.
 */
export async function alertOps(env, { subject, lines = [], requestId = null }) {
  const body = lines.filter(Boolean).map(l => `<div>${esc(l)}</div>`).join('');
  console.error('OPS ALERT', subject, JSON.stringify(lines));
  try {
    const to = env.NOTIFY_EMAIL || 'info@ukbrewerytours.com';
    if (!(await mayEmail(env, to))) return;
    await sendEmail(env, {
      to,
      subject: `[UBT payments] ${subject}`,
      html: payShell(`<tr><td style="padding:30px 28px;">
        <h1 style="margin:0 0 14px;font-size:20px;">${esc(subject)}</h1>
        <div style="font-size:14px;line-height:1.9;font-family:'Courier New',monospace;">${body}</div>
        ${requestId ? `<p style="margin:20px 0 0;font-size:12px;color:${INK_SOFT};">Request ${esc(requestId)}</p>` : ''}
      </td></tr>`),
    });
  } catch (err) {
    console.error('ops alert failed to send', subject, err);
  }
}

/* ------------------------------------------------------------------ events */

/**
 * Append-only audit line. Never fatal: losing the trail must not lose money.
 * `type` must be one of the values in the CHECK on payment_request_events —
 * an unknown value would throw, which is why this swallows.
 */
export async function recordEvent(env, {
  requestId, teamMemberId, type, detail = null, data = null,
  actor = 'system', ip = null, stripeEventId = null,
}) {
  try {
    let memberId = teamMemberId;
    if (!memberId) {
      const r = await env.DB.prepare('SELECT team_member_id FROM payment_requests WHERE id = ?')
        .bind(requestId).first();
      memberId = r?.team_member_id;
      if (!memberId) return;
    }
    await env.DB.prepare(
      `INSERT INTO payment_request_events
         (id, payment_request_id, team_member_id, type, detail, data, actor, ip, stripe_event_id)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).bind(
      newId(), requestId, memberId, type, detail,
      data ? JSON.stringify(data).slice(0, 4000) : null,
      actor, ip, stripeEventId,
    ).run();
  } catch (err) {
    console.error('event write failed', requestId, type, err);
  }
}

/**
 * Real money that resolves to no request. payment_request_events cannot hold it
 * (payment_request_id is NOT NULL with an FK), and Standard connected accounts
 * generate plenty of events from their own unrelated business — so this is both
 * the quarantine and the evidence an operator refunds from.
 */
export async function recordUnmatched(env, {
  eventId = null, account, sessionId = null, paymentIntent = null, chargeId = null,
  clientReferenceId = null, amountPence = null, currency = null, feePence = null, reason,
}) {
  try {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO unmatched_payments
         (id, stripe_account_id, stripe_event_id, stripe_session_id, stripe_payment_intent,
          stripe_charge_id, client_reference_id, amount_pence, currency,
          application_fee_pence, reason)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      newId(), account, eventId, sessionId, paymentIntent, chargeId,
      clientReferenceId, amountPence, currency, feePence, reason,
    ).run();
  } catch (err) {
    console.error('unmatched write failed', eventId, err);
  }
  await alertOps(env, {
    subject: `Unattributable payment on ${account}`,
    lines: [
      `Reason: ${reason}`,
      `Event: ${eventId || '—'}`,
      `Session: ${sessionId || '—'}`,
      `PaymentIntent: ${paymentIntent || '—'}`,
      `Amount: ${amountPence != null ? money(amountPence) : '—'} ${currency || ''}`,
      `Application fee: ${feePence != null ? money(feePence) : '—'}`,
      `Claimed request id: ${clientReferenceId || '—'}`,
      'ACTION: money may be sitting on the connected account with no local record. Refund or attribute by hand.',
    ],
  });
}

/* -------------------------------------------------------------- payability */

/**
 * May a NEW charge be created for this request, right now?
 *
 * Re-derived on every request from LIVE member state, never from the row
 * snapshot alone. The frozen stripe_account_id governs how an already-minted
 * session settles; it must never be what decides that a new charge may be made.
 * Otherwise deactivating a member closes /api/team/* while every pay link
 * already sitting in a client's inbox keeps charging money onto their account.
 *
 * charges_enabled alone is not enough either: a Standard account can have
 * charges_enabled = 1 while platform_payments goes inactive — ordinary charges
 * still work and only application_fee_amount is refused, so the client would hit
 * an error at the moment of payment with nobody alerted.
 *
 * Callers must SELECT the member columns aliased as member_active,
 * stripe_charges_enabled, stripe_account_state, stripe_platform_payments,
 * member_account_id.
 */
export function payabilityOf(row) {
  if (row.status === 'processing') return { ok: false, reason: 'processing' };
  if (row.status !== 'sent') return { ok: false, reason: 'closed' };
  if (row.expires_at && row.expires_at <= nowSql()) return { ok: false, reason: 'expired' };
  if (row.member_active !== 1) return { ok: false, reason: 'unavailable' };
  if (row.stripe_charges_enabled !== 1) return { ok: false, reason: 'unavailable' };
  if (row.stripe_account_state !== 'active') return { ok: false, reason: 'unavailable' };
  if (row.stripe_platform_payments && row.stripe_platform_payments !== 'active') {
    return { ok: false, reason: 'unavailable' };
  }
  if (!row.stripe_account_id || row.stripe_account_id !== row.member_account_id) {
    return { ok: false, reason: 'unavailable' };
  }
  // A row that reached 'sent' without frozen terms is a bug, not a charge.
  if (row.fee_pence == null || row.fee_bps == null || row.fee_frozen_at == null) {
    return { ok: false, reason: 'unavailable' };
  }
  return { ok: true };
}

/* -------------------------------------------------------------- validation */

/**
 * Does this paid session really match what we asked Stripe to charge?
 *
 * `expected` is the SESSION's own snapshot (payment_request_sessions) whenever
 * the session is one we recorded — a charge is proved against the figures its
 * own session was created with, not against the request's current values.
 *
 * The account check is an AUTHORISATION step, not a sanity check: Stripe
 * delivers events from every connected account to one endpoint, and a Standard
 * account holds its own API keys, so without it account B can settle account A's
 * request. The fee check is the other half: without it a member can settle their
 * own request with no application_fee_amount and keep 100%.
 */
export function sessionMismatch(expected, session, account, { paymentIntent = null } = {}) {
  if (!account || account !== expected.stripe_account_id) return 'account';
  if (String(session.currency || '').toLowerCase() !== String(expected.currency || '').toLowerCase()) return 'currency';
  if (session.amount_total !== expected.amount_pence) return 'amount';
  const expectedFee = expected.fee_pence || 0;
  const actualFee = paymentIntent?.application_fee_amount ?? 0;
  if (actualFee !== expectedFee) return 'fee';
  return null;
}

/* ------------------------------------------------------------- settle paid */

/**
 * The ONE place a request becomes paid. Called by the Connect webhook, by the
 * pay page's return-from-Stripe reconcile, and by the scheduler sweep.
 *
 * The guard is `status NOT IN ('paid','refunded')` — deliberately wide. A
 * Checkout Session lives up to 24h, so a request can be cancelled or expired
 * while the client is mid-3-D Secure. Narrowing this to ('sent','sending') means
 * a real charge on the member's account matches zero rows and is discarded in
 * silence. A payment that lands on a row that was NOT payable is still recorded,
 * and flagged (unexpected_payment, status_before_payment) so ops refunds it
 * deliberately rather than the database dropping it.
 *
 * `meta.changes === 0` is never treated as a benign no-op: it is either the same
 * payment arriving twice (proven by a matching PaymentIntent) or something we do
 * not understand, which alerts.
 */
export async function settlePaid(env, { row, session, paymentIntent = null, source = 'webhook' }) {
  const amountPaid = session?.amount_total ?? row.amount_pence;
  const pi = session?.payment_intent || paymentIntent?.id || null;
  const chargeId = paymentIntent?.latest_charge || null;
  const feeCollected = paymentIntent?.application_fee_amount ?? null;
  const feeId = paymentIntent?.application_fee || null;

  const res = await env.DB.prepare(
    `UPDATE payment_requests
        SET status = 'paid',
            paid_at = COALESCE(paid_at, datetime('now')),
            status_before_payment = COALESCE(status_before_payment, status),
            unexpected_payment = CASE WHEN status IN ('sent', 'processing') THEN 0 ELSE 1 END,
            stripe_payment_intent = COALESCE(stripe_payment_intent, ?1),
            stripe_charge_id = COALESCE(stripe_charge_id, ?2),
            amount_paid_pence = COALESCE(amount_paid_pence, ?3),
            fee_collected_pence = COALESCE(fee_collected_pence, ?4),
            stripe_application_fee_id = COALESCE(stripe_application_fee_id, ?5),
            checkout_lock_id = NULL,
            updated_at = datetime('now')
      WHERE id = ?6 AND status NOT IN ('paid', 'refunded')`,
  ).bind(pi, chargeId, amountPaid, feeCollected, feeId, row.id).run();

  const transitioned = res.meta.changes === 1;

  if (session?.id) {
    await env.DB.prepare(
      `UPDATE payment_request_sessions
          SET status = 'complete', completed_at = datetime('now'),
              stripe_payment_intent = COALESCE(stripe_payment_intent, ?1)
        WHERE id = ?2 AND status <> 'complete'`,
    ).bind(pi, session.id).run();
  }

  if (!transitioned) {
    // NOT a no-op. Work out which of the two it is, and alert on the second.
    const fresh = await env.DB.prepare(
      'SELECT status, stripe_payment_intent, amount_paid_pence, refunded_pence FROM payment_requests WHERE id = ?',
    ).bind(row.id).first();

    const samePayment = fresh
      && (fresh.status === 'paid' || fresh.status === 'refunded')
      && (!pi || !fresh.stripe_payment_intent || fresh.stripe_payment_intent === pi);

    if (!samePayment) {
      await alertOps(env, {
        subject: 'Paid event did not settle — row was not in a settleable state',
        requestId: row.id,
        lines: [
          `Source: ${source}`,
          `Local status: ${fresh?.status || 'ROW MISSING'}`,
          `Local PaymentIntent: ${fresh?.stripe_payment_intent || '—'}`,
          `Incoming PaymentIntent: ${pi || '—'}`,
          `Incoming amount: ${money(amountPaid)}`,
          `Already refunded: ${money(fresh?.refunded_pence || 0)}`,
          'ACTION: a SECOND real charge may exist on the connected account. Check Stripe before assuming a duplicate.',
        ],
      });
      await recordEvent(env, {
        requestId: row.id, teamMemberId: row.team_member_id, type: 'alert', actor: 'stripe',
        detail: 'paid event could not be applied', data: { source, incoming_pi: pi, local_status: fresh?.status },
      });
    }
  } else {
    await recordEvent(env, {
      requestId: row.id, teamMemberId: row.team_member_id, type: 'paid', actor: 'stripe',
      detail: `Paid ${money(amountPaid)} via ${source}`,
      data: { session_id: session?.id || null, payment_intent: pi, fee_collected_pence: feeCollected },
    });
  }

  // Re-read once: the emails must describe what is actually stored, and another
  // path may have written the charge ids between our UPDATE and now.
  const current = await env.DB.prepare('SELECT * FROM payment_requests WHERE id = ?').bind(row.id).first();
  if (!current || (current.status !== 'paid' && current.status !== 'refunded')) {
    return { transitioned, emailFailed: false, unexpected: false };
  }

  if (transitioned && current.unexpected_payment === 1) {
    await recordEvent(env, {
      requestId: row.id, teamMemberId: current.team_member_id, type: 'late_payment', actor: 'stripe',
      detail: `Paid while status was '${current.status_before_payment}'`,
    });
    await alertOps(env, {
      subject: 'Payment arrived on a request that was no longer live',
      requestId: row.id,
      lines: [
        `Status before payment: ${current.status_before_payment}`,
        `Amount: ${money(current.amount_paid_pence ?? current.amount_pence)}`,
        `Client: ${current.client_name}`,
        `Connected account: ${current.stripe_account_id}`,
        'The money IS recorded. Decide whether to honour the booking or refund it — the admin refund reverses our fee too.',
      ],
    });
  }

  const emailFailed = await sendPaidEmails(env, current, source);
  return { transitioned, emailFailed, unexpected: current.unexpected_payment === 1 };
}

/**
 * Compare-and-swap on paid_email_sent, so exactly one caller sends — and if
 * Resend is down the flag goes back to 0, because a receipt that is marked sent
 * but was never sent can never be re-driven.
 */
async function sendPaidEmails(env, row, source) {
  const claim = await env.DB.prepare(
    'UPDATE payment_requests SET paid_email_sent = 1 WHERE id = ? AND paid_email_sent = 0',
  ).bind(row.id).run();
  if (claim.meta.changes !== 1) return false;   // someone else has it, or it is done

  try {
    if (await mayEmail(env, row.client_email)) {
      await sendEmail(env, {
        to: row.client_email,
        subject: `Payment received — ${row.tour_name}`,
        html: paymentReceiptHtml({ row }),
      });
    }
  } catch (err) {
    // Release the claim so the webhook retry (or the sweep) re-attempts JUST the
    // email. The money is already recorded either way.
    console.error('client receipt failed', row.id, err);
    await env.DB.prepare('UPDATE payment_requests SET paid_email_sent = 0 WHERE id = ?').bind(row.id).run();
    return true;
  }

  await recordEvent(env, {
    requestId: row.id, teamMemberId: row.team_member_id, type: 'sent', actor: 'system',
    detail: `Receipt emailed (${source})`,
  });

  // Member notification is best-effort and deliberately AFTER the flag is
  // committed: a missed internal heads-up must never re-trigger the client's
  // receipt. mayEmail() is what keeps hello@alehunters.co.uk untouched.
  try {
    const member = await env.DB.prepare(
      'SELECT email, reply_to_email FROM team_members WHERE id = ?',
    ).bind(row.team_member_id).first();
    const to = member?.reply_to_email || member?.email;
    if (to && await mayEmail(env, to)) {
      await sendEmail(env, {
        to,
        subject: `Paid — ${row.client_name}, ${row.tour_name}`,
        html: memberPaidHtml({ row }),
      });
      await env.DB.prepare("UPDATE payment_requests SET member_notified_at = datetime('now') WHERE id = ?")
        .bind(row.id).run();
    }
  } catch (err) {
    console.error('member notification failed (client receipt was sent)', row.id, err);
  }
  return false;
}

/**
 * Write the charge / fee ids whether or not this caller won the transition.
 * Gating them on the winner is how rows end up permanently without a
 * stripe_charge_id — and then no refund or dispute can ever be matched to them.
 */
export async function settleCharge(env, { row, paymentIntent }) {
  if (!paymentIntent) return;
  await env.DB.prepare(
    `UPDATE payment_requests
        SET stripe_payment_intent = COALESCE(stripe_payment_intent, ?1),
            stripe_charge_id      = COALESCE(stripe_charge_id, ?2),
            fee_collected_pence   = COALESCE(fee_collected_pence, ?3),
            stripe_application_fee_id = COALESCE(stripe_application_fee_id, ?4)
      WHERE id = ?5 AND stripe_charge_id IS NULL`,
  ).bind(
    paymentIntent.id || null,
    paymentIntent.latest_charge || null,
    paymentIntent.application_fee_amount ?? null,
    paymentIntent.application_fee || null,
    row.id,
  ).run();
}

/* ------------------------------------------------------------ cancel/expire */

/**
 * Cancel or expire a request SAFELY. Two phase, per helper G in the migration.
 *
 * Order matters and is not negotiable: move to 'cancelling', expire every open
 * session at Stripe, THEN flip to the terminal status. The other way round
 * leaves a payable URL in the client's inbox pointing at a row we have already
 * written off, and the resulting charge lands with nothing to attribute it to.
 *
 * If Stripe says the session is already complete, the client has paid — abort
 * the cancel, restore the previous status, and let settlement handle it.
 *
 * @returns {{ok:true} | {ok:false, reason:'paid'|'stripe_unavailable'|'not_cancellable'}}
 */
export async function closePaymentRequest(env, {
  row, to = 'cancelled', reason = null, actor = 'system', teamMemberId = null,
}) {
  if (!['cancelled', 'expired'].includes(to)) throw new Error('closePaymentRequest: bad target status');

  // Ownership is part of the guard, not a separate check: a team cancel passes
  // teamMemberId and the statement simply matches nothing for another member's
  // row — the same 404 as a row that does not exist, so ids cannot be probed.
  const enter = teamMemberId
    ? await env.DB.prepare(
      `UPDATE payment_requests SET status = 'cancelling', updated_at = datetime('now')
        WHERE id = ?1 AND team_member_id = ?2 AND status IN ('draft','scheduled','sent','failed')`,
    ).bind(row.id, teamMemberId).run()
    : await env.DB.prepare(
      `UPDATE payment_requests SET status = 'cancelling', updated_at = datetime('now')
        WHERE id = ?1 AND status IN ('draft','scheduled','sent','failed')`,
    ).bind(row.id).run();
  if (enter.meta.changes !== 1) return { ok: false, reason: 'not_cancellable' };

  const previous = row.status;

  const { results: sessions } = await env.DB.prepare(
    "SELECT id, stripe_account_id FROM payment_request_sessions WHERE payment_request_id = ? AND status IN ('open','processing')",
  ).bind(row.id).all();

  for (const s of sessions) {
    let res;
    try {
      res = await expireCheckoutSession(env, { sessionId: s.id, account: s.stripe_account_id });
    } catch (err) {
      // Fail CLOSED: put the row back. Flipping the status while a session may
      // still be open is exactly the race that loses a payment.
      console.error('expire session failed — aborting close', row.id, err);
      await restore(env, row.id, previous);
      await alertOps(env, {
        subject: 'Could not expire Stripe session — request left open',
        requestId: row.id,
        lines: [`Session: ${s.id}`, `Account: ${s.stripe_account_id}`, String(err.message || err)],
      });
      return { ok: false, reason: 'stripe_unavailable' };
    }
    if (!res.expired) {
      // Already completed: the client paid. Abort and let settlement win.
      await restore(env, row.id, previous);
      await recordEvent(env, {
        requestId: row.id, teamMemberId: teamMemberId || row.team_member_id, type: 'note', actor,
        detail: 'close aborted — the Stripe session was already completed',
      });
      return { ok: false, reason: 'paid' };
    }
    await env.DB.prepare("UPDATE payment_request_sessions SET status='expired' WHERE id = ? AND status <> 'complete'")
      .bind(s.id).run();
  }

  const done = await env.DB.prepare(
    `UPDATE payment_requests
        SET status = ?1,
            cancelled_at = CASE WHEN ?1 = 'cancelled' THEN datetime('now') ELSE cancelled_at END,
            cancel_reason = COALESCE(?2, cancel_reason),
            stripe_checkout_session_id = NULL,
            stripe_checkout_url = NULL,
            stripe_checkout_expires_at = NULL,
            checkout_lock_id = NULL,
            updated_at = datetime('now')
      WHERE id = ?3 AND status = 'cancelling'`,
  ).bind(to, reason, row.id).run();

  if (done.meta.changes !== 1) return { ok: false, reason: 'not_cancellable' };

  await recordEvent(env, {
    requestId: row.id, teamMemberId: teamMemberId || row.team_member_id,
    type: to === 'cancelled' ? 'cancelled' : 'expired', actor, detail: reason,
  });
  return { ok: true };
}

function restore(env, id, previous) {
  const safe = ['draft', 'scheduled', 'sent', 'failed'].includes(previous) ? previous : 'sent';
  return env.DB.prepare(
    "UPDATE payment_requests SET status = ?1, updated_at = datetime('now') WHERE id = ?2 AND status = 'cancelling'",
  ).bind(safe, id).run();
}

/* ---------------------------------------------------------------- refunds */

/**
 * Refund a paid request ON THE CONNECTED ACCOUNT, reversing our application fee,
 * and record it.
 *
 * Two things that are easy to get wrong and expensive to get wrong:
 *   * the refund must carry the Stripe-Account header — a platform-scoped refund
 *     of a direct charge simply is not found;
 *   * refund_application_fee=true, or Stripe debits the connected account the
 *     full amount while the platform keeps its 20%: the member funds our fee on
 *     a booking that generated no revenue.
 *
 * Concurrency is the codebase's conditional-UPDATE idiom: the running total is
 * claimed BEFORE the Stripe call, so a double-click cannot over-refund, and the
 * claim is released if Stripe refuses.
 */
export async function refundPaymentRequest(env, { row, amountPence, reason = null, note = null, actor = 'admin' }) {
  if (row.status !== 'paid' && row.status !== 'refunded') {
    return { ok: false, error: 'This request has not been paid.' };
  }
  if (!row.stripe_payment_intent) return { ok: false, error: 'No Stripe payment is linked to this request.' };
  if (!row.stripe_account_id) return { ok: false, error: 'No connected account is recorded for this request.' };

  const paid = row.amount_paid_pence ?? row.amount_pence;
  const already = row.refunded_pence || 0;
  const max = paid - already;
  if (!Number.isInteger(amountPence) || amountPence <= 0) return { ok: false, error: 'Enter an amount to refund.' };
  if (amountPence > max) return { ok: false, error: `Amount exceeds the refundable ${money(max)}.` };

  // Claim the slice first: refunded_pence = ?already is the compare-and-swap.
  const claim = await env.DB.prepare(
    `UPDATE payment_requests
        SET refunded_pence = refunded_pence + ?1, updated_at = datetime('now')
      WHERE id = ?2 AND refunded_pence = ?3
        AND refunded_pence + ?1 <= COALESCE(amount_paid_pence, amount_pence)`,
  ).bind(amountPence, row.id, already).run();
  if (claim.meta.changes !== 1) return { ok: false, error: 'Refund state changed — reload and try again.' };

  let refund;
  try {
    refund = await createConnectRefund(env, {
      paymentIntent: row.stripe_payment_intent,
      account: row.stripe_account_id,
      amountPence,
      reason,
      refundApplicationFee: true,
      // Same request + same running total + same amount = same key.
      idempotencyKey: `pr-refund-${row.id}-${already}-${amountPence}`,
    });
  } catch (err) {
    // Release the claim; nothing moved at Stripe.
    await env.DB.prepare(
      'UPDATE payment_requests SET refunded_pence = refunded_pence - ?1 WHERE id = ?2 AND refunded_pence >= ?1',
    ).bind(amountPence, row.id).run();
    return { ok: false, error: `Stripe refused the refund: ${err.message}` };
  }

  const total = already + amountPence;
  // Stripe does not return the reversed fee on the refund object, so it is
  // derived pro rata from the frozen split — the same arithmetic Stripe applies.
  const feeBase = row.fee_collected_pence ?? row.fee_pence ?? 0;
  const feeReversed = feeBase > 0 ? Math.round((feeBase * amountPence) / paid) : 0;

  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO payment_request_refunds
         (id, payment_request_id, stripe_refund_id, stripe_account_id, amount_pence,
          fee_reversed_pence, reason, note, refunded_by, status)
       VALUES (?,?,?,?,?,?,?,?,?, 'succeeded')`,
    ).bind(
      newId(), row.id, refund?.id || null, row.stripe_account_id, amountPence,
      Math.min(feeReversed, amountPence), reason, note, actor,
    ),
    env.DB.prepare(
      `UPDATE payment_requests
          SET fee_refunded_pence = MIN(COALESCE(fee_collected_pence, fee_pence, 0),
                                       fee_refunded_pence + ?1),
              refunded_at = datetime('now'),
              status = CASE WHEN ?2 >= COALESCE(amount_paid_pence, amount_pence)
                            THEN 'refunded' ELSE status END,
              updated_at = datetime('now')
        WHERE id = ?3`,
    ).bind(feeReversed, total, row.id),
  ]);

  await recordEvent(env, {
    requestId: row.id, teamMemberId: row.team_member_id, type: 'refunded', actor,
    detail: `Refunded ${money(amountPence)} (platform fee reversed ${money(feeReversed)})`,
    data: { stripe_refund_id: refund?.id || null },
  });

  return { ok: true, refundedTotal: total, feeReversedPence: feeReversed, stripeRefundId: refund?.id || null };
}
