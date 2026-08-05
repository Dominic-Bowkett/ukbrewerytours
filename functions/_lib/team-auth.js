// Team auth for /team/ — deliberately NOT interchangeable with the admin session
// in _lib/auth.js. Same primitives (Web Crypto only, zero npm deps, PBKDF2 capped
// at the 100k the Workers runtime accepts), different key, different signed
// message, different cookie, different table, different audience.
//
// ---------------------------------------------------------------------------
// WHY A TEAM TOKEN CANNOT SATISFY THE ADMIN GATE
// ---------------------------------------------------------------------------
// The separation must not rest on two environment variables happening to hold
// different strings — that is one mistake in the Cloudflare dashboard away from
// collapsing, with no code anywhere that would notice. Four independent
// separations are in force, and the first two hold even if TEAM_SESSION_SECRET
// and ADMIN_SESSION_SECRET are set to the SAME value:
//
//  1. AUDIENCE, inside the signed payload. Every team token carries
//     aud:'ubt.team' and verifyTeamSession() rejects anything else. Admin tokens
//     carry no aud at all, so they fail here too. This claim is covered by the
//     signature, so it cannot be edited by the holder.
//
//  2. DOMAIN-SEPARATED HMAC MESSAGE. The team signature covers
//     'ubt.team.session.v1|' + payload, never the bare payload. '|' and '.' are
//     outside the base64url alphabet, so no admin payload can ever equal a
//     prefixed team message: the two signed-message spaces are provably
//     disjoint. _lib/auth.js verifySession() computes hmac(secret, payload) and
//     compares it to our signature over a different message — it cannot match,
//     whatever the secrets are. This is the guarantee that survives
//     misconfiguration, and it is why the aud check is belt to its braces.
//
//  3. TOKEN SHAPE. Team tokens are 't1.<payload>.<sig>' (three segments).
//     _lib/auth.js splits on '.' and takes the first two parts, so it would try
//     to verify the literal 't1' against our payload. Structurally hopeless.
//
//  4. COOKIE NAME. readCookie() in _lib/auth.js only ever looks for 'ubt_admin';
//     ours is '__Host-ubt_team'. A team credential is never even presented to
//     the admin gate. (Listed last on purpose: an attacker controls their own
//     cookie names, so this one is convenience, not security.)
//
// Recommended follow-up, not required for the above to hold: add aud:'ubt.admin'
// to createSession()/verifySession() in _lib/auth.js so the admin side is
// positively typed as well as negatively excluded.
//
// ---------------------------------------------------------------------------
// WHAT THE TOKEN IS ALLOWED TO CARRY
// ---------------------------------------------------------------------------
// Nothing authorisation-relevant. Only {aud, tmid, tv, sid, iat, exp}. The
// member's active flag, Stripe account, charge-readiness and fee are re-read
// from D1 on every request by functions/api/team/_middleware.js, so a token
// minted before a change can never widen access. `tv` is the session_epoch and
// is what makes a stateless token revocable: admin bumps it, and the very next
// request from every outstanding session for that member fails.

import { hashPassword, isInsecure } from './auth.js';

const enc = new TextEncoder();

/* ------------------------------------------------------------------ tunables */

const SESSION_HOURS = 8;                       // shorter than admin's 12: it moves money
const TOKEN_PREFIX = 't1';
const TEAM_AUD = 'ubt.team';
const SESSION_DOMAIN = 'ubt.team.session.v1|'; // HMAC domain separation (see header)
const PEPPER_DOMAIN = 'ubt.team.pw.v1|';
const COOKIE = 'ubt_team';                     // http, local `wrangler pages dev` only
const COOKIE_HOST = '__Host-ubt_team';         // https — pins Path=/ and Secure, no subdomain writes

// The Workers runtime rejects PBKDF2 above 100k iterations, so this is the
// ceiling and the honest value to store. hashPassword() in _lib/auth.js clamps
// to the same number on both write and read.
export const TEAM_ITERATIONS = 100000;
export const ALGO_PEPPERED = 'pbkdf2-sha256-p1';
export const ALGO_LEGACY = 'pbkdf2-sha256';

