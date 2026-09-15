// /api/admin/imported-vouchers — voucher codes issued by other systems.
//
//   GET     ?q=&source=&status=&page=   list, plus the sources and import batches
//   POST    { source, batch_id?, rows: [...] }   import (the admin parses the CSV
//           and maps its columns; rows arrive already normalised)
//   DELETE  ?batch=<id>   undo an import — rows that have been redeemed are kept
//
// Codes are unique per source; re-importing the same file skips what exists.

const PAGE_SIZE = 50;
const MAX_ROWS = 1000;         // per request; the admin sends big files in chunks
const STATUSES = new Set(['active', 'partially_redeemed', 'redeemed', 'void']);

const str = (v, max) => {
  const s = String(v ?? '').replace(/[\r\n]+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
};
const pence = v => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 10_000_000 ? n : null;
};

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim().slice(0, 100);
  const source = url.searchParams.get('source') || '';
  const status = url.searchParams.get('status') || '';
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);

  const where = [];
  const args = [];
  if (q) {
    const like = `%${q.replace(/[%_]/g, m => '\\' + m)}%`;
    const normLike = `%${q.toUpperCase().replace(/[^A-Z0-9]/g, '')}%`;
    where.push("(code_norm LIKE ? OR holder_name LIKE ? ESCAPE '\\' OR holder_email LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')");
    args.push(normLike, like, like, like);
  }
  if (source) { where.push('source = ?'); args.push(source); }
  if (STATUSES.has(status)) { where.push('status = ?'); args.push(status); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const [list, sources, batches] = await env.DB.batch([
    env.DB.prepare(`SELECT * FROM imported_vouchers ${w} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .bind(...args, PAGE_SIZE + 1, (page - 1) * PAGE_SIZE),
    env.DB.prepare(`SELECT source, COUNT(*) AS n, SUM(status IN ('active','partially_redeemed')) AS live,
                      SUM(CASE WHEN status IN ('active','partially_redeemed') THEN COALESCE(balance_pence, 0) ELSE 0 END) AS outstanding_pence
                      FROM imported_vouchers GROUP BY source ORDER BY source`),
    env.DB.prepare(`SELECT b.batch_id, b.source, b.n, b.imported_at,
                      (SELECT COUNT(*) FROM imported_voucher_redemptions r JOIN imported_vouchers v ON v.id = r.imported_voucher_id WHERE v.batch_id = b.batch_id) AS redemptions
                      FROM (SELECT batch_id, source, COUNT(*) AS n, MIN(created_at) AS imported_at FROM imported_vouchers GROUP BY batch_id, source) b
                     ORDER BY b.imported_at DESC LIMIT 20`),
  ]);

  const rows = list.results || [];
  return Response.json({
    vouchers: rows.slice(0, PAGE_SIZE).map(({ raw, ...v }) => v),
    hasMore: rows.length > PAGE_SIZE,
    sources: sources.results || [],
    batches: batches.results || [],
  }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return Response.json({ error: 'Invalid request.' }, { status: 400 }); }

  const source = str(body.source, 60);
  if (!source) return Response.json({ error: 'Name the system these codes came from.' }, { status: 400 });
  if (!Array.isArray(body.rows) || !body.rows.length) return Response.json({ error: 'No rows to import.' }, { status: 400 });
  if (body.rows.length > MAX_ROWS) return Response.json({ error: `Send at most ${MAX_ROWS} rows at a time.` }, { status: 400 });

  const batchId = /^imp_[a-z0-9]{10}$/.test(String(body.batch_id || ''))
    ? body.batch_id
    : 'imp_' + [...crypto.getRandomValues(new Uint8Array(10))].map(b => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');

  let invalid = 0;
  const clean = [];
  for (const r of body.rows) {
    const code = str(r?.code, 80);
    const codeNorm = code ? code.toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
    if (!codeNorm || codeNorm.length < 3) { invalid++; continue; }
    const amount = pence(r.amount_pence);
    let balance = pence(r.balance_pence);
    if (balance === null && amount !== null) balance = amount;
    let status = STATUSES.has(r.status) ? r.status : 'active';
    if (balance !== null && status === 'active') {
      if (balance === 0) status = 'redeemed';
      else if (amount !== null && balance < amount) status = 'partially_redeemed';
    }
    let raw = null;
    try { raw = r.raw ? JSON.stringify(r.raw).slice(0, 4000) : null; } catch { raw = null; }
    clean.push({
      code, code_norm: codeNorm, description: str(r.description, 300),
      amount_pence: amount, balance_pence: balance, status,
      holder_name: str(r.holder_name, 120), holder_email: str(r.holder_email, 200),
      purchased_at: str(r.purchased_at, 40), expires_at: str(r.expires_at, 40),
      notes: str(r.notes, 500), raw,
    });
  }

  if (!clean.length) return Response.json({ error: 'None of the rows had a usable code.', invalid }, { status: 400 });

  // One statement for the whole chunk: D1 caps bound parameters at 100 per
  // query, so the rows travel as a single JSON parameter and json_each expands them.
  const res = await env.DB.prepare(
    `INSERT INTO imported_vouchers
       (source, code, code_norm, description, amount_pence, balance_pence, status,
        holder_name, holder_email, purchased_at, expires_at, notes, raw, batch_id)
     SELECT ?1, json_extract(value, '$.code'), json_extract(value, '$.code_norm'), json_extract(value, '$.description'),
            json_extract(value, '$.amount_pence'), json_extract(value, '$.balance_pence'), json_extract(value, '$.status'),
            json_extract(value, '$.holder_name'), json_extract(value, '$.holder_email'),
            json_extract(value, '$.purchased_at'), json_extract(value, '$.expires_at'),
            json_extract(value, '$.notes'), json_extract(value, '$.raw'), ?2
       FROM json_each(?3) WHERE true
     ON CONFLICT (source, code_norm) DO NOTHING`,
  ).bind(source, batchId, JSON.stringify(clean)).run();

  const inserted = res.meta.changes || 0;
  return Response.json({ ok: true, batch_id: batchId, inserted, duplicates: clean.length - inserted, invalid });
}

export async function onRequestDelete({ request, env }) {
  const batch = new URL(request.url).searchParams.get('batch') || '';
  if (!/^imp_[a-z0-9]{10}$/.test(batch)) return Response.json({ error: 'Unknown import batch.' }, { status: 400 });

  const res = await env.DB.prepare(
    `DELETE FROM imported_vouchers WHERE batch_id = ?
       AND id NOT IN (SELECT imported_voucher_id FROM imported_voucher_redemptions)`,
  ).bind(batch).run();
  const kept = await env.DB.prepare('SELECT COUNT(*) AS n FROM imported_vouchers WHERE batch_id = ?').bind(batch).first();

  return Response.json({ ok: true, deleted: res.meta.changes || 0, kept: kept?.n || 0 });
}
