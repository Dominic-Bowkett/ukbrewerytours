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
  const CHANNEL_SHORT = { form: 'form', widget: 'embedded form', chat: 'live chat', web: 'messages page', email: 'email', phone: 'phone call' };

  const state = { view: 'inbox', status: 'open', type: '', site: '', assignee: '', q: '', page: 1, current: null, labels: null, list: [], team: [] };
  const isNotif = () => state.view === 'notifications';
  const isSales = () => state.view === 'sales';
  const isBin = () => state.view === 'bin';
  // Sales are notifications with a folder of their own.
  const isSale = e => e.notification_kind === 'sale';
  const filedPill = e => isSale(e)
    ? '<span class="type-pill type-sale">Sale</span>'
    : '<span class="type-pill type-notification">Notification</span>';
  let binDays = 7;
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
  const dateShort = s => {
    const d = parseTs(s);
    return d ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  };
  const linkify = s => esc(s).replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)]/g, u => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
  const typeLabel = t => (state.labels?.types?.[t]) || t;
  const statusLabel = s => (state.labels?.statuses?.[s]) || s;

  /* ---------------- list ---------------- */

  async function loadList({ quiet = false } = {}) {
    const params = new URLSearchParams({ view: state.view, status: state.status, type: state.type, site: state.site, assignee: state.assignee, q: state.q, page: state.page });
    if (since) params.set('since', since);
    if (!quiet) listEl.innerHTML = '<li class="muted pad">Loading…</li>';
    try {
      const d = await api('/api/admin/inbox?' + params);
      announce(d);
      state.labels = d.labels;
      state.list = d.enquiries;
      loadedOnce = true;

      // In the bin, a conversation keeps whatever status it had when it went in;
      // filtering on that would only hide things from someone looking for them.
      // Sales are a log: nothing in there is waiting to be closed.
      $('ibStatus').hidden = isBin() || isSales();
      $('ibStatus').innerHTML = STATUS_CHIPS
        .filter(([key]) => !isNotif() || !['dealing', 'waiting'].includes(key))
        .map(([key, label]) => {
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

      // Type, website and owner mean nothing to a Stripe receipt or to the bin.
      const plain = state.view === 'inbox';
      binDays = d.bin_days || binDays;
      ['ibType', 'ibSite', 'ibAssignee'].forEach(id => { $(id).hidden = !plain; });
      $('ibNotifTab').textContent = 'Notifications' + (d.counts.notifications ? ` (${d.counts.notifications})` : '');
      $('ibSalesTab').textContent = 'Sales' + (d.counts.sales_unread ? ` (${d.counts.sales_unread} new)` : '');
      $('ibBinTab').textContent = 'Bin' + (d.counts.bin ? ` (${d.counts.bin})` : '');
      $('ibEmptyBin').hidden = !isBin() || !d.counts.bin;
      $('ibQ').placeholder = isBin() ? 'Search the bin…' : isNotif() ? 'Search notifications…'
        : isSales() ? 'Search sales — buyer, code or amount…' : 'Search name, email, code or message…';

      state.team = d.team || [];
      const ownerSel = $('ibAssignee');
      ownerSel.innerHTML = '<option value="">Anyone</option><option value="none">Unassigned</option>'
        + state.team.map(t => `<option value="${esc(t.id)}">${esc(t.name)}${t.open_count ? ` (${t.open_count})` : ''}</option>`).join('');
      ownerSel.value = state.assignee;

      listEl.innerHTML = d.enquiries.length ? d.enquiries.map(listItem).join('')
        : `<li class="muted pad">${esc(emptyList())}</li>`;

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

  // A notification is read by its subject line — who sent it and what it says —
  // where a conversation is read by who it is from and what they want.
  /** How long a binned conversation has left. */
  function binCountdown(deletedAt) {
    const d = parseTs(deletedAt);
    if (!d) return '';
    const days = Math.ceil((d.getTime() + binDays * 86400000 - Date.now()) / 86400000);
    return days <= 0 ? 'going any minute now' : days === 1 ? 'gone tomorrow' : `gone in ${days} days`;
  }

  function listItem(e) {
    if (e.deleted_at) {
      return `<li class="ib-item${state.current === e.id ? ' active' : ''}" data-ib="${e.id}" tabindex="0">
        <div class="ib-row1"><span class="ib-name">${esc(e.name)}</span><time title="Deleted ${esc(when(e.deleted_at))}">${ago(e.deleted_at)}</time></div>
        ${e.subject && e.is_notification ? `<div class="ib-subject">${esc(e.subject)}</div>` : ''}
        <div class="ib-row2">
          ${e.is_notification
            ? filedPill(e)
            : `<span class="type-pill type-${esc(e.type)}">${esc(typeLabel(e.type))}</span>`}
          <span class="ib-why">${esc(binCountdown(e.deleted_at))}</span>
        </div>
        <div class="ib-snippet">${esc(e.snippet || '')}</div>
      </li>`;
    }
    const rest = e.is_notification
      ? `${e.subject ? `<div class="ib-subject">${esc(e.subject)}</div>` : ''}
         <div class="ib-row2">
           ${filedPill(e)}
           ${e.notification_reason && !isSale(e) ? `<span class="ib-why">${esc(e.notification_reason)}</span>` : ''}
         </div>`
      : `<div class="ib-row2">
           <span class="type-pill type-${esc(e.type)}">${esc(typeLabel(e.type))}</span>
           ${state.status === 'open' || state.status === 'all' ? `<span class="st-pill st-${esc(e.status)}">${esc(statusLabel(e.status))}</span>` : ''}
           <span class="ib-site">${esc(e.site_label)}${e.channel === 'chat' ? ' · chat' : ''}</span>
           ${e.assignee_name ? `<span class="ib-owner">→ ${esc(e.assignee_name)}</span>` : ''}
         </div>`;
    return `<li class="ib-item${e.unread ? ' unread' : ''}${state.current === e.id ? ' active' : ''}" data-ib="${e.id}" tabindex="0">
      <div class="ib-row1"><span class="ib-name">${esc(e.name)}</span><time title="${esc(when(e.last_message_at))}">${ago(e.last_message_at || e.created_at)}</time></div>
      ${rest}
      <div class="ib-snippet">${e.last_direction === 'out' ? '<strong>You:</strong> ' : ''}${esc(e.snippet || '')}</div>
    </li>`;
  }

  function emptyList() {
    if (state.q || state.type || state.site) return 'Nothing matches those filters.';
    if (isBin()) return `The bin is empty. Anything you delete waits here for ${binDays} days before it goes for good.`;
    if (isNotif()) return 'Nothing filed here yet. Receipts, booking confirmations and other machine-written mail lands here instead of the inbox.';
    if (isSales()) return 'No sales filed here yet. When a voucher sells, the heads-up emailed to info@ lands here — no alert, nothing to answer.';
    return state.status === 'open' ? 'Inbox zero — nothing open. 🍺' : 'No conversations here.';
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

  const emptyThread = () => {
    if (isBin()) return `<div class="thread-empty"><strong>Nothing selected</strong>Deleted conversations wait here for ${binDays} days. Pick one to read it, put it back, or delete it for good.</div>`;
    if (isNotif()) return '<div class="thread-empty"><strong>Nothing selected</strong>Receipts, confirmations and other machine-written mail are kept here. Pick one to read it.</div>';
    if (isSales()) return '<div class="thread-empty"><strong>Nothing selected</strong>Every voucher sale is filed here. Pick one to see the order.</div>';
    return '<div class="thread-empty"><strong>No conversation selected</strong>Pick one from the list to read and reply.</div>';
  };

  // Switching view closes whatever was open: the conversation on screen belongs
  // to the list you just left. Callers that want one open reopen it afterwards.
  function switchView(view) {
    if (state.view === view) return;
    state.view = view;
    state.current = null;
    threadEl.innerHTML = emptyThread();
    inboxEl.classList.remove('show-thread');
    // The filters mean different things in each view, so none of them carry over.
    // The bin shows everything in it: its rows keep the status they had going in.
    state.page = 1; state.type = ''; state.site = ''; state.assignee = '';
    state.status = view === 'bin' || view === 'sales' ? 'all' : 'open';
    document.querySelectorAll('[data-ib-view]').forEach(x => x.classList.toggle('on', x.dataset.ibView === view));
    loadList();
  }

  document.querySelector('.view-seg').addEventListener('click', e => {
    const b = e.target.closest('[data-ib-view]');
    if (!b || b.classList.contains('on')) return;
    if (location.hash.startsWith('#inbox/')) location.hash = 'inbox';
    switchView(b.dataset.ibView);
  });

  /** Move a conversation between the inbox and Notifications. */
  const file = (id, filed) => api('/api/admin/inbox/' + id, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ is_notification: filed }),
  });
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

  /* ---------------- address book ---------------- */

  // Admin only. Nothing in the team portal reads or writes it: a team member
  // replies to the conversation they were given, and has no way to start one.
  const contactsModal = $('contactsModal');
  const contactsEl = $('contactsBody');
  let contacts = [];
  let contactsLoaded = false;

  contactsModal.addEventListener('click', ev => { if (ev.target.closest('[data-close]')) contactsModal.hidden = true; });

  async function loadContacts(q = '') {
    const d = await api('/api/admin/contacts' + (q ? '?q=' + encodeURIComponent(q) : ''));
    contacts = d.contacts || [];
    contactsLoaded = true;
    return contacts;
  }

  async function openContacts(q = '') {
    contactsModal.hidden = false;
    contactsEl.innerHTML = '<p class="muted pad">Loading…</p>';
    try {
      await loadContacts(q);
    } catch (err) {
      contactsEl.innerHTML = `<p class="pad error">${esc(err.message)}</p>`;
      return;
    }
    renderContacts(q);
  }

  function renderContacts(q = '', editing = null) {
    const row = c => {
      const edit = editing === c.id;
      if (edit) {
        return `<tr class="ct-editing"><td colspan="3">
          <div class="redeem-row even">
            <div class="field"><label for="ct-name">Name</label><input id="ct-name" type="text" value="${esc(c.name)}" maxlength="120"></div>
            <div class="field"><label for="ct-email">Email</label><input id="ct-email" type="email" value="${esc(c.email)}"></div>
          </div>
          <div class="redeem-row even" style="margin-top:12px">
            <div class="field"><label for="ct-phone">Phone</label><input id="ct-phone" type="tel" value="${esc(c.phone || '')}"></div>
            <div class="field"><label for="ct-company">Company</label><input id="ct-company" type="text" value="${esc(c.company || '')}" maxlength="120"></div>
          </div>
          <div class="field" style="margin-top:12px"><label for="ct-notes">Notes</label>
            <textarea id="ct-notes" rows="2">${esc(c.notes || '')}</textarea></div>
          <div class="redeem-actions">
            <button class="btn btn-primary btn-sm" type="button" data-ct-save="${esc(c.id)}">Save</button>
            <button class="btn btn-ghost btn-sm" type="button" data-ct-cancel>Cancel</button>
            <button class="btn btn-ghost btn-sm" type="button" data-ct-del="${esc(c.id)}" style="margin-left:auto">Delete contact</button>
          </div>
        </td></tr>`;
      }
      return `<tr>
        <td class="ct-who">
          <strong>${esc(c.name)}</strong>
          <span class="muted">${[c.company, c.last_emailed_at ? `emailed ${dateShort(c.last_emailed_at)}` : 'not emailed yet'].filter(Boolean).map(esc).join(' · ')}</span>
          ${c.notes ? `<span class="muted">${esc(String(c.notes).slice(0, 110))}</span>` : ''}
        </td>
        <td class="ct-reach muted">
          ${esc(c.email)}
          ${c.phone ? `<a class="btn-call" href="tel:${esc(String(c.phone).replace(/[^\d+]/g, ''))}">📞 ${esc(c.phone)}</a>` : ''}
        </td>
        <td class="ct-actions"><div>
          <button class="btn btn-outline btn-sm" type="button" data-ct-email="${esc(c.id)}">Email</button>
          <button class="btn btn-ghost btn-sm" type="button" data-ct-edit="${esc(c.id)}">Edit</button>
        </div></td></tr>`;
    };

    contactsEl.innerHTML = `
      <h2 style="margin-bottom:6px">Contacts</h2>
      <p class="muted" style="margin-bottom:16px">People you email who haven't written in — venues, breweries, coach firms, past organisers. Yours alone: the team never sees this.</p>
      <div class="inbox-search" style="margin-bottom:14px">
        <input type="search" id="ctQ" placeholder="Search name, email, company or phone…" value="${esc(q)}" aria-label="Search contacts">
      </div>
      ${contacts.length
        ? `<table class="hist"><tbody>${contacts.map(row).join('')}</tbody></table>`
        : `<p class="muted">${q ? 'Nobody matches that.' : 'No contacts yet. Add the first one below — or tick "Add them to my contacts" when you send an email.'}</p>`}

      <form class="redeem-form" id="ctAddForm">
        <h3>Add a contact</h3>
        <div class="redeem-row even">
          <div class="field"><label for="ct-new-name">Name</label><input id="ct-new-name" type="text" required maxlength="120" placeholder="e.g. Sarah at Beavertown"></div>
          <div class="field"><label for="ct-new-email">Email</label><input id="ct-new-email" type="email" required placeholder="sarah@example.com"></div>
        </div>
        <div class="redeem-row even" style="margin-top:12px">
          <div class="field"><label for="ct-new-phone">Phone <span class="muted">(optional)</span></label><input id="ct-new-phone" type="tel"></div>
          <div class="field"><label for="ct-new-company">Company <span class="muted">(optional)</span></label><input id="ct-new-company" type="text" maxlength="120"></div>
        </div>
        <div class="field" style="margin-top:12px"><label for="ct-new-notes">Notes <span class="muted">(optional)</span></label>
          <textarea id="ct-new-notes" rows="2" placeholder="Books the Bermondsey groups — prefers a call first"></textarea></div>
        <p class="error" id="ctError" hidden></p>
        <div class="redeem-actions"><button class="btn btn-primary" type="submit">Add contact</button></div>
      </form>`;

    let ctTimer;
    $('ctQ').addEventListener('input', ev => {
      clearTimeout(ctTimer);
      const value = ev.target.value.trim();
      ctTimer = setTimeout(() => openContacts(value), 300);
    });

    $('ctAddForm').addEventListener('submit', async ev => {
      ev.preventDefault();
      const errEl = $('ctError');
      errEl.hidden = true;
      const btn = ev.target.querySelector('button[type="submit"]');
      btn.disabled = true;
      try {
        await api('/api/admin/contacts', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: $('ct-new-name').value, email: $('ct-new-email').value, phone: $('ct-new-phone').value,
            company: $('ct-new-company').value, notes: $('ct-new-notes').value,
          }),
        });
        await openContacts(q);
      } catch (err) {
        errEl.textContent = err.message; errEl.hidden = false;
        btn.disabled = false;
      }
    });
  }

  contactsEl.addEventListener('click', async ev => {
    const find = id => contacts.find(c => c.id === id);

    const mail = ev.target.closest('[data-ct-email]');
    if (mail) {
      const c = find(mail.dataset.ctEmail);
      contactsModal.hidden = true;
      openCompose({ to: c?.email, name: c?.name });
      return;
    }
    const edit = ev.target.closest('[data-ct-edit]');
    if (edit) { renderContacts($('ctQ').value.trim(), edit.dataset.ctEdit); return; }
    if (ev.target.closest('[data-ct-cancel]')) { renderContacts($('ctQ').value.trim()); return; }

    const save = ev.target.closest('[data-ct-save]');
    if (save) {
      save.disabled = true;
      try {
        await api('/api/admin/contacts/' + encodeURIComponent(save.dataset.ctSave), {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: $('ct-name').value, email: $('ct-email').value, phone: $('ct-phone').value,
            company: $('ct-company').value, notes: $('ct-notes').value,
          }),
        });
        await openContacts($('ctQ').value.trim());
      } catch (err) { alert(err.message); save.disabled = false; }
      return;
    }

    const del = ev.target.closest('[data-ct-del]');
    if (del) {
      const c = find(del.dataset.ctDel);
      if (!c || !confirm(`Delete ${c.name} from your contacts?\n\nConversations with them stay exactly as they are — only the address book card goes.`)) return;
      try {
        await api('/api/admin/contacts/' + encodeURIComponent(c.id), { method: 'DELETE' });
        await openContacts($('ctQ').value.trim());
      } catch (err) { alert(err.message); }
    }
  });

  $('ibContacts').addEventListener('click', () => openContacts());

  /* ---------------- new email ---------------- */

  const composeModal = $('composeModal');
  const composeEl = $('composeBody');
  composeModal.addEventListener('click', ev => { if (ev.target.closest('[data-close]')) composeModal.hidden = true; });

  const SIGN_OFF = '\n\nCheers,\nUK Brewery Tours';

  function openCompose(prefill = {}) {
    composeModal.hidden = false;
    composeEl.innerHTML = `
      <h2 style="margin-bottom:6px">New email</h2>
      <p class="muted" style="margin-bottom:18px">
        Goes out from <strong>info@ukbrewerytours.com</strong> and starts a conversation here, so their reply
        comes back to this inbox instead of a mailbox somewhere.
      </p>
      <form class="redeem-form" id="cmForm" style="margin-top:0;border-top:0;padding-top:0">
        <div class="field">
          <label for="cm-to">To</label>
          <input id="cm-to" type="text" required autocomplete="off" list="cmContacts"
                 placeholder="name@example.com — separate several with commas" value="${esc(prefill.to || '')}">
          <datalist id="cmContacts"></datalist>
        </div>
        <div id="cm-extra" hidden>
          <div class="redeem-row even" style="margin-top:12px">
            <div class="field"><label for="cm-cc">Cc</label><input id="cm-cc" type="text" autocomplete="off" placeholder="Everyone can see these"></div>
            <div class="field"><label for="cm-bcc">Bcc</label><input id="cm-bcc" type="text" autocomplete="off" placeholder="Hidden from the others"></div>
          </div>
          <div class="field" style="margin-top:12px">
            <label for="cm-reply">Replies come back to</label>
            <input id="cm-reply" type="email" placeholder="This conversation — recommended">
            <span class="muted" style="font-size:.8rem;display:block;margin-top:4px">Leave it blank and their reply lands on this thread. Name a mailbox and it goes there instead — you won't see the reply here.</span>
          </div>
        </div>
        <div class="field" style="margin-top:12px">
          <label for="cm-subject">Subject</label>
          <input id="cm-subject" type="text" required maxlength="200" value="${esc(prefill.subject || '')}" placeholder="What it's about">
        </div>
        <div class="field" style="margin-top:12px">
          <label for="cm-body">Message</label>
          <textarea id="cm-body" rows="11" required></textarea>
        </div>
        <label class="cm-check"><input type="checkbox" id="cm-save" checked> Add them to my contacts</label>
        <p class="error" id="cmError" hidden></p>
        <div class="redeem-actions">
          <button class="btn btn-ghost" type="button" id="cmMore">Cc, Bcc, reply-to</button>
          <button class="btn btn-primary" type="submit">Send email</button>
        </div>
      </form>`;

    const body = $('cm-body');
    body.value = prefill.body || SIGN_OFF;
    const to = $('cm-to');
    (to.value ? $('cm-subject') : to).focus();
    if (!prefill.body) body.setSelectionRange(0, 0);

    $('cmMore').addEventListener('click', () => {
      const extra = $('cm-extra');
      extra.hidden = !extra.hidden;
      $('cmMore').textContent = extra.hidden ? 'Cc, Bcc, reply-to' : 'Hide Cc, Bcc, reply-to';
      if (!extra.hidden) $('cm-cc').focus();
    });

    // The address book, offered as you type rather than as a second dialogue.
    (contactsLoaded ? Promise.resolve(contacts) : loadContacts().catch(() => []))
      .then(list => {
        const dl = $('cmContacts');
        if (dl) dl.innerHTML = list.map(c => `<option value="${esc(c.email)}">${esc(c.name)}${c.company ? ` — ${esc(c.company)}` : ''}</option>`).join('');
      });

    $('cmForm').addEventListener('submit', async ev => {
      ev.preventDefault();
      const errEl = $('cmError');
      errEl.hidden = true;
      const btn = ev.target.querySelector('button[type="submit"]');
      const recipients = $('cm-to').value.split(/[,;\n]+/).map(s => s.trim()).filter(Boolean);
      const bcc = $('cm-bcc')?.value.trim();
      if (!confirm(`Send this to ${recipients.join(', ')}${bcc ? ` (bcc ${bcc})` : ''}?`)) return;

      btn.disabled = true;
      btn.textContent = 'Sending…';
      try {
        const res = await api('/api/admin/compose', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to: $('cm-to').value,
            cc: $('cm-cc')?.value || '',
            bcc: bcc || '',
            reply_to: $('cm-reply')?.value || '',
            subject: $('cm-subject').value,
            body: $('cm-body').value,
            name: prefill.name || '',
            save_contact: $('cm-save').checked,
          }),
        });
        composeModal.hidden = true;
        contactsLoaded = false;              // the address book may have just grown
        switchView('inbox');
        location.hash = 'inbox/' + res.id;
        loadList({ quiet: true });
      } catch (err) {
        errEl.textContent = err.message;
        errEl.hidden = false;
        btn.disabled = false;
        btn.textContent = 'Send email';
      }
    });
  }

  $('ibCompose').addEventListener('click', () => openCompose());

  $('ibEmptyBin').addEventListener('click', async () => {
    const n = state.list.length;
    if (!confirm(`Empty the bin now?\n\nEverything in it goes for good, without waiting out the ${binDays} days. This cannot be undone.`)) return;
    try {
      const res = await api('/api/admin/inbox/bin', { method: 'DELETE' });
      state.current = null;
      location.hash = 'inbox';
      loadList();
      alert(res.deleted === 1 ? '1 conversation deleted.' : `${res.deleted || n} conversations deleted.`);
    } catch (err) { alert(err.message); }
  });

  /* ---------------- conversation ---------------- */

  const draftKey = id => 'ib_draft_' + id;
  const getDraft = id => { try { return localStorage.getItem(draftKey(id)); } catch { return null; } };
  const setDraft = (id, v) => { try { v ? localStorage.setItem(draftKey(id), v) : localStorage.removeItem(draftKey(id)); } catch { /* private mode */ } };

  async function openThread(id, { keepScroll = false } = {}) {
    // Moving to a different conversation starts on Reply again — otherwise a
    // phone call (which forces Notes) would leave the next one in Notes mode.
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
    // Two reasons there is nobody to reply to: a phone caller who left no email,
    // and a machine that wrote this. Either way the reply box would only produce
    // an error, so it is replaced by a line saying why. Notes still work.
    const notif = Boolean(e.is_notification);
    // In the bin nothing is editable at all: it is either coming back or going.
    const binned = Boolean(e.deleted_at);
    binDays = d.bin_days || binDays;
    const canEmail = !notif && !binned && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e.email || ''));
    if (!canEmail) composerMode = 'note';
    const sale = notif && isSale(e);
    const noReply = sale
      ? '💷 A voucher sale, filed in Sales — nothing here needs an answer.'
      : notif
      ? '🗂 Filed as a notification — nothing here is waiting on an answer.'
      : `📞 No email address — ${e.phone ? 'call them back' : 'nothing to reply to'}. Notes are saved here.`;
    const lastIn = [...d.messages].reverse().find(m => m.direction === 'in');

    threadEl.innerHTML = `
      <div class="th-head">
        <button class="btn btn-ghost btn-sm th-back" type="button" id="thBack">← Inbox</button>
        <div class="th-title">
          <h2>${esc(e.name)} ${notif
            ? filedPill(e)
            : `<span class="type-pill type-${esc(e.type)}">${esc(typeLabel(e.type))}</span>`}</h2>
          <div class="th-contact">
            ${notif ? `<span class="th-subject">${esc(e.subject || '(no subject)')}</span>` : ''}
            ${!notif && e.phone ? `<a class="btn-call" href="tel:${esc(String(e.phone).replace(/[^\d+]/g, ''))}">📞 Call ${esc(e.phone)}</a>` : ''}
            ${e.email && !sale ? `<a href="mailto:${esc(e.email)}">${esc(e.email)}</a>` : ''}
          </div>
        </div>
        <div class="th-actions">
          ${binned ? `
          <button class="btn btn-primary btn-sm" type="button" id="thRestore">Put it back</button>
          <button class="btn btn-ghost btn-sm" type="button" id="thForever">Delete forever</button>` : `
          <div class="seg" role="group" aria-label="Status"${sale ? ' hidden' : ''}>
            ${Object.entries(d.labels.statuses)
              // Nobody is "dealing with" a receipt or "awaiting" it: a
              // notification is either still there or filed.
              .filter(([k]) => !notif || k === 'new' || k === 'closed')
              .map(([k, v]) => `<button type="button" data-th-status="${k}" class="${e.status === k ? 'on' : ''}">${esc(v)}</button>`).join('')}
          </div>
          ${notif ? '<button class="btn btn-outline btn-sm" type="button" id="thPromote" title="Treat this as a real conversation: it moves to the inbox, where it can be typed, assigned and replied to">Move into the inbox</button>' : `
          <select id="thType" aria-label="Enquiry type">
            ${Object.entries(d.labels.types).map(([k, v]) => `<option value="${k}" ${e.type === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}
          </select>
          <select id="thAssign" aria-label="Assigned to" title="Hand this conversation to a team member. They see only what is assigned to them.">
            <option value="">Not assigned — you handle it</option>
            ${state.team.map(t => `<option value="${esc(t.id)}" ${e.assigned_to === t.id ? 'selected' : ''}>Assign to ${esc(t.name)}</option>`).join('')}
          </select>`}`}
        </div>
      </div>

      <div class="th-scroll">
        ${binned ? `<div class="th-binned">
          <strong>🗑 In the bin</strong>
          Deleted ${esc(when(e.deleted_at))} — ${esc(binCountdown(e.deleted_at))}, unless you put it back.
          The customer can no longer open their copy of this conversation, and a reply from them would start a new one.
        </div>` : ''}
        <div class="th-meta">
          ${binned ? '' : '<span class="th-live" title="New messages appear here automatically">Live</span>'}
          <span>#${e.id}</span>
          <span>${esc(e.site_label)} · ${esc(e.channel_label)}${e.widget_name ? ` (${esc(e.widget_name)})` : ''}</span>
          <span>Received ${esc(when(e.created_at))}</span>
          ${e.page ? `<span>From ${/^https?:/.test(e.page) ? `<a href="${esc(e.page)}" target="_blank" rel="noopener">${esc(e.page.replace(/^https?:\/\/(www\.)?/, ''))}</a>` : esc(e.page)}</span>` : ''}
          ${e.assignee_name ? `<span class="ib-owner">Assigned to ${esc(e.assignee_name)}</span>` : ''}
          ${binned ? '' : notif
            ? `<span class="th-why">Filed here${e.notification_reason ? ` — ${esc(e.notification_reason)}` : ''}</span>`
            : `<a href="${esc(e.thread_url)}" target="_blank" rel="noopener" title="The page the customer sees">Customer's view ↗</a>
               <button type="button" class="btn btn-ghost btn-sm" id="thFile" style="padding:0 6px;font-size:.78rem" title="Not a customer — move it to Notifications, out of the inbox">File away</button>`}
          ${binned ? '' : `<button type="button" class="btn btn-ghost btn-sm" id="thDelete" style="padding:0 6px;font-size:.78rem" title="Moves it to the bin for ${binDays} days">Delete</button>`}
        </div>

        ${e.fields.length || e.voucher_code ? `<div class="th-fields">
          ${e.voucher_code ? `<div><span>Voucher code given</span><code>${esc(e.voucher_code)}</code></div>` : ''}
          ${e.fields.map(f => `<div><span>${esc(f.label)}</span>${esc(f.value)}</div>`).join('')}
        </div>` : ''}

        ${notif || binned ? '' : voucherCard(d)}

        <div class="timeline">${d.messages.map(m => timelineItem(m, e)).join('')}</div>
        <button type="button" class="th-newpill" id="thNewPill" hidden>↓ New message</button>
      </div>

      ${binned ? '' : `
      <div class="th-composer${composerMode === 'note' ? ' note-mode' : ''}" id="thComposer">
        <div class="composer-tabs">
          ${canEmail
            ? `<button type="button" data-mode="reply" class="${composerMode === 'reply' ? 'on' : ''}">Reply to ${esc(first || 'customer')}</button>`
            : `<span class="composer-nomail">${esc(noReply)}</span>`}
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
      </div>`}`;

    // Composer: restore the draft, or start a greeting and sign-off.
    const text = $('thText');
    const signOff = `\n\nCheers,\n${e.brand}`;
    const draft = text ? getDraft(e.id) : null;
    if (text) {
      if (draft !== null) text.value = draft;
      else if (composerMode === 'reply') text.value = `Hi ${first},\n\n${signOff}`;
      syncComposer(e, canEmail);
      text.addEventListener('input', () => setDraft(e.id, text.value));
      if (!draft && composerMode === 'reply' && !keepScroll && window.innerWidth > 900) {
        const pos = `Hi ${first},\n\n`.length;
        // Focus without scrolling the page on open; the caret sits under the greeting.
        text.focus({ preventScroll: true });
        text.setSelectionRange(pos, pos);
      }
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
    $('thType')?.addEventListener('change', ev => patch(e.id, { type: ev.target.value }));
    $('thPromote')?.addEventListener('click', async () => {
      if (!confirm('Move this into the inbox?\n\nIt becomes an ordinary conversation — you can set its type, assign it and reply to it.')) return;
      try {
        await file(e.id, false);
        switchView('inbox');
        await openThread(e.id, { keepScroll: true });
      } catch (err) { alert(err.message); }
    });
    $('thFile')?.addEventListener('click', async () => {
      if (!confirm(`Move this out of the inbox?\n\nIt goes to Notifications: kept and searchable, but it stops counting as something to answer${e.assignee_name ? ` and comes off ${e.assignee_name}'s desk` : ''}.`)) return;
      try {
        await file(e.id, true);
        state.current = null;
        location.hash = 'inbox';
        switchView('notifications');
      } catch (err) { alert(err.message); }
    });
    $('thAssign')?.addEventListener('change', ev => {
      const to = ev.target.value;
      const who = state.team.find(t => t.id === to);
      const question = who
        ? `Assign this conversation to ${who.name}?\n\nThey'll get an email, it appears in their portal, and their replies go out from ${who.inbox_from_email || who.email}.`
        : 'Take this conversation back? It will disappear from their portal.';
      if (!confirm(question)) { ev.target.value = e.assigned_to || ''; return; }
      patch(e.id, { assigned_to: to || null });
    });
    $('thDelete')?.addEventListener('click', async () => {
      if (!confirm(`Delete this conversation with ${e.name}?\n\nIt goes to the bin, where you have ${binDays} days to change your mind. To file a real enquiry away instead, mark it Closed.`)) return;
      try {
        await api('/api/admin/inbox/' + e.id, { method: 'DELETE' });
        setDraft(e.id, null);
        state.current = null;
        location.hash = 'inbox';
        loadList();
      } catch (err) { alert(err.message); }
    });
    $('thRestore')?.addEventListener('click', async () => {
      try {
        await api('/api/admin/inbox/' + e.id, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ restore: true }),
        });
        switchView(e.is_notification ? (isSale(e) ? 'sales' : 'notifications') : 'inbox');
        await openThread(e.id);
      } catch (err) { alert(err.message); }
    });
    $('thForever')?.addEventListener('click', async () => {
      if (!confirm(`Delete this conversation with ${e.name} for good?\n\nThe whole thread goes with it. This one cannot be undone — leave it in the bin if you are not certain.`)) return;
      try {
        await api('/api/admin/inbox/' + e.id + '?forever=1', { method: 'DELETE' });
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
      syncComposer(e, canEmail);
      text.focus();
    }));
    if (text) {
      $('thSend').addEventListener('click', () => send(e, lastIn));
      text.addEventListener('keydown', ev => {
        if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') { ev.preventDefault(); send(e, lastIn); }
      });
    }
    bindVoucherCard(d);
  }

  function syncComposer(e, canEmail = true) {
    const reply = composerMode === 'reply' && canEmail;
    $('thAfterWrap').hidden = !reply;
    $('thSend').textContent = reply ? 'Send reply' : 'Save note';
    $('thText').placeholder = reply ? '' : 'Note for you and the team — what was said, what you agreed…';
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
      if (window.innerWidth <= 900) threadEl.innerHTML = emptyThread();
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
    if (currentThread.enquiry.deleted_at) return;   // nothing arrives in the bin
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
