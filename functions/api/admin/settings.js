// GET   /api/admin/settings — platform defaults (fee, terms, expiry)
// PATCH /api/admin/settings — change them
//
// Terms set here are the general ones, snapshotted onto each request at send
// time. A team member can be given their own terms instead (team_members.
// terms_override, edited via /api/admin/team/[id]); the resolution is
// member override -> platform default, in _lib/fees.js.
//
// Changing anything here affects only requests sent AFTER the change: every
// request freezes its own terms, fee and account when it goes out, so a client
// holding a link always sees what was actually agreed with them.

const MAX_TERMS = 20000;

export async function onRequestGet({ env }) {
  const s = await env.DB.prepare('SELECT * FROM platform_settings WHERE id = 1').first();

  // The Connect webhook refuses any event whose livemode disagrees with this
  // flag, and it defaults to 0 — so a platform on live keys with live_mode
  // still 0 silently discards every real Connect event, payments included.
  // The key prefix is the honest cross-check: it is not authoritative (a
  // restricted rk_live_ key breaks a naive startsWith, which is why the flag
  // exists at all) but it is exactly right for telling an admin the two
  // disagree.
  const key = env.STRIPE_SECRET_KEY || '';
  const keyLooksLive = /^(sk|rk)_live_/.test(key);
  const liveMode = s?.live_mode === 1;

  return Response.json({
    default_fee_bps: s?.default_fee_bps ?? 2000,
    default_terms: s?.default_terms ?? null,
    default_expiry_days: s?.default_expiry_days ?? 30,
    live_mode: liveMode,
    send_enabled: s?.send_enabled !== 0,
    stripe_key_mode: key ? (keyLooksLive ? 'live' : 'test') : 'missing',
    // Non-null only when something is actually wrong, so the UI can render it
    // as an alert rather than as a status line nobody reads.
    live_mode_mismatch: key && keyLooksLive !== liveMode
      ? `Stripe is using ${keyLooksLive ? 'LIVE' : 'TEST'} keys but live mode is ${liveMode ? 'on' : 'off'} — Connect webhook events are being discarded.`
      : null,
    updated_at: s?.updated_at ?? null,
  }, { headers: { 'Cache-Control': 'private, no-store' } });
}

export async function onRequestPatch({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const sets = [];
  const binds = [];

  if (body.default_fee_percent !== undefined) {
    const pct = Number(body.default_fee_percent);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      return Response.json({ error: 'Fee must be between 0 and 100 percent.' }, { status: 400 });
    }
    sets.push('default_fee_bps = ?');
    binds.push(Math.round(pct * 100));
  }

  if (body.default_terms !== undefined) {
    const terms = String(body.default_terms ?? '').trim().slice(0, MAX_TERMS);
    sets.push('default_terms = ?');
    binds.push(terms || null);
  }

  if (body.default_expiry_days !== undefined) {
    const days = Math.round(Number(body.default_expiry_days));
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      return Response.json({ error: 'Link expiry must be between 1 and 365 days.' }, { status: 400 });
    }
    sets.push('default_expiry_days = ?');
    binds.push(days);
  }

  // Live mode. Editable here because it was not editable anywhere — it sat at
  // the migration default of 0 while the platform ran on sk_live_ keys, and the
  // only symptom was an ops email saying an event had been discarded.
  if (body.live_mode !== undefined) {
    if (typeof body.live_mode !== 'boolean') {
      return Response.json({ error: 'live_mode must be true or false.' }, { status: 400 });
    }
    sets.push('live_mode = ?');
    binds.push(body.live_mode ? 1 : 0);
  }

  // The customer-facing kill switch. Turning it off stops the scheduler sending
  // payment requests; it does not stop our own reminders.
  if (body.send_enabled !== undefined) {
    if (typeof body.send_enabled !== 'boolean') {
      return Response.json({ error: 'send_enabled must be true or false.' }, { status: 400 });
    }
    sets.push('send_enabled = ?');
    binds.push(body.send_enabled ? 1 : 0);
  }

  if (!sets.length) return Response.json({ error: 'Nothing to change.' }, { status: 400 });

  sets.push("updated_at = datetime('now')");
  await env.DB.prepare(`UPDATE platform_settings SET ${sets.join(', ')} WHERE id = 1`).bind(...binds).run();

  const s = await env.DB.prepare('SELECT * FROM platform_settings WHERE id = 1').first();
  return Response.json({
    ok: true,
    default_fee_bps: s.default_fee_bps,
    default_terms: s.default_terms,
    default_expiry_days: s.default_expiry_days,
    live_mode: s.live_mode === 1,
    send_enabled: s.send_enabled !== 0,
    note: 'Applies to requests sent from now on. Requests already sent keep the terms they were sent with.',
  });
}
