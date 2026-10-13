// /api/team/inbox/:id/payment-request — a team member asks the customer in a
// conversation assigned to them to pay (a tour deposit, the balance…).
//
//   GET   this conversation's requests (no email addresses)
//   POST  { kind, tour_name, tour_date?, amount, note? } — create and email it
//
// It is an ordinary team payment request (see requests.js and _lib/connect.js):
// a DIRECT charge on the member's own connected account, with the platform fee
// frozen from their row (their override, else the platform default, 20%). What is
// different: the customer's name and email come from the conversation on the
// server — the member never types or sees the address — the customer's reply goes
// back to the thread, and the request is logged there, as is the payment.

import { freezeTerms, STRIPE_MIN_PENCE } from '../../../../_lib/fees.js';
import { payToken, sendPaymentRequest } from '../../../../_lib/connect.js';
import { logEvent } from '../../../../_lib/inbox.js';
import { mine } from '../[id].js';

const KINDS = { deposit: 'Deposit', full: 'Full payment', balance: 'Balance', extra: 'Extra payment' };
const MAX_PENCE = 2000000;
const clean = (s, max) => String(s ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, max);
const money = p => `£${(p / 100).toFixed(2)}`;
const sqlStamp = d => d.toISOString().slice(0, 19).replace('T', ' ');

async function listFor(env, enquiryId, memberId) {
  const { results } = await env.DB.prepare(
    `SELECT id, payment_kind, tour_name, tour_date, amount_pence, fee_pence, status, sent_at, paid_at, created_at
       FROM payment_requests WHERE enquiry_id = ? AND team_member_id = ? ORDER BY created_at DESC`,
  ).bind(enquiryId, memberId).all();
  return (results || []).map(r => ({ ...r, kind_label: KINDS[r.payment_kind] || 'Payment' }));
}

export async function onRequestGet({ params, env, data }) {
  const enquiry = await mine(env, params.id, data.teamMemberId);
  if (!enquiry) return Response.json({ error: 'Conversation not found.' }, { status: 404 });
  return Response.json({ requests: await listFor(env, enquiry.id, data.teamMemberId) });
}

