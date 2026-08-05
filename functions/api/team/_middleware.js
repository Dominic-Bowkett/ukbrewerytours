// Auth gate for every /api/team/* route.
//
// The verified member lands in ctx.data.team / ctx.data.teamMemberId. Nothing
// downstream may take an identity from anywhere else — not from the token body,
// not from a query parameter, not from the request JSON.
//
// Three things happen here that a stateless token cannot do on its own, and all
// three are per-request, not per-login:
//
//   1. AUDIENCE. verifyTeamSession() refuses anything whose signed payload does
//      not claim aud:'ubt.team'. Combined with the domain-separated HMAC message
//      in _lib/team-auth.js, an admin token cannot pass here and a team token
//      cannot pass the admin gate — even if both session secrets were set to the
//      same value, and even if someone copied the cookie under the other name.
//
//   2. REVOCATION. The member row is re-read on every request and its
//      session_epoch compared with the one baked into the token. Admin bumps
//      session_epoch in the same UPDATE that deactivates a member or changes
//      their password, so "sign out everywhere" takes effect on the next
//      request rather than up to eight hours later.
//
//   3. CHARGE-READINESS. active=1 is not enough to reach a money route. The
//      connected account must also be present, charges_enabled, have the
//      platform_payments capability active, and not be restricted or
//      deauthorized — otherwise the member spends the afternoon sending payment
//      requests that no client can pay.

import {
  readTeamCookie, verifyTeamSession, clearTeamCookie, isSameOrigin, teamAuthConfigError,
  isChargeReady,
} from '../../_lib/team-auth.js';

// Reachable without a session. Login mints one; logout only deletes a cookie and
// must keep working for a session that has already been revoked.
const PUBLIC = new Set(['/api/team/login', '/api/team/logout']);

// Reachable with a valid session even when the member cannot currently trade:
// the shell has to be able to say WHY, and a forced password change has to be
// completable.
const ALLOWED_WHEN_BLOCKED = new Set(['/api/team/me', '/api/team/password']);

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

function json(body, status, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...SECURITY_HEADERS, ...extraHeaders },
  });
}

/**
 * 401 + clear the cookie, so a revoked or expired credential stops being resent
 * on every subsequent request. Used ONLY for decisions about the credential
 * itself — never for a transient database failure, which must not log anyone out.
 */
function deny(request, message = 'Not signed in.', code = 'unauthenticated') {
  return json({ error: message, code }, 401, { 'Set-Cookie': clearTeamCookie(request) });
}

export async function onRequest(ctx) {
  const { request, env } = ctx;
  const path = new URL(request.url).pathname.replace(/\/+$/, '') || '/';
  const isRead = request.method === 'GET' || request.method === 'HEAD';

  // Money moves through these routes, so mutations are origin-checked on top of
  // the cookie's SameSite=Lax. Checked before the public bypass, so login and
  // logout are covered too.
  if (!isRead && !isSameOrigin(request)) {
    return json({ error: 'Bad origin.', code: 'bad_origin' }, 403);
  }

  // Fail closed on configuration. A missing or reused team secret means the team
  // area is CLOSED — it never borrows the admin key, and it never degrades to
  // signing with the string "undefined".
  const configProblem = teamAuthConfigError(env);
  if (configProblem) {
    console.error('team auth misconfigured:', configProblem);
    return json({ error: 'The team area is not configured.', code: 'not_configured' }, 503);
  }

  // Login and logout handle themselves; login does its own throttling because
  // this gate never sees it.
  if (PUBLIC.has(path)) return withHeaders(await ctx.next());

  const session = await verifyTeamSession(readTeamCookie(request), env);
  if (!session) return deny(request);

  // Re-read on every request rather than trusting the token. This is what makes
  // deactivation and revocation immediate, and the handlers need the Stripe
  // account and fee anyway, so it is one indexed primary-key read they would
  // have done regardless.
  let member;
  try {
    member = await env.DB.prepare(
      `SELECT id, email, name, company_name, reply_to_email,
              stripe_account_id, stripe_account_label, stripe_charges_enabled,
              stripe_platform_payments, stripe_account_state, stripe_account_checked_at,
              fee_bps, active, session_epoch, must_change_password, last_login_at
         FROM team_members
        WHERE id = ?`,
    ).bind(session.teamMemberId).first();
  } catch (err) {
    // A D1 incident is a temporary outage, not an authentication decision: do
    // not clear the cookie and do not report it as a sign-in failure.
    console.error('team gate: member lookup failed', session.teamMemberId, err);
    return json({ error: 'Temporarily unavailable. Please try again.', code: 'unavailable' }, 503);
  }

  if (!member) return deny(request);
  if (member.active !== 1) return deny(request, 'Your access has been withdrawn.', 'deactivated');

  // Server-side revocation. Any token minted before the bump stops verifying on
  // its very next request, with no session table to keep.
  if ((member.session_epoch | 0) !== session.tokenVersion) {
    return deny(request, 'Please sign in again.', 'session_revoked');
  }

  // A forced password change blocks everything except changing it and asking who
  // you are. Not a 401: the session is valid, the account is simply not usable yet.
  if (member.must_change_password === 1 && !ALLOWED_WHEN_BLOCKED.has(path)) {
    return json({ error: 'Please set a new password before continuing.', code: 'password_change_required' }, 403);
  }

  // Charge-readiness. Blocking here — rather than at send time — means a member
  // whose account has been restricted or disconnected finds out before they have
  // written and scheduled a request, instead of a client discovering it at the
  // moment of payment.
  if (!isChargeReady(member) && !ALLOWED_WHEN_BLOCKED.has(path)) {
    console.warn('team gate: not charge-ready', member.id, member.stripe_account_state, member.stripe_charges_enabled);
    return json({
      error: 'Your Stripe account cannot currently accept payments. Please contact UK Brewery Tours.',
      code: 'account_not_charge_ready',
    }, 403);
  }

  ctx.data.team = member;
  ctx.data.teamMemberId = member.id;   // the ONLY value handlers may scope queries on
  ctx.data.teamSessionId = session.sid;
  ctx.data.teamChargeReady = isChargeReady(member);
  // Admin handlers key off data.user. It stays empty here so that a team request
  // reaching one by any routing accident is unauthenticated rather than admin.
  ctx.data.user = undefined;

  return withHeaders(await ctx.next());
}

function withHeaders(res) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  return out;
}
