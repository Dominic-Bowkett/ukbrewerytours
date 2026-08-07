/* UK Brewery Tours — embeddable gift voucher widget loader.
 *
 * Usage on any website:
 *
 *   <div data-ubt-voucher="wgt_XXXXXXXXXX"></div>
 *   <script async src="https://www.ukbrewerytours.com/embed/voucher.js"></script>
 *
 * Each [data-ubt-voucher] container gets an iframe of /embed/widget/<id>.
 * The iframe reports its height (so the widget never scrolls internally) and
 * hands the Stripe Checkout URL back to this script, which navigates the host
 * page — Stripe refuses to run inside an iframe, and a cross-origin iframe
 * cannot reliably navigate the top window itself.
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

  var frames = [];

  function mount(el) {
    if (el.getAttribute('data-ubt-ready')) return;
    el.setAttribute('data-ubt-ready', '1');
    var id = el.getAttribute('data-ubt-voucher');
    if (!id) return;

    var iframe = document.createElement('iframe');
    iframe.src = ORIGIN + '/embed/widget/' + encodeURIComponent(id)
      + '?host=' + encodeURIComponent(window.location.href);
    iframe.title = 'Buy a gift voucher';
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
    var mounts = document.querySelectorAll('[data-ubt-voucher]');
    for (var i = 0; i < mounts.length; i++) mount(mounts[i]);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
