// GET /api/ads/conversions — Google Ads offline conversion feed (CSV).
//
// Google Ads fetches this on a schedule (Tools → Data manager → HTTPS,
// username "googleads", password = the ADS_FEED_PASSWORD secret). Data manager
// ties each connection to ONE conversion action, so each has its own URL:
//   /api/ads/voucher.csv, booking.csv, inbox.csv, enquiry.csv (./[file].js)
//   — also /api/ads/conversions?action=voucher|booking|inbox|enquiry
// — a plain CSV (click id, time with UTC offset, value, currency) for mapping.
// Without ?action it serves the classic all-actions upload template instead.
// Every sale or enquiry from the last 90 days that
// arrived through an ad click (a stored gclid) becomes one row. Re-sending a
// row Google already has is harmless: it is rejected as a duplicate, never
// counted twice.
//
// Value = what the platform keeps, so Google bids on real income, not turnover:
//   UKBT gift voucher sale     20% of the order, less any refunds
//   UKBT booking payment       the Connect fee actually collected (deposit,
//                              balance and extra payments each count)
//   UKBT inbox payment         20% of a /pay-now payment
//   UKBT group enquiry         no value — a secondary, early signal only
// The conversion names must match the conversion actions in Google Ads exactly.

import { safeEqual } from '../../_lib/stripe.js';

const SHARE = 0.2;
// Setup window for the sample row (see below). Closed once the four connections
// existed (21 Oct 2026); move it forward to add or re-map a connection.
const SAMPLE_UNTIL = Date.parse('2026-10-21T18:30:00Z');
const NAMES = {
  voucher: 'UKBT gift voucher sale',
  booking: 'UKBT booking payment',
  inbox: 'UKBT inbox payment',
  enquiry: 'UKBT group enquiry',
};

// D1 stores UTC 'YYYY-MM-DD HH:MM:SS'; Google wants local time plus the zone
// named in the Parameters row.
const londonFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});
function londonTime(utc) {
  const p = Object.fromEntries(londonFmt.formatToParts(new Date(utc.replace(' ', 'T') + 'Z')).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

const pounds = pence => (Math.max(0, pence) / 100).toFixed(2);

function authorised(request, env) {
  const m = /^Basic\s+(.+)$/i.exec(request.headers.get('authorization') || '');
  if (!m || !env.ADS_FEED_PASSWORD) return false;
  let decoded = '';
  try { decoded = atob(m[1]); } catch { return false; }
  return safeEqual(decoded, `googleads:${env.ADS_FEED_PASSWORD}`);
}

export function onRequestGet({ request, env }) {
  return conversionsFeed(request, env, new URL(request.url).searchParams.get('action'));
}

// Shared with ./[file].js, which serves the same per-action feed as
// /api/ads/<action>.csv — Data manager only accepts URLs ending in .csv.
export async function conversionsFeed(request, env, action) {
  if (!env.ADS_FEED_PASSWORD) return new Response('Feed not configured.', { status: 503 });
  if (!authorised(request, env)) {
    return new Response('Unauthorised', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="ads"' } });
  }

  const since = "datetime('now','-90 days')";
  const [vouchers, bookings, inbox, enquiries] = await env.DB.batch([
    env.DB.prepare(
      `SELECT o.gclid, o.paid_at AS at,
              o.total_pence - COALESCE((SELECT SUM(r.amount_pence) FROM refunds r WHERE r.order_id = o.id), 0) AS pence
         FROM orders o
        WHERE o.status = 'paid' AND o.is_demo = 0 AND o.gclid IS NOT NULL AND o.paid_at > ${since}`,
    ),
    // Booking payments carry no click id themselves: it comes from the enquiry
    // they were raised from, else the latest ad-click enquiry from the same email.
    env.DB.prepare(
      `SELECT COALESCE(e.gclid,
                (SELECT x.gclid FROM enquiries x
                  WHERE x.gclid IS NOT NULL AND lower(x.email) = lower(p.client_email) AND x.created_at <= p.paid_at
                  ORDER BY x.created_at DESC LIMIT 1)) AS gclid,
              p.paid_at AS at, COALESCE(p.fee_collected_pence, p.fee_pence, 0) AS pence
         FROM payment_requests p LEFT JOIN enquiries e ON e.id = p.enquiry_id
        WHERE p.status = 'paid' AND COALESCE(p.is_test, 0) = 0 AND p.paid_at > ${since}`,
    ),
    env.DB.prepare(
      `SELECT e.gclid, i.paid_at AS at, i.amount_pence AS pence
         FROM inbox_payments i JOIN enquiries e ON e.id = i.enquiry_id
        WHERE i.status = 'paid' AND e.gclid IS NOT NULL AND i.paid_at > ${since}`,
    ),
    env.DB.prepare(
      `SELECT gclid, created_at AS at FROM enquiries
        WHERE gclid IS NOT NULL AND type IN ('group', 'booking') AND created_at > ${since}`,
    ),
  ]);

  const rows = [];
  const add = (r, kind, value) => {
    if (r.gclid && r.at) rows.push({ kind, gclid: r.gclid, at: r.at, value });
  };
  for (const r of vouchers.results) if (r.pence > 0) add(r, 'voucher', pounds(Math.round(r.pence * SHARE)));
  for (const r of bookings.results) if (r.pence > 0) add(r, 'booking', pounds(r.pence));
  for (const r of inbox.results) if (r.pence > 0) add(r, 'inbox', pounds(Math.round(r.pence * SHARE)));
  for (const r of enquiries.results) add(r, 'enquiry', '');

  if (action && !NAMES[action]) return new Response('Unknown action.', { status: 404 });

  // Data manager will not set up a connection to a file with no data rows. Until
  // SAMPLE_UNTIL an empty per-action feed carries one sample row so its columns
  // can be mapped; Google rejects the made-up click id, so it never counts.
  if (action && Date.now() < SAMPLE_UNTIL && !rows.some(r => r.kind === action)) {
    rows.push({ kind: action, gclid: 'SAMPLE_ROW_FOR_SETUP_ONLY', at: new Date(Date.now() - 36e5).toISOString().slice(0, 19).replace('T', ' '), value: action === 'enquiry' ? '' : '1.00' });
  }

  const currency = v => (v === '' ? '' : 'GBP');
  const csv = (action
    ? [
      'Google Click ID,Conversion Time,Conversion Value,Conversion Currency',
      ...rows.filter(r => r.kind === action)
        .map(r => [r.gclid, `${r.at}+00:00`, r.value, currency(r.value)].join(',')),
    ]
    : [
      'Parameters:TimeZone=Europe/London',
      'Google Click ID,Conversion Name,Conversion Time,Conversion Value,Conversion Currency',
      ...rows.map(r => [r.gclid, NAMES[r.kind], londonTime(r.at), r.value, currency(r.value)].join(',')),
    ]).join('\n') + '\n';

  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}
