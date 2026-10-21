// Ad attribution sent up by the browser. The loaders (embed/chat.js,
// embed/voucher.js) remember the last ad click for 90 days and pass it along as
// a query string, e.g. "gclid=Cj0K…&utm_source=google&landing=https://…&ts=…".
// Everything is untrusted, so each value is whitelisted and length-capped.

const CLICK_ID = /^[A-Za-z0-9_\-]{10,200}$/;
const UTM = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];

/**
 * @param {string|object} raw  query string (or plain object) from the browser
 * @returns {{gclid:string|null, gbraid:string|null, wbraid:string|null, attribution:string|null}}
 */
export function cleanAttr(raw) {
  const empty = { gclid: null, gbraid: null, wbraid: null, attribution: null };
  let q;
  try {
    q = new URLSearchParams(typeof raw === 'string' ? raw.slice(0, 2000) : (raw || {}));
  } catch {
    return empty;
  }

  const id = k => {
    const v = (q.get(k) || '').trim();
    return CLICK_ID.test(v) ? v : null;
  };
  const out = { gclid: id('gclid'), gbraid: id('gbraid'), wbraid: id('wbraid'), attribution: null };

  const extra = {};
  for (const k of UTM) {
    const v = (q.get(k) || '').trim().slice(0, 150);
    if (v) extra[k] = v;
  }
  try {
    const u = new URL(q.get('landing') || '');
    if (u.protocol === 'https:' || u.protocol === 'http:') extra.landing = (u.origin + u.pathname).slice(0, 300);
  } catch { /* no landing page */ }
  const ts = Number(q.get('ts'));
  // Only a plausible past click time (within the 90-day window) is kept.
  if (Number.isFinite(ts) && ts > Date.now() - 91 * 864e5 && ts <= Date.now() + 864e5) {
    extra.clicked_at = new Date(ts).toISOString();
  }

  if (Object.keys(extra).length) out.attribution = JSON.stringify(extra);
  return out;
}