export async function onRequestPost({ params, request, env, data }) {
  const member = data.team;
  const enquiry = await mine(env, params.id, data.teamMemberId);
  if (!enquiry) return Response.json({ error: 'Conversation not found.' }, { status: 404 });
  // The inbox gate lets members without Stripe in (messages move no money); this
  // route does, so it applies the same readiness check as Team payments.
  if (!data.teamChargeReady) {
    return Response.json({ error: 'Your Stripe account is not ready to take payments yet — ask the office.' }, { status: 409 });
  }
  const clientEmail = String(enquiry.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail)) {
    return Response.json({ error: 'There is no email address on this conversation to send a payment link to.' }, { status: 400 });
  }

  let body;
  try { body = await request.json(); } catch { return Response.json({ error: 'Invalid request.' }, { status: 400 }); }

  const kind = KINDS[body.kind] ? body.kind : 'deposit';
  const tourName = clean(body.tour_name, 200);
  const tourDate = clean(body.tour_date, 10);
  const note = String(body.note ?? '').trim().slice(0, 2000);
  if (!tourName) return Response.json({ error: 'Enter the tour name.' }, { status: 400 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tourDate)) return Response.json({ error: 'Choose the tour date from the calendar.' }, { status: 400 });

  const amountPence = Math.round(Number(String(body.amount ?? '').replace(/[£,\s]/g, '')) * 100);
  if (!Number.isFinite(amountPence) || amountPence < STRIPE_MIN_PENCE) {
    return Response.json({ error: `The minimum payment is ${money(STRIPE_MIN_PENCE)}.` }, { status: 400 });
  }
  if (amountPence > MAX_PENCE) return Response.json({ error: 'For payments over £20,000 please contact the office.' }, { status: 400 });

  // Optional estimate: guests x price per guest. Both or neither.
  let guests = null, perGuestPence = null, totalPence = null;
  const hasGuests = String(body.guests ?? '').trim() !== '';
  const hasPrice = String(body.price_per_guest ?? '').trim() !== '';
  if (hasGuests || hasPrice) {
    guests = Math.round(Number(body.guests));
    perGuestPence = Math.round(Number(String(body.price_per_guest ?? '').replace(/[£,\s]/g, '')) * 100);
    if (!Number.isInteger(guests) || guests < 1 || guests > 1000) return Response.json({ error: 'Enter the number of guests (or leave both estimate boxes empty).' }, { status: 400 });
    if (!Number.isFinite(perGuestPence) || perGuestPence < 1) return Response.json({ error: 'Enter the price per guest (or leave both estimate boxes empty).' }, { status: 400 });
    totalPence = guests * perGuestPence;
    if (totalPence > MAX_PENCE) return Response.json({ error: 'That estimate is too large.' }, { status: 400 });
    if (totalPence < amountPence) return Response.json({ error: `This payment is more than the estimated total (${money(totalPence)}).` }, { status: 400 });
  }

  // Money terms from the MEMBER row, never the request body: their connected
  // account, and their fee override or the platform default.
  const settings = await env.DB.prepare('SELECT * FROM platform_settings WHERE id = 1').first();
  let frozen;
  try {
    frozen = freezeTerms({ request: { amount_pence: amountPence }, member, settings });
  } catch (err) {
    console.error('inbox payment request: terms', member.id, err);
    return Response.json({ error: 'Your Stripe account is not ready to take payments yet — ask the office.' }, { status: 409 });
  }

  const id = crypto.randomUUID();
  const publicToken = await payToken(id, env.ADMIN_SESSION_SECRET);
  const expires = new Date(Date.now() + (settings?.default_expiry_days ?? 30) * 86400000);

  await env.DB.prepare(`
    INSERT INTO payment_requests
      (id, public_token, team_member_id, client_name, client_email,
       tour_name, tour_date, tour_details,
       currency, amount_pence, fee_bps, fee_pence, fee_source, fee_frozen_at,
       terms_snapshot, stripe_account_id, member_display_name,
       status, send_rule, expires_at, created_by, payment_kind, enquiry_id,
       guest_count, price_per_guest_pence, booking_total_pence)
    VALUES (?,?,?,?,?,?,?,?,'gbp',?,?,?,?,datetime('now'),?,?,?,'draft','now',?,?,?,?,?,?,?)`)
    .bind(id, publicToken, member.id, enquiry.name, clientEmail,
          tourName, tourDate || null, note || null,
          amountPence, frozen.fee_bps, frozen.fee_pence, frozen.fee_source,
          frozen.terms_snapshot, frozen.stripe_account_id, frozen.member_display_name,
          sqlStamp(expires), `team:${member.email}`, kind, enquiry.id,
          guests, perGuestPence, totalPence)
    .run();

  try {
    await sendPaymentRequest(env, { requestId: id, member });
  } catch (err) {
    console.error('inbox payment request send failed', id, err);
    return Response.json({ error: `The payment link could not be sent: ${String(err.message || err).slice(0, 200)}` }, { status: 502 });
  }

  // On the thread, as the customer received it, so the office sees it too.
  const line = `💷 ${KINDS[kind]} request: ${money(amountPence)} — ${tourName}${tourDate ? `, ${tourDate}` : ''}`
    + (totalPence ? `\n(${guests} guests × ${money(perGuestPence)} = ${money(totalPence)} estimated${kind === 'deposit' ? `; ${money(totalPence - amountPence)} remaining` : ''})` : '');
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO enquiry_messages (enquiry_id, direction, channel, body, author) VALUES (?,?,?,?,?)',
    ).bind(enquiry.id, 'out', 'email', note ? `${note}\n\n${line}` : line, member.inbox_from_name || member.name),
    env.DB.prepare(
      `UPDATE enquiries SET status = 'waiting', unread = 0, alerted_at = NULL, last_message_at = datetime('now'), closed_at = NULL
        WHERE id = ?`,
    ).bind(enquiry.id),
  ]);
  await logEvent(env, enquiry.id, `💷 Payment link sent for ${money(amountPence)} — ${KINDS[kind]}, ${tourName} (on ${member.name}'s Stripe account)`, member.name);

  return Response.json({ ok: true, requests: await listFor(env, enquiry.id, member.id) });
}
