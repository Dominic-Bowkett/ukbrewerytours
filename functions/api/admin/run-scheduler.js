// POST /api/admin/run-scheduler — run the due-sends sweep by hand.
//
// The cron Worker (workers/scheduler/) owns the regular schedule. This is the
// manual pull: it lets an admin push a scheduled request out early, and it is
// the fallback if the Worker is ever down — the site alone can keep scheduled
// sends moving.
//
// Admin-gated by functions/api/admin/_middleware.js. Deliberately NOT available
// to team members: a member holding this could fire every other member's
// scheduled requests.

import { runScheduler } from '../../_lib/scheduler.js';

export async function onRequestPost({ env }) {
  const summary = await runScheduler(env);
  return Response.json(summary, { headers: { 'Cache-Control': 'no-store' } });
}
