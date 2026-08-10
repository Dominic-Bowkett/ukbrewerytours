// The sweep behind scheduled sends.
//
// Pages Functions cannot receive a cron trigger, so this module is called by a
// separate Worker (workers/scheduler/) bound to the same D1, and by an
// admin-only endpoint for a manual kick. It lives here rather than in the
// worker so the SQL sits alongside the schema it targets and is covered by the
// same column-contract tests as the rest of functions/.
//
// Every statement below is copied from the SHARED SQL HELPERS block at the foot
// of migrations/0004_connect.sql, which is the authoritative version.
//
// A tick does four things, in this order and for this reason:
//
//   1. REAP first. A row stuck in 'sending' from a worker that died mid-flight
//      is invisible everywhere — no dashboard, no failure report — until
//      someone asks why a client never paid. Reaping before claiming means a
//      row released this tick is eligible again this tick.
//   2. CLAIM the due rows, one atomic UPDATE, so two overlapping runs cannot
//      both own the same request.
//   3. SEND, one row at a time, re-checking the member against Stripe. Terms
//      were frozen when the request was created, possibly weeks ago; whether
//      the account can still take a direct charge is a question that has to be
//      asked now.
//   4. EXPIRE stale links, then report anything that looks stuck.
//
// Nothing here throws to the caller. A cron tick that raises is a tick that
// silently does not happen again until someone reads the logs.

import { isChargeReady } from './team-auth.js';
import { retrieveAccount } from './stripe.js';
import { sendEmail } from './email.js';
import {
  mayEmail, recordEvent, alertOps, paymentRequestHtml, randomId,
} from './connect.js';

/** How many due rows one tick will take on. Matches the LIMIT in the schema. */
const CLAIM_LIMIT = 25;

/** A claim older than this is assumed dead and is released. */
const STALL_MINUTES = 15;

/**
 * Refresh a member's cached Stripe capability state.
 *
 * Called when the cache is older than platform_settings.account_staleness_hours.
 * A scheduled send is the one path where the cache is guaranteed to be stale:
 * the request may have been created a month before its send date, and in that
 * time the account can have been restricted, lost platform_payments, or
 * deauthorized us. Sending blind would mint a pay link that takes the client to
 * a checkout Stripe refuses.
 *
 * On a Stripe error the row is left alone and `null` is returned — the caller
 * treats that as "cannot confirm", which defers the send rather than sending
 * or failing it. A Stripe outage must not burn send_attempts.
 */
async function refreshAccount(env, member) {
  let account;
  try {
    account = await retrieveAccount(env, member.stripe_account_id);
  } catch (err) {
    console.error('scheduler: account refresh failed', member.id, err.message);
    return null;
  }

  const caps = account.capabilities || {};
  const charges = account.charges_enabled ? 1 : 0;
  const card = caps.card_payments || null;
  // transfers is the modern name for what older accounts call platform_payments;
  // isChargeReady only understands 'active', so normalise here rather than
  // teaching the gate about both.
  const platform = caps.platform_payments || caps.transfers || null;

  await env.DB.prepare(
    `UPDATE team_members
        SET stripe_charges_enabled = ?2, stripe_payouts_enabled = ?3,
            stripe_card_payments = ?4, stripe_platform_payments = ?5,
            stripe_account_checked_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?1`,
  ).bind(member.id, charges, account.payouts_enabled ? 1 : 0, card, platform).run();

  return {
    ...member,
    stripe_charges_enabled: charges,
    stripe_payouts_enabled: account.payouts_enabled ? 1 : 0,
    stripe_card_payments: card,
    stripe_platform_payments: platform,
  };
}

/**
 * Release rows abandoned mid-send.
 *
 * NOTE the predicate carries no send_attempts filter. The claim has already
 * incremented the counter, so a row whose final attempt died sits at
 * send_attempts = max_send_attempts; a reaper filtered on
 * `send_attempts < max_send_attempts` would skip it on every tick forever. The
 * CASE is what recovers it, by moving it to 'failed' where it is at least
 * visible.
 */
