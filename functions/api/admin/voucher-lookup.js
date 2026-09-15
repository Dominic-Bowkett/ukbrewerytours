// GET /api/admin/voucher-lookup?code=… — check a code (or several: "AB12 + CD34")
// against UK Brewery Tours vouchers and every imported source.

import { lookupCodes, explicitPieces } from '../../_lib/inbox.js';

export async function onRequestGet({ request, env }) {
  const code = String(new URL(request.url).searchParams.get('code') || '').slice(0, 300);
  const pieces = explicitPieces(code);
  if (!pieces.length) return Response.json({ error: 'Enter a voucher code.' }, { status: 400 });

  const matches = await lookupCodes(env, pieces.map(p => p.norm));
  const hit = new Set(matches.flatMap(m => [m.code_norm, m.code_norm.replace(/^UBT/, '')]));
  const unmatched = pieces.filter(p => !hit.has(p.norm) && !hit.has(p.norm.replace(/^UBT/, ''))).map(p => p.typed);
  return Response.json({ matches, unmatched }, { headers: { 'Cache-Control': 'no-store' } });
}
