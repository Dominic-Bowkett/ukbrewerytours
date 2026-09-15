// Live chat UI — one renderer for two places:
//
//   frame  /embed/chat/frame   the pop-up chat, iframed bottom-right on every
//                              network site by /embed/chat.js
//   page   /messages/<token>   the full-page conversation a customer reaches
//                              from the link in our emails
//
// It is "chat" in feel, not in transport: messages go through /api/contact
// (first message) and /api/thread (everything after), and team replies arrive
// by polling. Every reply is also emailed, so nobody has to keep the tab open.

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

export const PROFILES = {
  ukbt: { name: 'UK Brewery Tours', home: 'https://www.ukbrewerytours.com/', accent: '#e0932f', accentInk: '#241505', head: '#201611' },
  london: { name: 'London Brewery Tours', home: 'https://www.londonbrewerytour.com/', accent: '#ffb703', accentInk: '#1c1208', head: '#1c1208' },
  bristol: { name: 'Bristol Brewery Tours', home: 'https://www.bristolbrewerytours.com/', accent: '#e8942e', accentInk: '#1b1206', head: '#0e2b2f' },
};

const TOPICS = [
  ['booking', '🍺 Book a tour', 'Which tour are you interested in, and roughly when?'],
  ['group', '👥 Group booking', 'Brilliant — tell us your city, group size and rough dates.'],
  ['redemption', '🎟️ Redeem a voucher', "Lovely — which tour and date would you like? We'll ask for your voucher code in a moment."],
  ['voucher', '🎁 Gift vouchers', 'What would you like to know about gift vouchers?'],
  ['general', '💬 Something else', 'Go ahead — what can we help with?'],
];

const CHAT_ICON = '<svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor" aria-hidden="true"><path d="M12 3C6.5 3 2 6.6 2 11.1c0 2.4 1.3 4.6 3.4 6.1-.2 1.3-.8 2.6-1.9 3.6-.2.2 0 .6.3.6 2.1-.1 3.8-.9 5-1.9 1 .3 2.1.4 3.2.4 5.5 0 10-3.6 10-8.1S17.5 3 12 3Zm-4.5 9.4a1.3 1.3 0 1 1 0-2.6 1.3 1.3 0 0 1 0 2.6Zm4.5 0a1.3 1.3 0 1 1 0-2.6 1.3 1.3 0 0 1 0 2.6Zm4.5 0a1.3 1.3 0 1 1 0-2.6 1.3 1.3 0 0 1 0 2.6Z"/></svg>';
const SEND_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M3.4 20.4 21 12 3.4 3.6 3.4 10l12.6 2-12.6 2z"/></svg>';