async function reapStalled(env) {
  const res = await env.DB.prepare(
    `UPDATE payment_requests
        SET status = CASE WHEN send_attempts >= max_send_attempts
                          THEN 'failed' ELSE COALESCE(resume_status, 'scheduled') END,
            send_at = CASE WHEN send_attempts >= max_send_attempts THEN send_at
                           WHEN COALESCE(resume_status, 'scheduled') = 'scheduled'
                           THEN datetime('now', '+5 minutes')
                           ELSE send_at END,
            claim_id = NULL, claimed_at = NULL, resume_status = NULL,
            last_send_error = 'released after stalled send',
            updated_at = datetime('now')
      WHERE status = 'sending'
        AND claimed_at IS NOT NULL
        AND claimed_at <= datetime('now', '-${STALL_MINUTES} minutes')`,
  ).run();
  return res.meta.changes || 0;
}

/**
 * Take ownership of the due rows.
 *
 * One statement, therefore atomic: a second overlapping run finds the status
 * already flipped and matches nothing. `resume_status = status` reads the
 * pre-update value, which is what lets a failure put the row back where it came
 * from. UPDATE…LIMIT is not compiled into D1, hence the id IN (SELECT … LIMIT).
 */
async function claimDue(env, claimId) {
  await env.DB.prepare(
    `UPDATE payment_requests
        SET status = 'sending',
            resume_status = status,
            claim_id = ?1,
            claimed_at = datetime('now'),
            send_attempts = send_attempts + 1,
            updated_at = datetime('now')
      WHERE status = 'scheduled'
        AND send_at IS NOT NULL
        AND send_at <= datetime('now')
        AND send_attempts < max_send_attempts
        AND id IN (SELECT id FROM payment_requests
                    WHERE status = 'scheduled'
                      AND send_at IS NOT NULL
                      AND send_at <= datetime('now')
                    ORDER BY send_at LIMIT ${CLAIM_LIMIT})`,
  ).bind(claimId).run();

  // Read back by claim id rather than RETURNING: the claim is what proves
  // ownership, so selecting on it cannot pick up a row another run owns.
  const { results } = await env.DB.prepare(`
    SELECT r.*, m.id AS m_id, m.name AS member_name, m.email AS member_email,
           m.reply_to_email, m.active, m.stripe_account_id AS m_account,
           m.stripe_charges_enabled, m.stripe_card_payments,
           m.stripe_platform_payments, m.stripe_account_state,
           m.stripe_account_checked_at, m.deauthorized_at
      FROM payment_requests r
      JOIN team_members m ON m.id = r.team_member_id
     WHERE r.claim_id = ?1 AND r.status = 'sending'
     ORDER BY r.send_at`).bind(claimId).all();
  return results || [];
}

/**
 * Put a claimed row back, with backoff, or give up on it.
 *
 * `defer` is for conditions that are nobody's fault and will probably clear —
 * a Stripe outage, the kill switch. It rewinds send_attempts so a bad afternoon
 * cannot exhaust a request's five tries without a single email ever being
 * attempted.
 */
async function releaseClaim(env, row, claimId, error, { defer = false } = {}) {
  await env.DB.prepare(
    `UPDATE payment_requests
        SET status = CASE WHEN ?4 = 0 AND send_attempts >= max_send_attempts
                          THEN 'failed' ELSE COALESCE(resume_status, 'scheduled') END,
            send_attempts = CASE WHEN ?4 = 1 THEN MAX(send_attempts - 1, 0) ELSE send_attempts END,
            send_at = CASE WHEN ?4 = 0 AND send_attempts >= max_send_attempts THEN send_at
                           WHEN COALESCE(resume_status, 'scheduled') = 'scheduled'
                           THEN datetime('now', '+' || ?5 || ' minutes')
                           ELSE send_at END,
            claim_id = NULL, claimed_at = NULL, resume_status = NULL,
            last_send_error = ?3, updated_at = datetime('now')
      WHERE id = ?1 AND claim_id = ?2 AND status = 'sending'`,
  ).bind(
    row.id, claimId, String(error).slice(0, 300), defer ? 1 : 0,
    // Deferrals come back soon; real failures back off further each time.
    defer ? 5 : 15 * Math.max(row.send_attempts || 1, 1),
  ).run();

  await recordEvent(env, {
    requestId: row.id,
    teamMemberId: row.team_member_id,
    type: defer ? 'send_released' : 'send_failed',
    actor: 'system',
    detail: String(error).slice(0, 300),
  });
}

/**
 * One claimed row: check the member is still sendable, email the client, and
 * move the row to 'sent'.
 *
 * The terms (fee, connected account, expiry) were frozen when the request was
 * created and are deliberately not recomputed — the member agreed to a number
 * and a client email quoting a different one would be indefensible. What IS
 * rechecked is whether the charge can happen at all.
 */
