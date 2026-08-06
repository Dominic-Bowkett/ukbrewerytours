// POST /api/team/password — set a new password.
//
// Reachable while must_change_password is set (see ALLOWED_WHEN_BLOCKED in
// _middleware.js), because otherwise a member handed a generated password
// would be locked out of the one route that clears the flag.
//
// Changing the password bumps session_epoch, which invalidates every other
// outstanding session for this member — including one an attacker might hold.

import {
  hashTeamPassword, verifyTeamPassword, TEAM_ITERATIONS, ALGO_PEPPERED,
  createTeamSession, teamSessionCookie, teamAuthConfigError,
} from '../../_lib/team-auth.js';

const MIN_LENGTH = 12;

export async function onRequestPost({ request, env, data }) {
  if (teamAuthConfigError(env)) {
    return Response.json({ error: 'Temporarily unavailable. Please try again.' }, { status: 503 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const current = String(body.current_password ?? '');
  // Trimmed: a generated password is copied by hand, and a trailing space is
  // the most common reason a correct one appears to be wrong.
  const next = String(body.new_password ?? '').trim();

  if (next.length < MIN_LENGTH) {
    return Response.json({ error: `Use at least ${MIN_LENGTH} characters.` }, { status: 400 });
  }
  if (next.length > 200) {
    return Response.json({ error: 'That password is too long.' }, { status: 400 });
  }

  const member = await env.DB.prepare(
    'SELECT id, email, password_hash, password_salt, iterations, algo, session_epoch FROM team_members WHERE id = ?',
  ).bind(data.member.id).first();
  if (!member) return Response.json({ error: 'Not signed in.' }, { status: 401 });

  // Prove they hold the current password: a stolen session alone must not be
  // enough to change it and lock the real member out.
  if (!(await verifyTeamPassword(current, member, env))) {
    return Response.json({ error: 'Your current password is not right.' }, { status: 401 });
  }
  if (current.trim() === next) {
    return Response.json({ error: 'Choose a different password from the current one.' }, { status: 400 });
  }

  const saltBytes = new Uint8Array(16);
  crypto.getRandomValues(saltBytes);
  const salt = [...saltBytes].map(b => b.toString(16).padStart(2, '0')).join('');
  const hash = await hashTeamPassword(next, salt, env);

  await env.DB.prepare(`
    UPDATE team_members
       SET password_hash = ?, password_salt = ?, iterations = ?, algo = ?,
           must_change_password = 0,
           password_changed_at = datetime('now'),
           session_epoch = session_epoch + 1,
           updated_at = datetime('now')
     WHERE id = ?`)
    .bind(hash, salt, TEAM_ITERATIONS, ALGO_PEPPERED, member.id).run();

  // The epoch bump just invalidated this session too, so issue a fresh one
  // rather than bouncing them back to the login page they just came from.
  const fresh = await env.DB.prepare('SELECT id, session_epoch FROM team_members WHERE id = ?')
    .bind(member.id).first();
  const token = await createTeamSession(fresh, env);

  return Response.json(
    { ok: true },
    { headers: { 'Set-Cookie': teamSessionCookie(request, token) } },
  );
}
