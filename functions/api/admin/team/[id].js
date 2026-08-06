// PATCH /api/admin/team/:id — edit one team member (admin only)
//
// Only these fields are writable, by an explicit allowlist rather than a
// generic "apply whatever was sent" helper: name, their own terms, their fee,
// and active. Everything financial that a member could otherwise influence —
// which Stripe account they charge on — is deliberately NOT editable here in a
// way that could redirect money mid-flight; changing an account requires the
// member to have no live requests.

const MAX_TERMS = 20000;

export async function onRequestPatch({ request, env, params }) {
  const id = String(params.id || '');
  const member = await env.DB.prepare('SELECT * FROM team_members WHERE id = ?').bind(id).first();
  if (!member) return Response.json({ error: 'Team member not found.' }, { status: 404 });

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const sets = [];
  const binds = [];

  if (body.name !== undefined) {
    const name = String(body.name ?? '').trim().slice(0, 100);
    if (!name) return Response.json({ error: 'Name cannot be empty.' }, { status: 400 });
    sets.push('name = ?'); binds.push(name);
  }

  // Per-member terms. Null/empty falls back to the platform default.
  if (body.terms_override !== undefined) {
    const t = String(body.terms_override ?? '').trim().slice(0, MAX_TERMS);
    sets.push('terms_override = ?'); binds.push(t || null);
  }

  // Per-member fee. Null falls back to the platform default.
  if (body.fee_percent !== undefined) {
    if (body.fee_percent === null || body.fee_percent === '') {
      sets.push('fee_bps = ?'); binds.push(null);
    } else {
      const pct = Number(body.fee_percent);
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
        return Response.json({ error: 'Fee must be between 0 and 100 percent.' }, { status: 400 });
      }
      sets.push('fee_bps = ?'); binds.push(Math.round(pct * 100));
    }
  }

  if (body.active !== undefined) {
    const active = body.active ? 1 : 0;
    sets.push('active = ?'); binds.push(active);
    // Deactivating must also invalidate any live session immediately, not in
    // twelve hours' time — session_epoch is checked on every team request.
    if (!active) sets.push('session_epoch = session_epoch + 1');
  }

  if (body.reply_to_email !== undefined) {
    const e = String(body.reply_to_email ?? '').trim().toLowerCase().slice(0, 200);
    if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
      return Response.json({ error: 'Enter a valid reply-to email.' }, { status: 400 });
    }
    sets.push('reply_to_email = ?'); binds.push(e || null);
  }

  if (!sets.length) return Response.json({ error: 'Nothing to change.' }, { status: 400 });

  sets.push("updated_at = datetime('now')");
  binds.push(id);
  await env.DB.prepare(`UPDATE team_members SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();

  const updated = await env.DB.prepare(
    'SELECT id, email, name, stripe_account_id, fee_bps, terms_override, active, reply_to_email FROM team_members WHERE id = ?',
  ).bind(id).first();

  return Response.json({ ok: true, member: updated });
}
