/* Admin → Gift vouchers → "Codes from other systems".
 *
 * Import a CSV export from another voucher system (map its columns once), list
 * and search the codes, and redeem/mark them. Imported codes are checked
 * against every Inbox redemption request alongside our own UBT- codes.
 *
 * Uses the inline index.html helpers: api(), esc(), money(), dt().
 */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const modal = $('impModal');
  const body = $('impBody');
  const LABEL = { active: 'Unused', partially_redeemed: 'Part-used', redeemed: 'Fully used', void: 'Void' };
  let page = 1;
  let hasMore = false;

  /* ---------------- list ---------------- */

  window.loadImported = async function () {
    const rows = $('impRows');
    const params = new URLSearchParams({ page, q: $('impQ').value.trim(), source: $('impSource').value });
    try {
      const d = await api('/api/admin/imported-vouchers?' + params);
      hasMore = d.hasMore;

      const sel = $('impSource');
      const cur = sel.value;
      sel.innerHTML = '<option value="">All sources</option>'
        + d.sources.map(s => `<option value="${esc(s.source)}">${esc(s.source)} (${s.n})</option>`).join('');
      sel.value = cur;

      $('impSummary').innerHTML = d.sources.map(s =>
        `<span class="tag"><strong>${esc(s.source)}</strong> · ${s.n} codes · ${s.live} usable${s.outstanding_pence ? ` · ${money(s.outstanding_pence)} outstanding` : ''}</span>`).join('');
      window.__impBatches = d.batches;

      rows.innerHTML = d.vouchers.length ? d.vouchers.map(v => `
        <tr>
          <td><code>${esc(v.code)}</code></td>
          <td>${esc(v.source)}</td>
          <td>${v.amount_pence != null ? money(v.amount_pence) : `<span class="muted">${esc(v.description || '—')}</span>`}</td>
          <td>${v.balance_pence != null ? `<strong>${money(v.balance_pence)}</strong>` : '<span class="muted">—</span>'}</td>
          <td><span class="pill pill-${esc(v.status)}">${LABEL[v.status] || esc(v.status)}</span></td>
          <td>${esc(v.holder_name || '—')}${v.holder_email ? `<br><span class="muted">${esc(v.holder_email)}</span>` : ''}</td>
          <td class="muted">${esc(v.expires_at || '—')}</td>
          <td><button class="btn btn-sm" type="button" data-imp="${v.id}">View</button></td>
        </tr>`).join('')
        : `<tr><td colspan="8" class="muted pad">${d.sources.length ? 'No codes match.' : 'No codes imported yet. Use “Import codes” to upload a CSV from another voucher system.'}</td></tr>`;

      $('impPageLabel').textContent = 'Page ' + page;
      $('impPrev').disabled = page <= 1;
      $('impNext').disabled = !hasMore;
    } catch (err) {
      rows.innerHTML = `<tr><td colspan="8" class="pad error">${esc(err.message)}</td></tr>`;
    }
  };

  let qt;
  $('impQ').addEventListener('input', () => { clearTimeout(qt); qt = setTimeout(() => { page = 1; loadImported(); }, 300); });
  $('impSource').addEventListener('change', () => { page = 1; loadImported(); });
  $('impPrev').addEventListener('click', () => { if (page > 1) { page--; loadImported(); } });
  $('impNext').addEventListener('click', () => { if (hasMore) { page++; loadImported(); } });
  $('impRows').addEventListener('click', e => { const b = e.target.closest('[data-imp]'); if (b) openImported(Number(b.dataset.imp)); });

  modal.addEventListener('click', e => { if (e.target.closest('[data-close]')) modal.hidden = true; });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') modal.hidden = true; });

  /* ---------------- one code ---------------- */

  window.openImported = async function (id) {
    modal.hidden = false;
    body.innerHTML = '<p class="muted pad">Loading…</p>';
    let d;
    try { d = await api('/api/admin/imported-voucher/' + id); } catch (err) { body.innerHTML = `<p class="pad error">${esc(err.message)}</p>`; return; }
    const v = d.voucher;
    const tracked = v.balance_pence != null;

    body.innerHTML = `
      <div class="detail-head">
        <code class="big-code">${esc(v.code)}</code>
        <span class="pill pill-${esc(v.status)}">${LABEL[v.status] || esc(v.status)}</span>
        <span class="tag">${esc(v.source)}</span>
      </div>
      ${tracked ? `<div class="balance-box">
        <div><span>Original</span><strong>${v.amount_pence != null ? money(v.amount_pence) : '—'}</strong></div>
        <div><span>Used</span><strong>${v.amount_pence != null ? money(v.amount_pence - v.balance_pence) : '—'}</strong></div>
        <div class="hl"><span>Balance</span><strong>${money(v.balance_pence)}</strong></div>
      </div>` : `<p style="margin-bottom:8px">${v.description ? `<strong>${esc(v.description)}</strong> · ` : ''}<span class="muted">no monetary value recorded</span></p>`}

      <form class="redeem-form" id="impAct">
        <h3>${tracked ? 'Redeem' : 'Mark as used'} <span class="sub">— customer used it on a tour</span></h3>
        <div class="redeem-row">
          ${tracked ? `<div class="field"><label for="impAmt">Amount (£)</label><input id="impAmt" type="number" step="0.01" min="0.01" max="${(v.balance_pence / 100).toFixed(2)}" placeholder="0.00"></div>` : ''}
          <div class="field" ${tracked ? '' : 'style="grid-column:1/-1"'}><label for="impNote">Note (optional)</label><input id="impNote" type="text" maxlength="300" placeholder="e.g. Bristol tour, 12 Aug"></div>
        </div>
        <p class="error" id="impErr" hidden></p>
        <div class="redeem-actions">
          ${tracked && v.balance_pence > 0 && v.status !== 'void' ? `
            <button class="btn btn-primary" type="button" data-act="redeem">Redeem amount</button>
            <button class="btn btn-outline" type="button" data-act="redeem-full">Redeem full ${money(v.balance_pence)}</button>` : ''}
          ${!tracked && v.status !== 'redeemed' ? '<button class="btn btn-primary" type="button" data-act="redeemed">Mark fully used</button>' : ''}
          ${!tracked && v.status === 'active' ? '<button class="btn btn-outline" type="button" data-act="partially_redeemed">Mark partly used</button>' : ''}
          ${!tracked && v.status !== 'active' ? '<button class="btn btn-ghost" type="button" data-act="active">Reinstate</button>' : ''}
          ${v.status !== 'void' ? '<button class="btn btn-ghost" type="button" data-act="void">Void</button>' : ''}
        </div>
      </form>

      <div class="meta-grid">
        <div><span>Holder</span>${esc(v.holder_name || '—')}${v.holder_email ? `<br><span class="muted">${esc(v.holder_email)}</span>` : ''}</div>
        <div><span>Purchased</span>${esc(v.purchased_at || '—')}</div>
        <div><span>Expires</span>${esc(v.expires_at || '—')}</div>
        <div><span>Imported</span>${dt(v.created_at)}</div>
        ${v.notes ? `<div class="full"><span>Notes</span>${esc(v.notes)}</div>` : ''}
        ${v.raw ? `<div class="full"><span>Original CSV row</span><code class="small" style="white-space:pre-wrap;word-break:break-word">${esc(Object.entries(v.raw).map(([k, val]) => `${k}: ${val}`).join('\n'))}</code></div>` : ''}
      </div>

      <h3 class="hist-title">History</h3>
      ${d.redemptions.length ? `<table class="hist"><tbody>${d.redemptions.map(r => `
        <tr><td>${dt(r.created_at)}</td>
        <td><strong>${r.amount_pence != null ? '−' + money(r.amount_pence) : esc(LABEL[r.status_after] || r.status_after)}</strong></td>
        <td class="muted">${r.balance_after_pence != null ? 'balance ' + money(r.balance_after_pence) : ''}</td>
        <td class="muted">${esc(r.note || '')}${r.enquiry_id ? ` <a href="#inbox/${r.enquiry_id}" data-close>enquiry #${r.enquiry_id}</a>` : ''}</td>
        <td class="muted">${esc(r.redeemed_by || '')}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">Not used yet.</p>'}`;

    $('impAct').addEventListener('click', async e => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      const err = $('impErr');
      err.hidden = true;
      const note = $('impNote').value;
      let payload;
      if (act === 'redeem' || act === 'redeem-full') {
        const amount = act === 'redeem-full' ? v.balance_pence / 100 : Number($('impAmt').value);
        if (!(amount > 0)) { err.textContent = 'Enter an amount to redeem.'; err.hidden = false; return; }
        if (!confirm(`Redeem £${amount.toFixed(2)} from ${v.code}?`)) return;
        payload = { action: 'redeem', note, ...(act === 'redeem-full' ? { full: true } : { amount }) };
      } else {
        const words = { redeemed: 'fully used', partially_redeemed: 'partly used', active: 'unused again', void: 'void' };
        if (!confirm(`Mark ${v.code} as ${words[act]}?`)) return;
        payload = { action: act, note };
      }
      try {
        await api('/api/admin/imported-voucher/' + v.id, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        await openImported(v.id);
        loadImported();
      } catch (e2) { err.textContent = e2.message; err.hidden = false; }
    });
  };

  /* ---------------- import wizard ---------------- */

  // RFC 4180-ish: quoted fields, doubled quotes, CRLF; delimiter sniffed from the header.
  function parseCsv(text) {
    text = text.replace(/^﻿/, '');
    const firstLine = text.split(/\r?\n/, 1)[0] || '';
    const delim = [',', ';', '\t'].map(d => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
    const rows = [];
    let row = [], field = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
        else field += c;
      } else if (c === '"') quoted = true;
      else if (c === delim) { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        if (row.some(f => f.trim() !== '')) rows.push(row);
        row = [];
      } else field += c;
    }
    row.push(field);
    if (row.some(f => f.trim() !== '')) rows.push(row);
    return rows;
  }

  const TARGETS = [
    ['code', 'Voucher code', /code|voucher.?(no|number|id)|^voucher$/i, true],
    ['amount', 'Original value (£)', /^(amount|value|face.?value|original|price|initial)|amount|value/i],
    ['balance', 'Balance remaining (£)', /balance|remaining|left|outstanding/i],
    ['description', 'Product / description', /product|item|description|experience|title|package/i],
    ['holder_name', 'Holder name', /recipient.?name|^name$|holder|customer.?name|first.?name|buyer.?name|purchaser.?name/i],
    ['holder_email', 'Holder email', /email/i],
    ['status', 'Status', /status|state/i],
    ['purchased_at', 'Purchase date', /purchas|order.?date|created|issued|sold|bought/i],
    ['expires_at', 'Expiry date', /expir|valid.?until|valid.?to|end.?date/i],
    ['notes', 'Notes', /note|comment|message/i],
  ];

  const toPence = s => {
    const t = String(s || '').replace(/[£$€,\s]|GBP/gi, '');
    if (!t || isNaN(Number(t))) return null;
    return Math.round(Number(t) * 100);
  };
  const toDate = s => {
    const t = String(s || '').trim();
    if (!t) return null;
    let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = t.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/);   // UK: day first
    if (m) {
      const y = m[3].length === 2 ? '20' + m[3] : m[3];
      return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    }
    return t.slice(0, 40);
  };
  const toStatus = s => {
    const t = String(s || '').toLowerCase();
    if (!t) return null;
    if (/partial|part/.test(t)) return 'partially_redeemed';
    if (/void|cancel|refund|expired|disabled|revoked/.test(t)) return 'void';
    if (/redeem|used|claimed|complete|spent|^yes$|^true$|^1$/.test(t)) return 'redeemed';
    return 'active';
  };

  $('impImport').addEventListener('click', () => {
    modal.hidden = false;
    const sources = [...$('impSource').options].map(o => o.value).filter(Boolean);
    const batches = window.__impBatches || [];
    body.innerHTML = `
      <h2 style="margin-bottom:6px">Import voucher codes</h2>
      <p class="muted" style="margin-bottom:18px">Upload a CSV export from another voucher system. You'll match its columns up next — nothing is saved until you confirm.</p>
      <div class="field"><label for="impSrc">Which system are these from?</label>
        <input id="impSrc" type="text" list="impSrcList" maxlength="60" placeholder="e.g. GiftUp, Buyagift, Red Letter Days">
        <datalist id="impSrcList">${sources.map(s => `<option value="${esc(s)}">`).join('')}</datalist></div>
      <div class="imp-drop" style="margin-top:14px">
        <input id="impFile" type="file" accept=".csv,text/csv,text/plain">
        <p class="muted" style="margin-top:8px;font-size:.85rem">…or paste the CSV below</p>
        <div class="field" style="margin-top:8px"><textarea id="impPaste" rows="4" placeholder="code,value,balance,name,email"></textarea></div>
      </div>
      <p class="error" id="impErr" hidden></p>
      <div class="redeem-actions"><button class="btn btn-primary" type="button" id="impNextStep">Next: match columns</button></div>
      ${batches.length ? `<h3 class="hist-title">Recent imports</h3>
        <table class="hist imp-batches"><tbody>${batches.map(b => `
          <tr><td>${dt(b.imported_at)}</td><td><strong>${esc(b.source)}</strong></td><td>${b.n} codes</td>
          <td>${b.redemptions ? `<span class="muted">${b.redemptions} used — can't undo</span>` : `<button class="btn btn-ghost btn-sm" type="button" data-undo="${esc(b.batch_id)}">Undo import</button>`}</td></tr>`).join('')}
        </tbody></table>` : ''}`;

    body.querySelectorAll('[data-undo]').forEach(b => b.addEventListener('click', async () => {
      if (!confirm('Delete every code from this import? Codes that have already been used are kept.')) return;
      try {
        const r = await api('/api/admin/imported-vouchers?batch=' + encodeURIComponent(b.dataset.undo), { method: 'DELETE' });
        alert(`Deleted ${r.deleted} codes${r.kept ? `, kept ${r.kept} that have been used` : ''}.`);
        modal.hidden = true;
        loadImported();
      } catch (err) { alert(err.message); }
    }));

    $('impNextStep').addEventListener('click', async () => {
      const err = $('impErr');
      err.hidden = true;
      const source = $('impSrc').value.trim();
      if (!source) { err.textContent = 'Name the system these codes came from.'; err.hidden = false; $('impSrc').focus(); return; }
      let text = $('impPaste').value;
      const file = $('impFile').files[0];
      if (file) {
        if (file.size > 20 * 1024 * 1024) { err.textContent = 'That file is over 20MB.'; err.hidden = false; return; }
        text = await file.text();
      }
      const rows = parseCsv(text || '');
      if (rows.length < 2) { err.textContent = 'Need a header row plus at least one code.'; err.hidden = false; return; }
      mapStep(source, rows[0].map(h => h.trim()), rows.slice(1));
    });
  });

  function mapStep(source, headers, data) {
    const used = new Set();
    const guess = TARGETS.map(([key, , re]) => {
      const i = headers.findIndex((h, idx) => !used.has(idx) && re.test(h));
      if (i >= 0) used.add(i);
      return [key, i];
    });
    const opts = sel => '<option value="-1">— not in this file —</option>'
      + headers.map((h, i) => `<option value="${i}" ${sel === i ? 'selected' : ''}>${esc(h || `Column ${i + 1}`)}</option>`).join('');

    body.innerHTML = `
      <h2 style="margin-bottom:6px">Match the columns</h2>
      <p class="muted" style="margin-bottom:4px"><strong>${data.length}</strong> rows from <strong>${esc(source)}</strong>. Only the code is required.</p>
      <p class="muted" style="font-size:.82rem">Money in pounds (£25 or 25.00). Dates are read UK-style, day first. If there's a value but no balance, the full value counts as unused.</p>
      <div class="imp-map">${TARGETS.map(([key, label, , req], n) => `
        <div class="field"><label for="map-${key}">${label}${req ? ' *' : ''}</label>
          <select id="map-${key}" data-map="${key}">${opts(guess[n][1])}</select></div>`).join('')}
      </div>
      <div class="imp-preview" id="impPreview"></div>
      <p class="error" id="impErr" hidden></p>
      <div class="redeem-actions">
        <button class="btn btn-primary" type="button" id="impGo">Import ${data.length} codes</button>
        <button class="btn btn-ghost" type="button" id="impBack">Back</button>
      </div>`;

    const mapping = () => Object.fromEntries([...body.querySelectorAll('[data-map]')].map(s => [s.dataset.map, Number(s.value)]));
    const cell = (row, i) => (i >= 0 ? String(row[i] ?? '').trim() : '');
    const build = row => {
      const m = mapping();
      const amount = toPence(cell(row, m.amount));
      const balance = toPence(cell(row, m.balance));
      // Same rule the server applies: a spent balance is used, whatever the status column says.
      let status = toStatus(cell(row, m.status));
      if ((!status || status === 'active') && balance !== null) {
        status = balance === 0 ? 'redeemed' : (amount !== null && balance < amount ? 'partially_redeemed' : status);
      }
      return {
        code: cell(row, m.code),
        amount_pence: amount,
        balance_pence: balance,
        description: cell(row, m.description) || null,
        holder_name: cell(row, m.holder_name) || null,
        holder_email: cell(row, m.holder_email) || null,
        status,
        purchased_at: toDate(cell(row, m.purchased_at)),
        expires_at: toDate(cell(row, m.expires_at)),
        notes: cell(row, m.notes) || null,
        raw: Object.fromEntries(headers.map((h, i) => [h || `Column ${i + 1}`, row[i] ?? '']).filter(([, v]) => String(v).trim() !== '')),
      };
    };

    const preview = () => {
      const sample = data.slice(0, 6).map(build);
      $('impPreview').innerHTML = `<table><thead><tr><th>Code</th><th>Value</th><th>Balance</th><th>Description</th><th>Holder</th><th>Status</th><th>Expires</th></tr></thead><tbody>
        ${sample.map(r => `<tr><td><code>${esc(r.code || '(missing)')}</code></td><td>${r.amount_pence != null ? money(r.amount_pence) : '—'}</td>
          <td>${r.balance_pence != null ? money(r.balance_pence) : '—'}</td><td>${esc(r.description || '—')}</td>
          <td>${esc(r.holder_name || r.holder_email || '—')}</td><td>${esc(r.status || 'active')}</td><td>${esc(r.expires_at || '—')}</td></tr>`).join('')}
      </tbody></table>`;
    };
    body.querySelectorAll('[data-map]').forEach(s => s.addEventListener('change', preview));
    preview();
    $('impBack').addEventListener('click', () => $('impImport').click());

    $('impGo').addEventListener('click', async () => {
      const err = $('impErr');
      err.hidden = true;
      if (mapping().code < 0) { err.textContent = 'Choose which column holds the voucher code.'; err.hidden = false; return; }
      const rows = data.map(build);
      const btn = $('impGo');
      btn.disabled = true;
      let batchId = null, inserted = 0, duplicates = 0, invalid = 0;
      try {
        for (let i = 0; i < rows.length; i += 500) {
          btn.textContent = `Importing… ${Math.min(i + 500, rows.length)} / ${rows.length}`;
          const r = await api('/api/admin/imported-vouchers', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ source, batch_id: batchId, rows: rows.slice(i, i + 500) }),
          });
          batchId = r.batch_id;
          inserted += r.inserted; duplicates += r.duplicates; invalid += r.invalid;
        }
        body.innerHTML = `
          <h2 style="margin-bottom:14px">Import finished</h2>
          <div class="balance-box">
            <div class="hl"><span>New codes</span><strong>${inserted}</strong></div>
            <div><span>Already imported</span><strong>${duplicates}</strong></div>
            <div><span>Rows without a code</span><strong>${invalid}</strong></div>
          </div>
          <p class="muted" style="margin-top:16px">These ${esc(source)} codes are now checked against every redemption request in the Inbox. Imported the wrong columns? Reopen “Import codes” and use Undo import.</p>
          <div class="redeem-actions"><button class="btn btn-primary" type="button" data-close>Done</button></div>`;
        page = 1;
        $('impSource').value = '';
        loadImported();
      } catch (e) {
        err.textContent = e.message + (inserted ? ` (${inserted} codes were imported before this failed.)` : '');
        err.hidden = false;
        btn.disabled = false;
        btn.textContent = `Import ${data.length} codes`;
      }
    });
  }
})();
