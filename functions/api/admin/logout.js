// POST /api/admin/logout — clear the session cookie.

import { clearCookie, isInsecure } from '../../_lib/auth.js';

export async function onRequestPost({ request }) {
  return Response.json(
    { ok: true },
    { headers: { 'Set-Cookie': clearCookie({ secure: !isInsecure(request) }) } },
  );
}