async function sendClaimed(env, row, claimId, settings) {
  const member = {
    id: row.m_id,
    active: row.active,
    stripe_account_id: row.m_account,
    stripe_charges_enabled: row.stripe_charges_enabled,
    stripe_card_payments: row.stripe_card_payments,
    stripe_platform_payments: row.stripe_platform_payments,
    stripe_account_state: row.stripe_account_state,
    deauthorized_at: row.deauthorized_at,
  };

  // The account snapshot on the request is what a paid session settles against;
  // it must still be the member's account, or the money would land somewhere
  // the request does not describe.
  if (row.stripe_account_id && member.stripe_account_id !== row.stripe_account_id) {
    await releaseClaim(env, row, claimId,
      'The connected account changed after this was scheduled — recreate the request.');
    return { id: row.id, outcome: 'failed' };
  }

  const staleHours = settings?.account_staleness_hours ?? 24;
  const checked = row.stripe_account_checked_at
    ? Date.parse(`${row.stripe_account_checked_at.replace(' ', 'T')}Z`) : 0;
  let current = member;
  if (!Number.isFinite(checked) || Date.now() - checked > staleHours * 3600000) {
    current = await refreshAccount(env, member);
    if (!current) {
      await releaseClaim(env, row, claimId, 'Could not reach Stripe to confirm the account.', { defer: true });
      return { id: row.id, outcome: 'deferred' };
    }
  }

  if (!isChargeReady(current)) {
    await releaseClaim(env, row, claimId,
      'That Stripe account can no longer take payments — nothing was sent.');
    return { id: row.id, outcome: 'failed' };
  }

  if (!(await mayEmail(env, row.client_email))) {
    await releaseClaim(env, row, claimId, 'That client address is suppressed and cannot be emailed.');
    return { id: row.id, outcome: 'failed' };
  }
  if (!env.RESEND_API_KEY) {
    await releaseClaim(env, row, claimId, 'Email is not configured.', { defer: true });
    return { id: row.id, outcome: 'deferred' };
  }

  const base = env.BASE_URL || 'https://www.ukbrewerytours.com';
  const payUrl = `${base}/pay/${row.public_token}`;

  let messageId = null;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        // Keyed on (id, reminder_count) and NEVER on send_attempts: the claim
        // increments send_attempts, so a retry would compute a different key
        // and Resend would treat a duplicate as a fresh email.
        'Idempotency-Key': `pr-send-${row.id}-${row.reminder_count || 0}`,
      },
      body: JSON.stringify({
        from: env.FROM_EMAIL || 'UK Brewery Tours <info@ukbrewerytours.com>',
        to: [row.client_email],
        reply_to: row.reply_to_email || row.member_email || 'info@ukbrewerytours.com',
        subject: `${row.member_display_name || 'UK Brewery Tours'} — payment for ${row.tour_name}`,
        html: paymentRequestHtml({ row, payUrl }),
      }),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j?.message || `Resend ${res.status}`);
    messageId = j?.id || null;
  } catch (err) {
    await releaseClaim(env, row, claimId, `Could not send the email: ${err.message}`);
    return { id: row.id, outcome: 'failed' };
  }

  // send_email_sent and status move in ONE statement, so there is no window
  // where the mail is out but the row still looks unsent — which is the window
  // a second tick would use to send it again.
  const done = await env.DB.prepare(
    `UPDATE payment_requests
        SET status = 'sent', sent_at = datetime('now'),
            send_email_sent = 1, send_message_id = ?3,
            claim_id = NULL, claimed_at = NULL, resume_status = NULL,
            last_send_error = NULL, updated_at = datetime('now')
      WHERE id = ?1 AND status = 'sending' AND claim_id = ?2`,
  ).bind(row.id, claimId, messageId).run();

  if (!done.meta.changes) {
    // The email is out but the row moved under us — reaped, cancelled, paid.
    // Loud, because the client now holds a link the record does not explain.
    await alertOps(env, {
      subject: 'Scheduled email sent but the request had already moved on',
      lines: [`Request ${row.id}`, `Client ${row.client_email}`, `Resend id ${messageId || 'unknown'}`],
      requestId: row.id,
    });
    return { id: row.id, outcome: 'orphaned' };
  }

  await recordEvent(env, {
    requestId: row.id,
    teamMemberId: row.team_member_id,
    type: 'sent',
    actor: 'system',
    detail: `Scheduled payment request emailed to ${row.client_email}`,
  });
  return { id: row.id, outcome: 'sent' };
}

