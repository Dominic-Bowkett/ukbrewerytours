// Admin auth: PBKDF2 password hashing + HMAC-signed session cookies.
// Uses only Web Crypto, which is native to the Workers runtime (no npm deps).

const enc = new TextEncoder();
// The Workers runtime rejects PBKDF2 above 100k iterations, so this is the ceiling.
const ITERATIONS = 100000;
const COOKIE_NAME = 'ubt_admin';
const SESSION_HOURS = 12;

function toHex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time string compare — avoids leaking match position via timing. */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function hashPassword(password, salt, iterations = ITERATIONS) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    // Clamped: a stored value above the runtime cap would throw instead of failing the login.
    { name: 'PBKDF2', salt: enc.encode(salt), iterations: Math.min(iterations, ITERATIONS), hash: 'SHA-256' },
    key,
    256,
  );
  return toHex(bits);
}

export async function verifyPassword(password, user) {
  const hash = await hashPassword(password, user.password_salt, user.iterations || ITERATIONS);
  return safeEqual(hash, user.password_hash);
}

// base64url helpers (cookie-safe, no padding)
const b64url = s => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlDecode = s => atob(s.replace(/-/g, '+').replace(/_/g, '/'));

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

export async function createSession(user, secret) {
  const payload = b64url(JSON.stringify({
    uid: user.id,
    email: user.email,
    exp: Date.now() + SESSION_HOURS * 3600 * 1000,
  }));
  return `${payload}.${await hmac(secret, payload)}`;
}

export async function verifySession(token, secret) {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  if (!safeEqual(sig, await hmac(secret, payload))) return null;
  try {
    const data = JSON.parse(b64urlDecode(payload));
    if (!data.exp || Date.now() > data.exp) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * Signed token letting a customer view their own vouchers without logging in.
 * Bound to the order id, so it grants access to that order and nothing else.
 * No expiry: vouchers never expire, so the link in their email must keep working.
 */
export async function orderToken(orderId, secret) {
  return (await hmac(secret, `order:${orderId}`)).slice(0, 32);
}

export async function verifyOrderToken(orderId, token, secret) {
  if (!orderId || !token) return false;
  return safeEqual(token, await orderToken(orderId, secret));
}

export function sessionCookie(token, { secure = true } = {}) {
  const maxAge = SESSION_HOURS * 3600;
  return `${COOKIE_NAME}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

export function clearCookie({ secure = true } = {}) {
  return `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

export function readCookie(request) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE_NAME) return v.join('=');
  }
  return null;
}

/** True when the request is over plain http (local `wrangler pages dev`). */
export function isInsecure(request) {
  return new URL(request.url).protocol === 'http:';
}
