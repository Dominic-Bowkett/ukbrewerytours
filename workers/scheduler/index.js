// The cron half of the payment-request system.
//
// This exists as a separate Worker for one reason: Pages Functions cannot
// receive scheduled events. Everything else about it — the same D1, the same
// secrets, the same code — is shared with the site, so the sweep itself lives
// in functions/_lib/scheduler.js and this file is only the trigger.
//
// Deploy from this directory:
//   npx wrangler deploy
// Secrets it needs (same values as the Pages project):
//   RESEND_API_KEY, STRIPE_SECRET_KEY
// Vars are in wrangler.toml; the D1 binding points at the SAME database as the
// site, not a copy.

import { runScheduler } from '../../functions/_lib/scheduler.js';

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runScheduler(env).then((summary) => {
        // One line per tick, so `wrangler tail` shows what a quiet minute did.
        console.log('scheduler tick', JSON.stringify(summary));
      }),
    );
  },

  // A hand pull on the same rope, for checking the deploy without waiting for
  // the next tick. Gated on a shared secret: this endpoint sends real email to
  // real clients, so it must not be open to anyone who finds the workers.dev
  // hostname.
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/run') return new Response('Not found', { status: 404 });

    const given = request.headers.get('x-scheduler-key') || url.searchParams.get('key') || '';
    const want = env.SCHEDULER_KEY || '';
    if (!want || given.length !== want.length || given !== want) {
      return new Response('Forbidden', { status: 403 });
    }

    const summary = await runScheduler(env);
    return Response.json(summary, { headers: { 'Cache-Control': 'no-store' } });
  },
};
