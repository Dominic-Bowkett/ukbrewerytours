// POST /api/admin/team/impersonate {id} — start a "view as" session for a team
// member. Admin-gated by the /api/admin middleware; the response sets the TEAM
// cookie, so the browser's next visit to /team/ is that member's portal, with
// everything the member could do — including setting up payment requests.
//
// The minted token carries the signed imp:1 claim, so the portal can show a
// "viewing as" banner and logs can tell these sessions apart from real logins.
// Revocation, active and charge-ready checks all still run per-request in the
// team middleware — impersonation grants exactly what the member has, no more.

import { createTeamSession, teamSessionCookie, teamAuthConfigError } from '../../../_lib/team-auth.js';

export async function onRequestPost({ request, env, data }) {
  const problem = teamAuthConfigError(env);
  if (problem) {
    console.error('impersonate: team auth misconfigured:', problem);
    return Response.json({ error: 'The team area is not configured.' }, { status: 503 });
  }

  let body;
  try { body = await request.json(); } catch { return Response.json({ error: 'Invalid request.' }, { status: 400 }); }
  const id = String(body.id || '').trim();
  if (!id) return Response.json({ error: 'Missing team member id.' }, { status: 400 });

  const member = await env.DB.prepare(
    'SELECT id, name, email, active, session_epoch FROM team_members WHERE id = ?',
  ).bind(id).first();
  if (!member) return Response.json({ error: 'No such team member.' }, { status: 404 });
  if (member.active !== 1) {
    return Response.json({ error: 'That member is disabled — reactivate them first.' }, { status: 400 });
  }

  const token = await createTeamSession(member, env, { impersonated: true });
  console.log(`impersonation started: admin ${data.user?.email || '?'} as ${member.email} (${member.id})`);

  return Response.json(
    { ok: true, name: member.name },
    { headers: { 'Set-Cookie': teamSessionCookie(request, token), 'Cache-Control': 'no-store' } },
  );
}