export function chatHtml({ mode, profileKey = 'ukbt', token = null, hostUrl = '' }) {
  const p = PROFILES[profileKey] || PROFILES.ukbt;
  const page = mode === 'page';
  const config = {
    mode: page ? 'page' : 'frame',
    site: PROFILES[profileKey] ? profileKey : 'ukbt',
    brand: p.name,
    home: p.home,
    token,
    hostUrl: String(hostUrl || '').slice(0, 500),
    topics: TOPICS.map(([key, , prompt]) => [key, prompt]),
  };

  return `<!DOCTYPE html>
<html lang="en-GB">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<title>${page ? `Your conversation — ${esc(p.name)}` : `Chat — ${esc(p.name)}`}</title>
<style>
  :root { --accent: ${p.accent}; --accent-ink: ${p.accentInk}; --head: ${p.head};
          --ink: #241a12; --ink-soft: #6b5c4f; --line: #e8dfd1; --bg: #f6f1e8; --paper: #fff; --red: #a13c37; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; background: transparent; }
  body { font: 15px/1.5 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; color: var(--ink); overflow: hidden; }
  [hidden] { display: none !important; }
  button { font: inherit; cursor: pointer; }

  .panel { position: absolute; display: flex; flex-direction: column; background: var(--bg); overflow: hidden; }
  /* The iframe clips anything outside it, so the shadow stays inside the 12px margin. */
  .mode-frame .panel { right: 12px; bottom: 84px; left: 12px; top: 12px; border-radius: 16px;
    box-shadow: 0 4px 10px rgba(20, 12, 6, .2), 0 1px 3px rgba(20, 12, 6, .14); }
  .mode-frame.full .panel { inset: 0; border-radius: 0; box-shadow: none; }
  .mode-page { background: #efe7da; overflow: auto; }
  .mode-page .panel { position: relative; margin: 20px auto; width: calc(100% - 24px); max-width: 640px;
    height: calc(100% - 40px); min-height: 480px; border-radius: 16px; box-shadow: 0 18px 50px rgba(20, 12, 6, .18); }

  .hd { display: flex; align-items: center; gap: 12px; padding: 14px 14px 14px 16px; background: var(--head); color: #fff; flex-shrink: 0; }
  .avatar { width: 40px; height: 40px; border-radius: 50%; background: var(--accent); color: var(--accent-ink);
    display: grid; place-items: center; font-size: 20px; flex-shrink: 0; }
  .who { flex: 1; min-width: 0; }
  .who strong { display: block; font-size: 1rem; line-height: 1.25; }
  .who span { display: block; font-size: .78rem; opacity: .78; }
  .who span::before { content: ''; display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #5fd08a; margin-right: 6px; vertical-align: 1px; }
  .x { width: 34px; height: 34px; border: 0; border-radius: 50%; background: rgba(255,255,255,.12); color: #fff; font-size: 22px; line-height: 1; }
  .x:hover { background: rgba(255,255,255,.22); }
  .menu { border: 0; background: none; color: #fff; opacity: .8; font-size: .78rem; text-decoration: underline; padding: 4px; }

  .body { flex: 1; overflow-y: auto; padding: 16px 14px 8px; display: flex; flex-direction: column; gap: 8px; overscroll-behavior: contain; }
  #thread { display: flex; flex-direction: column; gap: 8px; }
  #thread:empty { display: none; }
  .msg { display: flex; flex-direction: column; max-width: 84%; }
  .msg.you { align-self: flex-end; align-items: flex-end; margin-left: auto; }
  .msg.team { align-self: flex-start; }
  .bubble { padding: 9px 13px; border-radius: 16px; white-space: pre-wrap; word-wrap: break-word; overflow-wrap: anywhere; font-size: .94rem; line-height: 1.45; }
  .team .bubble { background: var(--paper); border-top-left-radius: 5px; box-shadow: 0 1px 1px rgba(0,0,0,.06); }
  .you .bubble { background: var(--accent); color: var(--accent-ink); border-top-right-radius: 5px; }
  .bubble a { color: inherit; font-weight: 600; }
  .msg time { font-size: .7rem; color: var(--ink-soft); margin: 3px 6px 0; }
  .msg.pending .bubble { opacity: .6; }
  .sys { align-self: center; text-align: center; font-size: .78rem; color: var(--ink-soft); background: rgba(255,255,255,.6);
    border-radius: 10px; padding: 6px 12px; max-width: 92%; }

  .topics { display: flex; flex-wrap: wrap; gap: 6px; margin: 2px 0 4px; }
  .topic { border: 1.5px solid var(--accent); background: var(--paper); color: var(--ink); border-radius: 999px; padding: 6px 12px; font-size: .86rem; font-weight: 600; }
  .topic:hover, .topic.on { background: var(--accent); color: var(--accent-ink); }

  .details { align-self: stretch; background: var(--paper); border-radius: 14px; padding: 14px; display: flex; flex-direction: column; gap: 10px; box-shadow: 0 1px 1px rgba(0,0,0,.06); }
  .details p { font-size: .9rem; font-weight: 600; }
  .details label { font-size: .74rem; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--ink-soft); display: block; margin-bottom: 4px; }
  .details input { width: 100%; border: 1.5px solid var(--line); border-radius: 9px; padding: 9px 11px; font: inherit; font-size: .95rem; color: var(--ink); background: #fff; }
  .details input:focus, .composer textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
  .go { border: 0; border-radius: 999px; background: var(--accent); color: var(--accent-ink); font-weight: 700; padding: 11px 16px; }
  .go:disabled, .send:disabled { opacity: .5; cursor: default; }
  .err { color: var(--red); font-size: .85rem; }
  .hp { position: absolute; left: -9999px; width: 1px; height: 1px; overflow: hidden; }

  .topicbar { display: flex; align-items: center; gap: 6px; padding: 0 14px 6px; font-size: .78rem; color: var(--ink-soft); }
  .topicbar button { border: 0; background: none; color: var(--ink-soft); font-size: .95rem; line-height: 1; padding: 0 4px; }
  .composer { display: flex; align-items: flex-end; gap: 8px; padding: 8px 10px 10px; background: var(--bg); flex-shrink: 0; }
  .composer textarea { flex: 1; resize: none; border: 1.5px solid var(--line); border-radius: 20px; padding: 10px 14px; font: inherit; font-size: .95rem;
    line-height: 1.4; max-height: 120px; background: #fff; color: var(--ink); }
  .send { width: 44px; height: 44px; border-radius: 50%; border: 0; background: var(--accent); color: var(--accent-ink); display: grid; place-items: center; flex-shrink: 0; }
  .foot { text-align: center; font-size: .7rem; color: var(--ink-soft); padding: 0 12px 10px; background: var(--bg); flex-shrink: 0; }
  .foot a, .foot button { color: var(--ink-soft); background: none; border: 0; font-size: inherit; text-decoration: underline; }

  .launcher { position: absolute; right: 16px; bottom: 16px; width: 60px; height: 60px; border-radius: 50%; border: 0;
    background: var(--accent); color: var(--accent-ink); display: grid; place-items: center;
    box-shadow: 0 6px 18px rgba(20, 12, 6, .3); transition: transform .15s ease; }
  .launcher:hover { transform: scale(1.06); }
  .launcher .close-ico { font-size: 30px; line-height: 1; }
  .badge { position: absolute; top: -2px; right: -2px; min-width: 20px; height: 20px; border-radius: 10px; background: #d93a2b; color: #fff;
    font-size: .72rem; font-weight: 700; display: grid; place-items: center; padding: 0 5px; border: 2px solid #fff; }
  .mode-frame.full.open .launcher { display: none; }
  .mode-page .launcher { display: none; }
  @media (prefers-reduced-motion: reduce) { .launcher { transition: none; } }
</style>
</head>
<body class="mode-${page ? 'page' : 'frame'}">
<section class="panel" id="panel" ${page ? '' : 'hidden'} aria-label="Chat with ${esc(p.name)}">
  <header class="hd">
    <div class="avatar" aria-hidden="true">🍺</div>
    <div class="who"><strong>${esc(p.name)}</strong><span>Usually replies within a few hours</span></div>
    ${page ? '' : '<button class="x" id="close" type="button" aria-label="Close chat">&times;</button>'}
  </header>

  <div class="body" id="body" aria-live="polite">
    <div class="msg team" id="greet"><div class="bubble">${page
      ? 'Your conversation with us is below — add a message any time and we\'ll reply by email too.'
      : 'Hi there 👋 Questions about a tour, a group booking or a gift voucher? Send us a message — we\'ll reply here and by email.'}</div></div>
    ${page ? '' : `<div class="topics" id="topics">${TOPICS.map(([key, label]) =>
      `<button type="button" class="topic" data-topic="${key}">${label}</button>`).join('')}</div>`}
    <div id="thread"></div>
    <form class="details" id="details" hidden novalidate>
      <p>Where should we send our reply?</p>
      <div><label for="d-name">Name</label><input id="d-name" type="text" autocomplete="name" maxlength="100"></div>
      <div><label for="d-email">Email</label><input id="d-email" type="email" autocomplete="email" maxlength="200"></div>
      <div id="d-code-row" hidden><label for="d-code">Voucher code</label><input id="d-code" type="text" autocomplete="off" maxlength="200" placeholder="e.g. UBT-XXXX-XXXX" style="text-transform:uppercase"></div>
      <div class="hp" aria-hidden="true"><label for="d-company">Company</label><input id="d-company" type="text" tabindex="-1" autocomplete="off"></div>
      <p class="err" id="d-err" hidden></p>
      <button class="go" id="d-go" type="submit">Send message</button>
    </form>
  </div>

  <div class="topicbar" id="topicbar" hidden><span id="topiclabel"></span><button type="button" id="cleartopic" aria-label="Clear topic">&times;</button></div>
  <form class="composer" id="composer" novalidate>
    <textarea id="text" rows="1" maxlength="5000" placeholder="Type a message…" aria-label="Message"></textarea>
    <button class="send" id="send" type="submit" aria-label="Send">${SEND_ICON}</button>
  </form>
  <p class="err" id="err" hidden style="padding:0 16px 6px"></p>
  <div class="foot" id="foot">${page
    ? `<a href="${esc(p.home)}">${esc(p.name)}</a> · replies come from info@ukbrewerytours.com`
    : 'Replies also come by email from info@ukbrewerytours.com'}<span id="restart" hidden> · <button type="button" id="newchat">Start a new conversation</button></span></div>
</section>

<button class="launcher" id="launcher" type="button" aria-label="Chat with ${esc(p.name)}" aria-expanded="false" ${page ? 'hidden' : ''}>
  <span id="l-open">${CHAT_ICON}</span><span id="l-close" class="close-ico" hidden>&times;</span>
  <span class="badge" id="badge" hidden>1</span>
</button>

<script>
(function () {
  'use strict';
  var C = ${JSON.stringify(config).replace(/</g, '\\u003c')};
  var PAGE = C.mode === 'page';
  var framed = window.parent !== window;
  var $ = function (id) { return document.getElementById(id); };
  var KEY = 'ubt_chat_' + C.site;

  var store = {
    get: function (k) { try { return JSON.parse(localStorage.getItem(KEY) || '{}')[k]; } catch (e) { return mem[k]; } },
    set: function (k, v) { mem[k] = v; try { var o = JSON.parse(localStorage.getItem(KEY) || '{}'); o[k] = v; localStorage.setItem(KEY, JSON.stringify(o)); } catch (e) {} }
  };
  var mem = {};

  var token = PAGE ? C.token : store.get('token');
  var topic = null;
  var open = PAGE;
  var messages = [];
  var pendingText = '';
  var pollTimer = null;
  var sending = false;

  function post(msg) { if (framed && !PAGE) { msg.ubtChat = 1; parent.postMessage(msg, '*'); } }

  function fmtTime(s) {
    try {
      var d = new Date(String(s).replace(' ', 'T') + 'Z');
      var today = new Date();
      var sameDay = d.toDateString() === today.toDateString();
      return sameDay
        ? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
        : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ', ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    } catch (e) { return ''; }
  }

  function escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function linkify(s) {
    return escHtml(s).replace(/https?:\\/\\/[^\\s<]+[^\\s<.,;:!?)]/g, function (u) {
      return '<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + u + '</a>';
    });
  }

  function scrollDown() { var b = $('body'); b.scrollTop = b.scrollHeight; }

  function render() {
    var html = messages.map(function (m) {
      return '<div class="msg ' + (m.from === 'team' ? 'team' : 'you') + (m.pending ? ' pending' : '') + '">'
        + '<div class="bubble">' + linkify(m.body) + '</div>'
        + '<time>' + (m.pending ? 'Sending…' : (m.from === 'team' ? C.brand + ' · ' : '') + fmtTime(m.at)) + '</time></div>';
    }).join('');
    if (thanks) html += '<div class="sys">' + escHtml(thanks) + '</div>';
    if (closedNote) html += '<div class="sys">This conversation was closed — send a message to reopen it.</div>';
    $('thread').innerHTML = html;
    if ($('topics')) $('topics').hidden = !!token || messages.length > 0;
    $('restart').hidden = PAGE || !token;
    updateBadge();
    scrollDown();
  }
  var thanks = '';
  var closedNote = false;

  function lastSeen() { return Number(store.get('seen') || 0); }
  function updateBadge() {
    if (PAGE) return;
    var seen = lastSeen();
    var unread = messages.filter(function (m) { return m.from === 'team' && m.id > seen; }).length;
    if (open && unread) { markSeen(); unread = 0; }
    $('badge').hidden = !unread;
    $('badge').textContent = String(unread);
  }
  function markSeen() {
    var max = 0;
    messages.forEach(function (m) { if (m.from === 'team' && m.id > max) max = m.id; });
    if (max) store.set('seen', max);
  }

  function showError(msg) { $('err').textContent = msg; $('err').hidden = !msg; }

  function load() {
    if (!token) return Promise.resolve();
    return fetch('/api/thread?t=' + encodeURIComponent(token), { cache: 'no-store' })
      .then(function (r) {
        if (r.status === 404) {
          if (!PAGE) { token = null; store.set('token', null); messages = []; render(); }
          else { $('greet').querySelector('.bubble').textContent = 'Sorry — we could not find this conversation.'; $('composer').hidden = true; }
          return null;
        }
        return r.json();
      })
      .then(function (d) {
        if (!d || !d.ok) return;
        var before = messages.length;
        messages = d.messages;
        closedNote = !!d.closed;
        if (d.messages.length !== before) render(); else updateBadge();
      })
      .catch(function () {});
  }

  function schedule() {
    clearTimeout(pollTimer);
    if (!token) return;
    var hidden = document.visibilityState === 'hidden';
    var delay = hidden ? 120000 : (open ? 12000 : 60000);
    pollTimer = setTimeout(function () { load().then(schedule); }, delay);
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && token) load().then(schedule);
  });

  function setOpen(v) {
    if (PAGE) return;
    open = v;
    $('panel').hidden = !v;
    document.body.classList.toggle('open', v);
    $('launcher').setAttribute('aria-expanded', String(v));
    $('l-open').hidden = v;
    $('l-close').hidden = !v;
    post({ type: 'state', open: v });
    if (v) {
      markSeen(); updateBadge(); scrollDown();
      setTimeout(function () { if (!$('details').hidden) $('d-name').focus(); else $('text').focus(); }, 60);
      if (token) load().then(schedule);
    } else {
      schedule();
    }
  }

  function setTopic(key) {
    topic = key;
    var t = C.topics.filter(function (x) { return x[0] === key; })[0];
    [].forEach.call(document.querySelectorAll('.topic'), function (b) { b.classList.toggle('on', b.getAttribute('data-topic') === key); });
    $('topicbar').hidden = !key || !!token;
    if (key) {
      var btn = document.querySelector('.topic[data-topic="' + key + '"]');
      $('topiclabel').textContent = 'Topic: ' + (btn ? btn.textContent.replace(/^\\S+\\s/, '') : key);
    }
    $('d-code-row').hidden = key !== 'redemption';
    if (t && !token) {
      $('greet').querySelector('.bubble').textContent = t[1];
      $('text').focus();
    }
  }

  // ---- sending ----
  function autosize() { var t = $('text'); t.style.height = 'auto'; t.style.height = Math.min(120, t.scrollHeight) + 'px'; }
  $('text').addEventListener('input', autosize);
  $('text').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !('ontouchstart' in window)) { e.preventDefault(); $('composer').requestSubmit ? $('composer').requestSubmit() : $('send').click(); }
  });

  $('composer').addEventListener('submit', function (e) {
    e.preventDefault();
    showError('');
    var text = $('text').value.trim();
    if (!text || sending) return;

    if (!token) {
      // First message: hold it and ask where to reply.
      pendingText = text;
      messages = [{ from: 'you', body: text, pending: true, at: '' }];
      render();
      $('d-name').value = $('d-name').value || store.get('name') || '';
      $('d-email').value = $('d-email').value || store.get('email') || '';
      $('details').hidden = false;
      $('composer').hidden = true;
      $('topicbar').hidden = true;
      scrollDown();
      setTimeout(function () { ($('d-name').value ? ($('d-email').value ? ($('d-code-row').hidden ? $('d-go') : $('d-code')) : $('d-email')) : $('d-name')).focus(); }, 30);
      return;
    }

    sending = true;
    $('send').disabled = true;
    messages.push({ from: 'you', body: text, pending: true, at: '' });
    $('text').value = ''; autosize();
    closedNote = false;
    render();

    fetch('/api/thread', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ t: token, message: text, channel: PAGE ? 'web' : 'chat' })
    }).then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || 'Could not send.'); return d; }); })
      .then(function (d) { messages = d.messages; closedNote = false; render(); schedule(); })
      .catch(function (err) {
        messages.pop(); render();
        $('text').value = text; autosize();
        showError(err.message || 'Could not send — please try again.');
      })
      .then(function () { sending = false; $('send').disabled = false; });
  });

  $('details').addEventListener('submit', function (e) {
    e.preventDefault();
    var err = $('d-err');
    err.hidden = true;
    var name = $('d-name').value.trim(), email = $('d-email').value.trim(), code = $('d-code').value.trim();
    function fail(msg, el) { err.textContent = msg; err.hidden = false; if (el) el.focus(); }
    if (!name) return fail('Please enter your name.', $('d-name'));
    if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) return fail('Please enter a valid email so we can reply.', $('d-email'));
    if (topic === 'redemption' && !code) return fail('Please add your voucher code — it is in your voucher email.', $('d-code'));

    $('d-go').disabled = true;
    $('d-go').textContent = 'Sending…';
    fetch('/api/contact', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: 'chat', name: name, email: email, message: pendingText,
        type: topic || 'general', voucher_code: topic === 'redemption' ? code : '',
        hostUrl: C.hostUrl, company: $('d-company').value
      })
    }).then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || 'Could not send.'); return d; }); })
      .then(function (d) {
        token = d.token;
        store.set('token', token); store.set('name', name); store.set('email', email); store.set('seen', 0);
        thanks = 'Thanks ' + name.split(' ')[0] + "! We've got your message and will reply here and by email to " + email + '.';
        $('details').hidden = true;
        $('composer').hidden = false;
        $('topicbar').hidden = true;
        pendingText = '';
        return load();
      })
      .then(function () { $('text').value = ''; autosize(); render(); schedule(); })
      .catch(function (e2) { fail(e2.message || 'Could not send — please try again.'); })
      .then(function () { $('d-go').disabled = false; $('d-go').textContent = 'Send message'; });
  });

  // ---- controls ----
  if ($('topics')) $('topics').addEventListener('click', function (e) {
    var b = e.target.closest('.topic'); if (b) setTopic(b.getAttribute('data-topic'));
  });
  $('cleartopic').addEventListener('click', function () { setTopic(null); $('topicbar').hidden = true; });
  if ($('close')) $('close').addEventListener('click', function () { setOpen(false); });
  $('launcher').addEventListener('click', function () { setOpen(!open); });
  $('newchat').addEventListener('click', function () {
    if (!confirm('Start a new conversation? Your previous messages stay with us and in your email.')) return;
    token = null; store.set('token', null); messages = []; thanks = ''; closedNote = false; topic = null;
    $('greet').querySelector('.bubble').textContent = 'Hi there 👋 What can we help with this time?';
    $('details').hidden = true; $('composer').hidden = false;
    render(); clearTimeout(pollTimer); $('text').focus();
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && open && !PAGE) setOpen(false); });

  // Messages from the loader on the host page.
  window.addEventListener('message', function (e) {
    if (e.source !== window.parent || !e.data || e.data.ubtChat !== 1) return;
    if (e.data.type === 'layout') document.body.classList.toggle('full', !!e.data.full);
    if (e.data.type === 'open') {
      if (!token && e.data.topic && C.topics.some(function (x) { return x[0] === e.data.topic; })) setTopic(e.data.topic);
      if (typeof e.data.text === 'string' && e.data.text && !$('text').value) $('text').value = e.data.text.slice(0, 1000);
      setOpen(true);
      // Size the box once the panel is visible — a hidden textarea measures 0.
      setTimeout(autosize, 60);
    }
    if (e.data.type === 'layout') setTimeout(autosize, 30);
  });

  render();
  if (token) load().then(schedule);
  if (PAGE) { setTimeout(function () { $('text').focus(); }, 100); }
  post({ type: 'ready' });
})();
</script>
</body>
</html>`;
}
