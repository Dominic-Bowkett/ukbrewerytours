// One-time set-up links: a team member chooses their own password at
// /team/setup.html#t=<token>. Nothing is generated, shown or emailed but the
// link itself. Only a SHA-256 of the token is stored (setup_token_hash), so a
// database read does not hand out working links. The token sits in the URL
// fragment, which browsers never send to the server or put in a Referer.

export const SETUP_DAYS = 7;
const BASE = 'https://www.ukbrewerytours.com';

export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** A fresh link for a member, replacing any earlier one. */
export async function issueSetupLink(env, memberId) {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  await env.DB.prepare(
    `UPDATE team_members SET setup_token_hash = ?, setup_expires_at = datetime('now', ?) WHERE id = ?`,
  ).bind(await sha256Hex(token), `+${SETUP_DAYS} days`, memberId).run();
  return `${BASE}/team/setup.html#t=${token}`;
}
