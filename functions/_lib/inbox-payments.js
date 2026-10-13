// Payment requests from an inbox conversation ("pay £5 for your top-up").
//
// The customer's link is /pay-now/<token>. Opening it makes a fresh Stripe
// Checkout Session for the amount and redirects there, so a link opened days
// later still works (a session itself expires after 24 hours). The Stripe
// webhook — and, belt and braces, the success page — calls markPaid().
//
// Logged on the conversation only. Nothing here touches vouchers: Dom adjusts
// those by hand if a payment calls for it.

import { BASE_URL, logEvent, newToken } from './inbox.js';
import { sendEmail } from './email.js';

export const MIN_PENCE = 100;          // £1
export const MAX_PENCE = 500000;       // £5,000 — a typo guard, not a business rule

export const payLink = token => `${BASE_URL}/pay-now/${token}`;
export const pounds = p => `£${(p / 100).toFixed(2)}`;

/** Amount typed in pounds ("5", "£5.50", "12.5") → pence, or null. */
export function parsePounds(v) {
  const n = Number(String(v ?? '').replace(/[£,\s]/g, ''));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

export async function createPaymentRequest(env, enquiry, { amountPence, description, who }) {
  const token = newToken();
  const res = await env.DB.prepare(
    `INSERT INTO inbox_payments (enquiry_id, token, amount_pence, description, customer_email, created_by)
     VALUES (?,?,?,?,?,?)`,
  ).bind(enquiry.id, token, amountPence, description, enquiry.email || null, who).run();
  return { id: res.meta.last_row_id, token, url: payLink(token) };
}

/** Requests on a conversation, newest first, in the shape the admin page shows. */
export async function paymentsFor(env, enquiryId) {
  const { results } = await env.DB.prepare(
    `SELECT id, token, amount_pence, description, status, created_by, created_at, paid_at, cancelled_at
       FROM inbox_payments WHERE enquiry_id = ? ORDER BY id DESC`,
  ).bind(enquiryId).all();
  const own = (results || []).map(({ token, ...p }) => ({ ...p, url: payLink(token) }));

  // Requests a team member raised from this conversation, on their own Stripe
  // account. Shown for the record; they are managed in Team payments.
  const { results: team } = await env.DB.prepare(
    `SELECT r.id, r.payment_kind, r.tour_name, r.tour_date, r.amount_pence, r.fee_pence, r.status,
            r.created_at, r.paid_at, m.name AS member_name
       FROM payment_requests r JOIN team_members m ON m.id = r.team_member_id
      WHERE r.enquiry_id = ? ORDER BY r.created_at DESC`,
  ).bind(enquiryId).all();
  const KIND = { deposit: 'Deposit', full: 'Full payment', balance: 'Balance', extra: 'Extra payment' };
  const STATUS = { paid: 'paid', refunded: 'paid', cancelled: 'cancelled', expired: 'cancelled', failed: 'cancelled' };
  const theirs = (team || []).map(r => ({
    id: `team-${r.id}`,
    team: true,
    amount_pence: r.amount_pence,
    description: `${KIND[r.payment_kind] || 'Payment'} — ${r.tour_name}${r.tour_date ? `, ${r.tour_date}` : ''} · ${r.member_name}'s Stripe (fee ${pounds(r.fee_pence || 0)})`,
    status: STATUS[r.status] || 'open',
    created_at: r.created_at,
    paid_at: r.paid_at,
  }));
  return [...theirs, ...own].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

/** A Checkout Session for one request. Card, Apple Pay and Google Pay come with Checkout. */
export async function checkoutFor(env, payment, brand) {
  const p = new URLSearchParams();
  p.set('mode', 'payment');
  p.set('success_url', `${payLink(payment.token)}?paid={CHECKOUT_SESSION_ID}`);
  p.set('cancel_url', payLink(payment.token) + '?cancelled=1');
  p.set('client_reference_id', `inbox-payment-${payment.id}`);
  p.set('metadata[inbox_payment_id]', String(payment.id));
  p.set('metadata[enquiry_id]', String(payment.enquiry_id));
  p.set('payment_intent_data[metadata][inbox_payment_id]', String(payment.id));
  p.set('payment_intent_data[description]', `${brand}: ${payment.description}`);
  if (payment.customer_email) {
    p.set('customer_email', payment.customer_email);
    // Stripe emails the receipt.
    p.set('payment_intent_data[receipt_email]', payment.customer_email);
  }
  p.set('line_items[0][quantity]', '1');
  p.set('line_items[0][price_data][currency]', 'gbp');
  p.set('line_items[0][price_data][unit_amount]', String(payment.amount_pence));
  p.set('line_items[0][price_data][product_data][name]', payment.description);
  p.set('line_items[0][price_data][product_data][description]', brand);

  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: p.toString(),
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Stripe ${res.status}: ${json?.error?.message || 'checkout session failed'}`);
  return json;
}

/**
 * Record a completed session against its request. Idempotent: the conditional
 * UPDATE means the webhook and the success page can both call it and only the
 * first one logs and alerts.
 */
export async function markPaid(env, session) {
  const id = Number(session?.metadata?.inbox_payment_id);
  if (!id || session.payment_status !== 'paid') return false;
  const claim = await env.DB.prepare(
    `UPDATE inbox_payments SET status = 'paid', paid_at = datetime('now'), stripe_session_id = ?, stripe_payment_intent = ?
      WHERE id = ? AND status != 'paid'`,
  ).bind(session.id, session.payment_intent || null, id).run();
  if (!claim.meta.changes) return false;

  const pay = await env.DB.prepare('SELECT * FROM inbox_payments WHERE id = ?').bind(id).first();
  const enquiry = await env.DB.prepare('SELECT id, name, email, deleted_at FROM enquiries WHERE id = ?').bind(pay.enquiry_id).first();
  const amount = pounds(session.amount_total ?? pay.amount_pence);

  if (enquiry) {
    await logEvent(env, enquiry.id, `💷 Paid ${amount} — ${pay.description}`, 'Stripe');
    // Bring it to the top of the inbox, unread, unless it has been binned.
    if (!enquiry.deleted_at) {
      await env.DB.prepare("UPDATE enquiries SET unread = 1, last_message_at = datetime('now') WHERE id = ?").bind(enquiry.id).run();
    }
  }

  // One short alert per payment.
  try {
    const who = enquiry?.name || session.customer_details?.name || 'A customer';
    await sendEmail(env, {
      to: env.ALERT_EMAIL || 'dom@ukbrewerytours.com',
      subject: `Payment received: ${amount} from ${who}`,
      html: `<p style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6">${esc(who)} paid <strong>${amount}</strong> for "${esc(pay.description)}".</p>
        ${enquiry ? `<p style="font-family:Arial,sans-serif;font-size:15px"><a href="${BASE_URL}/admin/#inbox/${enquiry.id}">Open the conversation</a></p>` : ''}`,
    });
  } catch (err) {
    console.error('payment alert failed', err);
  }
  return true;
}

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
