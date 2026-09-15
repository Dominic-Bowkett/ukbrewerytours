// POST /api/admin/redeem — take value off a voucher (full or partial).
// Body: { code, amount?, full?: true, note?, enquiry_id? }

import { normaliseCode, formatMoney } from '../../_lib/codes.js';
import { logEvent } from '../../_lib/inbox.js';

export async function onRequestPost({ request, env, data }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const code = normaliseCode(body.code || '');
  if (!code) return Response.json({ error: 'Enter a voucher code.' }, { status: 400 });

  const voucher = await env.DB.prepare('SELECT * FROM vouchers WHERE code=?').bind(code).first();
  if (!voucher) return Response.json({ error: 'Voucher not found.' }, { status: 404 });
  if (voucher.status === 'pending') return Response.json({ error: 'This voucher has not been paid for.' }, { status: 409 });
  if (voucher.status === 'void') return Response.json({ error: 'This voucher has been voided.' }, { status: 409 });
  if (voucher.balance_pence <= 0) return Response.json({ error: 'This voucher is fully redeemed.' }, { status: 409 });

  const full = body.full === true || body.full === 'true';
  const amountPence = full ? voucher.balance_pence : Math.round(Number(body.amount) * 100);

  if (!Number.isFinite(amountPence) || amountPence <= 0) {
    return Response.json({ error: 'Enter an amount to redeem.' }, { status: 400 });
  }
  if (amountPence > voucher.balance_pence) {
    return Response.json({ error: `Amount exceeds the remaining balance of ${formatMoney(voucher.balance_pence)}.` }, { status: 400 });
  }

  const balanceAfter = voucher.balance_pence - amountPence;
  const newStatus = balanceAfter === 0 ? 'redeemed' : 'partially_redeemed';

  // Conditional update = the atomic guard. If another admin redeemed in the
  // meantime the balance no longer matches and this affects zero rows.
  const upd = await env.DB.prepare(
    'UPDATE vouchers SET balance_pence=?, status=? WHERE id=? AND balance_pence=?',
  ).bind(balanceAfter, newStatus, voucher.id, voucher.balance_pence).run();

  if (!upd.meta.changes) {
    return Response.json({ error: 'Voucher was updated elsewhere — reload and try again.' }, { status: 409 });
  }

  // Redeemed from an inbox conversation: link it, and put it on that timeline.
  const enquiryId = /^\d+$/.test(String(body.enquiry_id || '')) ? Number(body.enquiry_id) : null;
  const who = data?.user?.email || 'admin';
  const note = String(body.note || '').trim().slice(0, 300) || null;

  await env.DB.prepare(
    'INSERT INTO redemptions (voucher_id, amount_pence, balance_after_pence, redeemed_by, note, enquiry_id) VALUES (?,?,?,?,?,?)',
  ).bind(voucher.id, amountPence, balanceAfter, who, note, enquiryId).run();

  if (enquiryId) {
    try {
      await logEvent(env, enquiryId,
        `Redeemed ${formatMoney(amountPence)} from ${code} — ${formatMoney(balanceAfter)} left${note ? ` (${note})` : ''}`, who);
    } catch (err) {
      console.error('redemption timeline entry failed', err);
    }
  }

  return Response.json({
    ok: true,
    code,
    redeemed_pence: amountPence,
    balance_pence: balanceAfter,
    status: newStatus,
  });
}
