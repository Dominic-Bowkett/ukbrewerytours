// POST /api/team/login — exchange credentials for a team session cookie.
//
// Not gated by _middleware.js (see its PUBLIC set), so everything defensive has
// to happen here.
//
// THROTTLING. The block is keyed on an HMAC of (ip + email) and, separately, on
// the ip alone — never on the member row. A lock keyed on the account would let
// anyone who knows Alehunters' work address take the money path offline with ten
// requests every fifteen minutes, and the only recovery would be a password
// reset. Because the key always contains the client IP, a block can only ever
// apply to the address doing the guessing, and a correct password from the real
// member's own connection is never delayed at all: on success the counters are
// cleared and the session is issued.
//
// TIMING. Every failure path costs the same: two full PBKDF2 runs (see
// verifyTeamPassword, which never short-circuits on the stored algorithm), plus
// a floor on the total response time, plus an exponential delay derived from the
// ip+email counter — a counter that exists whether or not the address belongs to
// anybody, so the wait cannot be used to tell a real member from a guess.

import {
  verifyTeamPassword, upgradeTeamPasswordHash, createTeamSession, teamSessionCookie,
  teamAuthConfigError, loginAttemptKeys, readLoginAttempts, recordLoginFailure,
  clearLoginAttempts, failureDelayMs, DUMMY_MEMBER,
} from '../../_lib/team-auth.js';

// Floor on the response time of any failure, so the cheap rejections (no such
// email, inactive member) cannot be told from the expensive one by a stopwatch.
const MIN_FAILURE_MS = 400;

const NO_STORE = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

const sleep = ms => (ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve());

function json(body, status, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...NO_STORE, ...extraHeaders },
  });
}

export async function onRequestPost({ request, env }) {
  const started = Date.now();

  const configProblem = teamAuthConfigError(env);
  if (configProblem) {
    console.error('team login: misconfigured:', configProblem);
    return json({ error: 'The team area is not configured.', code: 'not_configured' }, 503);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid request.' }, 400);
  }

  const email = String(body?.email || '').trim().toLowerCase().slice(0, 254);
  const password = String(body?.password || '').slice(0, 512);

  // One message for a wrong password, an unknown address and a deactivated
  // account, so the form never confirms who has a login.
  const fail = async (pairFailures) => {
    await sleep(Math.max(
      failureDelayMs(pairFailures),
      MIN_FAILURE_MS - (Date.now() - started),
    ));
    return json({ error: 'Incorrect email or password.' }, 401);
  };

  if (!email || !email.includes('@') || !password) return fail(0);

  const keys = await loginAttemptKeys(env, request, email);
  const throttle = await readLoginAttempts(env, keys);

  if (throttle.blocked) {
    // Deliberately does NOT reveal whether the address exists, and applies only
    // to this ip+email pair.
    return json(
      { error: 'Too many attempts from this connection. Please try again shortly.', code: 'throttled' },
      429,
      { 'Retry-After': String(throttle.retryAfter) },
    );
  }

  let member = null;
  try {
    member = await env.DB.prepare(
      `SELECT id, email, name, password_hash, password_salt, iterations, algo,
              active, session_epoch, must_change_password, failed_attempts
         FROM team_members
        WHERE email = ?`,
    ).bind(email).first();
  } catch (err) {
    console.error('team login: member lookup failed', err);
    return json({ error: 'Temporarily unavailable. Please try again.', code: 'unavailable' }, 503);
  }

  // Always run the KDF, even for an unknown address: the dummy row makes a
  // missing account cost exactly the same as a wrong password.
  let ok = false;
  let needsUpgrade = false;
  try {
    ({ ok, needsUpgrade } = await verifyTeamPassword(password, member || null, env));
  } catch (err) {
    console.error('team login: verify failed', err);
    return json({ error: 'Temporarily unavailable. Please try again.', code: 'unavailable' }, 503);
  }
  // Referenced so the dummy row cannot be tree-shaken out of the build.
  void DUMMY_MEMBER;

  if (!member || !ok || member.active !== 1) {
    await recordLoginFailure(env, keys);
    if (member) {
      // Audit only — this counter never gates a login. It exists so an admin can
      // see an account being attacked.
      try {
        await env.DB.prepare(
          `UPDATE team_members
              SET failed_attempts = failed_attempts + 1, last_failed_at = ?
            WHERE id = ?`,
        ).bind(Math.floor(Date.now() / 1000), member.id).run();
      } catch (err) {
        console.error('team login: failure counter write failed', member.id, err);
      }
    }
    return fail(throttle.pairFailures + 1);
  }

  // Correct password. Clear the throttle for this pair and reset the audit
  // counters, then mint the session.
  await clearLoginAttempts(env, keys);

  // A password that verified under the legacy unpeppered scheme is re-hashed in
  // place. session_epoch is deliberately NOT bumped: the password has not
  // changed, so the member's other sessions stand.
  if (needsUpgrade) {
    try {
      await upgradeTeamPasswordHash(env, { memberId: member.id, password });
    } catch (err) {
      console.error('team login: password re-hash failed', member.id, err);
    }
  }

  let token;
  try {
    token = await createTeamSession(member, env);
    await env.DB.prepare(
      `UPDATE team_members
          SET last_login_at = datetime('now'), failed_attempts = 0, last_failed_at = NULL
        WHERE id = ?`,
    ).bind(member.id).run();
  } catch (err) {
    console.error('team login: session mint failed', member.id, err);
    return json({ error: 'Temporarily unavailable. Please try again.', code: 'unavailable' }, 503);
  }

  return json(
    {
      ok: true,
      email: member.email,
      name: member.name,
      // The shell uses this to route straight to the change-password screen.
      mustChangePassword: member.must_change_password === 1,
    },
    200,
    { 'Set-Cookie': teamSessionCookie(request, token) },
  );
}
// Only onRequestPost is exported: Pages answers any other method with 405 by
// itself. Exporting a catch-all onRequest alongside it would just create two
// entry points into the same credential check.
