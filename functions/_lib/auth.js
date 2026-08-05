// Admin auth: PBKDF2 password hashing + HMAC-signed session cookies.
// Uses only Web Crypto, which is native to the Workers runtime (no npm deps).

const enc = new TextEncoder();
const ITERATIONS = 150000;
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
    { name: 'PBKDF2', salt: enc.encode(salt), iterations, hash: 'SHA-256' },
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
