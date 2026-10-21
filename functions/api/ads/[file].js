// GET /api/ads/<action>.csv — the per-action Google Ads conversion feed under a
// .csv name, which Google Ads Data manager requires. See ./conversions.js.

import { conversionsFeed } from './conversions.js';

export function onRequestGet({ request, env, params }) {
  const m = /^(voucher|booking|inbox|enquiry)\.csv$/.exec(String(params.file || ''));
  if (!m) return new Response('Not found', { status: 404 });
  return conversionsFeed(request, env, m[1]);
}
