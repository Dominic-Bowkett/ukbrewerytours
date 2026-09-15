// Enquiry inbox — shared by the public endpoints (contact form, embedded
// widgets, live chat, the /messages/ page, inbound email) and the admin API.
//
// An enquiry is a conversation: the `enquiries` row is its header, the
// `enquiry_messages` rows are the thread. Every conversation carries a random
// token, which is the customer's only key to it — it unlocks the /messages/
// page, the chat widget's history and (once inbound email is switched on) the
// reply-to address on our emails.

import { sendEmail, inboxAlertHtml } from './email.js';
import { normaliseCode } from './codes.js';

export const BASE_URL = 'https://www.ukbrewerytours.com';

export const TYPES = {
  redemption: 'Voucher redemption',
  group: 'Group booking',
  booking: 'Tour booking',
  voucher: 'Gift voucher question',
  general: 'General enquiry',
};

export const STATUSES = {
  new: 'New',
  dealing: 'Dealing with',
  waiting: 'Awaiting customer',
  closed: 'Closed',
};

export const CHANNELS = {
  form: 'Website form',
  widget: 'Embedded form',
  chat: 'Live chat',
  web: 'Messages page',
  email: 'Email',
};

const SITE_LABELS = {
  'ukbrewerytours.com': 'UK Brewery Tours',
  'londonbrewerytour.com': 'London Brewery Tours',
  'bristolbrewerytours.com': 'Bristol Brewery Tours',
};

export const siteLabel = site => SITE_LABELS[site] || site || 'UK Brewery Tours';

/** The brand a customer on that site recognises (unknown partner sites → UKBT). */
export const brandFor = site => SITE_LABELS[site] || 'UK Brewery Tours';

export const TOKEN_RE = /^[0-9a-f]{32}$/;

export function newToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

export const threadUrl = token => `${BASE_URL}/messages/${token}`;
export const adminUrl = id => `${BASE_URL}/admin/#inbox/${id}`;

/**
 * Where a customer's email reply should land. Until inbound email is routed
 * (INBOUND_REPLY_DOMAIN set, see INBOX.md) replies go to the info@ mailbox as
 * they always have; after, they come straight back into the conversation.
 */
export function replyAddress(env, token) {
  const domain = String(env.INBOUND_REPLY_DOMAIN || '').trim();
  return domain && token ? `reply-${token}@${domain}` : 'info@ukbrewerytours.com';
}

/** Hostname without www — preview and local hosts count as their real site. */
export function siteFromUrl(url) {
  let host = '';
  try { host = new URL(String(url)).hostname.toLowerCase(); } catch { return 'ukbrewerytours.com'; }
  host = host.replace(/^www\./, '');
  if (!host || host === 'localhost' || /^[\d.]+$/.test(host) || host.endsWith('ukbrewerytours.pages.dev')) return 'ukbrewerytours.com';
  if (host.endsWith('bristolbrewerytours.pages.dev')) return 'bristolbrewerytours.com';
  if (/(^|\.)london[\w-]*\.pages\.dev$/.test(host)) return 'londonbrewerytour.com';
  return host.slice(0, 100);
}

/** Best guess at the enquiry type from the page it was sent from. */
export function inferType(page) {
  let path = String(page || '');
  try { if (/^https?:/i.test(path)) path = new URL(path).pathname; } catch { /* keep as is */ }
  path = path.toLowerCase();
  if (path.includes('redeem')) return 'redemption';
  if (/group|private|stag|hen-do|corporate|team-building/.test(path)) return 'group';
  if (path.includes('gift-voucher') || path.includes('voucher')) return 'voucher';
  return 'general';
}

export const cleanType = t => (Object.prototype.hasOwnProperty.call(TYPES, t) ? t : null);

export function defaultSubject(type, site) {
  const brand = brandFor(site);
  switch (type) {
    case 'redemption': return `Your voucher redemption request — ${brand}`;
    case 'group': return `Your group booking enquiry — ${brand}`;
    case 'booking': return `Your tour booking enquiry — ${brand}`;
    case 'voucher': return `Your gift voucher enquiry — ${brand}`;
    default: return `Your enquiry — ${brand}`;
  }
}

// Structured extras a form may send alongside the message. Anything else is dropped.
const FIELD_KEYS = ['tour', 'preferred_date', 'group_size', 'city', 'occasion', 'budget'];
export const FIELD_LABELS = {
  tour: 'Tour', preferred_date: 'Preferred date', group_size: 'Group size',
  city: 'City', occasion: 'Occasion', budget: 'Budget',
};

