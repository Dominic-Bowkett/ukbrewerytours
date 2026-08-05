// POST /api/admin/login  — exchange credentials for a signed session cookie.
// Not covered by _middleware.js (see its early-exit for this path).

import { verifyPassword, createSession, sessionCookie, isInsecure } from '../../_lib/auth.js';

export async function onRequestPost({ request, env }) {
  if (!env.ADMIN_SESSION_SECRET) {
    return Response.json({ error: 'Admin auth is not configured.' }, { status: 503 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const fail = () => Response.json({ error: 'Incorrect email or password.' }, { status: 401 });

  if (!email || !password) return fail();

  const user = await env.DB.prepare('SELECT * FROM admin_users WHERE email = ?').bind(email).first();
  if (!user) return fail();
  if (!(await verifyPassword(password, user))) return fail();

  const token = await createSession(user, env.ADMIN_SESSION_SECRET);
  await env.DB.prepare("UPDATE admin_users SET last_login_at=datetime('now') WHERE id=?").bind(user.id).run();

  return Response.json(
    { ok: true, email: user.email },
    { headers: { 'Set-Cookie': sessionCookie(token, { secure: !isInsecure(request) }) } },
  );
}
