/* Client-facing payment request page (/pay/<token>).
 *
 * Every value rendered here comes from a member-supplied field, so nothing is
 * ever written with innerHTML — textContent only. Stored XSS on this page would
 * run on the same origin as /admin/ and /team/.
 *
 * The button is disabled for the whole round trip: the server is single-flight
 * anyway, but there is no reason to send the second request at all.
 */
(function () {
  var root = document.getElementById('pay');
  if (!root) return;
  var token = root.dataset.token;

  var el = function (tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  var money = function (pence, currency) {
    try {
      return new Intl.NumberFormat('en-GB', {
        style: 'currency', currency: (currency || 'gbp').toUpperCase(),
      }).format(pence / 100);
    } catch (e) {
      return '£' + (pence / 100).toFixed(2);
    }
  };

  var prettyDate = function (iso, time) {
    if (!iso) return null;
    var parts = iso.split('-');
    if (parts.length !== 3) return iso;
    var d = new Date(Date.UTC(+parts[0], +parts[1] - 1, +parts[2]));
    var out = d.toLocaleDateString('en-GB', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
    });
    return time ? out + ' at ' + time : out;
  };

  var CLOSED_COPY = {
    expired: 'This payment link has expired. Please contact the organiser for a new one.',
    unavailable: 'This payment link is temporarily unavailable. Please contact the organiser.',
    closed: 'This request is no longer open for payment. Please contact the organiser.',
  };

  var clear = function () { while (root.firstChild) root.removeChild(root.firstChild); };

  var showError = function (message) {
    var box = el('p', 'pay-error', message);
    box.setAttribute('role', 'alert');
    root.appendChild(box);
    return box;
  };

  var render = function (d) {
    clear();

    root.appendChild(el('p', 'pay-seller', d.seller_name));
    root.appendChild(el('h1', 'pay-title', d.tour_name));

    var when = prettyDate(d.tour_date, d.tour_time);
    if (when) root.appendChild(el('p', 'pay-date', when));

    var amount = el('div', 'pay-amount', money(d.amount_pence, d.currency));
    root.appendChild(amount);

    if (d.details) {
      var det = el('p', 'pay-details');
      d.details.split('\n').forEach(function (line, i) {
        if (i) det.appendChild(document.createElement('br'));
        det.appendChild(document.createTextNode(line));
      });
      root.appendChild(det);
    }

    if (d.status === 'paid') {
      root.appendChild(el('p', 'pay-paid', 'Paid — thank you. A receipt is on its way to your inbox.'));
    } else if (d.status === 'closed') {
      root.appendChild(el('p', 'pay-error', CLOSED_COPY[d.closed_reason] || CLOSED_COPY.closed));
    } else {
      var btn = el('button', 'pay-button', 'Pay ' + money(d.amount_pence, d.currency) + ' securely');
      btn.type = 'button';
      btn.addEventListener('click', function () { startCheckout(btn); });
      root.appendChild(btn);
      root.appendChild(el('p', 'pay-secure', 'Payments are handled by Stripe. We never see your card details.'));
    }

    if (d.terms) {
      var terms = el('div', 'pay-terms');
      terms.appendChild(el('h2', null, 'Terms'));
      var p = el('p');
      d.terms.split('\n').forEach(function (line, i) {
        if (i) p.appendChild(document.createElement('br'));
        p.appendChild(document.createTextNode(line));
      });
      terms.appendChild(p);
      root.appendChild(terms);
    }

    if (d.reference) root.appendChild(el('p', 'pay-ref', 'Reference: ' + d.reference));
  };

  var startCheckout = function (btn) {
    btn.disabled = true;
    var original = btn.textContent;
    btn.textContent = 'Opening secure checkout…';

    fetch('/api/pay/' + encodeURIComponent(token) + '/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // The server ignores the body entirely; sent only so the request is
      // unambiguous to any proxy in between.
      body: '{}',
    }).then(function (res) {
      return res.json().then(function (body) { return { ok: res.ok, body: body }; });
    }).then(function (r) {
      if (r.body && r.body.url) {
        // Top-level redirect, never an iframe.
        window.location.href = r.body.url;
        return;
      }
      btn.textContent = original;
      if (r.body && r.body.paid) {
        load();   // re-render as paid
        return;
      }
      btn.disabled = false;
      showError((r.body && r.body.error) || 'Could not start the payment. Please try again.');
    }).catch(function () {
      btn.textContent = original;
      btn.disabled = false;
      showError('Could not reach the payment service. Please check your connection and try again.');
    });
  };

  var load = function () {
    fetch('/api/pay/' + encodeURIComponent(token) + window.location.search, {
      headers: { Accept: 'application/json' },
    }).then(function (res) {
      if (!res.ok) throw new Error('not found');
      return res.json();
    }).then(render).catch(function () {
      clear();
      root.appendChild(el('h1', 'pay-title', 'Payment link not found'));
      root.appendChild(el('p', null,
        'This link is not valid, or it has been withdrawn. Please check the link in your email, or contact whoever sent it.'));
    });
  };

  load();
})();