export function cleanFields(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const k of FIELD_KEYS) {
    const v = String(input[k] ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
    if (v) out[k] = v;
  }
  return out;
}

/** Create the conversation and its first message. Returns { id, token, subject }. */
export async function createEnquiry(env, e) {
  const token = newToken();
  const subject = defaultSubject(e.type, e.site);
  const fieldsJson = Object.keys(e.fields || {}).length ? JSON.stringify(e.fields) : null;

  const res = await env.DB.prepare(
    `INSERT INTO enquiries (name, email, phone, message, page, ip, widget_id, widget_origin,
       type, channel, site, status, unread, token, subject, fields, voucher_code, last_message_at, last_inbound_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,'new',1,?,?,?,?,datetime('now'),datetime('now'))`,
  ).bind(
    e.name, e.email, e.phone || null, e.message, e.page || null, e.ip || null,
    e.widgetId || null, e.widgetOrigin || null,
    e.type, e.channel, e.site, token, subject, fieldsJson, e.voucherCode || null,
  ).run();

  const id = res.meta.last_row_id;
  await env.DB.prepare(
    'INSERT INTO enquiry_messages (enquiry_id, direction, channel, body, author, ip) VALUES (?,?,?,?,?,?)',
  ).bind(id, 'in', e.channel, e.message, e.name, e.ip || null).run();

  return { id, token, subject };
}

/** A customer follow-up (chat, messages page, email reply). Reopens a closed conversation. */
export async function appendCustomerMessage(env, enquiry, { body, channel, author, ip }) {
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO enquiry_messages (enquiry_id, direction, channel, body, author, ip) VALUES (?,?,?,?,?,?)',
    ).bind(enquiry.id, 'in', channel, body, author || enquiry.name, ip || null),
    env.DB.prepare(
      `UPDATE enquiries SET unread = 1, last_message_at = datetime('now'), last_inbound_at = datetime('now'),
         status = CASE WHEN status IN ('waiting','closed') THEN 'dealing' ELSE status END,
         closed_at = NULL
       WHERE id = ?`,
    ).bind(enquiry.id),
  ]);
}

/** Internal timeline entry (status changes, redemptions). Never shown to the customer. */
export async function logEvent(env, enquiryId, body, author) {
  await env.DB.prepare(
    'INSERT INTO enquiry_messages (enquiry_id, direction, channel, body, author) VALUES (?,?,?,?,?)',
  ).bind(enquiryId, 'event', 'admin', body, author || null).run();
}

/**
 * Email Dom about a new enquiry or a customer follow-up. Follow-ups are
 * throttled per conversation (a chat is several quick messages); the claim is a
 * conditional UPDATE, so two simultaneous messages cannot both send.
 */
export async function alertAdmin(env, enquiry, { body, followUp = false, matches = [], unmatched = [] }) {
  if (!env.RESEND_API_KEY) return false;
  const claim = await env.DB.prepare(
    followUp
      ? "UPDATE enquiries SET alerted_at = datetime('now') WHERE id = ? AND (alerted_at IS NULL OR alerted_at < datetime('now','-10 minutes'))"
      : "UPDATE enquiries SET alerted_at = datetime('now') WHERE id = ?",
  ).bind(enquiry.id).run();
  if (!claim.meta.changes) return false;

  const typeLabel = TYPES[enquiry.type] || 'Enquiry';
  const prefix = followUp ? 'New reply' : `New ${typeLabel.toLowerCase()}`;
  await sendEmail(env, {
    to: env.ALERT_EMAIL || 'dom@ukbrewerytours.com',
    subject: `${prefix} — ${enquiry.name} (${siteLabel(enquiry.site)})`,
    html: inboxAlertHtml({
      enquiry, body, followUp, matches, unmatched,
      typeLabel, channelLabel: CHANNELS[enquiry.channel] || enquiry.channel,
      siteName: siteLabel(enquiry.site), link: adminUrl(enquiry.id),
    }),
  });
  return true;
}

/* ---------------- voucher code matching ---------------- */

const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const UBT_RE = /\bUBT[\s-]?[A-Z0-9]{4}[\s-]?[A-Z0-9]{4}\b/gi;

/** Pieces of the "voucher code" field — "9TPJC + DDRV4" is two codes. */
export function explicitCodes(field) {
  const pieces = String(field || '').split(/[,+&/;|\n]|\band\b/i).map(s => s.trim()).filter(Boolean);
  return [...new Set(pieces.map(norm).filter(c => c.length >= 4 && c.length <= 40))];
}

