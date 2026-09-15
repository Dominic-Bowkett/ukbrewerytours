// /api/admin/imported-voucher/:id — one code from another system.
//
//   GET   the code and its redemption history
//   POST  { action, amount?, full?, note?, enquiry_id? }
//         action "redeem"  — take value off (codes with a tracked balance)
//         action "redeemed" | "partially_redeemed" — mark use (codes without a value)
//         action "active"  — reinstate a code marked used by mistake
//         action "void"    — cancel it

import { formatMoney } from '../../../_lib/codes.js';
import { logEvent } from '../../../_lib/inbox.js';

const LABEL = { redeemed: 'fully used', partially_redeemed: 'partly used', active: 'reinstated', void: 'void' };

async function find(env, id) {
  if (!/^\d+$/.test(String(id))) return null;
  return env.DB.prepare('SELECT * FROM imported_vouchers WHERE id = ?').bind(Number(id)).first();
}

export async function onRequestGet({ params, env }) {
  const v = await find(env, params.id);
  if (!v) return Response.json({ error: 'Code not found.' }, { status: 404 });
  const { results } = await env.DB.prepare(
    'SELECT * FROM imported_voucher_redemptions WHERE imported_voucher_id = ? ORDER BY id DESC',
  ).bind(v.id).all();
  let raw = null;
  try { raw = v.raw ? JSON.parse(v.raw) : null; } catch { raw = null; }
  return Response.json({ voucher: { ...v, raw }, redemptions: results || [] }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function onRequestPost({ params, request, env, data }) {
  const v = await find(env, params.id);
  if (!v) return Response.json({ error: 'Code not found.' }, { status: 404 });

  let body;
  try { body = await request.json(); } catch { return Response.json({ error: 'Invalid request.' }, { status: 400 }); }

  const who = data?.user?.email || 'admin';
  const note = String(body.note || '').trim().slice(0, 300) || null;
  const enquiryId = /^\d+$/.test(String(body.enquiry_id || '')) ? Number(body.enquiry_id) : null;
  const action = String(body.action || '');
  const tracked = v.balance_pence !== null && v.balance_pence !== undefined;

  let amountPence = null;
  let balanceAfter = v.balance_pence;
  let statusAfter;

  if (action === 'redeem') {
    if (!tracked) return Response.json({ error: 'This code has no value recorded — mark it as used instead.' }, { status: 400 });
    if (v.status === 'void') return Response.json({ error: 'This code is void.' }, { status: 409 });
    if (v.balance_pence <= 0) return Response.json({ error: 'This code is fully redeemed.' }, { status: 409 });
    const full = body.full === true || body.full === 'true';
    amountPence = full ? v.balance_pence : Math.round(Number(body.amount) * 100);
    if (!Number.isFinite(amountPence) || amountPence <= 0) return Response.json({ error: 'Enter an amount to redeem.' }, { status: 400 });
    if (amountPence > v.balance_pence) {
      return Response.json({ error: `Amount exceeds the remaining balance of ${formatMoney(v.balance_pence)}.` }, { status: 400 });
    }
    balanceAfter = v.balance_pence - amountPence;
    statusAfter = balanceAfter === 0 ? 'redeemed' : 'partially_redeemed';
  } else if (LABEL[action]) {
    if (action === v.status) return Response.json({ error: `Already ${LABEL[action]}.` }, { status: 409 });
    statusAfter = action;
    // A tracked balance follows the status for the unambiguous cases.
    if (tracked && action === 'redeemed') { amountPence = v.balance_pence; balanceAfter = 0; }
  } else {
    return Response.json({ error: 'Unknown action.' }, { status: 400 });
  }

  // Conditional on the row being unchanged since it was read (two admins at once).
  const upd = await env.DB.prepare(
    'UPDATE imported_vouchers SET status = ?, balance_pence = ? WHERE id = ? AND status = ? AND balance_pence IS ?',
  ).bind(statusAfter, balanceAfter, v.id, v.status, v.balance_pence).run();
  if (!upd.meta.changes) return Response.json({ error: 'This code was updated elsewhere — reload and try again.' }, { status: 409 });

  await env.DB.prepare(
    `INSERT INTO imported_voucher_redemptions
       (imported_voucher_id, amount_pence, balance_after_pence, status_after, redeemed_by, note, enquiry_id)
     VALUES (?,?,?,?,?,?,?)`,
  ).bind(v.id, amountPence, balanceAfter, statusAfter, who, note, enquiryId).run();

  if (enquiryId) {
    const what = action === 'redeem' || (tracked && action === 'redeemed')
      ? `Redeemed ${formatMoney(amountPence)} from ${v.code} (${v.source}) — ${formatMoney(balanceAfter)} left`
      : `${v.code} (${v.source}) marked ${LABEL[action]}`;
    try { await logEvent(env, enquiryId, note ? `${what} (${note})` : what, who); } catch (err) { console.error(err); }
  }

  return Response.json({ ok: true, status: statusAfter, balance_pence: balanceAfter, redeemed_pence: amountPence });
}
