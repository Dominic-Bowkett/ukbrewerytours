/* Team portal → My messages.
 *
 * Only the conversations assigned to the signed-in member: the API scopes every
 * query on the session's member id, so there is nothing here that can widen it.
 * They can reply (from their own address), change status and add notes. There is
 * no assigning, no deleting and no voucher redeeming — those stay with the admin.
 *
 * Loaded deferred after the inline script in team/index.html (api(), esc()).
 */
(function () {
  'use strict';

  const STATUS_CHIPS = [
    ['open', 'Open'], ['new', 'New'], ['dealing', 'Dealing with'],
    ['waiting', 'Awaiting customer'], ['closed', 'Closed'], ['all', 'All'],
  ];
  const VSTATUS = { active: 'Unused', partially_redeemed: 'Part-used', redeemed: 'Fully used', pending: 'Unpaid', void: 'Void', refunded: 'Refunded' };
  const CHANNEL_SHORT = { form: 'form', widget: 'embedded form', chat: 'live chat', web: 'messages page', email: 'email', phone: 'phone call' };
  const THREAD_POLL = 4000;
  const LIST_POLL = 15000;

  const state = { status: 'open', q: '', page: 1, current: null, labels: null, list: [] };
  let loadedOnce = false;
  let currentThread = null;
  let composerMode = 'reply';
  let lastMsgId = 0;
  let threadPolling = false;
  let lastThreadPoll = 0;
  let since = null;
  const alerted = new Set();

  const $ = id => document.getElementById(id);
  const inboxEl = $('inbox');
  const listEl = $('ibList');
  const threadEl = $('ibThread');
  const money = p => '£' + ((p || 0) / 100).toFixed(2);

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
    const params = new URLSearchParams({ status: state.status, q: state.q, page: state.page });
    if (since) params.set('since', since);
    if (!quiet) listEl.innerHTML = '<li class="muted pad">Loading…</li>';
    try {
      const d = await api('/api/team/inbox?' + params);
      announce(d);
      state.labels = d.labels;
      state.list = d.enquiries;
      loadedOnce = true;
      if (state.current) setTimeout(pollThread, 0);

      $('ibStatus').innerHTML = STATUS_CHIPS.map(([key, label]) => {
        const n = d.counts.status[key] || 0;
        return `<button type="button" class="chip-btn${state.status === key ? ' on' : ''}" data-ib-status="${key}">${label}<b>${n}</b></button>`;
      }).join('');

      listEl.innerHTML = d.enquiries.length ? d.enquiries.map(e => `
        <li class="ib-item${e.unread ? ' unread' : ''}${state.current === e.id ? ' active' : ''}" data-ib="${e.id}" tabindex="0">
          <div class="ib-row1"><span class="ib-name">${esc(e.name)}</span><time title="${esc(when(e.last_message_at))}">${ago(e.last_message_at || e.created_at)}</time></div>
          <div class="ib-row2">
            <span class="type-pill type-${esc(e.type)}">${esc(typeLabel(e.type))}</span>
            <span class="st-pill st-${esc(e.status)}">${esc(statusLabel(e.status))}</span>
            ${e.phone ? `<a class="ib-call" href="tel:${esc(String(e.phone).replace(/[^\d+]/g, ''))}" title="Call ${esc(e.phone)}" onclick="event.stopPropagation()">📞 ${esc(e.phone)}</a>` : ''}
            <span class="ib-site">${esc(e.site_label)}${e.channel === 'chat' ? ' · chat' : ''}</span>
          </div>
          <div class="ib-snippet">${e.last_direction === 'out' ? '<strong>You:</strong> ' : ''}${esc(e.snippet || '')}</div>
        </li>`).join('')
        : `<li class="muted pad">${state.q ? 'Nothing matches that search.' : state.status === 'open' ? 'Nothing open — all caught up. 🍺' : 'Nothing here.'}</li>`;

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
    document.title = (n ? `(${n}) ` : '') + 'Team portal — UK Brewery Tours';
  }

  /* ---------------- alerts ---------------- */

  const notifySupported = 'Notification' in window && window.isSecureContext;
  const notifyWanted = () => { try { return localStorage.getItem('team_notify') === '1'; } catch { return false; } };
  const notifyOn = () => notifySupported && notifyWanted() && Notification.permission === 'granted';

  function syncNotifyButton() {
    const btn = $('ibNotify');
    if (!notifySupported) { btn.hidden = true; return; }
    btn.hidden = false;
    const on = notifyOn();
    btn.classList.toggle('on', on);
    btn.textContent = on ? '🔔 Alerts on' : Notification.permission === 'denied' ? '🔕 Alerts blocked' : '🔕 Alerts off';
  }
  $('ibNotify').addEventListener('click', async () => {
    if (Notification.permission === 'denied') {
      alert('Notifications are blocked for this site in your browser settings. Allow them there, then turn alerts on.');
      return;
    }
    if (notifyOn()) {
      try { localStorage.setItem('team_notify', '0'); } catch { /* ignore */ }
    } else {
      const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
      try { localStorage.setItem('team_notify', perm === 'granted' ? '1' : '0'); } catch { /* ignore */ }
    }
    syncNotifyButton();
  });
  syncNotifyButton();

  function announce(d) {
    const first = since === null;
    since = d.server_now || since;
    for (const r of d.recent_inbound || []) {
      const key = `${r.id}@${r.last_inbound_at}`;
      if (alerted.has(key)) continue;
      alerted.add(key);
      if (first) continue;
      const watching = document.visibilityState === 'visible' && state.current === r.id;
      if (watching) continue;
      if (document.visibilityState !== 'visible' && notifyOn()) {
        const n = new Notification(`New message from ${r.name}`, { body: r.snippet || '', tag: 'tm-' + r.id });
        n.onclick = () => { window.focus(); location.hash = 'inbox/' + r.id; n.close(); };
      } else if (document.visibilityState === 'visible') {
        toast(r);
      }
    }
  }

  let toastTimer;
  function toast(r) {
    let el = $('ibToast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'ibToast';
      el.className = 'ib-toast';
      el.hidden = true;
      document.body.appendChild(el);
    }
    el.innerHTML = `<strong>New message from ${esc(r.name)}</strong><span>${esc(r.snippet || '')}</span>`;
    el.hidden = false;
    el.onclick = () => { el.hidden = true; location.hash = 'inbox/' + r.id; };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 8000);
  }

  $('ibStatus').addEventListener('click', e => {
    const b = e.target.closest('[data-ib-status]');
    if (!b) return;
    state.status = b.dataset.ibStatus; state.page = 1; loadList();
  });
  let qTimer;
  $('ibQ').addEventListener('input', e => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { state.q = e.target.value.trim(); state.page = 1; loadList(); }, 300);
  });
  $('ibPrev').addEventListener('click', () => { if (state.page > 1) { state.page--; loadList(); } });
  $('ibNext').addEventListener('click', () => { state.page++; loadList(); });
  const go = id => { location.hash = 'inbox/' + id; };
  listEl.addEventListener('click', e => { const li = e.target.closest('[data-ib]'); if (li) go(li.dataset.ib); });
  listEl.addEventListener('keydown', e => { if (e.key === 'Enter') { const li = e.target.closest('[data-ib]'); if (li) go(li.dataset.ib); } });

  /* ---------------- conversation ---------------- */

  const draftKey = id => 'tm_draft_' + id;
  const getDraft = id => { try { return localStorage.getItem(draftKey(id)); } catch { return null; } };
  const setDraft = (id, v) => { try { v ? localStorage.setItem(draftKey(id), v) : localStorage.removeItem(draftKey(id)); } catch { /* private mode */ } };

  async function openThread(id, { keepScroll = false } = {}) {
    // A different conversation starts on Reply again (see the admin equivalent).
    if (state.current !== id) composerMode = 'reply';
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
      d = await api('/api/team/inbox/' + id);
    } catch (err) {
      threadEl.innerHTML = `<div class="thread-empty"><strong>Couldn't open that conversation</strong>${esc(err.message)}</div>`;
      return;
    }
    if (state.current !== id) return;
    state.labels = d.labels;
    currentThread = d;
    render(d, keepScroll);
  }

  function render(d, keepScroll) {
    const e = d.enquiry;
    const scroller = threadEl.querySelector('.th-scroll');
    const prevScroll = scroller ? scroller.scrollTop : 0;
    const first = String(e.name || '').split(/\s+/)[0];
    const sendAs = window.teamMe?.inboxFrom || 'your address';
    // Phone callers often leave no email — then there is nothing to reply to,
    // and the composer is notes-only.
    const canEmail = e.can_email !== false;
    if (!canEmail) composerMode = 'note';

    threadEl.innerHTML = `
      <div class="th-head">
        <button class="btn btn-ghost btn-sm th-back" type="button" id="thBack">← Messages</button>
        <div class="th-title">
          <h2>${esc(e.name)} <span class="type-pill type-${esc(e.type)}">${esc(typeLabel(e.type))}</span></h2>
          <div class="th-contact">
            ${e.phone
              ? `<a class="btn-call" href="tel:${esc(String(e.phone).replace(/[^\d+]/g, ''))}">📞 Call ${esc(e.phone)}</a>`
              : '<span class="muted">No phone number given — reply below</span>'}
          </div>
        </div>
        <div class="th-actions">
          <div class="seg" role="group" aria-label="Status">
            ${Object.entries(d.labels.statuses).map(([k, v]) =>
              `<button type="button" data-th-status="${k}" class="${e.status === k ? 'on' : ''}">${esc(v)}</button>`).join('')}
          </div>
        </div>
      </div>

      <div class="th-scroll">
        <div class="th-meta">
          <span class="th-live" title="New messages appear here automatically">Live</span>
          <span>#${e.id}</span>
          <span>${esc(e.site_label)} · ${esc(e.channel_label)}</span>
          <span>Received ${esc(when(e.created_at))}</span>
        </div>

        ${e.fields.length || e.voucher_code ? `<div class="th-fields">
          ${e.voucher_code ? `<div><span>Voucher code given</span><code>${esc(e.voucher_code)}</code></div>` : ''}
          ${e.fields.map(f => `<div><span>${esc(f.label)}</span>${esc(f.value)}</div>`).join('')}
        </div>` : ''}

        ${voucherCard(d)}

        <div class="timeline">${d.messages.map(m => item(m, e)).join('')}</div>
        <button type="button" class="th-newpill" id="thNewPill" hidden>↓ New message</button>
      </div>

      <div class="th-composer${composerMode === 'note' ? ' note-mode' : ''}" id="thComposer">
        <div class="composer-tabs">
          ${canEmail
            ? `<button type="button" data-mode="reply" class="${composerMode === 'reply' ? 'on' : ''}">Reply to ${esc(first || 'customer')}</button>`
            : `<span class="composer-nomail">📞 No email address — ${e.phone ? 'call them back' : 'nothing to reply to'}. Notes are saved here.</span>`}
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

    const text = $('thText');
    const draft = getDraft(e.id);
    const signOff = `\n\nCheers,\n${window.teamMe?.inboxFromName || e.brand}`;
    if (draft !== null) text.value = draft;
    else if (composerMode === 'reply') text.value = `Hi ${first},\n\n${signOff}`;
    syncComposer(e, sendAs, canEmail);
    text.addEventListener('input', () => setDraft(e.id, text.value));
    if (!draft && composerMode === 'reply' && !keepScroll && window.innerWidth > 900) {
      const pos = `Hi ${first},\n\n`.length;
      text.focus({ preventScroll: true });
      text.setSelectionRange(pos, pos);
    }

    const sc = threadEl.querySelector('.th-scroll');
    if (keepScroll) sc.scrollTop = prevScroll;
    else if (window.innerWidth > 900) sc.scrollTop = sc.scrollHeight;
    else window.scrollTo({ top: 0 });

    lastMsgId = d.messages.reduce((max, m) => Math.max(max, m.id), 0);
    $('thNewPill').addEventListener('click', () => {
      const firstNew = threadEl.querySelector('.timeline .tl-unseen');
      const target = firstNew || threadEl.querySelector('.timeline > :last-child');
      if (target) reveal(target, firstNew ? 'center' : 'end');
      clearUnseen();
    });
    sc.addEventListener('scroll', () => { if (isNearBottom()) clearUnseen(); }, { passive: true });

    $('thBack').addEventListener('click', () => { location.hash = 'inbox'; });
    threadEl.querySelectorAll('[data-th-status]').forEach(b => b.addEventListener('click', async () => {
      try {
        await api('/api/team/inbox/' + e.id, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: b.dataset.thStatus }),
        });
        await openThread(e.id, { keepScroll: true });
        loadList({ quiet: true });
      } catch (err) { alert(err.message); }
    }));
    threadEl.querySelectorAll('.composer-tabs button').forEach(b => b.addEventListener('click', () => {
      composerMode = b.dataset.mode;
      threadEl.querySelectorAll('.composer-tabs button').forEach(x => x.classList.toggle('on', x === b));
      $('thComposer').classList.toggle('note-mode', composerMode === 'note');
      const squash = s => s.replace(/\s+/g, ' ').trim();
      if (composerMode === 'note' && squash(text.value) === squash(`Hi ${first},${signOff}`)) { text.value = ''; setDraft(e.id, null); }
      syncComposer(e, sendAs, canEmail);
      text.focus();
    }));
    $('thSend').addEventListener('click', () => send(e));
    text.addEventListener('keydown', ev => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') { ev.preventDefault(); send(e); }
    });
  }

  function syncComposer(e, sendAs, canEmail = true) {
    const reply = composerMode === 'reply' && canEmail;
    $('thAfterWrap').hidden = !reply;
    $('thSend').textContent = reply ? 'Send reply' : 'Save note';
    $('thText').placeholder = reply ? '' : 'Note for you and the office — what was said, what you agreed…';
    $('thHint').textContent = reply
      ? `Emails ${e.name} from ${sendAs} · Ctrl+Enter to send`
      : 'Only visible to you and the office — never sent to the customer';
    if (reply) $('thAfter').value = 'waiting';
  }

  function item(m, e) {
    if (m.direction === 'event') return `<div class="tl-event">${esc(m.body)} · ${esc(when(m.created_at))}</div>`;
    if (m.direction === 'note') return `<div class="tl-note"><div class="tl-by">📝 Note · ${esc(m.author || '')} · ${esc(when(m.created_at))}</div>${linkify(m.body)}</div>`;
    const out = m.direction === 'out';
    const by = out
      ? `${esc(m.author || 'You')} · emailed · ${esc(when(m.created_at))}`
      : `${esc(m.author || e.name)} · via ${esc(CHANNEL_SHORT[m.channel] || m.channel)} · ${esc(when(m.created_at))}`;
    return `<div class="tl-msg ${out ? 'out' : 'in'}"><div class="tl-by">${by}</div><div class="tl-body">${linkify(m.body)}</div></div>`;
  }

  async function send(e) {
    const text = $('thText');
    const errEl = $('thError');
    const btn = $('thSend');
    errEl.hidden = true;
    const body = text.value.trim();
    const reply = composerMode === 'reply';
    const first = String(e.name || '').split(/\s+/)[0];
    const squash = s => s.replace(/\s+/g, ' ').trim();
    if (!body || (reply && squash(body) === squash(`Hi ${first}, Cheers, ${window.teamMe?.inboxFromName || e.brand}`))) {
      errEl.textContent = reply ? 'Write your reply first.' : 'Write a note first.';
      errEl.hidden = false;
      return;
    }
    if (reply && !confirm(`Send this reply to ${e.name}?`)) return;
    btn.disabled = true;
    btn.textContent = reply ? 'Sending…' : 'Saving…';
    try {
      const path = reply ? `/api/team/inbox/${e.id}/reply` : `/api/team/inbox/${e.id}/note`;
      await api(path, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reply ? { body, status: $('thAfter').value } : { body }),
      });
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

  /* ---------------- voucher check (read-only here) ---------------- */

  function voucherCard(d) {
    const { matches, unmatched } = d.vouchers;
    if (!matches.length && !unmatched.length) return '';
    return `<div class="vcheck">
      <div class="vcheck-head"><h3>Voucher check</h3></div>
      ${matches.map(m => {
        const tracked = m.balance_pence !== null && m.balance_pence !== undefined;
        const dead = ['redeemed', 'void', 'pending', 'refunded'].includes(m.status) || (tracked && m.balance_pence <= 0);
        return `<div class="vc-card${dead ? ' bad' : ''}">
          <div class="vc-top"><code>${esc(m.code)}</code>
            <span class="pill pill-${esc(m.status)}">${esc(VSTATUS[m.status] || m.status)}</span>
            <span class="tag">${esc(m.source)}</span></div>
          <div class="vc-nums">${tracked
            ? `Balance <strong>${money(m.balance_pence)}</strong>${m.amount_pence != null ? ` <span class="muted">of ${money(m.amount_pence)}</span>` : ''}`
            : `<span class="muted">No value recorded</span>${m.description ? ` — <strong>${esc(m.description)}</strong>` : ''}`}</div>
          <div class="vc-who muted">${m.holder_name ? `Holder: ${esc(m.holder_name)}` : ''}</div>
        </div>`;
      }).join('')}
      ${unmatched.map(c => `<div class="vc-miss">❌ <code>${esc(c)}</code> — no matching code found. Check with the office.</div>`).join('')}
      <p class="vc-none" style="margin-top:8px">Redeeming a voucher is done by the office — ask them to take the value off.</p>
    </div>`;
  }

  /* ---------------- live updates ---------------- */

  function isNearBottom() {
    const last = threadEl.querySelector('.timeline > :last-child');
    if (!last) return true;
    const sc = threadEl.querySelector('.th-scroll');
    const internal = sc && getComputedStyle(sc).overflowY !== 'visible' && sc.scrollHeight > sc.clientHeight;
    const bottom = internal ? sc.getBoundingClientRect().bottom : window.innerHeight;
    return last.getBoundingClientRect().top < bottom - 20;
  }
  function reveal(node, where = 'end') {
    const sc = threadEl.querySelector('.th-scroll');
    const internal = sc && getComputedStyle(sc).overflowY !== 'visible' && sc.scrollHeight > sc.clientHeight;
    if (!internal) { node.scrollIntoView({ behavior: 'smooth', block: where === 'end' ? 'nearest' : 'center' }); return; }
    const offset = node.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
    const top = where === 'end' ? offset + node.offsetHeight - sc.clientHeight + 24 : offset - sc.clientHeight / 3;
    sc.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }
  function clearUnseen() {
    threadEl.querySelectorAll('.tl-unseen').forEach(el => el.classList.remove('tl-unseen'));
    const pill = $('thNewPill');
    if (pill) pill.hidden = true;
  }

  async function pollThread() {
    const id = state.current;
    if (threadPolling || !id || !currentThread || currentThread.enquiry.id !== id) return;
    if (document.querySelector('[data-panel="inbox"]').hidden) return;
    if (document.visibilityState !== 'visible' && Date.now() - lastThreadPoll < 20000) return;
    lastThreadPoll = Date.now();
    threadPolling = true;
    try {
      const d = await api(`/api/team/inbox/${id}/updates?after=${lastMsgId}&seen=1`);
      if (state.current !== id || currentThread.enquiry.id !== id) return;
      const e = currentThread.enquiry;
      if (d.messages.length) {
        const wasAtBottom = isNearBottom();
        const timeline = threadEl.querySelector('.timeline');
        const holder = document.createElement('div');
        let added = null;
        for (const m of d.messages) {
          if (m.id <= lastMsgId) continue;
          holder.innerHTML = item(m, e);
          const node = holder.firstElementChild;
          node.classList.add('tl-new');
          if (m.direction === 'in') node.classList.add('tl-unseen');
          timeline.appendChild(node);
          added = added || node;
          currentThread.messages.push(m);
          lastMsgId = Math.max(lastMsgId, m.id);
        }
        if (added && wasAtBottom) { reveal(timeline.lastElementChild, 'end'); clearUnseen(); }
        else if (d.messages.some(m => m.direction === 'in')) $('thNewPill').hidden = false;
        loadList({ quiet: true });
      }
      if (d.status !== e.status) {
        e.status = d.status;
        threadEl.querySelectorAll('[data-th-status]').forEach(b => b.classList.toggle('on', b.dataset.thStatus === d.status));
      }
      const card = threadEl.querySelector('.vcheck');
      if (d.vouchers && card && JSON.stringify(d.vouchers) !== JSON.stringify(currentThread.vouchers)) {
        currentThread.vouchers = d.vouchers;
        const holder = document.createElement('div');
        holder.innerHTML = voucherCard(currentThread);
        if (holder.firstElementChild) card.replaceWith(holder.firstElementChild);
      }
    } catch { /* offline or signed out — the next tick tries again */ }
    finally { threadPolling = false; }
  }

  setInterval(pollThread, THREAD_POLL);
  window.addEventListener('scroll', () => {
    const pill = $('thNewPill');
    if (pill && !pill.hidden && isNearBottom()) clearUnseen();
  }, { passive: true });

  let lastListPoll = 0;
  setInterval(async () => {
    const visible = document.visibilityState === 'visible';
    if (!visible && Date.now() - lastListPoll < 55000) return;
    lastListPoll = Date.now();
    if (document.querySelector('[data-panel="inbox"]').hidden || !loadedOnce) return;
    if (document.activeElement?.id === 'ibQ') return;
    loadList({ quiet: true });
  }, LIST_POLL);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { lastThreadPoll = 0; pollThread(); lastListPoll = 0; }
  });

  window.teamInboxRoute = function (sub) {
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
})();