/**
 * Everything that might be a voucher code: the explicit field, UBT-style codes
 * anywhere in the text, and free-text tokens that look code-like (letters AND
 * digits, or 5+ capitals, or a long number). False positives just don't match.
 */
export function candidateCodes(field, text) {
  const out = new Set(explicitCodes(field));
  for (const piece of String(field || '').split(/\s+/)) {
    const n = norm(piece);
    if (n.length >= 4 && n.length <= 40) out.add(n);
  }
  const t = String(text || '');
  for (const m of t.matchAll(UBT_RE)) out.add(norm(m[0]));
  for (const m of t.matchAll(/\b[A-Za-z0-9][A-Za-z0-9-]{3,28}[A-Za-z0-9]\b/g)) {
    const w = m[0];
    const letters = /[A-Za-z]/.test(w);
    const digits = /\d/.test(w);
    const caps = letters && w === w.toUpperCase() && norm(w).length >= 5;
    if ((letters && digits) || caps || /^\d{8,}$/.test(w)) out.add(norm(w));
  }
  return [...out].slice(0, 45);
}

/** Look candidate codes up in our own vouchers and every imported source. */
export async function lookupCodes(env, candidates) {
  const list = [...new Set((candidates || []).map(norm).filter(Boolean))].slice(0, 45);
  if (!list.length) return [];
  const matches = [];

  const ubt = [...new Set(list.map(c => normaliseCode(c)).filter(c => /^UBT-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(c)))];
  if (ubt.length) {
    const { results } = await env.DB.prepare(
      `SELECT v.id, v.code, v.amount_pence, v.balance_pence, v.status, v.paid_at, v.created_at,
              COALESCE(v.refunded_pence, 0) AS refunded_pence,
              o.purchaser_name, o.purchaser_email, o.recipient_name, o.recipient_email,
              o.send_to_self, o.is_demo, o.tour_name
         FROM vouchers v JOIN orders o ON o.id = v.order_id
        WHERE v.code IN (${ubt.map(() => '?').join(',')})`,
    ).bind(...ubt).all();
    for (const v of results || []) {
      const toSelf = v.send_to_self === 1;
      matches.push({
        kind: 'ukbt', id: v.id, code: v.code, code_norm: norm(v.code), source: 'UK Brewery Tours',
        amount_pence: v.amount_pence, balance_pence: v.balance_pence, refunded_pence: v.refunded_pence,
        status: v.status, is_demo: v.is_demo === 1, description: v.tour_name || null,
        holder_name: toSelf ? v.purchaser_name : (v.recipient_name || v.purchaser_name),
        holder_email: toSelf ? v.purchaser_email : (v.recipient_email || v.purchaser_email),
        purchaser_name: v.purchaser_name, purchased_at: v.paid_at || v.created_at, expires_at: null,
      });
    }
  }

  try {
    const { results } = await env.DB.prepare(
      `SELECT * FROM imported_vouchers WHERE code_norm IN (${list.map(() => '?').join(',')})`,
    ).bind(...list).all();
    for (const v of results || []) {
      matches.push({
        kind: 'imported', id: v.id, code: v.code, code_norm: v.code_norm, source: v.source,
        amount_pence: v.amount_pence, balance_pence: v.balance_pence, refunded_pence: 0,
        status: v.status, is_demo: false, description: v.description,
        holder_name: v.holder_name, holder_email: v.holder_email,
        purchased_at: v.purchased_at, expires_at: v.expires_at, notes: v.notes,
      });
    }
  } catch (err) {
    // The imported table arrives with migration 0011; never break lookups over it.
    console.error('imported voucher lookup failed', err);
  }

  return matches;
}

/** Voucher check for a whole conversation: matches, plus explicit codes that matched nothing. */
export async function voucherCheck(env, enquiry, texts) {
  const text = (texts || []).join('\n');
  const matches = await lookupCodes(env, candidateCodes(enquiry.voucher_code, text));
  const hit = new Set();
  for (const m of matches) {
    hit.add(m.code_norm);
    if (m.kind === 'ukbt') hit.add(norm(m.code).replace(/^UBT/, ''));
  }
  const unmatched = explicitCodes(enquiry.voucher_code).filter(c => !hit.has(c) && !hit.has(c.replace(/^UBT/, '')));
  return { matches, unmatched };
}