// Login throttling. Keyed on ip+email and on ip, never on the member.
const THROTTLE_WINDOW_SECONDS = 900;
const PAIR_BLOCK_AFTER = 12;                   // failures from one ip+email pair
const IP_BLOCK_AFTER = 60;                     // failures from one ip across all addresses
const BLOCK_SECONDS = 900;
const ATTEMPT_TTL_SECONDS = 86400;

/* ---------------------------------------------------------------- primitives */

function toHex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Constant-time string compare. Returns false for a length mismatch, which is
 * fine: the lengths compared here (hex digests, base64url signatures, algorithm
 * names) are fixed and public.
 */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacHex(secret, data) {
  // Never let an unset secret reach here: enc.encode(undefined) keys the HMAC
  // with the literal bytes "undefined", a key every attacker knows.
  if (typeof secret !== 'string' || secret === '') throw new Error('hmac: missing secret');
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return toHex(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

// base64url (cookie-safe, no padding). The payload is ASCII-only by construction
// — digits and short fixed strings — so btoa is safe here.
const b64url = s => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlDecode = s => atob(s.replace(/-/g, '+').replace(/_/g, '/'));

function randomHex(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return toHex(buf);
}

/* --------------------------------------------------------------- config gate */

/**
 * Fail closed, loudly and in one place. Returns a short reason string when the
 * team area must refuse to operate, or null when it is safe to proceed.
 *
 * The secret-reuse check is the important one. If TEAM_SESSION_SECRET were ever
 * set to the same value as ADMIN_SESSION_SECRET, the domain-separated message
 * above still keeps the two token spaces disjoint — but a shared secret is a
 * mistake we should refuse to run on rather than quietly tolerate.
 */
export function teamAuthConfigError(env) {
  const secret = env.TEAM_SESSION_SECRET;
  if (typeof secret !== 'string' || secret.length < 32) return 'TEAM_SESSION_SECRET missing or too short';
  if (typeof env.TEAM_PASSWORD_PEPPER !== 'string' || env.TEAM_PASSWORD_PEPPER.length < 32) {
    return 'TEAM_PASSWORD_PEPPER missing or too short';
  }
  if (safeEqual(secret, env.ADMIN_SESSION_SECRET || '')) return 'TEAM_SESSION_SECRET must not equal ADMIN_SESSION_SECRET';
  return null;
}

/* ------------------------------------------------------------------ sessions */

/**
 * Mint a team session token.
 *
 * @param {{id:number, session_epoch:number}} member  a freshly read team_members row
 */
export async function createTeamSession(member, env) {
  const problem = teamAuthConfigError(env);
  if (problem) throw new Error(`team session: ${problem}`);
  if (!Number.isInteger(member?.id) || member.id <= 0) throw new Error('team session: bad member id');

  const now = Date.now();
  const payload = b64url(JSON.stringify({
    aud: TEAM_AUD,                     // checked on every request; covered by the signature
    tmid: member.id,
    tv: normaliseTokenVersion(member.session_epoch),
    sid: randomHex(8),                 // session id, for log correlation only
    iat: now,
    exp: now + SESSION_HOURS * 3600 * 1000,
  }));
  const sig = await hmacHex(env.TEAM_SESSION_SECRET, SESSION_DOMAIN + payload);
  return `${TOKEN_PREFIX}.${payload}.${sig}`;
}

/**
 * Verify a team session token. Returns {teamMemberId, tokenVersion, sid, exp} or
 * null. Every rejection is silent and identical to the caller.
 */
export async function verifyTeamSession(token, env) {
  if (teamAuthConfigError(env)) return null;             // fail closed
  if (typeof token !== 'string' || token.length < 16 || token.length > 4096) return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [prefix, payload, sig] = parts;
  if (prefix !== TOKEN_PREFIX || !payload || !sig) return null;

  let expected;
  try {
    expected = await hmacHex(env.TEAM_SESSION_SECRET, SESSION_DOMAIN + payload);
  } catch {
    return null;
  }
  if (!safeEqual(sig, expected)) return null;

  try {
    const d = JSON.parse(b64urlDecode(payload));
    // The audience claim. A token that does not positively assert it is a team
    // token is not one, whatever else it says.
    if (d.aud !== TEAM_AUD) return null;
    if (!Number.isInteger(d.tmid) || d.tmid <= 0) return null;
    if (!Number.isInteger(d.tv) || d.tv < 1) return null;
    if (!Number.isInteger(d.exp) || Date.now() > d.exp) return null;
    return {
      teamMemberId: d.tmid,
      tokenVersion: d.tv,
      sid: typeof d.sid === 'string' ? d.sid : null,
      exp: d.exp,
    };
  } catch {
    return null;
  }
}

function normaliseTokenVersion(v) {
  return Number.isInteger(v) && v >= 1 ? v : 1;
}

/* -------------------------------------------------------------------- cookie */

// Over https only the __Host- name is written or read, so the relaxed dev name
// can never be smuggled in from production.
function cookieName(request) {
  return isInsecure(request) ? COOKIE : COOKIE_HOST;
}

export function teamSessionCookie(request, token) {
  const secure = !isInsecure(request);
  return `${cookieName(request)}=${token}; HttpOnly; Path=/; SameSite=Lax; `
    + `Max-Age=${SESSION_HOURS * 3600}${secure ? '; Secure' : ''}`;
}

export function clearTeamCookie(request) {
  const secure = !isInsecure(request);
  return `${cookieName(request)}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

export function readTeamCookie(request) {
  const wanted = cookieName(request);
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === wanted) return v.join('=');
  }
  return null;
}

/* --------------------------------------------------------------- CSRF / CORS */

/**
 * SameSite=Lax already blocks cross-site POSTs, but this area moves money, so
 * mutations are checked twice. Unlike a permissive "no Origin header means not a
 * browser" rule, a state-changing request that presents NEITHER Sec-Fetch-Site
 * nor Origin is refused: every browser that can reach this endpoint sends at
 * least one, and there is no non-browser client of /api/team/*.
 */
export function isSameOrigin(request) {
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite) return fetchSite === 'same-origin' || fetchSite === 'none';
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ password */

function clampIterations(v) {
  const n = Number.isInteger(v) && v > 0 ? v : TEAM_ITERATIONS;
  return Math.min(n, TEAM_ITERATIONS);
}

/**
 * PBKDF2 cannot be raised above 100k here, which is not much work for an offline
 * attacker. Since the iteration count is fixed, the password is first HMAC'd
 * with a pepper held in Cloudflare secrets and never written to D1 — so a stolen
 * database dump on its own is not crackable.
 */
export async function hashTeamPassword(password, salt, env, { peppered = true, iterations = TEAM_ITERATIONS } = {}) {
  const input = peppered
    ? await hmacHex(env.TEAM_PASSWORD_PEPPER, PEPPER_DOMAIN + password)
    : password;
  return hashPassword(input, salt, clampIterations(iterations));
}

/**
 * Burned when the email is unknown so that a missing account costs the same two
 * KDF runs as a real one. The hash is 64 hex chars, matching a real digest, so
 * safeEqual compares the full length rather than bailing on a length mismatch.
 */
export const DUMMY_MEMBER = Object.freeze({
  password_hash: '0'.repeat(64),
  password_salt: 'ubt-team-timing-equaliser',
  iterations: TEAM_ITERATIONS,
  algo: ALGO_PEPPERED,
});

/**
 * Verify a password in constant work, with NO short-circuit on an algorithm
 * mismatch.
 *
 * Both candidate digests are always derived — peppered and legacy — and the
 * choice between them is made with bitwise arithmetic on 0/1 flags rather than a
 * branch. An early `if (member.algo !== ALGO) return false` would be worse than
 * useless here: with a legacy or NULL algo it would return in microseconds for a
 * real member while the dummy row still ran the full KDF, turning the timing
 * equaliser into an account-enumeration oracle running backwards.
 *
 * @returns {{ok: boolean, needsUpgrade: boolean}} needsUpgrade marks a correct
 *   password that verified under the legacy scheme and should be re-hashed.
 */
export async function verifyTeamPassword(password, member, env) {
  if (teamAuthConfigError(env)) throw new Error('verifyTeamPassword: team auth is not configured');

  const row = member || DUMMY_MEMBER;
  const salt = typeof row.password_salt === 'string' && row.password_salt
    ? row.password_salt : DUMMY_MEMBER.password_salt;
  const stored = typeof row.password_hash === 'string' && row.password_hash.length === 64
    ? row.password_hash : DUMMY_MEMBER.password_hash;
  const iterations = clampIterations(row.iterations);
  const pw = typeof password === 'string' ? password : '';

  // Always both. Same work on every path: unknown email, wrong password, legacy
  // row, peppered row, corrupt algo column.
  const pepperedHash = await hashTeamPassword(pw, salt, env, { peppered: true, iterations });
  const legacyHash = await hashTeamPassword(pw, salt, env, { peppered: false, iterations });

  const matchesPeppered = safeEqual(pepperedHash, stored) ? 1 : 0;
  const matchesLegacy = safeEqual(legacyHash, stored) ? 1 : 0;

  const algo = typeof row.algo === 'string' ? row.algo : '';
  const isPeppered = safeEqual(algo, ALGO_PEPPERED) ? 1 : 0;
  const isLegacy = safeEqual(algo, ALGO_LEGACY) ? 1 : 0;
  const present = member ? 1 : 0;

  // Bitwise, not `&&` — no operand is skipped, so no path is shorter than another.
  const ok = ((matchesPeppered & isPeppered) | (matchesLegacy & isLegacy)) & present;
  return { ok: ok === 1, needsUpgrade: (ok & isLegacy) === 1 };
}

/**
 * Re-hash a correct legacy password under the peppered scheme. Guarded on the
 * stored algo so two concurrent logins cannot fight, and deliberately does NOT
 * bump session_epoch: the password has not changed, so live sessions stand.
 */
export async function upgradeTeamPasswordHash(env, { memberId, password }) {
  const salt = randomHex(16);
  const hash = await hashTeamPassword(password, salt, env, { peppered: true, iterations: TEAM_ITERATIONS });
  const res = await env.DB.prepare(
    `UPDATE team_members
        SET password_hash = ?, password_salt = ?, iterations = ?, algo = ?,
            updated_at = datetime('now')
      WHERE id = ? AND algo = ?`,
  ).bind(hash, salt, TEAM_ITERATIONS, ALGO_PEPPERED, memberId, ALGO_LEGACY).run();
  return res.meta.changes === 1;
}

/* ----------------------------------------------------------- charge-readiness */

/**
 * May this member reach a route that can move money?
 *
 * charges_enabled ALONE is not enough. A Standard connected account can keep
 * charges_enabled = 1 while the platform_payments capability goes inactive:
 * ordinary charges still work and only application_fee_amount is refused — which
 * is precisely the call every payment request makes. The account state catches
 * the other half, a member clicking "Disconnect" in their own Stripe dashboard,
 * which leaves charges_enabled untouched and would otherwise be invisible.
 *
 * Lives here rather than in the middleware so /api/team/me and the gate answer
 * from one definition and can never disagree about whether a member may trade.
 */
export function isChargeReady(member) {
  return Boolean(member)
    && member.active === 1
    && typeof member.stripe_account_id === 'string'
    && member.stripe_account_id.startsWith('acct_')
    && member.stripe_charges_enabled === 1
    && member.stripe_platform_payments === 1
    && member.stripe_account_state === 'active';
}

/* ------------------------------------------------------------ login throttle */

const nowSeconds = () => Math.floor(Date.now() / 1000);

export function clientIp(request) {
  return request.headers.get('CF-Connecting-IP')
    || request.headers.get('x-forwarded-for')?.split(',')[0].trim()
    || 'unknown';
}

/**
 * Throttle keys. BOTH contain the client IP, which is the whole point: a block
 * can never be aimed at a member by someone who merely knows their email
 * address. The pair key throttles credential stuffing against one account from
 * one source; the ip key throttles spraying across many accounts from one source.
 * Keys are keyed hashes so the table holds no raw addresses.
 */
export async function loginAttemptKeys(env, request, email) {
  const ip = clientIp(request);
  const secret = env.TEAM_SESSION_SECRET;
  const [pair, addr] = await Promise.all([
    hmacHex(secret, `login.pair.v1|${ip}|${email}`),
    hmacHex(secret, `login.ip.v1|${ip}`),
  ]);
  return { pair: pair.slice(0, 32), ip: addr.slice(0, 32) };
}

/**
 * Read both counters. Returns the block state and the pair's failure count,
 * which is what drives the response delay — taking the delay from the ip+email
 * counter rather than from the member row is deliberate, because that counter
 * exists whether or not the email belongs to anybody, so the wait cannot be used
 * to tell a real address from a made-up one.
 */
export async function readLoginAttempts(env, keys) {
  const now = nowSeconds();
  let rows = [];
  try {
    const res = await env.DB.prepare(
      'SELECT attempt_key, failures, window_start, blocked_until FROM team_login_attempts WHERE attempt_key IN (?, ?)',
    ).bind(keys.pair, keys.ip).all();
    rows = res.results || [];
  } catch {
    // A throttle-table outage must not become a login outage; the per-request
    // KDF cost is still a meaningful brake.
    return { blocked: false, retryAfter: 0, pairFailures: 0 };
  }

  const pick = k => rows.find(r => r.attempt_key === k) || null;
  const pairRow = pick(keys.pair);
  const ipRow = pick(keys.ip);

  let retryAfter = 0;
  for (const row of [pairRow, ipRow]) {
    if (row?.blocked_until && row.blocked_until > now) {
      retryAfter = Math.max(retryAfter, row.blocked_until - now);
    }
  }

  const fresh = pairRow && pairRow.window_start > now - THROTTLE_WINDOW_SECONDS;
  return {
    blocked: retryAfter > 0,
    retryAfter,
    pairFailures: fresh ? (pairRow.failures | 0) : 0,
  };
}

/**
 * Exponential delay on failure — never a hard lock on the member. With the
 * ~100-bit generated passwords this system issues, throttling only has to make
 * guessing infeasible, not punish the person who actually holds the password.
 * Capped so a Worker never sits on a request.
 */
export function failureDelayMs(pairFailures) {
  const n = Number.isInteger(pairFailures) && pairFailures > 0 ? pairFailures : 0;
  if (n < 2) return 0;
  return Math.min(125 * 2 ** (n - 1), 2000);
}

/** One upsert per key, in a single implicit transaction. */
export async function recordLoginFailure(env, keys) {
  const now = nowSeconds();
  const cutoff = now - THROTTLE_WINDOW_SECONDS;
  const statement = (key, threshold) => env.DB.prepare(
    `INSERT INTO team_login_attempts (attempt_key, failures, window_start, blocked_until, updated_at)
     VALUES (?, 1, ?, NULL, ?)
     ON CONFLICT(attempt_key) DO UPDATE SET
       failures = CASE WHEN team_login_attempts.window_start < ?
                       THEN 1 ELSE team_login_attempts.failures + 1 END,
       window_start = CASE WHEN team_login_attempts.window_start < ?
                          THEN ? ELSE team_login_attempts.window_start END,
       blocked_until = CASE
           WHEN (CASE WHEN team_login_attempts.window_start < ?
                      THEN 1 ELSE team_login_attempts.failures + 1 END) >= ?
           THEN ? ELSE team_login_attempts.blocked_until END,
       updated_at = ?`,
  ).bind(key, now, now, cutoff, cutoff, now, cutoff, threshold, now + BLOCK_SECONDS, now);

  const batch = [
    statement(keys.pair, PAIR_BLOCK_AFTER),
    statement(keys.ip, IP_BLOCK_AFTER),
  ];

  // Opportunistic pruning, roughly one login failure in fifty. Cheaper than a
  // cron for a table that only grows under attack.
  const dice = new Uint8Array(1);
  crypto.getRandomValues(dice);
  if (dice[0] < 5) {
    batch.push(env.DB.prepare('DELETE FROM team_login_attempts WHERE updated_at < ?')
      .bind(now - ATTEMPT_TTL_SECONDS));
  }

  try {
    await env.DB.batch(batch);
  } catch {
    /* throttle bookkeeping is best-effort; never fail a login response on it */
  }
}

/** Clear on success, so an honest member's own IP pair resets immediately. */
export async function clearLoginAttempts(env, keys) {
  try {
    await env.DB.prepare('DELETE FROM team_login_attempts WHERE attempt_key IN (?, ?)')
      .bind(keys.pair, keys.ip).run();
  } catch {
    /* best-effort */
  }
}

/* ------------------------------------------------------------------ ownership */

// Ownership is structural, not a habit. There is no unscoped read helper and no
// generic update helper: an id on its own is never sufficient authority in
// /team/, and no caller may hand this module a SQL fragment.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// payment_requests.id is a TEXT uuid; clients.id is an INTEGER. Binding a Number
// into a TEXT-affinity primary key silently matches nothing, which reads exactly
// like "not yours" and is how an ownership check gets deleted under pressure.
export const isRequestId = v => typeof v === 'string' && UUID_RE.test(v);
export const isClientId = v => Number.isInteger(v) && v > 0;

/** Identical for "does not exist" and "belongs to someone else", so ids cannot be probed. */
export function notFound() {
  return Response.json({ error: 'Not found.' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
}

const REQUEST_COLUMNS = `id, public_token, team_member_id, client_id, parent_request_id,
  client_name, client_email, tour_name, tour_date, tour_time, tour_details, reference,
  currency, amount_pence, fee_bps, fee_pence, fee_source, fee_frozen_at, terms_snapshot,
  stripe_account_id, member_display_name, status, send_rule, send_rule_days, send_at,
  send_attempts, sent_at, expires_at, reminder_count, viewed_at, view_count,
  stripe_checkout_session_id, stripe_checkout_url, stripe_checkout_expires_at,
  amount_paid_pence, fee_collected_pence, paid_at, refunded_pence, refunded_at,
  cancelled_at, cancel_reason, created_at, updated_at`;

/** Read one payment request that must belong to this member. */
export async function ownedPaymentRequest(env, { id, teamMemberId }) {
  if (!Number.isInteger(teamMemberId)) throw new Error('ownedPaymentRequest: no session member id');
  if (!isRequestId(id)) return null;
  return env.DB.prepare(
    `SELECT ${REQUEST_COLUMNS} FROM payment_requests WHERE id = ? AND team_member_id = ?`,
  ).bind(id, teamMemberId).first();
}

/** Read one address-book client that must belong to this member. */
export async function ownedClient(env, { id, teamMemberId }) {
  if (!Number.isInteger(teamMemberId)) throw new Error('ownedClient: no session member id');
  if (!isClientId(id)) return null;
  return env.DB.prepare(
    `SELECT id, team_member_id, name, email, company, phone, notes,
            request_count, paid_count, total_paid_pence, last_request_at, last_paid_at, created_at
       FROM clients WHERE id = ? AND team_member_id = ?`,
  ).bind(id, teamMemberId).first();
}

// The ONLY columns a /team/ route may write on a payment request, and only while
// it is still a draft. Everything omitted is omitted on purpose:
//   fee_bps, fee_bps_override, fee_pence, fee_source, fee_frozen_at
//       — the platform's cut. fee_bps_override is admin-only; a member who could
//         write it would set their own fee to zero.
//   stripe_account_id, stripe_checkout_*, amount_paid_pence, fee_collected_pence,
//   refunded_pence, paid_at, status, public_token, team_member_id, is_test,
//   created_by, sent_at, send_attempts, claim_id
//       — settlement state and identity. A member who could write team_member_id
//         could hand a request to someone else; one who could write status could
//         mark their own request paid.
const DRAFT_WRITABLE = Object.freeze([
  'client_name', 'client_email', 'tour_name', 'tour_date', 'tour_time',
  'tour_details', 'reference', 'client_id', 'amount_pence',
  'send_rule', 'send_rule_days', 'send_at',
]);
const DRAFT_WRITABLE_SET = new Set(DRAFT_WRITABLE);

export { DRAFT_WRITABLE };

/**
 * Edit a draft. The SET clause is assembled ONLY from the allowlist literals
 * above — a caller passes values, never SQL — and every value is bound. An
 * unknown key throws rather than being skipped, so a mass-assignment attempt is
 * a loud 500 and an alert instead of a silent partial write.
 *
 * The status guard is a fixed literal, not a caller-supplied fragment: once a
 * request has been sent, the amount and terms the client is holding are frozen,
 * and the only lawful edit is cancel-and-reissue.
 */
export async function updateOwnedDraftRequest(env, { id, teamMemberId, values }) {
  if (!Number.isInteger(teamMemberId)) throw new Error('updateOwnedDraftRequest: no session member id');
  if (!isRequestId(id)) return false;
  if (!values || typeof values !== 'object') throw new Error('updateOwnedDraftRequest: no values');

  const keys = Object.keys(values);
  for (const k of keys) {
    if (!DRAFT_WRITABLE_SET.has(k)) throw new Error(`updateOwnedDraftRequest: ${k} is not writable from /team/`);
  }
  if (keys.length === 0) return false;

  // `k` here is guaranteed to be one of the frozen literals above.
  const setSql = keys.map(k => `${k} = ?`).join(', ');
  const binds = keys.map(k => values[k]);

  const res = await env.DB.prepare(
    `UPDATE payment_requests
        SET ${setSql}, updated_at = datetime('now')
      WHERE id = ? AND team_member_id = ?
        AND status IN ('draft', 'scheduled', 'failed')`,
  ).bind(...binds, id, teamMemberId).run();
  return res.meta.changes === 1;
}

/**
 * Cancel a request that has NOT yet reached a client. Fully literal SQL.
 *
 * 'sent' is excluded on purpose. A sent request may have a live Stripe Checkout
 * Session against it, and flipping the row to 'cancelled' while that session is
 * still payable is how a real charge lands with nowhere to record it. Cancelling
 * a sent request has to expire the session on the connected account first, which
 * belongs to the Connect layer, not here.
 */
export async function cancelOwnedRequest(env, { id, teamMemberId, reason = null }) {
  if (!Number.isInteger(teamMemberId)) throw new Error('cancelOwnedRequest: no session member id');
  if (!isRequestId(id)) return false;
  const res = await env.DB.prepare(
    `UPDATE payment_requests
        SET status = 'cancelled', cancelled_at = datetime('now'),
            cancel_reason = ?, updated_at = datetime('now')
      WHERE id = ? AND team_member_id = ?
        AND status IN ('draft', 'scheduled', 'failed')`,
  ).bind(reason, id, teamMemberId).run();
  return res.meta.changes === 1;
}

/* ------------------------------------------------------- text in / text out */

/**
 * Normalise a string on the way IN. Strips C0/C1 control characters and Unicode
 * bidi overrides, collapses whitespace, and caps the length. This is hygiene,
 * not an escape: it does not make the value safe to interpolate into HTML.
 */
export function sanitiseTeamText(value, maxLength = 500) {
  if (value === null || value === undefined) return null;
  const cleaned = String(value)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/\r\n?/g, '\n')
    .trim();
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength) : cleaned;
}

/**
 * Escape for HTML text and attribute contexts.
 *
 * MANDATORY for every team-supplied string rendered in the ADMIN dashboard.
 * Stored XSS there is not a defacement, it is a privilege escalation: the admin
 * page runs same-origin with the ubt_admin cookie attached, so one unescaped
 * field lets a team member — a third-party business — drive /api/admin/* as an
 * admin, and every one of the four session separations in this file is bypassed
 * without a single token ever being forged.
 *
 * The fields that carry team- or client-controlled text into admin views:
 *   team_members.name, company_name, stripe_account_label
 *   clients.name, email, company, phone, notes
 *   payment_requests.client_name, client_email, tour_name, tour_details,
 *                    reference, member_display_name, terms_snapshot,
 *                    cancel_reason, last_send_error
 *   payment_request_events.detail, data, actor
 *
 * Prefer textContent / createElement over innerHTML entirely; use this only
 * where an innerHTML template is unavoidable. ' and / are escaped as well as the
 * usual four, so an unquoted attribute cannot be broken out of. Belt to that
 * brace: serve /admin/*, /team/* and /pay/* with
 *   Content-Security-Policy: default-src 'self'; script-src 'self'; object-src 'none';
 *     base-uri 'none'; frame-ancestors 'none'; form-action 'self' https://checkout.stripe.com
 * which requires moving the inline <script> blocks in admin/index.html out to
 * their own files.
 */
export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\//g, '&#47;');
}
