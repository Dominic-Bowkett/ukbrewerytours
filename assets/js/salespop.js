// Social-proof pop-up (bottom left): rotates the latest gift voucher sales
// from /api/recent-sales — anonymised, amounts and timing only. Clicking the
// card opens the voucher modal (falling back to /gift-vouchers/); the × hides
// it to a small pill, and that choice sticks for a day via localStorage.
(function () {
  if (document.body.dataset.voucherDemo === '1') return;

  var KEY = 'ubtSalesPopMin';        // epoch ms when minimised
  var MIN_FOR = 24 * 60 * 60 * 1000; // stay minimised for a day
  var FIRST_DELAY = 4000;            // page settle → first toast
  var SHOW_FOR = 7000;               // toast on screen
  var GAP = 6000;                    // quiet gap between toasts

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

  fetch('/api/recent-sales')
    .then(function (r) { return r.json(); })
    .then(function (data) {
      var sales = (data && data.sales) || [];
      if (!sales.length) return;

      var wrap = document.createElement('div');
      wrap.className = 'salespop';
      wrap.innerHTML =
        '<button type="button" class="salespop-card" data-voucher-open aria-label="Buy a gift voucher">' +
          '<span class="salespop-ico" aria-hidden="true">🎁</span>' +
          '<span class="salespop-text"><span class="salespop-msg"></span>' +
          '<span class="salespop-when"></span></span>' +
        '</button>' +
        '<button type="button" class="salespop-hide" aria-label="Hide recent purchases">×</button>' +
        '<button type="button" class="salespop-pill" aria-label="Show recent purchases">🎁</button>';
      document.body.appendChild(wrap);

      var card = wrap.querySelector('.salespop-card');
      var hideBtn = wrap.querySelector('.salespop-hide');
      var pill = wrap.querySelector('.salespop-pill');
      var msgEl = wrap.querySelector('.salespop-msg');
      var whenEl = wrap.querySelector('.salespop-when');

      var i = 0;
      var timer = null;
      var minimised = Date.now() - minimisedAt() < MIN_FOR;

      // No voucher modal on this page (shouldn't happen) → gift voucher page.
      if (!document.querySelector('[data-voucher-modal]')) {
        card.addEventListener('click', function () { location.href = '/gift-vouchers/'; });
      }
      card.addEventListener('click', function () {
        if (typeof gtag === 'function') gtag('event', 'sales_pop_click');
      });

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
    .catch(function () { /* social proof must never break the page */ });
})();
