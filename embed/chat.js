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

  // Ad attribution: remember the last ad click (Google click id + UTM tags) in
  // this site's localStorage for 90 days, so a voucher sale or enquiry days
  // later can be credited to the ad. Returns it as a query string ('' if none).
  // The same function lives in embed/voucher.js; whichever loads first wins.
  if (!window.UBTAttr) window.UBTAttr = function () {
    var KEYS = ['gclid', 'gbraid', 'wbraid', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
    // The ad click Google itself is holding, or null. Until the banner is
    // answered, url_passthrough carries it from page to page inside _gl
    // ("1*hash*key*value*…", web-safe base64 with '.' for '='); once cookies are
    // on, Google's tag keeps it in _gcl_aw / _gcl_gb. Both hold "GCL.<secs>.<id>".
    function googleClick(gl) {
      var raw = {}, parts = (gl || '').split('*'), NAMES = { _gcl_aw: 'gclid', _gcl_gb: 'gbraid' }, j, k, m, t;
      for (j = 2; j + 1 < parts.length; j += 2) {
        try { raw[parts[j]] = atob(parts[j + 1].replace(/-/g, '+').replace(/_/g, '/').replace(/\./g, '=')); } catch (e) { /* not base64 */ }
      }
      for (k in NAMES) {
        m = raw[k] ? null : document.cookie.match(new RegExp('(?:^|; )' + k + '=([^;]*)'));
        m = /^GCL\.(\d+)\.([A-Za-z0-9_\-]{10,200})$/.exec(raw[k] || (m ? decodeURIComponent(m[1]) : ''));
        t = m ? Number(m[1]) * 1000 : 0;
        // A click older than the 90-day window is not revived as a new one.
        if (t > Date.now() - 90 * 864e5 && t <= Date.now() + 864e5) return { key: NAMES[k], id: m[2], ts: Math.min(t, Date.now()) };
      }
      return null;
    }
    try {
      // Only with cookie consent: ubt_consent (UKBT, Bristol) or lbt_consent (London).
      if (localStorage.getItem('ubt_consent') !== 'granted' && localStorage.getItem('lbt_consent') !== 'granted') {
        localStorage.removeItem('ubt_attr');
        return '';
      }
      var q = new URLSearchParams(location.search), fresh = null, i, v;
      for (i = 0; i < KEYS.length; i++) {
        v = q.get(KEYS[i]);
        if (v) { fresh = fresh || {}; fresh[KEYS[i]] = v.slice(0, 200); }
      }
      var s = JSON.parse(localStorage.getItem('ubt_attr') || 'null');
      // No click id in this URL (they accepted cookies a page or two after
      // arriving from the ad): take Google's copy, unless it's one already stored.
      if (!(fresh && (fresh.gclid || fresh.gbraid || fresh.wbraid))) {
        var g = googleClick(q.get('_gl'));
        if (g && (fresh || !(s && s[g.key] === g.id))) {
          fresh = fresh || {};
          fresh[g.key] = g.id;
          fresh.ts = g.ts;
        }
      }
      if (fresh) {
        fresh.landing = location.origin + location.pathname;
        fresh.ts = fresh.ts || Date.now();
        localStorage.setItem('ubt_attr', JSON.stringify(fresh));
        s = fresh;
      }
      if (!s || !(Date.now() - s.ts < 90 * 864e5)) return '';
      var out = new URLSearchParams();
      for (var k in s) if (Object.prototype.hasOwnProperty.call(s, k)) out.set(k, String(s[k]));
      return out.toString();
    } catch (e) { return ''; } // storage blocked — attribution is best effort
  };
  var ATTR = window.UBTAttr();
  // Cookies accepted after the chat loaded: store any ad click in this page's
  // URL and hand it to the chat frame (its src was built without it).
  function onConsent() {
    ATTR = window.UBTAttr();
    if (frame && ATTR) send({ type: 'attr', attr: ATTR });
  }
  document.addEventListener('ubt:consent', onConsent);
  document.addEventListener('lbt:consent', onConsent);

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
      + '&host=' + encodeURIComponent(window.location.href)
      + (ATTR ? '&attr=' + encodeURIComponent(ATTR) : '');
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
