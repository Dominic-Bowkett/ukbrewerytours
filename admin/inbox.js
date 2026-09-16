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

  const state = { status: 'open', type: '', site: '', assignee: '', q: '', page: 1, current: null, labels: null, list: [], team: [] };
  let loadedOnce = false;
  let currentThread = null;
  let composerMode = 'reply';

  // Live updates: the open conversation is checked every THREAD_POLL ms, the list
  // (and new-message alerts) every LIST_POLL ms — both only while the tab is visible.
  const THREAD_POLL = 4000;
  const LIST_POLL = 15000;
  let lastMsgId = 0;
  let threadPolling = false;
  let since = null;                 // server time of the previous list response
  const alerted = new Set();        // "<id>@<last_inbound_at>" already announced

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
    const params = new URLSearchParams({ status: state.status, type: state.type, site: state.site, assignee: state.assignee, q: state.q, page: state.page });
    if (since) params.set('since', since);
    if (!quiet) listEl.innerHTML = '<li class="muted pad">Loading…</li>';
    try {
      const d = await api('/api/admin/inbox?' + params);
      announce(d);
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

      state.team = d.team || [];
      const ownerSel = $('ibAssignee');
      ownerSel.innerHTML = '<option value="">Anyone</option><option value="none">Unassigned</option>'
        + state.team.map(t => `<option value="${esc(t.id)}">${esc(t.name)}${t.open_count ? ` (${t.open_count})` : ''}</option>`).join('');
      ownerSel.value = state.assignee;

      listEl.innerHTML = d.enquiries.length ? d.enquiries.map(e => `
        <li class="ib-item${e.unread ? ' unread' : ''}${state.current === e.id ? ' active' : ''}" data-ib="${e.id}" tabindex="0">
          <div class="ib-row1"><span class="ib-name">${esc(e.name)}</span><time title="${esc(when(e.last_message_at))}">${ago(e.last_message_at || e.created_at)}</time></div>
          <div class="ib-row2">
            <span class="type-pill type-${esc(e.type)}">${esc(typeLabel(e.type))}</span>
            ${state.status === 'open' || state.status === 'all' ? `<span class="st-pill st-${esc(e.status)}">${esc(statusLabel(e.status))}</span>` : ''}
            <span class="ib-site">${esc(e.site_label)}${e.channel === 'chat' ? ' · chat' : ''}</span>
            ${e.assignee_name ? `<span class="ib-owner">→ ${esc(e.assignee_name)}</span>` : ''}
          </div>
          <div class="ib-snippet">${e.last_direction === 'out' ? '<strong>You:</strong> ' : ''}${esc(e.snippet || '')}</div>
        </li>`).join('')
        : `<li class="muted pad">${state.q || state.type || state.site ? 'Nothing matches those filters.' : state.status === 'open' ? 'Inbox zero — nothing open. 🍺' : 'No conversations here.'}</li>`;

      // The list just refreshed — make sure the open conversation is as current as it is.
      if (state.current) setTimeout(pollThread, 0);

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

  /* ---------------- new-message alerts ---------------- */

  const notifySupported = 'Notification' in window && window.isSecureContext;
  const notifyWanted = () => { try { return localStorage.getItem('ib_notify') === '1'; } catch { return false; } };
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
      try { localStorage.setItem('ib_notify', '0'); } catch { /* ignore */ }
    } else {
      const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
      try { localStorage.setItem('ib_notify', perm === 'granted' ? '1' : '0'); } catch { /* ignore */ }
    }
    syncNotifyButton();
  });
  syncNotifyButton();

  // Called with every list response. The first response only sets the baseline,
  // so opening the admin never replays old messages.
  function announce(d) {
    const first = since === null;
    since = d.server_now || since;
    for (const r of d.recent_inbound || []) {
      const key = `${r.id}@${r.last_inbound_at}`;
      if (alerted.has(key)) continue;
      alerted.add(key);
      if (first) continue;
      const panelVisible = !document.querySelector('[data-panel="inbox"]').hidden;
      const watching = document.visibilityState === 'visible' && panelVisible && state.current === r.id;
      if (watching) continue;   // the live thread shows it
      if (document.visibilityState !== 'visible' && notifyOn()) {
        const n = new Notification(`New message from ${r.name}`, { body: r.snippet || '', tag: 'ib-' + r.id });
        n.onclick = () => { window.focus(); location.hash = 'inbox/' + r.id; n.close(); };
      } else if (document.visibilityState === 'visible') {
        toast(r);
      }
    }
  }

  let toastTimer;
  function toast(r) {
    const el = $('ibToast');
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
  $('ibType').addEventListener('change', e => { state.type = e.target.value; state.page = 1; loadList(); });
  $('ibSite').addEventListener('change', e => { state.site = e.target.value; state.page = 1; loadList(); });
  $('ibAssignee').addEventListener('change', e => { state.assignee = e.target.value; state.page = 1; loadList(); });
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

  /* ---------------- who can be given conversations ---------------- */

  const teamModal = $('teamInboxModal');
  const teamBody = $('teamInboxBody');
  teamModal.addEventListener('click', e => { if (e.target.closest('[data-close]')) teamModal.hidden = true; });

  async function openTeamManager() {
    teamModal.hidden = false;
    teamBody.innerHTML = '<p class="muted pad">Loading…</p>';
    let members = [];
    try {
      members = (await api('/api/admin/team')).members || [];
    } catch (err) {
      teamBody.innerHTML = `<p class="pad error">${esc(err.message)}</p>`;
      return;
    }
    const inboxers = members.filter(m => m.inbox_access === 1);

    teamBody.innerHTML = `
      <h2 style="margin-bottom:6px">Team access to messages</h2>
      <p class="muted" style="margin-bottom:18px">
        A teammate signs in at <strong>ukbrewerytours.com/team/</strong> and sees <strong>only</strong> the conversations you
        assign to them — never yours, never each other's. Their replies go out from their own address. You keep seeing everything.
      </p>
      ${inboxers.length ? `<table class="hist"><tbody>${inboxers.map(m => `
        <tr>
          <td><strong>${esc(m.name)}</strong><br><span class="muted">${esc(m.email)}</span></td>
          <td class="muted">replies from<br>${esc(m.inbox_from_email || m.email)}</td>
          <td class="muted">alerts to<br>${esc(m.notify_email || m.email)}</td>
          <td class="muted">${m.open_conversations || 0} open</td>
          <td><span class="pill pill-${m.active ? 'active' : 'pending'}">${m.active ? 'Active' : 'Disabled'}</span></td>
          <td><button class="btn btn-ghost btn-sm" data-revoke="${esc(m.id)}" data-name="${esc(m.name)}">Remove access</button></td>
        </tr>`).join('')}</tbody></table>`
        : '<p class="muted">No one has access to messages yet.</p>'}

      <form class="redeem-form" id="teamAddForm">
        <h3>Give someone access</h3>
        <div class="redeem-row">
          <div class="field"><label for="ti-name">Name <span class="muted">(shown on the assignment)</span></label>
            <input id="ti-name" type="text" required placeholder="e.g. London team"></div>
          <div class="field"><label for="ti-email">Their login email</label>
            <input id="ti-email" type="email" required placeholder="london@ukbrewerytours.com"></div>
        </div>
        <div class="redeem-row" style="margin-top:12px">
          <div class="field"><label for="ti-from">Replies to customers come from</label>
            <input id="ti-from" type="email" placeholder="Same as the login email"></div>
          <div class="field"><label for="ti-notify">Send their alerts to</label>
            <input id="ti-notify" type="email" placeholder="A real mailbox they read"></div>
        </div>
        <p class="muted" style="font-size:.8rem;margin-top:6px">The "from" address only needs to be on ukbrewerytours.com — it does not need a mailbox, because customer replies come back to the conversation's own reply address. The alerts address does need to be a real mailbox.</p>
        <p class="error" id="teamAddError" hidden></p>
        <div class="redeem-actions"><button class="btn btn-primary" type="submit">Create login</button></div>
      </form>`;

    teamBody.querySelectorAll('[data-revoke]').forEach(b => b.addEventListener('click', async () => {
      if (!confirm(`Remove ${b.dataset.name}'s access to messages?\n\nThey are signed out immediately. Conversations assigned to them stay assigned until you reassign them.`)) return;
      try {
        await api('/api/admin/team/' + encodeURIComponent(b.dataset.revoke), {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ inbox_access: false }),
        });
        openTeamManager();
        loadList({ quiet: true });
      } catch (err) { alert(err.message); }
    }));

    $('teamAddForm').addEventListener('submit', async ev => {
      ev.preventDefault();
      const errEl = $('teamAddError');
      errEl.hidden = true;
      const btn = ev.target.querySelector('button');
      btn.disabled = true; btn.textContent = 'Creating…';
      try {
        const res = await api('/api/admin/team', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            kind: 'inbox',
            name: $('ti-name').value,
            email: $('ti-email').value,
            inbox_from_email: $('ti-from').value,
            inbox_from_name: $('ti-name').value,
            notify_email: $('ti-notify').value,
          }),
        });
        teamBody.innerHTML = `
          <h2 style="margin-bottom:14px">Login created for ${esc(res.member.name)}</h2>
          <div class="balance-box"><div class="hl full-width">
            <span>Password — shown once</span>
            <strong style="font-family:ui-monospace,Consolas,monospace;font-size:1.15rem">${esc(res.password)}</strong>
          </div></div>
          <p class="muted" style="margin-top:16px">${esc(res.notice)} They sign in at ukbrewerytours.com/team/ with <strong>${esc(res.member.email)}</strong> and will be asked to set their own password.</p>
          <div class="redeem-actions"><button class="btn btn-primary" data-close type="button">Done</button></div>`;
        loadList({ quiet: true });
      } catch (err) {
        errEl.textContent = err.message; errEl.hidden = false;
        btn.disabled = false; btn.textContent = 'Create login';
      }
    });
  }
  $('ibTeam').addEventListener('click', openTeamManager);

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
          <select id="thAssign" aria-label="Assigned to" title="Hand this conversation to a team member. They see only what is assigned to them.">
            <option value="">Not assigned — you handle it</option>
            ${state.team.map(t => `<option value="${esc(t.id)}" ${e.assigned_to === t.id ? 'selected' : ''}>Assign to ${esc(t.name)}</option>`).join('')}
          </select>
        </div>
      </div>

      <div class="th-scroll">
        <div class="th-meta">
          <span class="th-live" title="New messages appear here automatically">Live</span>
          <span>#${e.id}</span>
          <span>${esc(e.site_label)} · ${esc(e.channel_label)}${e.widget_name ? ` (${esc(e.widget_name)})` : ''}</span>
          <span>Received ${esc(when(e.created_at))}</span>
          ${e.page ? `<span>From ${/^https?:/.test(e.page) ? `<a href="${esc(e.page)}" target="_blank" rel="noopener">${esc(e.page.replace(/^https?:\/\/(www\.)?/, ''))}</a>` : esc(e.page)}</span>` : ''}
          ${e.assignee_name ? `<span class="ib-owner">Assigned to ${esc(e.assignee_name)}</span>` : ''}
          <a href="${esc(e.thread_url)}" target="_blank" rel="noopener" title="The page the customer sees">Customer's view ↗</a>
          <button type="button" class="btn btn-ghost btn-sm" id="thDelete" style="padding:0 6px;font-size:.78rem">Delete (spam)</button>
        </div>

        ${e.fields.length || e.voucher_code ? `<div class="th-fields">
          ${e.voucher_code ? `<div><span>Voucher code given</span><code>${esc(e.voucher_code)}</code></div>` : ''}
          ${e.fields.map(f => `<div><span>${esc(f.label)}</span>${esc(f.value)}</div>`).join('')}
        </div>` : ''}

        ${voucherCard(d)}

        <div class="timeline">${d.messages.map(m => timelineItem(m, e)).join('')}</div>
        <button type="button" class="th-newpill" id="thNewPill" hidden>↓ New message</button>
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

    lastMsgId = d.messages.reduce((max, m) => Math.max(max, m.id), 0);
    $('thNewPill').addEventListener('click', () => {
      const firstNew = threadEl.querySelector('.timeline .tl-unseen');
      const target = firstNew || threadEl.querySelector('.timeline > :last-child');
      if (target) reveal(target, firstNew ? 'center' : 'end');
      clearUnseen();
    });
    sc.addEventListener('scroll', () => { if (isNearBottom()) clearUnseen(); }, { passive: true });

    $('thBack').addEventListener('click', () => { location.hash = 'inbox'; });
    threadEl.querySelectorAll('[data-th-status]').forEach(b => b.addEventListener('click', () => patch(e.id, { status: b.dataset.thStatus })));
    $('thType').addEventListener('change', ev => patch(e.id, { type: ev.target.value }));
    $('thAssign').addEventListener('change', ev => {
      const to = ev.target.value;
      const who = state.team.find(t => t.id === to);
      const question = who
        ? `Assign this conversation to ${who.name}?\n\nThey'll get an email, it appears in their portal, and their replies go out from ${who.inbox_from_email || who.email}.`
        : 'Take this conversation back? It will disappear from their portal.';
      if (!confirm(question)) { ev.target.value = e.assigned_to || ''; return; }
      patch(e.id, { assigned_to: to || null });
    });
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

  /* ---------------- live conversation ---------------- */

  // Is the end of the timeline on screen? The thread scrolls inside its pane on
  // desktop and with the page on phones, so compare against whichever applies.
  function isNearBottom() {
    const last = threadEl.querySelector('.timeline > :last-child');
    if (!last) return true;
    const sc = threadEl.querySelector('.th-scroll');
    const internal = sc && getComputedStyle(sc).overflowY !== 'visible' && sc.scrollHeight > sc.clientHeight;
    const bottom = internal ? sc.getBoundingClientRect().bottom : window.innerHeight;
    return last.getBoundingClientRect().top < bottom - 20;
  }

  // Bring a timeline item into view by scrolling only the thread pane on desktop
  // (scrollIntoView would also nudge the whole admin page).
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

  // Append what's new without re-rendering: the reply box, its draft, the caret
  // and the scroll position all stay exactly as they are.
  // Runs in the background too: a window covered by another one reports itself as
  // hidden, and Dom may be watching the chat on the website in front of the admin.
  // Hidden tabs are checked every 20s at most (browsers throttle timers there anyway).
  let lastThreadPoll = 0;
  async function pollThread() {
    const id = state.current;
    if (threadPolling || !id || !currentThread || currentThread.enquiry.id !== id) return;
    if (document.querySelector('[data-panel="inbox"]').hidden) return;
    if (document.visibilityState !== 'visible' && Date.now() - lastThreadPoll < 20000) return;
    lastThreadPoll = Date.now();
    threadPolling = true;
    try {
      const d = await api(`/api/admin/inbox/${id}/updates?after=${lastMsgId}&seen=1`);
      if (state.current !== id || currentThread.enquiry.id !== id) return;
      const e = currentThread.enquiry;

      if (d.messages.length) {
        const wasAtBottom = isNearBottom();
        const timeline = threadEl.querySelector('.timeline');
        const holder = document.createElement('div');
        let firstNode = null;
        for (const m of d.messages) {
          if (m.id <= lastMsgId) continue;
          holder.innerHTML = timelineItem(m, e);
          const node = holder.firstElementChild;
          node.classList.add('tl-new');
          if (m.direction === 'in') node.classList.add('tl-unseen');
          timeline.appendChild(node);
          firstNode = firstNode || node;
          currentThread.messages.push(m);
          lastMsgId = Math.max(lastMsgId, m.id);
        }
        const inbound = d.messages.some(m => m.direction === 'in');
        if (firstNode && wasAtBottom) {
          reveal(timeline.lastElementChild, 'end');
          clearUnseen();
        } else if (inbound) {
          $('thNewPill').hidden = false;
        }
        loadList({ quiet: true });
      }

      if (d.status !== e.status) {
        e.status = d.status;
        threadEl.querySelectorAll('[data-th-status]').forEach(b => b.classList.toggle('on', b.dataset.thStatus === d.status));
      }
      if (d.type !== e.type && document.activeElement?.id !== 'thType') {
        e.type = d.type;
        $('thType').value = d.type;
      }

      // A new customer message can add a voucher code. Refresh the card unless
      // someone is mid-way through using it.
      const card = threadEl.querySelector('.vcheck');
      if (d.vouchers && card && !card.contains(document.activeElement)
          && JSON.stringify(d.vouchers) !== JSON.stringify(currentThread.vouchers)) {
        currentThread.vouchers = d.vouchers;
        const holder = document.createElement('div');
        holder.innerHTML = voucherCard(currentThread);
        card.replaceWith(holder.firstElementChild);
        bindVoucherCard(currentThread);
      }
    } catch { /* offline or signed out — the next tick tries again */ }
    finally { threadPolling = false; }
  }

  setInterval(pollThread, THREAD_POLL);
  // On phones the thread scrolls with the page rather than inside its pane.
  window.addEventListener('scroll', () => {
    const pill = $('thNewPill');
    if (pill && !pill.hidden && isNearBottom()) clearUnseen();
  }, { passive: true });

  // The list, badge and new-message alerts. While hidden, browsers throttle
  // timers to about once a minute anyway, which is plenty for a notification.
  let lastListPoll = 0;
  setInterval(async () => {
    const visible = document.visibilityState === 'visible';
    if (!visible && Date.now() - lastListPoll < 55000) return;
    lastListPoll = Date.now();
    const panel = document.querySelector('[data-panel="inbox"]');
    if (panel.hidden || !loadedOnce) {
      try {
        const params = new URLSearchParams({ status: 'open', page: 1 });
        if (since) params.set('since', since);
        const d = await api('/api/admin/inbox?' + params);
        announce(d);
        setBadge(d.unread);
      } catch { /* ignore */ }
      return;
    }
    if (document.activeElement?.id === 'ibQ') return;   // don't reshuffle the list mid-search
    loadList({ quiet: true });
  }, LIST_POLL);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { lastThreadPoll = 0; pollThread(); lastListPoll = 0; checkBuild(); }
  });

  /* ---------------- newer admin deployed? ---------------- */

  // build.js stamps the page with a hash of the admin files and publishes the same
  // hash at /admin/version.json. An admin left open across a deploy keeps running
  // the old code, so offer a reload instead of letting it quietly misbehave.
  const pageBuild = document.querySelector('meta[name="admin-build"]')?.content || '';
  let lastBuildCheck = 0;
  async function checkBuild() {
    if (!pageBuild || Date.now() - lastBuildCheck < 120000 || document.getElementById('updateBar')) return;
    lastBuildCheck = Date.now();
    try {
      const r = await fetch('/admin/version.json?cb=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) return;
      const { build } = await r.json();
      if (!build || build === pageBuild) return;
      const bar = document.createElement('div');
      bar.id = 'updateBar';
      bar.className = 'update-bar';
      bar.innerHTML = '<span>A newer version of the admin is live.</span><button type="button" class="btn btn-primary btn-sm">Reload</button>';
      bar.querySelector('button').addEventListener('click', () => {
        const draft = document.getElementById('thText');
        if (draft && state.current) setDraft(state.current, draft.value);
        location.reload();
      });
      document.body.appendChild(bar);
    } catch { /* offline — try again later */ }
  }
  setInterval(checkBuild, 5 * 60000);
  checkBuild();
})();
