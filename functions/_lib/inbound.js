// Helpers for inbound email (functions/api/inbound-email.js).

/**
 * Verify a Svix-signed webhook (Resend uses Svix).
 * Signs `${svix-id}.${svix-timestamp}.${rawBody}` with HMAC-SHA256, keyed by the
 * base64 body of the whsec_ secret, compared base64 against each v1 signature.
 */
export async function verifySvix(request, rawBody, secret) {
  const id = request.headers.get('svix-id');
  const ts = request.headers.get('svix-timestamp');
  const sigHeader = request.headers.get('svix-signature');
  if (!id || !ts || !sigHeader || !secret) return false;

  // Replay window: a captured request stops being accepted after five minutes.
  const age = Math.abs(Date.now() / 1000 - Number(ts));
  if (!Number.isFinite(age) || age > 300) return false;

  const keyB64 = secret.startsWith('whsec_') ? secret.slice(6) : secret;
  let keyBytes;
  try {
    keyBytes = Uint8Array.from(atob(keyB64), c => c.charCodeAt(0));
  } catch {
    return false;
  }
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${ts}.${rawBody}`));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));

  let ok = false;
  for (const part of sigHeader.split(' ')) {
    const [version, value] = part.split(',');
    if (version !== 'v1' || !value) continue;
    // Constant-time-ish: compare every candidate, never break early.
    ok = safeEqual(value, expected) || ok;
  }
  return ok;
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** "Jane Smith <jane@example.com>" → { name, email }. */
export function parseAddress(value) {
  const raw = String(value || '').trim();
  const m = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  const email = (m ? m[2] : raw).trim().toLowerCase();
  let name = (m ? m[1] : '').trim();
  if (!name) name = email.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  return { name: name.slice(0, 100), email: email.slice(0, 200) };
}

/** The conversation token out of reply-<32 hex>@anything, from any recipient field. */
export function tokenFromRecipients(...fields) {
  for (const field of fields.flat()) {
    const m = /reply-([0-9a-f]{32})@/i.exec(String(field || ''));
    if (m) return m[1].toLowerCase();
  }
  return null;
}

/**
 * Trim the quoted history off a reply. Conservative: it only cuts at markers
 * that begin a line, and keeps everything if that would leave nothing.
 */
export function stripQuoted(text) {
  const body = String(text || '').replace(/\r\n/g, '\n');
  const markers = [
    /^On .{0,200}\bwrote:\s*$/im,
    /^-{2,}\s*Original Message\s*-{2,}\s*$/im,
    /^_{10,}\s*$/m,
    /^From:\s.+$/im,
    /^Sent from my \w+/im,
    /^>.*$/m,
  ];
  let cut = body.length;
  for (const re of markers) {
    const m = re.exec(body);
    if (m && m.index < cut) cut = m.index;
  }
  const trimmed = body.slice(0, cut).trim();
  return trimmed.length >= 2 ? trimmed : body.trim();
}

/** Plain text from an HTML body, for senders that only send HTML. */
export function htmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Automated mail that should never open or reopen a conversation. */
export function isAutomated(headers = {}, from = '') {
  const get = k => {
    const hit = Object.entries(headers || {}).find(([name]) => name.toLowerCase() === k);
    return hit ? String(hit[1] || '') : '';
  };
  if (get('auto-submitted') && get('auto-submitted').toLowerCase() !== 'no') return true;
  if (get('x-autoreply') || get('x-autorespond')) return true;
  if (/^(bulk|list|junk)$/i.test(get('precedence'))) return true;
  if (get('list-unsubscribe')) return true;
  return /^(mailer-daemon|no-?reply|postmaster|bounce)/i.test(String(from || ''));
}