/**
 * Retire pay links nobody used.
 *
 * Refuses to expire a row with a live or in-flight session: a client can be
 * mid-3-D-Secure as the sweep runs, and that charge is real. Killing the row
 * first would land the money against a request marked expired.
 */
async function expireStale(env) {
  const res = await env.DB.prepare(
    `UPDATE payment_requests
        SET status = 'expired', updated_at = datetime('now')
      WHERE status = 'sent'
        AND expires_at IS NOT NULL
        AND expires_at <= datetime('now')
        AND NOT EXISTS (SELECT 1 FROM payment_request_sessions s
                         WHERE s.payment_request_id = payment_requests.id
                           AND s.status IN ('open', 'processing'))`,
  ).run();
  return res.meta.changes || 0;
}

/* --------------------------------------------------------------- reminders */

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * Reminder body → HTML. Blank lines separate paragraphs; lines starting '- '
 * become bullets. Not a markdown parser, on purpose — this renders notes we
 * wrote ourselves, and a second parser is a second thing to get wrong.
 */
function reminderHtml({ subject, intro, body }) {
  const blocks = String(body).split(/\n\s*\n/).map((block) => {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.every(l => l.startsWith('- '))) {
      return `<ul style="margin:0 0 16px;padding-left:20px;">${
        lines.map(l => `<li style="margin:0 0 6px;">${esc(l.slice(2))}</li>`).join('')}</ul>`;
    }
    return `<p style="margin:0 0 16px;font-size:15px;line-height:1.7;">${esc(lines.join(' '))}</p>`;
  }).join('');

  return `<!doctype html><html><body style="margin:0;padding:0;background:#f6f1e7;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f1e7;padding:24px 12px;">
 <tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fffdf8;border-radius:14px;overflow:hidden;font-family:'Segoe UI',Helvetica,Arial,sans-serif;color:#2b1d12;">
   <tr><td style="background:#2b1d12;padding:22px 28px;">
     <span style="color:#fffdf8;font-size:19px;font-weight:700;">🍺 UK Brewery Tours</span>
   </td></tr>
   <tr><td style="padding:30px 28px;">
     <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#8a7660;">Reminder</div>
     <h1 style="margin:6px 0 14px;font-size:22px;line-height:1.3;">${esc(subject)}</h1>
     ${intro ? `<p style="margin:0 0 20px;font-size:14px;color:#8a7660;line-height:1.6;">${esc(intro)}</p>` : ''}
     ${blocks}
   </td></tr>
  </table>
 </td></tr>
</table>
</body></html>`;
}

/**
 * Send any reminders that have come due.
 *
 * Same claim-then-send shape as the payment sweep above, for the same reason:
 * two overlapping ticks must not both send, and a worker that dies between the
 * claim and the send must not leave the row stuck. A failure backs off and
 * retries; an exhausted row goes to 'failed' where it is at least visible.
 */
async function sendDueReminders(env) {
  const claimId = randomId();
  const out = { claimed: 0, sent: 0, failed: 0, reaped: 0 };

  // Reap first, so a stalled claim is eligible again on this same tick.
  const reaped = await env.DB.prepare(
    `UPDATE reminders
        SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending' END,
            claim_id = NULL, claimed_at = NULL,
            last_error = 'released after stalled send', updated_at = datetime('now')
      WHERE status = 'sending' AND claimed_at IS NOT NULL
        AND claimed_at <= datetime('now', '-${STALL_MINUTES} minutes')`,
  ).run();
  out.reaped = reaped.meta.changes || 0;

  await env.DB.prepare(
    `UPDATE reminders
        SET status = 'sending', claim_id = ?1, claimed_at = datetime('now'),
            attempts = attempts + 1, updated_at = datetime('now')
      WHERE status = 'pending'
        AND send_at <= datetime('now')
        AND attempts < max_attempts
        AND id IN (SELECT id FROM reminders
                    WHERE status = 'pending' AND send_at <= datetime('now')
                    ORDER BY send_at LIMIT 10)`,
  ).bind(claimId).run();

  const { results } = await env.DB.prepare(
    "SELECT * FROM reminders WHERE claim_id = ?1 AND status = 'sending' ORDER BY send_at",
  ).bind(claimId).all();
  out.claimed = (results || []).length;

  for (const r of results || []) {
    try {
      if (!(await mayEmail(env, r.to_email))) throw new Error('address is suppressed');
      const sent = await sendEmail(env, {
        to: r.to_email,
        subject: r.subject,
        html: reminderHtml({ subject: r.subject, intro: r.intro, body: r.body }),
      });
      // Status and sent_at move together, so there is no window in which the
      // mail is out but the row still looks due.
      await env.DB.prepare(
        `UPDATE reminders
            SET status = 'sent', sent_at = datetime('now'), message_id = ?3,
                claim_id = NULL, claimed_at = NULL, last_error = NULL,
                updated_at = datetime('now')
          WHERE id = ?1 AND claim_id = ?2 AND status = 'sending'`,
      ).bind(r.id, claimId, sent?.id || null).run();
      out.sent++;
    } catch (err) {
      await env.DB.prepare(
        `UPDATE reminders
            SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending' END,
                send_at = CASE WHEN attempts >= max_attempts THEN send_at
                               ELSE datetime('now', '+' || (15 * attempts) || ' minutes') END,
                claim_id = NULL, claimed_at = NULL, last_error = ?3,
                updated_at = datetime('now')
          WHERE id = ?1 AND claim_id = ?2 AND status = 'sending'`,
      ).bind(r.id, claimId, String(err.message).slice(0, 300)).run();
      out.failed++;
      console.error('reminder send failed', r.id, err.message);
    }
  }

  return out;
}

