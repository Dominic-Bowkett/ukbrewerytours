// POST /api/admin/team/:id/setup-link — a fresh one-time link for this member to
// choose their own password (valid SETUP_DAYS; replaces any earlier link). The
// admin forwards it however suits; nothing is emailed from here.

import { issueSetupLink, SETUP_DAYS } from '../../../../_lib/team-setup.js';

export async function onRequestPost({ params, env }) {
  const member = await env.DB.prepare('SELECT id, name, active FROM team_members WHERE id = ?').bind(String(params.id)).first();
  if (!member) return Response.json({ error: 'Team member not found.' }, { status: 404 });
  if (member.active !== 1) return Response.json({ error: 'That member is switched off.' }, { status: 400 });
  return Response.json({ ok: true, url: await issueSetupLink(env, member.id), days: SETUP_DAYS });
}
