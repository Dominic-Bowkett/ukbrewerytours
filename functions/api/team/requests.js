// GET  /api/team/requests  — this member's payment requests
// POST /api/team/requests  — create one (draft, scheduled, or send now)
//
// Every query is scoped by the session's team_member_id. There is no route
// parameter that names a member, so one member cannot read or create against
// another's Stripe account even by guessing ids.
//
// The client never influences money: amount is validated here, and the fee and
// connected account are resolved from the MEMBER row and frozen at send time —
// never taken from the request body.

import { freezeTerms, STRIPE_MIN_PENCE } from '../../_lib/fees.js';
import { payToken, sendPaymentRequest } from '../../_lib/connect.js';

const isEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim());
const clean = (s, max) => String(s ?? '').trim().slice(0, max);
const MAX_PENCE = 2000000;   // £20,000 — a sanity ceiling, not a business rule

/** SQLite-comparable UTC stamp: 'YYYY-MM-DD HH:MM:SS'. ISO-8601 sorts wrong. */
function sqlStamp(d) {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

export async function onRequestGet({ env, data }) {
  const memberId = data.teamMemberId;
  const { results } = await env.DB.prepare(`
    SELECT id, public_token, client_name, client_email, tour_name, tour_date,
           amount_pence, fee_pence, currency, status, send_at, sent_at, paid_at,
           amount_paid_pence, refunded_pence, expires_at, view_count, created_at
      FROM payment_requests
     WHERE team_member_id = ?
     ORDER BY created_at DESC
     LIMIT 200`).bind(memberId).all();

  const totals = await env.DB.prepare(`
    SELECT COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN status='paid' THEN amount_paid_pence ELSE 0 END), 0) AS paid_pence,
           COALESCE(SUM(CASE WHEN status='paid' THEN fee_collected_pence ELSE 0 END), 0) AS fee_pence,
           COALESCE(SUM(CASE WHEN status IN ('sent','processing') THEN amount_pence ELSE 0 END), 0) AS outstanding_pence
      FROM payment_requests WHERE team_member_id = ?`).bind(memberId).first();

  return Response.json({ requests: results, totals },
    { headers: { 'Cache-Control': 'private, no-store' } });
}

export async function onRequestPost({ request, env, data }) {
  const member = data.team;

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const clientName = clean(body.client_name, 120);
  const clientEmail = clean(body.client_email, 200).toLowerCase();
  const tourName = clean(body.tour_name, 200);
  const tourDate = clean(body.tour_date, 10);       // YYYY-MM-DD
  const tourTime = clean(body.tour_time, 5);        // HH:MM
  const tourDetails = clean(body.tour_details, 4000);
  const reference = clean(body.reference, 60);

  if (!clientName) return Response.json({ error: 'Enter the client’s name.' }, { status: 400 });
  if (!isEmail(clientEmail)) return Response.json({ error: 'Enter a valid client email.' }, { status: 400 });
  if (!tourName) return Response.json({ error: 'Enter what the payment is for.' }, { status: 400 });
  if (tourDate && !/^\d{4}-\d{2}-\d{2}$/.test(tourDate)) {
    return Response.json({ error: 'Tour date must be YYYY-MM-DD.' }, { status: 400 });
  }
  // CRLF in a name would let a sender forge mail headers downstream.
  if (/[\r\n]/.test(clientName) || /[\r\n]/.test(clientEmail)) {
    return Response.json({ error: 'Invalid characters in name or email.' }, { status: 400 });
  }

  const amountPence = Math.round(Number(body.amount) * 100);
  if (!Number.isFinite(amountPence) || amountPence < STRIPE_MIN_PENCE) {
    return Response.json({ error: `The minimum payment is £${(STRIPE_MIN_PENCE / 100).toFixed(2)}.` }, { status: 400 });
  }
  if (amountPence > MAX_PENCE) {
    return Response.json({ error: 'For payments over £20,000 please contact the office.' }, { status: 400 });
  }

  // --- deposit / balance / extra ---
  // Usually a booking is a deposit then a balance, but sometimes there are
  // extra payments on top. `parent_request_id` links a follow-up to the
  // original so the client's email can say "Balance for …" rather than
  // reading like a brand-new booking.
  const KINDS = ['full', 'deposit', 'balance', 'extra'];
  const paymentKind = KINDS.includes(body.payment_kind) ? body.payment_kind : 'full';

  let parentId = null;
  if (body.parent_request_id) {
    // Scoped by team_member_id: a member cannot chain onto another's booking.
    const parent = await env.DB.prepare(
      'SELECT id, client_email, tour_name, booking_total_pence FROM payment_requests WHERE id = ? AND team_member_id = ?',
    ).bind(clean(body.parent_request_id, 40), member.id).first();
    if (!parent) return Response.json({ error: 'That original booking was not found.' }, { status: 404 });
    parentId = parent.id;
  }
  if (paymentKind === 'balance' && !parentId) {
    return Response.json({ error: 'A balance payment must be linked to its deposit.' }, { status: 400 });
  }

  let bookingTotalPence = null;
  if (body.booking_total !== undefined && body.booking_total !== null && body.booking_total !== '') {
    bookingTotalPence = Math.round(Number(body.booking_total) * 100);
    if (!Number.isFinite(bookingTotalPence) || bookingTotalPence < amountPence) {
      return Response.json({ error: 'The booking total cannot be less than this payment.' }, { status: 400 });
    }
    if (bookingTotalPence > MAX_PENCE) {
      return Response.json({ error: 'That booking total is too large.' }, { status: 400 });
    }
  }

  // --- when should it go out? ---
  // 'now' | 'at' (send_at) | 'before' (N days before tour_date)
  const mode = ['now', 'at', 'before'].includes(body.send_mode) ? body.send_mode : 'now';
  let sendAt = null;
  // NOT NULL in the schema, with 'now' as the default — passing null here fails
  // the constraint and 500s every immediate send.
  let sendRule = 'now';
  let sendRuleDays = null;

  if (mode === 'at') {
    const t = Date.parse(body.send_at);
    if (!Number.isFinite(t)) return Response.json({ error: 'Choose when to send it.' }, { status: 400 });
    if (t < Date.now() - 60000) return Response.json({ error: 'That send time is in the past.' }, { status: 400 });
    sendAt = sqlStamp(new Date(t));
    sendRule = 'at';
  } else if (mode === 'before') {
    const days = Math.round(Number(body.send_rule_days));
    if (!Number.isInteger(days) || days < 0 || days > 365) {
      return Response.json({ error: 'Days before the event must be between 0 and 365.' }, { status: 400 });
    }
    if (!tourDate) return Response.json({ error: 'Add the tour date to schedule relative to it.' }, { status: 400 });
    const at = new Date(`${tourDate}T09:00:00Z`);
    at.setUTCDate(at.getUTCDate() - days);
    if (at.getTime() < Date.now()) {
      return Response.json({ error: 'That would have sent already — pick fewer days or send now.' }, { status: 400 });
    }
    sendAt = sqlStamp(at);
    sendRule = 'days_before_event';
    sendRuleDays = days;
  }

  // --- freeze the money terms from the MEMBER row, never the request body ---
  const settings = await env.DB.prepare('SELECT * FROM platform_settings WHERE id = 1').first();
  let frozen;
  try {
    frozen = freezeTerms({ request: { amount_pence: amountPence }, member, settings });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 409 });
  }

  const id = crypto.randomUUID();
  // Derived, not random: /api/pay/[token] re-derives this from the row id and
  // refuses to serve a row whose stored token does not match, so a tampered
  // public_token column cannot hand out a link to a different request.
  const publicToken = await payToken(id, env.ADMIN_SESSION_SECRET);

  const expiryDays = settings?.default_expiry_days ?? 30;
  const expires = new Date(Date.now() + expiryDays * 86400000);

  const status = mode === 'now' ? 'draft' : 'scheduled';

  await env.DB.prepare(`
    INSERT INTO payment_requests
      (id, public_token, team_member_id, client_name, client_email,
       tour_name, tour_date, tour_time, tour_details, reference,
       currency, amount_pence, fee_bps, fee_pence, fee_source, fee_frozen_at,
       terms_snapshot, stripe_account_id, member_display_name,
       status, send_rule, send_rule_days, send_at, expires_at, created_by,
       payment_kind, parent_request_id, booking_total_pence)
    VALUES (?,?,?,?,?,?,?,?,?,?,'gbp',?,?,?,?,datetime('now'),?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(id, publicToken, member.id, clientName, clientEmail,
          tourName, tourDate || null, tourTime || null, tourDetails || null, reference || null,
          amountPence, frozen.fee_bps, frozen.fee_pence, frozen.fee_source,
          frozen.terms_snapshot, frozen.stripe_account_id, frozen.member_display_name,
          status, sendRule, sendRuleDays, sendAt, sqlStamp(expires), `team:${member.email}`,
          paymentKind, parentId, bookingTotalPence)
    .run();

  // Remember the client so a repeat request is two clicks, not retyping.
  await env.DB.prepare(`
    INSERT INTO clients (id, team_member_id, name, email, request_count, last_request_at)
    VALUES (?,?,?,?,1,datetime('now'))
    ON CONFLICT(team_member_id, email) DO UPDATE
      SET name = excluded.name,
          request_count = request_count + 1,
          last_request_at = datetime('now'),
          updated_at = datetime('now')`)
    .bind(crypto.randomUUID(), member.id, clientName, clientEmail)
    .run();

  if (mode !== 'now') {
    return Response.json({ ok: true, id, status, send_at: sendAt, scheduled: true });
  }

  // Send immediately. A failure here leaves the row as a draft the member can retry,
  // rather than a half-sent request.
  try {
    const sent = await sendPaymentRequest(env, { requestId: id, member });
    return Response.json({ ok: true, id, status: 'sent', pay_url: sent?.payUrl || null });
  } catch (err) {
    console.error('immediate send failed', id, err);
    return Response.json({
      ok: true, id, status: 'draft',
      warning: `Saved, but the email could not be sent: ${err.message}. Open it and try again.`,
    }, { status: 202 });
  }
}