/**
 * The monitors from the schema. A non-empty result is an alert whatever the
 * cause: these are exactly the states that are silent on every screen.
 */
async function checkMonitors(env) {
  const stuck = await env.DB.prepare(`
    SELECT
      (SELECT COUNT(*) FROM payment_requests
        WHERE status = 'scheduled' AND send_at IS NOT NULL
          AND send_at <= datetime('now', '-1 hour')) AS overdue,
      (SELECT COUNT(*) FROM payment_requests
        WHERE status = 'sending' AND claimed_at <= datetime('now', '-1 hour')) AS stalled,
      (SELECT COUNT(*) FROM payment_requests
        WHERE paid_email_sent = 0 AND status IN ('paid', 'refunded')
          AND paid_at <= datetime('now', '-10 minutes')) AS no_receipt`).first();

  const problems = [];
  if (stuck.overdue) problems.push(`${stuck.overdue} request(s) past their send time by over an hour`);
  if (stuck.stalled) problems.push(`${stuck.stalled} request(s) stuck mid-send for over an hour`);
  if (stuck.no_receipt) problems.push(`${stuck.no_receipt} paid request(s) with no receipt emailed`);

  if (problems.length) {
    await alertOps(env, { subject: 'Payment scheduler needs attention', lines: problems });
  }
  return stuck;
}

/**
 * One tick. Safe to run concurrently with itself and safe to run often.
 *
 * @returns a summary suitable for logging or returning from the admin endpoint.
 */
export async function runScheduler(env) {
  const claimId = randomId();
  const summary = { reaped: 0, claimed: 0, sent: 0, failed: 0, deferred: 0, expired: 0, skipped: null };

  try {
    // Reaping happens whatever the kill switch says: a stuck row is stuck
    // regardless of whether new sends are wanted.
    summary.reaped = await reapStalled(env);

    const settings = await env.DB.prepare('SELECT * FROM platform_settings WHERE id = 1').first();

    if (settings && settings.send_enabled === 0) {
      summary.skipped = 'sending is switched off in platform settings';
    } else {
      const rows = await claimDue(env, claimId);
      summary.claimed = rows.length;
      for (const row of rows) {
        const r = await sendClaimed(env, row, claimId, settings);
        if (r.outcome === 'sent') summary.sent++;
        else if (r.outcome === 'deferred') summary.deferred++;
        else summary.failed++;
      }
    }

    summary.expired = await expireStale(env);

    // Reminders are ours, not a client's — the kill switch is about not
    // emailing customers, so it deliberately does not gate these.
    summary.reminders = await sendDueReminders(env);

    summary.monitors = await checkMonitors(env);
  } catch (err) {
    // A tick that throws is a tick that does not happen again until someone
    // reads the logs, so this is reported and swallowed.
    console.error('scheduler tick failed', err);
    summary.error = err.message;
    try {
      await alertOps(env, { subject: 'Payment scheduler tick failed', lines: [err.message] });
    } catch { /* alerting is best-effort */ }
  }

  return summary;
}
