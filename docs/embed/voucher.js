/* UK Brewery Tours — embeddable widget loader (gift vouchers, contact forms).
 *
 * Usage on any website:
 *
 *   <div data-ubt-widget="wgt_XXXXXXXXXX"></div>
 *   <script async src="https://www.ukbrewerytours.com/embed/widget.js"></script>
 *
 * (data-ubt-voucher and /embed/voucher.js are the original voucher-only names —
 * both keep working; the two script files are identical copies.)
 *
 * Each container gets an iframe of /embed/widget/<id>, which renders whatever
 * kind of widget that id is. The iframe reports its height (so the widget never
 * scrolls internally). Voucher widgets also hand the Stripe Checkout URL back
 * to this script, which navigates the host page — Stripe refuses to run inside
 * an iframe, and a cross-origin iframe cannot reliably navigate the top window.
 */
(function () {
  'use strict';

  // Derive our origin from this script's own URL so preview deployments and
  // local dev work unchanged; fall back to production.
  var ORIGIN = 'https://www.ukbrewerytours.com';
  try {
    var cs = document.currentScript;
    if (cs && cs.src) ORIGIN = new URL(cs.src).origin;
  } catch (e) { /* very old browser — production origin is fine */ }

  // Ad attribution — the same function as in embed/chat.js (see there).
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

  var frames = [];

  function widgetSrc(id) {
    var attr = window.UBTAttr();
    return ORIGIN + '/embed/widget/' + encodeURIComponent(id)
      + '?host=' + encodeURIComponent(window.location.href)
      + (attr ? '&attr=' + encodeURIComponent(attr) : '');
  }

  // Cookies accepted after the widgets loaded: reload them with the ad click.
  // The banner shows on arrival, so nobody has typed into a widget yet.
  function onConsent() {
    if (!window.UBTAttr()) return;
    for (var i = 0; i < frames.length; i++) frames[i].src = widgetSrc(frames[i].getAttribute('data-ubt-id'));
  }
  document.addEventListener('ubt:consent', onConsent);
  document.addEventListener('lbt:consent', onConsent);

  function mount(el) {
    if (el.getAttribute('data-ubt-ready')) return;
    el.setAttribute('data-ubt-ready', '1');
    var id = el.getAttribute('data-ubt-widget') || el.getAttribute('data-ubt-voucher');
    if (!id) return;

    var iframe = document.createElement('iframe');
    iframe.src = widgetSrc(id);
    iframe.setAttribute('data-ubt-id', id);
    iframe.title = 'UK Brewery Tours';
    iframe.loading = 'lazy';
    iframe.style.cssText = 'display:block;width:100%;border:0;min-height:560px;background:transparent;';
    iframe.setAttribute('scrolling', 'no');
    el.appendChild(iframe);
    frames.push(iframe);
  }

  window.addEventListener('message', function (e) {
    if (e.origin !== ORIGIN || !e.data || e.data.ubtVoucher !== 1) return;

    if (e.data.type === 'size' && typeof e.data.height === 'number') {
      for (var i = 0; i < frames.length; i++) {
        if (frames[i].contentWindow === e.source) {
          frames[i].style.minHeight = '0';
          frames[i].style.height = Math.ceil(e.data.height) + 'px';
        }
      }
      return;
    }

    // Only ever navigate to Stripe's hosted checkout — nothing else.
    if (e.data.type === 'checkout' && typeof e.data.url === 'string'
        && e.data.url.indexOf('https://checkout.stripe.com/') === 0) {
      window.location.href = e.data.url;
    }
  });

  function init() {
    var mounts = document.querySelectorAll('[data-ubt-widget], [data-ubt-voucher]');
    for (var i = 0; i < mounts.length; i++) mount(mounts[i]);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
