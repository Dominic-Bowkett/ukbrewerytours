// POST /api/team/logout — clear the team session cookie.
//
// In the gate's PUBLIC set on purpose: a member whose session has already been
// revoked (session_epoch bumped) or expired still needs the stale cookie
// removed, and a logout that 401s leaves it sitting in the jar being resent.
// The endpoint is still origin-checked, because _middleware.js applies that
// check to every mutation before the public bypass.
//
// Only __Host-ubt_team is cleared. An admin session in the same browser is
// untouched — that is exactly what the separate cookie name buys, and signing
// out of /team/ should not sign Dom out of /admin/.
//
// This clears ONE browser. To revoke a member everywhere, admin bumps
// team_members.session_epoch, which the gate checks on every request:
//   UPDATE team_members SET session_epoch = session_epoch + 1 WHERE id = ?;

import { clearTeamCookie } from '../../_lib/team-auth.js';

export async function onRequestPost({ request }) {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Set-Cookie': clearTeamCookie(request),
    },
  });
}
