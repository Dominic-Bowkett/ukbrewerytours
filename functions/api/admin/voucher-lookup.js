// GET /api/admin/voucher-lookup?code=… — check a code (or several: "AB12 + CD34")
// against UK Brewery Tours vouchers and every imported source.

import { lookupCodes, explicitCodes } from '../../_lib/inbox.js';

export async function onRequestGet({ request, env }) {
  const code = String(new URL(request.url).searchParams.get('code') || '').slice(0, 300);
  const pieces = explicitCodes(code);
  if (!pieces.length) return Response.json({ error: 'Enter a voucher code.' }, { status: 400 });

  const matches = await lookupCodes(env, pieces);
  const hit = new Set(matches.flatMap(m => [m.code_norm, m.code_norm.replace(/^UBT/, '')]));
  const unmatched = pieces.filter(c => !hit.has(c) && !hit.has(c.replace(/^UBT/, '')));
  return Response.json({ matches, unmatched }, { headers: { 'Cache-Control': 'no-store' } });
}
