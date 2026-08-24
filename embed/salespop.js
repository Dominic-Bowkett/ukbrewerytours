// UK Brewery Tours — embeddable recent-sales pop-up for network sites
// (bristolbrewerytours.com, londonbrewerytour.com, …).
//
//   <script async src="https://www.ukbrewerytours.com/embed/salespop.js"
//           data-link="/gift-vouchers/#buy"></script>
//
// Shows the latest paid gift voucher sales (anonymised: face value, quantity
// and time-ago only) as a rotating toast in the bottom-left corner, matching
// the pop-up on ukbrewerytours.com itself. Clicking goes to data-link (the
// host site's own voucher page; default /gift-vouchers/). The × minimises it
// to a pill for a day (localStorage, per host origin). Self-contained: injects
// its own namespaced styles, inherits the host page's body font.
(function () {
  if (window.__ubtSalesPop) return; // idempotent — ignore a double include
  window.__ubtSalesPop = true;

  var API = 'https://www.ukbrewerytours.com/api/recent-sales';
  var script = document.currentScript;
  var LINK = (script && script.getAttribute('data-link')) || '/gift-vouchers/';
  var ACCENT = (script && script.getAttribute('data-accent')) || '#f6e3c2';

  var KEY = 'ubtSalesPopMin';        // epoch ms when minimised
  var MIN_FOR = 24 * 60 * 60 * 1000; // stay minimised for a day
  var FIRST_DELAY = 1500;            // page settle → first toast
  var SHOW_FOR = 5000;               // toast on screen
  var GAP = 2500;                    // quiet gap between toasts

  function minimisedAt() {
    try { return parseInt(localStorage.getItem(KEY), 10) || 0; } catch (e) { return 0; }
  }
  function setMinimised(on) {
    try { on ? localStorage.setItem(KEY, String(Date.now())) : localStorage.removeItem(KEY); } catch (e) {}
  }

  function pounds(pence) {
    return pence % 100 === 0 ? '£' + (pence / 100) : '£' + (pence / 100).toFixed(2);
  }

  function saleText(s) {
    var v = pounds(s.amount_pence);
    return s.quantity > 1
      ? 'A customer purchased ' + s.quantity + ' × ' + v + ' gift vouchers'
      : 'A customer purchased a ' + v + ' gift voucher';
  }

  function agoText(mins) {
    if (mins < 5) return 'just now';
    if (mins < 60) return mins + ' minutes ago';
    var h = Math.round(mins / 60);
    if (h < 2) return 'an hour ago';
    if (h < 24) return h + ' hours ago';
    var d = Math.round(h / 24);
    if (d < 2) return 'yesterday';
    if (d < 14) return d + ' days ago';
    var w = Math.round(d / 7);
    if (d < 60) return w + ' weeks ago';
    var mo = Math.round(d / 30);
    return mo < 2 ? 'a month ago' : mo + ' months ago';
  }

  var CSS =
    '.ubtsp{position:fixed;left:14px;bottom:calc(14px + env(safe-area-inset-bottom,0px));z-index:999999;}' +
    '.ubtsp-card{display:flex;align-items:center;gap:12px;width:min(320px,calc(100vw - 28px));' +
      'padding:12px 34px 12px 14px;background:#fffdf7;border:1px solid #e6dac4;border-radius:14px;' +
      'box-shadow:0 2px 4px rgba(36,26,18,.08),0 24px 48px -20px rgba(36,26,18,.32);' +
      'text-align:left;text-decoration:none;cursor:pointer;opacity:0;transform:translateY(14px);' +
      'pointer-events:none;transition:opacity .35s ease,transform .35s ease;}' +
    '.ubtsp.on .ubtsp-card{opacity:1;transform:none;pointer-events:auto;}' +
    '.ubtsp-ico{flex:none;width:42px;height:42px;display:grid;place-items:center;font-size:1.25rem;' +
      'background:' + ACCENT + ';border-radius:50%;}' +
    '.ubtsp-msg{display:block;font-size:.89rem;font-weight:600;line-height:1.4;color:#241a12;}' +
    '.ubtsp-when{display:block;margin-top:2px;font-size:.78rem;font-weight:400;color:#6b5a49;}' +
    '.ubtsp-hide{position:absolute;top:4px;right:4px;width:26px;height:26px;display:grid;place-items:center;' +
      'font-size:1rem;line-height:1;color:#6b5a49;background:none;border:0;border-radius:50%;cursor:pointer;' +
      'opacity:0;pointer-events:none;transition:opacity .35s ease;}' +
    '.ubtsp.on .ubtsp-hide{opacity:1;pointer-events:auto;}' +
    '.ubtsp-hide:hover{color:#241a12;background:#eceae3;}' +
    '.ubtsp-pill{display:none;width:46px;height:46px;place-items:center;font-size:1.25rem;background:#fffdf7;' +
      'border:1px solid #e6dac4;border-radius:50%;' +
      'box-shadow:0 1px 2px rgba(36,26,18,.06),0 12px 32px -16px rgba(36,26,18,.22);' +
      'cursor:pointer;transition:transform .2s ease;}' +
    '.ubtsp-pill:hover{transform:scale(1.08);}' +
    '.ubtsp.min .ubtsp-card,.ubtsp.min .ubtsp-hide{display:none;}' +
    '.ubtsp.min .ubtsp-pill{display:grid;}' +
    '@media (prefers-reduced-motion:reduce){.ubtsp-card{transition:opacity .35s ease;transform:none;}' +
      '.ubtsp-pill{transition:none;}}';

  function boot() {
    fetch(API)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var sales = (data && data.sales) || [];
        if (!sales.length) return;

        var style = document.createElement('style');
        style.textContent = CSS;
        document.head.appendChild(style);

        var wrap = document.createElement('div');
        wrap.className = 'ubtsp';
        wrap.innerHTML =
          '<a class="ubtsp-card" href="' + LINK.replace(/"/g, '&quot;') + '" aria-label="Buy a gift voucher">' +
            '<span class="ubtsp-ico" aria-hidden="true">🎁</span>' +
            '<span><span class="ubtsp-msg"></span><span class="ubtsp-when"></span></span>' +
          '</a>' +
          '<button type="button" class="ubtsp-hide" aria-label="Hide recent purchases">×</button>' +
          '<button type="button" class="ubtsp-pill" aria-label="Show recent purchases">🎁</button>';
        document.body.appendChild(wrap);

        var hideBtn = wrap.querySelector('.ubtsp-hide');
        var pill = wrap.querySelector('.ubtsp-pill');
        var msgEl = wrap.querySelector('.ubtsp-msg');
        var whenEl = wrap.querySelector('.ubtsp-when');

        var i = 0;
        var timer = null;
        var minimised = Date.now() - minimisedAt() < MIN_FOR;

        function showToast() {
          if (minimised) return;
          var s = sales[i % sales.length];
          i += 1;
          msgEl.textContent = saleText(s);
          whenEl.textContent = agoText(s.mins_ago);
          wrap.classList.add('on');
          timer = setTimeout(function () {
            wrap.classList.remove('on');
            timer = setTimeout(showToast, GAP);
          }, SHOW_FOR);
        }

        function applyMin() {
          wrap.classList.toggle('min', minimised);
          wrap.classList.remove('on');
          clearTimeout(timer);
          if (!minimised) timer = setTimeout(showToast, 600);
        }

        hideBtn.addEventListener('click', function () {
          minimised = true;
          setMinimised(true);
          applyMin();
        });
        pill.addEventListener('click', function () {
          minimised = false;
          setMinimised(false);
          applyMin();
        });

        if (minimised) {
          wrap.classList.add('min');
        } else {
          timer = setTimeout(showToast, FIRST_DELAY);
        }
      })
      .catch(function () { /* social proof must never break the host page */ });
  }

  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot);
})();
