/* UK Brewery Tours — live chat loader (replaces the WhatsApp buttons).
 *
 * Usage on any network site, once per page:
 *
 *   <script async src="https://www.ukbrewerytours.com/embed/chat.js" data-site="london"></script>
 *
 * data-site picks the branding: ukbt (default), london, bristol. Messages land
 * in the UK Brewery Tours admin inbox, tagged with the page they came from.
 *
 * Any element with data-chat-open opens the chat when clicked, optionally
 * preset:  <a href="/contact/" data-chat-open data-chat-topic="group"
 *             data-chat-text="Hi! I'd like a group booking for …">Enquire</a>
 * Topics: booking, group, redemption, voucher, general. The href is the no-JS
 * fallback. Scripts can call window.UBTChat.open({ topic, text }).
 */
(function () {
  'use strict';
  if (window.UBTChat) return;

  var script = document.currentScript;
  var ORIGIN = 'https://www.ukbrewerytours.com';
  try { if (script && script.src) ORIGIN = new URL(script.src).origin; } catch (e) { /* production is fine */ }
  var SITE = (script && script.getAttribute('data-site')) || 'ukbt';

  var frame = null;
  var ready = false;
  var queue = [];
  var isOpen = false;
  var CLOSED = 92;

  function isSmall() { return window.innerWidth < 560 || window.innerHeight < 520; }

  function size() {
    if (!frame) return;
    // Hosts can style around the chat, e.g. lift the closed bubble above a
    // cookie banner:  body.has-cookie-banner iframe[data-ubt-chat="closed"] { bottom: 118px !important }
    frame.setAttribute('data-ubt-chat', isOpen ? 'open' : 'closed');
    var s = frame.style;
    if (!isOpen) {
      s.width = CLOSED + 'px'; s.height = CLOSED + 'px'; s.top = 'auto'; s.left = 'auto';
      document.documentElement.style.removeProperty('overflow');
    } else if (isSmall()) {
      s.width = '100%'; s.height = '100%'; s.top = '0'; s.left = '0';
      document.documentElement.style.overflow = 'hidden';
    } else {
      s.width = '404px'; s.height = Math.min(700, window.innerHeight) + 'px'; s.top = 'auto'; s.left = 'auto';
      document.documentElement.style.removeProperty('overflow');
    }
    send({ type: 'layout', full: isOpen && isSmall() });
  }

  function send(msg) {
    msg.ubtChat = 1;
    if (ready && frame && frame.contentWindow) frame.contentWindow.postMessage(msg, ORIGIN);
    else queue.push(msg);
  }

  function mount() {
    if (frame) return;
    frame = document.createElement('iframe');
    frame.src = ORIGIN + '/embed/chat/frame?site=' + encodeURIComponent(SITE)
      + '&host=' + encodeURIComponent(window.location.href);
    frame.title = 'Chat with us';
    frame.setAttribute('data-ubt-chat', 'closed');
    frame.setAttribute('allowtransparency', 'true');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:' + CLOSED + 'px;height:' + CLOSED + 'px;'
      + 'border:0;margin:0;padding:0;background:transparent;color-scheme:normal;z-index:2147483000;'
      + 'max-width:100%;max-height:100%;';
    document.body.appendChild(frame);
  }

  window.addEventListener('message', function (e) {
    if (!frame || e.source !== frame.contentWindow || e.origin !== ORIGIN || !e.data || e.data.ubtChat !== 1) return;
    if (e.data.type === 'ready') {
      ready = true;
      var q = queue; queue = [];
      for (var i = 0; i < q.length; i++) send(q[i]);
      size();
    } else if (e.data.type === 'state') {
      isOpen = !!e.data.open;
      size();
    }
  });

  window.addEventListener('resize', function () { if (isOpen) size(); });

  window.UBTChat = {
    open: function (opts) {
      opts = opts || {};
      mount();
      send({ type: 'open', topic: opts.topic || '', text: opts.text || '' });
    }
  };

  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-chat-open]') : null;
    if (!el) return;
    e.preventDefault();
    window.UBTChat.open({ topic: el.getAttribute('data-chat-topic'), text: el.getAttribute('data-chat-text') });
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
