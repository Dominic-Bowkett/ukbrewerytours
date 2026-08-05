// Auth gate for every /api/admin/* route except login.
// Verified session lands in ctx.data.user for downstream handlers.

import { readCookie, verifySession } from '../../_lib/auth.js';

export async function onRequest(ctx) {
  const { request, env } = ctx;
  const path = new URL(request.url).pathname;

  // Login must stay reachable while unauthenticated.
  if (path === '/api/admin/login') return ctx.next();

  const user = await verifySession(readCookie(request), env.ADMIN_SESSION_SECRET);
  if (!user) return Response.json({ error: 'Not signed in.' }, { status: 401 });

  ctx.data.user = user;
  return ctx.next();
}
