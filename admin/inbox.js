/* Admin → Inbox. Every enquiry from every network site: forms, embedded
 * widgets, live chat and (once routed) customer email replies.
 *
 * Loaded deferred after the inline script in index.html, whose helpers it
 * uses: api(), esc(), money(), openVoucher(), load(), vouchersLoaded.
 * Routes: #inbox (list) and #inbox/<id> (a conversation).
 */
(function () {
  'use strict';

  const STATUS_CHIPS = [
    ['open', 'Open'], ['new', 'New'], ['dealing', 'Dealing with'],
    ['waiting', 'Awaiting customer'], ['closed', 'Closed'], ['all', 'All'],
  ];
  const VSTATUS = { active: 'Unused', partially_redeemed: 'Part-used', redeemed: 'Fully used', pending: 'Unpaid', void: 'Void', refunded: 'Refunded' };
  const CHANNEL_SHORT = { form: 'form', widget: 'embedded form', chat: 'live chat', web: 'messages page', email: 'email' };

  const state = { status: 'open', type: '', site: '', q: '', page: 1, current: null, labels: null, list: [] };
  let loadedOnce = false;
  let currentThread = null;
  let composerMode = 'reply';

  const $ = id => document.getElementById(id);
  const inboxEl = $('inbox');
  const listEl = $('ibList');
  const threadEl = $('ibThread');

  const parseTs = s => (s ? new Date(String(s).replace(' ', 'T') + 'Z') : null);
  function ago(s) {
    const d = parseTs(s);
    if (!d) return '';
    const mins = Math.round((Date.now() - d.getTime()) / 60000);
    if (mins < 1) return 'now';
    if (mins < 60) return mins + 'm';
    if (mins < 60 * 24) return Math.round(mins / 60) + 'h';
    if (mins < 60 * 24 * 7) return Math.round(mins / 1440) + 'd';
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }
  const when = s => {
    const d = parseTs(s);
    return d ? d.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
  };
  const linkify = s => esc(s).replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)]/g, u => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
  const typeLabel = t => (state.labels?.types?.[t]) || t;
  const statusLabel = s => (state.labels?.statuses?.[s]) || s;

  /* ---------------- list ---------------- */

  async function loadList({ quiet = false } = {}) {
    const params = new URLSearchParams({ status: state.status, type: state.type, site: state.site, q: state.q, page: state.page });
    if (!quiet) listEl.innerHTML = '<li class="muted pad">Loading…</li>';
    try {
      const d = await api('/api/admin/inbox?' + params);
      state.labels = d.labels;
      state.list = d.enquiries;
      loadedOnce = true;

      $('ibStatus').innerHTML = STATUS_CHIPS.map(([key, label]) => {
        const n = d.counts.status[key] || 0;
        return `<button type="button" class="chip-btn${state.status === key ? ' on' : ''}" data-ib-status="${key}">${label}<b>${n}</b></button>`;
      }).join('');

      const typeSel = $('ibType');
      typeSel.innerHTML = '<option value="">All types</option>' + Object.entries(d.labels.types)
        .map(([k, v]) => `<option value="${k}">${esc(v)}${d.counts.type[k] ? ` (${d.counts.type[k]})` : ''}</option>`).join('');
      typeSel.value = state.type;

      const siteSel = $('ibSite');
      siteSel.innerHTML = '<option value="">All websites</option>' + d.sites
        .map(s => `<option value="${esc(s.site)}">${esc(s.label)}</option>`).join('');
      siteSel.value = state.site;

      listEl.innerHTML = d.enquiries.length ? d.enquiries.map(e => `
        <li class="ib-item${e.unread ? ' unread' : ''}${state.current === e.id ? ' active' : ''}" data-ib="${e.id}" tabindex="0">
          <div class="ib-row1"><span class="ib-name">${esc(e.name)}</span><time title="${esc(when(e.last_message_at))}">${ago(e.last_message_at || e.created_at)}</time></div>
          <div class="ib-row2">
            <span class="type-pill type-${esc(e.type)}">${esc(typeLabel(e.type))}</span>
            ${state.status === 'open' || state.status === 'all' ? `<span class="st-pill st-${esc(e.status)}">${esc(statusLabel(e.status))}</span>` : ''}
            <span class="ib-site">${esc(e.site_label)}${e.channel === 'chat' ? ' · chat' : ''}</span>
          </div>
          <div class="ib-snippet">${e.last_direction === 'out' ? '<strong>You:</strong> ' : ''}${esc(e.snippet || '')}</div>
        </li>`).join('')
        : `<li class="muted pad">${state.q || state.type || state.site ? 'Nothing matches those filters.' : state.status === 'open' ? 'Inbox zero — nothing open. 🍺' : 'No conversations here.'}</li>`;

      $('ibPager').hidden = state.page <= 1 && !d.hasMore;
      $('ibPage').textContent = 'Page ' + state.page;
      $('ibPrev').disabled = state.page <= 1;
      $('ibNext').disabled = !d.hasMore;
      setBadge(d.unread);
    } catch (err) {
      if (!quiet) listEl.innerHTML = `<li class="pad error">${esc(err.message)}</li>`;
    }
  }

  function setBadge(n) {
    const b = $('inboxBadge');
    b.hidden = !n;
    b.textContent = n > 99 ? '99+' : String(n);
    document.title = (n ? `(${n}) ` : '') + 'Admin — UK Brewery Tours';
  }

  $('ibStatus').addEventListener('click', e => {
    const b = e.target.closest('[data-ib-status]');
    if (!b) return;
    state.status = b.dataset.ibStatus; state.page = 1; loadList();
  });
  $('ibType').addEventListener('change', e => { state.type = e.target.value; state.page = 1; loadList(); });
  $('ibSite').addEventListener('change', e => { state.site = e.target.value; state.page = 1; loadList(); });
  let qTimer;
  $('ibQ').addEventListener('input', e => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { state.q = e.target.value.trim(); state.page = 1; loadList(); }, 300);
  });
  $('ibPrev').addEventListener('click', () => { if (state.page > 1) { state.page--; loadList(); } });
  $('ibNext').addEventListener('click', () => { state.page++; loadList(); });

  function go(id) { location.hash = 'inbox/' + id; }
  listEl.addEventListener('click', e => { const li = e.target.closest('[data-ib]'); if (li) go(li.dataset.ib); });
  listEl.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const li = e.target.closest('[data-ib]'); if (li) go(li.dataset.ib);
  });

  /* ---------------- conversation ---------------- */

  const draftKey = id => 'ib_draft_' + id;
  const getDraft = id => { try { return localStorage.getItem(draftKey(id)); } catch { return null; } };
  const setDraft = (id, v) => { try { v ? localStorage.setItem(draftKey(id), v) : localStorage.removeItem(draftKey(id)); } catch { /* private mode */ } };

  async function openThread(id, { keepScroll = false } = {}) {
    state.current = id;
    inboxEl.classList.add('show-thread');
    listEl.querySelectorAll('.ib-item').forEach(li => {
      const on = Number(li.dataset.ib) === id;
      li.classList.toggle('active', on);
      if (on) li.classList.remove('unread');
    });
    if (!keepScroll) threadEl.innerHTML = '<div class="thread-empty">Loading…</div>';

    let d;
    try {
      d = await api('/api/admin/inbox/' + id);
    } catch (err) {
      threadEl.innerHTML = `<div class="thread-empty"><strong>Couldn't open that conversation</strong>${esc(err.message)}</div>`;
      return;
    }
    if (state.current !== id) return;
    state.labels = d.labels;
    currentThread = d;
    renderThread(d, keepScroll);
  }

  function renderThread(d, keepScroll) {
    const e = d.enquiry;
    const scroller = threadEl.querySelector('.th-scroll');
    const prevScroll = scroller ? scroller.scrollTop : 0;
    const first = String(e.name || '').split(/\s+/)[0];
    const lastIn = [...d.messages].reverse().find(m => m.direction === 'in');

    threadEl.innerHTML = `
      <div class="th-head">
        <button class="btn btn-ghost btn-sm th-back" type="button" id="thBack">← Inbox</button>
        <div class="th-title">
          <h2>${esc(e.name)} <span class="type-pill type-${esc(e.type)}">${esc(typeLabel(e.type))}</span></h2>
          <div class="th-contact">
            <a href="mailto:${esc(e.email)}">${esc(e.email)}</a>
            ${e.phone ? `<a href="tel:${esc(String(e.phone).replace(/[^\d+]/g, ''))}">${esc(e.phone)}</a>` : ''}
          </div>
        </div>
        <div class="th-actions">
          <div class="seg" role="group" aria-label="Status">
            ${Object.entries(d.labels.statuses).map(([k, v]) =>
              `<button type="button" data-th-status="${k}" class="${e.status === k ? 'on' : ''}">${esc(v)}</button>`).join('')}
          </div>
          <select id="thType" aria-label="Enquiry type">
            ${Object.entries(d.labels.types).map(([k, v]) => `<option value="${k}" ${e.type === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}
          </select>
        </div>
      </div>

      <div class="th-scroll">
        <div class="th-meta">
          <span>#${e.id}</span>
          <span>${esc(e.site_label)} · ${esc(e.channel_label)}${e.widget_name ? ` (${esc(e.widget_name)})` : ''}</span>
          <span>Received ${esc(when(e.created_at))}</span>
          ${e.page ? `<span>From ${/^https?:/.test(e.page) ? `<a href="${esc(e.page)}" target="_blank" rel="noopener">${esc(e.page.replace(/^https?:\/\/(www\.)?/, ''))}</a>` : esc(e.page)}</span>` : ''}
          <a href="${esc(e.thread_url)}" target="_blank" rel="noopener" title="The page the customer sees">Customer's view ↗</a>
          <button type="button" class="btn btn-ghost btn-sm" id="thDelete" style="padding:0 6px;font-size:.78rem">Delete (spam)</button>
        </div>

        ${e.fields.length || e.voucher_code ? `<div class="th-fields">
          ${e.voucher_code ? `<div><span>Voucher code given</span><code>${esc(e.voucher_code)}</code></div>` : ''}
          ${e.fields.map(f => `<div><span>${esc(f.label)}</span>${esc(f.value)}</div>`).join('')}
        </div>` : ''}

        ${voucherCard(d)}

        <div class="timeline">${d.messages.map(m => timelineItem(m, e)).join('')}</div>
      </div>

      <div class="th-composer${composerMode === 'note' ? ' note-mode' : ''}" id="thComposer">
        <div class="composer-tabs">
          <button type="button" data-mode="reply" class="${composerMode === 'reply' ? 'on' : ''}">Reply to ${esc(first || 'customer')}</button>
          <button type="button" data-mode="note" class="${composerMode === 'note' ? 'on' : ''}">Internal note</button>
        </div>
        <textarea id="thText" aria-label="Message"></textarea>
        <p class="error" id="thError" hidden></p>
        <div class="composer-foot">
          <span class="muted" id="thHint"></span>
          <div class="send-row">
            <label class="muted" id="thAfterWrap">then mark
              <select id="thAfter">
                <option value="waiting">Awaiting customer</option>
                <option value="dealing">Dealing with</option>
                <option value="closed">Closed</option>
              </select>
            </label>
            <button class="btn btn-primary" type="button" id="thSend">Send reply</button>
          </div>
        </div>
      </div>`;

    // Composer: restore the draft, or start a greeting and sign-off.
    const text = $('thText');
    const draft = getDraft(e.id);
    const signOff = `\n\nCheers,\n${e.brand}`;
    if (draft !== null) text.value = draft;
    else if (composerMode === 'reply') text.value = `Hi ${first},\n\n${signOff}`;
    syncComposer(e);
    text.addEventListener('input', () => setDraft(e.id, text.value));
    if (!draft && composerMode === 'reply' && !keepScroll && window.innerWidth > 900) {
      const pos = `Hi ${first},\n\n`.length;
      // Focus without scrolling the page on open; the caret sits under the greeting.
      text.focus({ preventScroll: true });
      text.setSelectionRange(pos, pos);
    }

    const sc = threadEl.querySelector('.th-scroll');
    if (keepScroll) sc.scrollTop = prevScroll;
    else if (window.innerWidth > 900) sc.scrollTop = sc.scrollHeight;
    else window.scrollTo({ top: 0 });

    $('thBack').addEventListener('click', () => { location.hash = 'inbox'; });
    threadEl.querySelectorAll('[data-th-status]').forEach(b => b.addEventListener('click', () => patch(e.id, { status: b.dataset.thStatus })));
    $('thType').addEventListener('change', ev => patch(e.id, { type: ev.target.value }));
    $('thDelete').addEventListener('click', async () => {
      if (!confirm(`Delete this conversation with ${e.name}?\n\nUse this for spam only — it can't be undone. To file a real enquiry away, mark it Closed instead.`)) return;
      try {
        await api('/api/admin/inbox/' + e.id, { method: 'DELETE' });
        setDraft(e.id, null);
        state.current = null;
        location.hash = 'inbox';
        loadList();
      } catch (err) { alert(err.message); }
    });
    threadEl.querySelectorAll('.composer-tabs button').forEach(b => b.addEventListener('click', () => {
      composerMode = b.dataset.mode;
      threadEl.querySelectorAll('.composer-tabs button').forEach(x => x.classList.toggle('on', x === b));
      $('thComposer').classList.toggle('note-mode', composerMode === 'note');
      const squash = s => s.replace(/\s+/g, ' ').trim();
      if (composerMode === 'note' && squash(text.value) === squash(`Hi ${first},${signOff}`)) { text.value = ''; setDraft(e.id, null); }
      syncComposer(e);
      text.focus();
    }));
    $('thSend').addEventListener('click', () => send(e, lastIn));
    text.addEventListener('keydown', ev => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') { ev.preventDefault(); send(e, lastIn); }
    });
    bindVoucherCard(d);
  }

  function syncComposer(e) {
    const reply = composerMode === 'reply';
    $('thAfterWrap').hidden = !reply;
    $('thSend').textContent = reply ? 'Send reply' : 'Save note';
    $('thHint').textContent = reply
      ? `Emails ${e.email} from info@ukbrewerytours.com · Ctrl+Enter to send`
      : 'Only visible here — never sent to the customer';
    // A reply usually leaves the ball with the customer; a closed thread stays closed unless changed.
    if (reply) $('thAfter').value = 'waiting';
  }

  function timelineItem(m, e) {
    if (m.direction === 'event') {
      return `<div class="tl-event">${esc(m.body)} · ${esc(when(m.created_at))}</div>`;
    }
    if (m.direction === 'note') {
      return `<div class="tl-note"><div class="tl-by">📝 Note · ${esc(m.author || '')} · ${esc(when(m.created_at))}</div>${linkify(m.body)}</div>`;
    }
    const out = m.direction === 'out';
    const by = out
      ? `${esc(m.author || 'You')} · emailed · ${esc(when(m.created_at))}`
      : `${esc(m.author || e.name)} · via ${esc(CHANNEL_SHORT[m.channel] || m.channel)} · ${esc(when(m.created_at))}`;
    return `<div class="tl-msg ${out ? 'out' : 'in'}"><div class="tl-by">${by}</div><div class="tl-body">${linkify(m.body)}</div></div>`;
  }

  async function patch(id, body) {
    try {
      await api('/api/admin/inbox/' + id, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      await openThread(id, { keepScroll: true });
      loadList({ quiet: true });
    } catch (err) { alert(err.message); }
  }

  async function send(e, lastIn) {
    const text = $('thText');
    const errEl = $('thError');
    const btn = $('thSend');
    errEl.hidden = true;
    const body = text.value.trim();
    const reply = composerMode === 'reply';
    const first = String(e.name || '').split(/\s+/)[0];
    const squash = s => s.replace(/\s+/g, ' ').trim();
    if (!body || (reply && squash(body) === squash(`Hi ${first}, Cheers, ${e.brand}`))) {
      errEl.textContent = reply ? 'Write your reply first.' : 'Write a note first.';
      errEl.hidden = false;
      return;
    }
    if (reply && !confirm(`Send this reply to ${e.email}?`)) return;

    btn.disabled = true;
    btn.textContent = reply ? 'Sending…' : 'Saving…';
    try {
      if (reply) {
        await api(`/api/admin/inbox/${e.id}/reply`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ body, status: $('thAfter').value }),
        });
      } else {
        await api(`/api/admin/inbox/${e.id}/note`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body }),
        });
      }
      setDraft(e.id, null);
      composerMode = 'reply';
      await openThread(e.id);
      loadList({ quiet: true });
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
      btn.disabled = false;
      btn.textContent = reply ? 'Send reply' : 'Save note';
    }
  }

  /* ---------------- voucher check ---------------- */

  function voucherCard(d) {
    const { matches, unmatched } = d.vouchers;
    const e = d.enquiry;
    if (!matches.length && !unmatched.length && e.type !== 'redemption') {
      return `<div class="vcheck" style="background:transparent;border-style:dashed">
        <div class="vcheck-head" style="margin:0"><h3 class="muted" style="font-weight:600">Voucher check</h3>${checkForm()}</div>
        <div id="vcExtra"></div></div>`;
    }
    return `<div class="vcheck">
      <div class="vcheck-head"><h3>Voucher check</h3>${checkForm()}</div>
      ${matches.map(m => matchCard(m, e)).join('')}
      ${unmatched.map(c => `<div class="vc-miss">❌ <code>${esc(c)}</code> — no match in UK Brewery Tours vouchers or imported codes. Check for a typo, or search it with the box above.</div>`).join('')}
      ${!matches.length && !unmatched.length ? '<p class="vc-none">No voucher code found in this conversation — ask the customer for it, or check one above.</p>' : ''}
      <div id="vcExtra"></div>
    </div>`;
  }

  const checkForm = () => `<form id="vcForm"><input id="vcCode" placeholder="Check a code" aria-label="Voucher code to check" autocomplete="off"><button class="btn btn-sm" type="submit">Check</button></form>`;

  function matchCard(m, e) {
    const tracked = m.balance_pence !== null && m.balance_pence !== undefined;
    const dead = ['redeemed', 'void', 'pending', 'refunded'].includes(m.status) || (tracked && m.balance_pence <= 0);
    const expired = m.expires_at && /^\d{4}-\d{2}-\d{2}/.test(m.expires_at) && new Date(m.expires_at.slice(0, 10) + 'T23:59:59') < new Date();
    let fields = {};
    try { fields = Object.fromEntries((e.fields || []).map(f => [f.key, f.value])); } catch { fields = {}; }
    const defaultNote = [`Enquiry #${e.id}`, fields.tour, fields.preferred_date].filter(Boolean).join(' — ');
    const key = `${m.kind}-${m.id}`;

    const nums = tracked
      ? `Balance <strong>${money(m.balance_pence)}</strong>${m.amount_pence !== null && m.amount_pence !== undefined ? ` <span class="muted">of ${money(m.amount_pence)}</span>` : ''}${m.refunded_pence ? ` <span class="muted">· ${money(m.refunded_pence)} refunded</span>` : ''}`
      : `<span class="muted">No value recorded</span>${m.description ? ` — <strong>${esc(m.description)}</strong>` : ''}`;

    let actions = '';
    if (m.kind === 'ukbt' || tracked) {
      actions = dead ? '' : `
        <div class="vc-redeem" data-vc="${key}">
          <input type="number" step="0.01" min="0.01" max="${(m.balance_pence / 100).toFixed(2)}" placeholder="£ amount" aria-label="Amount to redeem">
          <input type="text" value="${esc(defaultNote)}" aria-label="Redemption note" maxlength="300">
          <button class="btn btn-primary btn-sm" type="button" data-vc-act="amount">Redeem amount</button>
          <button class="btn btn-outline btn-sm" type="button" data-vc-act="full">Redeem full ${money(m.balance_pence)}</button>
        </div>`;
    } else {
      actions = `
        <div class="vc-redeem" data-vc="${key}">
          <input type="text" value="${esc(defaultNote)}" aria-label="Note" maxlength="300">
          ${m.status !== 'redeemed' ? '<button class="btn btn-primary btn-sm" type="button" data-vc-act="redeemed">Mark fully used</button>' : ''}
          ${m.status !== 'partially_redeemed' && m.status !== 'redeemed' ? '<button class="btn btn-outline btn-sm" type="button" data-vc-act="partially_redeemed">Mark partly used</button>' : ''}
          ${m.status !== 'active' ? '<button class="btn btn-ghost btn-sm" type="button" data-vc-act="active">Reinstate</button>' : ''}
        </div>`;
    }

    return `<div class="vc-card${dead || expired ? ' bad' : ''}">
      <div class="vc-top">
        <code>${esc(m.code)}</code>
        <span class="pill pill-${esc(m.status)}">${esc(VSTATUS[m.status] || m.status)}</span>
        <span class="tag">${esc(m.source)}</span>
        ${m.is_demo ? '<span class="tag">demo</span>' : ''}
        <button class="btn btn-ghost btn-sm" type="button" data-vc-open="${key}" data-code="${esc(m.code)}" style="margin-left:auto">Details</button>
      </div>
      <div class="vc-nums">${nums}</div>
      <div class="vc-who muted">${[
        m.holder_name || m.holder_email ? `Holder: ${esc(m.holder_name || '')}${m.holder_email ? ` &lt;${esc(m.holder_email)}&gt;` : ''}` : '',
        m.purchaser_name && m.purchaser_name !== m.holder_name ? `bought by ${esc(m.purchaser_name)}` : '',
        m.purchased_at ? `issued ${esc(String(m.purchased_at).slice(0, 10))}` : '',
        m.expires_at ? `expires ${esc(m.expires_at)}` : '',
      ].filter(Boolean).join(' · ')}</div>
      ${m.holder_email && e.email && m.holder_email.toLowerCase() !== e.email.toLowerCase()
        ? `<div class="vc-msg muted">Issued to a different email from this enquiry's (${esc(e.email)}) — normal for gifts, but worth a glance.</div>` : ''}
      ${expired ? `<div class="vc-warn">⚠ Expired ${esc(m.expires_at)}</div>` : ''}
      ${m.status === 'pending' ? '<div class="vc-warn">⚠ Never paid for — do not redeem.</div>' : ''}
      ${actions}
      <p class="error" data-vc-err="${key}" hidden></p>
    </div>`;
  }

  function bindVoucherCard(d) {
    const e = d.enquiry;
    const byKey = Object.fromEntries(d.vouchers.matches.map(m => [`${m.kind}-${m.id}`, m]));

    const form = $('vcForm');
    if (form) form.addEventListener('submit', async ev => {
      ev.preventDefault();
      const code = $('vcCode').value.trim();
      const out = $('vcExtra');
      if (!code) return;
      out.innerHTML = '<p class="vc-none">Checking…</p>';
      try {
        const r = await api('/api/admin/voucher-lookup?code=' + encodeURIComponent(code));
        r.matches.forEach(m => { byKey[`${m.kind}-${m.id}`] = m; });
        out.innerHTML = r.matches.map(m => matchCard(m, e)).join('')
          + r.unmatched.map(c => `<div class="vc-miss">❌ <code>${esc(c)}</code> — not found anywhere.</div>`).join('');
      } catch (err) {
        out.innerHTML = `<p class="error">${esc(err.message)}</p>`;
      }
    });

    threadEl.querySelector('.vcheck')?.addEventListener('click', async ev => {
      const open = ev.target.closest('[data-vc-open]');
      if (open) {
        const m = byKey[open.dataset.vcOpen];
        if (m?.kind === 'ukbt') openVoucher(m.code);
        else if (m) window.openImported?.(m.id);
        return;
      }
      const btn = ev.target.closest('[data-vc-act]');
      if (!btn) return;
      const wrap = btn.closest('[data-vc]');
      const m = byKey[wrap.dataset.vc];
      if (!m) return;
      const errEl = threadEl.querySelector(`[data-vc-err="${wrap.dataset.vc}"]`);
      errEl.hidden = true;
      const act = btn.dataset.vcAct;
      const note = wrap.querySelector('input[type="text"]').value;
      const amountInput = wrap.querySelector('input[type="number"]');

      let url, payload, question;
      if (act === 'amount' || act === 'full') {
        const amount = act === 'full' ? m.balance_pence / 100 : Number(amountInput?.value);
        if (!(amount > 0)) { errEl.textContent = 'Enter an amount to redeem.'; errEl.hidden = false; amountInput?.focus(); return; }
        question = `Redeem £${amount.toFixed(2)} from ${m.code}?\n\nBalance afterwards: £${((m.balance_pence / 100) - amount).toFixed(2)}`;
        payload = { note, enquiry_id: e.id, ...(act === 'full' ? { full: true } : { amount }) };
        if (m.kind === 'ukbt') { url = '/api/admin/redeem'; payload.code = m.code; }
        else { url = '/api/admin/imported-voucher/' + m.id; payload.action = 'redeem'; }
      } else {
        const words = { redeemed: 'fully used', partially_redeemed: 'partly used', active: 'reinstated (unused)' };
        question = `Mark ${m.code} as ${words[act]}?`;
        url = '/api/admin/imported-voucher/' + m.id;
        payload = { action: act, note, enquiry_id: e.id };
      }
      if (!confirm(question)) return;

      wrap.querySelectorAll('button').forEach(b => { b.disabled = true; });
      try {
        await api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        if (typeof vouchersLoaded !== 'undefined' && vouchersLoaded) { load(); window.loadImported?.(); }
        await openThread(e.id, { keepScroll: true });
      } catch (err) {
        errEl.textContent = err.message;
        errEl.hidden = false;
        wrap.querySelectorAll('button').forEach(b => { b.disabled = false; });
      }
    });
  }

  /* ---------------- routing + refresh ---------------- */

  window.inboxRoute = function (sub) {
    if (!loadedOnce) loadList();
    const id = /^\d+$/.test(sub || '') ? Number(sub) : null;
    if (id) {
      if (state.current !== id || !threadEl.querySelector('.th-head')) openThread(id);
    } else {
      state.current = null;
      inboxEl.classList.remove('show-thread');
      listEl.querySelectorAll('.ib-item.active').forEach(li => li.classList.remove('active'));
      if (window.innerWidth <= 900) threadEl.innerHTML = '<div class="thread-empty"><strong>No conversation selected</strong>Pick one from the list to read and reply.</div>';
    }
  };

  // Refresh every minute while the tab is visible. The open conversation is only
  // re-rendered when it has something new and nobody is typing in it.
  setInterval(async () => {
    if (document.visibilityState !== 'visible') return;
    const panel = document.querySelector('[data-panel="inbox"]');
    if (panel.hidden) {
      try { const d = await api('/api/admin/inbox?status=open&page=1'); setBadge(d.unread); } catch { /* ignore */ }
      return;
    }
    const before = state.list.find(x => x.id === state.current);
    await loadList({ quiet: true });
    const after = state.list.find(x => x.id === state.current);
    const typing = document.activeElement && document.activeElement.id === 'thText';
    if (state.current && before && after && after.message_count !== before.message_count && !typing) {
      openThread(state.current, { keepScroll: true });
    }
  }, 60000);
})();
