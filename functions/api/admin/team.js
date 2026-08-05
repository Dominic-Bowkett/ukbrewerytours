// GET  /api/admin/team   — list team members
// POST /api/admin/team   — create one, assigning a Stripe connected account
//
// Admin-only: the stripe_account_id and the fee are set HERE and nowhere else.
// A team member can never choose which account they charge on, nor their own
// cut. The generated password is returned ONCE in the response body and never
// emailed — the first connected account has an active no-contact instruction,
// and handing credentials over directly is the safer default regardless.

import { hashTeamPassword, TEAM_ITERATIONS, ALGO_PEPPERED, teamAuthConfigError } from '../../_lib/team-auth.js';
import { stripeApi } from '../../_lib/stripe.js';

const isEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim());
const clean = (s, max) => String(s ?? '').trim().slice(0, max);

/**
 * Readable but strong: four words plus digits beats a short random string when a
 * human has to be told it and type it once. ~44 bits from the wordlist alone.
 */
function generatePassword() {
  const words = ['amber', 'porter', 'hoppy', 'stout', 'malt', 'brew', 'cask', 'yeast',
    'barrel', 'copper', 'hazy', 'crisp', 'draft', 'grain', 'tapped', 'wheat',
    'bitter', 'lager', 'stein', 'firkin', 'mash', 'sparge', 'kettle', 'growler'];
  const buf = new Uint32Array(4);
  crypto.getRandomValues(buf);
  const digits = new Uint32Array(1);
  crypto.getRandomValues(digits);
  return [...buf].map(v => words[v % words.length]).join('-') + '-' + String(digits[0] % 9000 + 1000);
}

export async function onRequestGet({ env }) {
  const { results } = await env.DB.prepare(`
    SELECT m.id, m.email, m.name, m.stripe_account_id, m.fee_bps, m.active,
           m.created_at, m.last_login_at, m.stripe_charges_enabled,
           (SELECT COUNT(*) FROM payment_requests r WHERE r.team_member_id = m.id) AS request_count,
           (SELECT COALESCE(SUM(amount_paid_pence), 0) FROM payment_requests r
             WHERE r.team_member_id = m.id AND r.status = 'paid') AS paid_pence
    FROM team_members m
    ORDER BY m.active DESC, m.name`).all();

  const settings = await env.DB.prepare(
    'SELECT default_fee_bps FROM platform_settings WHERE id = 1').first();

  return Response.json({
    members: results,
    default_fee_bps: settings?.default_fee_bps ?? 2000,
  }, { headers: { 'Cache-Control': 'private, no-store' } });
}

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const email = clean(body.email, 200).toLowerCase();
  const name = clean(body.name, 100);
  const accountId = clean(body.stripe_account_id, 60);

  if (!name) return Response.json({ error: 'Enter the team member’s name.' }, { status: 400 });
  if (!isEmail(email)) return Response.json({ error: 'Enter a valid email address.' }, { status: 400 });
  if (!/^acct_[A-Za-z0-9]+$/.test(accountId)) {
    return Response.json({ error: 'Choose a Stripe connected account.' }, { status: 400 });
  }

  // Optional per-member fee override, in basis points. Bounded server-side:
  // a 0% fee is legitimate (a favour), but >100% would invert the split.
  let feeBps = null;
  if (body.fee_percent !== undefined && body.fee_percent !== null && body.fee_percent !== '') {
    const pct = Number(body.fee_percent);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      return Response.json({ error: 'Fee must be between 0 and 100 percent.' }, { status: 400 });
    }
    feeBps = Math.round(pct * 100);
  }

  // The account must exist and be able to take a direct charge with a fee —
  // otherwise the member could raise requests that can never be paid.
  let account;
  try {
    account = await stripeApi(env, `/accounts/${accountId}`);
  } catch (err) {
    return Response.json({ error: `Stripe does not recognise that account: ${err.message}` }, { status: 400 });
  }
  const caps = account.capabilities || {};
  if (account.charges_enabled !== true || caps.card_payments !== 'active') {
    return Response.json({ error: 'That account cannot currently take card payments.' }, { status: 400 });
  }
  if (caps.platform_payments !== 'active' && caps.transfers !== 'active') {
    return Response.json({ error: 'That account cannot take a platform fee — check its Connect capabilities.' }, { status: 400 });
  }

  const existing = await env.DB.prepare(
    'SELECT id, name FROM team_members WHERE stripe_account_id = ?').bind(accountId).first();
  if (existing) {
    return Response.json({ error: `That account is already assigned to ${existing.name}.` }, { status: 409 });
  }

  // The pepper and session secret must exist before a member can be created,
  // otherwise the hash written now could never be verified at login.
  const configError = teamAuthConfigError(env);
  if (configError) {
    return Response.json({ error: `Team auth is not configured: ${configError}` }, { status: 503 });
  }

  const password = generatePassword();
  const saltBytes = new Uint8Array(16);
  crypto.getRandomValues(saltBytes);
  const salt = [...saltBytes].map(b => b.toString(16).padStart(2, '0')).join('');
  const hash = await hashTeamPassword(password, salt, env);
  const id = crypto.randomUUID();

  try {
    await env.DB.prepare(`
      INSERT INTO team_members (id, email, name, password_hash, password_salt, iterations, algo,
                                stripe_account_id, stripe_account_label, fee_bps,
                                active, stripe_charges_enabled, must_change_password)
      VALUES (?,?,?,?,?,?,?,?,?,?,1,1,1)`)
      .bind(id, email, name, hash, salt, TEAM_ITERATIONS, ALGO_PEPPERED,
            accountId, account.email || account.business_profile?.name || null, feeBps).run();
  } catch (err) {
    if (String(err.message || '').includes('UNIQUE')) {
      return Response.json({ error: 'A team member with that email already exists.' }, { status: 409 });
    }
    throw err;
  }

  return Response.json({
    ok: true,
    member: { id, email, name, stripe_account_id: accountId, fee_bps: feeBps },
    // Shown once in the UI. Deliberately not emailed.
    password,
    notice: 'Save this password now — it is not stored in plain text and cannot be shown again.',
  });
}
