// POST /api/team/setup  { token, password }
//
// Redeems a one-time set-up link (see _lib/team-setup.js): sets the member's
// own password, clears the link, cuts any other session and signs them in.
// Public by necessity (they have no password yet) — the 256-bit token is the
// credential, and it works once, before it expires, for an active member.

import {
  hashTeamPassword, TEAM_ITERATIONS, ALGO_PEPPERED,
  createTeamSession, teamSessionCookie, teamAuthConfigError,
} from '../../_lib/team-auth.js';
import { sha256Hex } from '../../_lib/team-setup.js';

const MIN_LENGTH = 12;

export async function onRequestPost({ request, env }) {
  if (teamAuthConfigError(env)) {
    return Response.json({ error: 'Temporarily unavailable. Please try again.' }, { status: 503 });
  }
  let body;
  try { body = await request.json(); } catch { return Response.json({ error: 'Invalid request.' }, { status: 400 }); }

  const token = String(body.token ?? '').trim().toLowerCase();
  const password = String(body.password ?? '').trim();
  if (!/^[0-9a-f]{64}$/.test(token)) return Response.json({ error: 'This set-up link is not valid.' }, { status: 400 });
  if (password.length < MIN_LENGTH) return Response.json({ error: `Use at least ${MIN_LENGTH} characters.` }, { status: 400 });
  if (password.length > 200) return Response.json({ error: 'That password is too long.' }, { status: 400 });

  const member = await env.DB.prepare(
    `SELECT id, email FROM team_members
      WHERE setup_token_hash = ? AND active = 1 AND setup_expires_at > datetime('now')`,
  ).bind(await sha256Hex(token)).first();
  if (!member) {
    return Response.json({ error: 'This set-up link has expired or has already been used. Ask for a new one.' }, { status: 400 });
  }

  const saltBytes = new Uint8Array(16);
  crypto.getRandomValues(saltBytes);
  const salt = [...saltBytes].map(b => b.toString(16).padStart(2, '0')).join('');
  const hash = await hashTeamPassword(password, salt, env);

  // The token is cleared in the same statement that uses it, so it works once.
  const res = await env.DB.prepare(`
    UPDATE team_members
       SET password_hash = ?, password_salt = ?, iterations = ?, algo = ?,
           must_change_password = 0, password_changed_at = datetime('now'),
           setup_token_hash = NULL, setup_expires_at = NULL,
           failed_attempts = 0, locked_until = NULL,
           session_epoch = session_epoch + 1, updated_at = datetime('now')
     WHERE id = ? AND setup_token_hash = ?`)
    .bind(hash, salt, TEAM_ITERATIONS, ALGO_PEPPERED, member.id, await sha256Hex(token)).run();
  if (!res.meta.changes) return Response.json({ error: 'This set-up link has already been used.' }, { status: 400 });

  const fresh = await env.DB.prepare('SELECT id, session_epoch FROM team_members WHERE id = ?').bind(member.id).first();
  const session = await createTeamSession(fresh, env);
  return Response.json({ ok: true, email: member.email }, { headers: { 'Set-Cookie': teamSessionCookie(request, session) } });
}
