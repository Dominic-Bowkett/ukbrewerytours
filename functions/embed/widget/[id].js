// GET /embed/widget/:id — the embeddable gift voucher purchase form.
//
// Loaded inside an <iframe> on OTHER websites by /embed/voucher.js. Because the
// frame is served from ukbrewerytours.com, its fetch() to /api/create-checkout
// is same-origin — the host site needs no CORS and never touches the payment.
// Stripe won't run inside an iframe, so the Checkout URL is posted up to the
// loader script, which navigates the host page.
//
// Public and unauthenticated by design; the widget id is the only key, and all
// it unlocks is the ability to BUY a voucher.

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Black or white text, whichever reads better on the accent colour. */
function inkOn(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [n >> 16 & 255, n >> 8 & 255, n & 255];
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#241505' : '#ffffff';
}

// A bare message card (widget missing / paused). Still reports its height so
// the host page doesn't keep a big empty hole.
function messageCard(title, text, status = 200) {
  return new Response(`<!DOCTYPE html>
<html lang="en-GB"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title>
<style>body{margin:0;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;background:transparent}
.card{background:#fff;border:1px solid #e5ddd0;border-radius:14px;padding:26px;text-align:center;color:#4d4337}
.card h2{margin:0 0 8px;font-size:1.05rem;color:#241505}.card p{margin:0;font-size:.92rem;line-height:1.55}</style></head>
<body><div class="card"><h2>${esc(title)}</h2><p>${esc(text)}</p></div>
<script>(function(){function r(){if(window.parent!==window)parent.postMessage({ubtVoucher:1,type:'size',height:document.documentElement.scrollHeight},'*')}
window.addEventListener('load',r);r()})();</script></body></html>`, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex', 'Cache-Control': 'no-store' },
  });
}

export async function onRequestGet({ params, env }) {
  const id = String(params.id || '').trim();

  let widget = null;
  try {
    widget = await env.DB.prepare('SELECT * FROM widgets WHERE id = ?').bind(id).first();
  } catch (err) {
    console.error('widget lookup failed', err);
  }

  if (!widget) {
    return messageCard('Gift vouchers', 'This voucher widget is no longer available.', 404);
  }

  const headers = {
    'Content-Type': 'text/html; charset=utf-8',
    'X-Robots-Tag': 'noindex',
    // Config edits in the admin should show up on the host site promptly.
    'Cache-Control': 'no-store',
  };

  // Lock framing down when the admin listed specific sites; otherwise embed anywhere.
  let origins = [];
  try { origins = JSON.parse(widget.allowed_origins || '[]'); } catch { /* treat as open */ }
  if (Array.isArray(origins) && origins.length) {
    headers['Content-Security-Policy'] = `frame-ancestors 'self' ${origins.join(' ')}`;
  }

  if (widget.status !== 'active') {
    const res = messageCard('Gift vouchers', 'Gift voucher sales are temporarily unavailable. Please check back soon.');
    for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
    return res;
  }

  const accent = HEX.test(widget.accent_color) ? widget.accent_color : '#e09330';
  const accentInk = inkOn(accent);

  if (widget.kind === 'contact') {
    return new Response(contactPageHtml(widget, accent, accentInk), { headers });
  }

  let presets = [];
  try { presets = JSON.parse(widget.preset_amounts || '[]'); } catch { presets = []; }
  presets = presets.filter(p => Number.isInteger(p) && p >= 1000 && p <= 100000);
  const allowCustom = widget.allow_custom === 1 || presets.length === 0;

  const heading = widget.heading || 'Buy a gift voucher';
  const blurb = widget.blurb
    || 'Delivered instantly by email — redeemable against any UK Brewery Tours experience, and it never expires.';
  const defaultPence = presets[0] || 5000;

  const chips = presets.map(p => `<button type="button" class="chip${p === defaultPence ? ' is-on' : ''}"
    data-amount="${p / 100}">£${p % 100 === 0 ? (p / 100) : (p / 100).toFixed(2)}</button>`).join('');

  const html = `<!DOCTYPE html>
<html lang="en-GB">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(heading)} — UK Brewery Tours</title>
<style>
  :root { --accent: ${accent}; --accent-ink: ${accentInk}; --ink: #241505; --ink-soft: #6b5c4f;
          --line: #e5ddd0; --cream: #faf6ee; --red: #a13c37; }
  * { box-sizing: border-box; margin: 0; }
  html, body { background: transparent; }
  body { font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; color: var(--ink); }
  .card { background: #fff; border: 1px solid var(--line); border-radius: 14px; padding: 24px; }
  .head { margin-bottom: 18px; }
  .head h1 { font-size: 1.3rem; line-height: 1.25; }
  .head p { color: var(--ink-soft); font-size: .92rem; line-height: 1.55; margin-top: 6px; }
  form { display: flex; flex-direction: column; gap: 16px; }
  label, .lbl { font-size: .8rem; font-weight: 600; letter-spacing: .03em; text-transform: uppercase;
                color: var(--ink-soft); margin-bottom: 6px; display: block; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
  .chip { border: 1.5px solid var(--line); background: #fff; border-radius: 999px; padding: 9px 18px;
          font-size: .95rem; font-weight: 600; color: var(--ink); cursor: pointer; }
  .chip.is-on { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  @media (max-width: 480px) { .row { grid-template-columns: 1fr; } }
  .field { min-width: 0; }
  input[type="text"], input[type="email"], input[type="number"], textarea {
    width: 100%; border: 1.5px solid var(--line); border-radius: 9px; padding: 10px 12px;
    font: inherit; font-size: .95rem; color: var(--ink); background: #fff;
  }
  input:focus, textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
  textarea { resize: vertical; line-height: 1.5; }
  .amount { position: relative; }
  .amount .cur { position: absolute; left: 12px; top: 50%; transform: translateY(-50%);
                 font-weight: 600; color: var(--ink-soft); }
  .amount input { padding-left: 26px; }
  .hint { font-size: .78rem; color: var(--ink-soft); margin-top: 5px; }
  .stepper { display: flex; border: 1.5px solid var(--line); border-radius: 9px; overflow: hidden; }
  .stepper button { width: 44px; border: 0; background: var(--cream); font-size: 1.15rem; cursor: pointer; color: var(--ink); }
  .stepper input { border: 0; text-align: center; width: 100%; border-radius: 0; }
  .total { display: flex; justify-content: space-between; align-items: center; background: var(--cream);
           border-radius: 9px; padding: 12px 16px; font-size: .95rem; }
  .total strong { font-size: 1.15rem; }
  .toggle { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .toggle label { display: block; text-transform: none; letter-spacing: 0; font-size: .92rem; font-weight: 600;
                  border: 1.5px solid var(--line); border-radius: 9px; text-align: center; padding: 10px;
                  cursor: pointer; margin: 0; color: var(--ink); }
  .toggle input { position: absolute; opacity: 0; pointer-events: none; }
  .toggle label:has(input:checked) { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
  .note { background: var(--cream); border-radius: 9px; padding: 12px 16px; font-size: .85rem;
          color: var(--ink-soft); line-height: 1.55; }
  .note strong { color: var(--ink); display: block; margin-bottom: 2px; }
  .err { color: var(--red); font-size: .9rem; }
  .submit { border: 0; border-radius: 999px; background: var(--accent); color: var(--accent-ink);
            font: inherit; font-weight: 700; font-size: 1rem; padding: 14px 20px; cursor: pointer; }
  .submit:disabled { opacity: .55; cursor: default; }
  .fine { text-align: center; font-size: .78rem; color: var(--ink-soft); line-height: 1.6; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<div class="card">
  <div class="head">
    <h1>${esc(heading)}</h1>
    <p>${esc(blurb)}</p>
  </div>

  <form id="f" novalidate>
    <div>
      <span class="lbl">Voucher amount</span>
      ${chips ? `<div class="chips">${chips}</div>` : ''}
      <div class="amount" id="amountWrap" ${allowCustom ? '' : 'hidden'}>
        <span class="cur">£</span>
        <input id="amount" type="number" inputmode="decimal" min="10" max="1000" step="1" value="${defaultPence / 100}">
      </div>
      ${allowCustom ? '<p class="hint">Minimum £10 — or pick an amount above</p>' : ''}
    </div>

    <div class="row">
      <div class="field">
        <span class="lbl" id="qtyLbl">Number of vouchers</span>
        <div class="stepper" role="group" aria-labelledby="qtyLbl">
          <button type="button" id="down" aria-label="One fewer voucher">&minus;</button>
          <input id="qty" type="number" min="1" max="20" value="1" readonly aria-live="polite">
          <button type="button" id="up" aria-label="One more voucher">+</button>
        </div>
      </div>
      <div class="field">
        <span class="lbl">Total</span>
        <div class="total"><span>To pay</span><strong id="total">£0.00</strong></div>
      </div>
    </div>

    <div>
      <span class="lbl">Who is it for?</span>
      <div class="toggle" role="radiogroup" aria-label="Who is it for?">
        <label><input type="radio" name="deliver" value="other" checked><span>Someone else</span></label>
        <label><input type="radio" name="deliver" value="self"><span>Myself</span></label>
      </div>
    </div>

    <div id="recipient">
      <div class="row">
        <div class="field"><label for="rname">Recipient's name</label>
          <input id="rname" type="text" autocomplete="off" placeholder="Alex Smith"></div>
        <div class="field"><label for="remail">Recipient's email</label>
          <input id="remail" type="email" autocomplete="off" placeholder="alex@example.com"></div>
      </div>
      <div class="field" style="margin-top:14px"><label for="msg">Gift message (optional)</label>
        <textarea id="msg" rows="${widget.gift_message ? 3 : 2}" maxlength="1000">${esc(widget.gift_message || '')}</textarea></div>
    </div>

    <div class="row">
      <div class="field"><label for="pname">Your name</label>
        <input id="pname" type="text" autocomplete="name" placeholder="Jamie Doe"></div>
      <div class="field"><label for="pemail">Your email</label>
        <input id="pemail" type="email" autocomplete="email" placeholder="you@example.com"></div>
    </div>

    <div class="note"><strong>&#128231; Delivered instantly by email</strong>
      The email contains the voucher code and is everything needed to book — nothing is posted.</div>

    <p class="err" id="err" hidden></p>
    <button class="submit" id="go" type="submit">Continue to payment</button>
    <p class="fine">&#128274; Secure payment by Stripe &middot; Issued &amp; redeemed by
      <a href="https://www.ukbrewerytours.com/gift-vouchers/" target="_blank" rel="noopener">UK Brewery Tours</a>
      &middot; Never expires</p>
  </form>
</div>

<script>
(function () {
  'use strict';
  var WIDGET_ID = ${JSON.stringify(widget.id)};
  var HOST_URL = new URLSearchParams(location.search).get('host') || '';
  var framed = window.parent !== window;

  var $ = function (id) { return document.getElementById(id); };
  var amountEl = $('amount'), qtyEl = $('qty'), totalEl = $('total'), errEl = $('err'), go = $('go');

  // --- height reporting: the widget must never scroll inside itself ---
  function report() {
    if (framed) parent.postMessage({ ubtVoucher: 1, type: 'size', height: document.documentElement.scrollHeight }, '*');
  }
  if (window.ResizeObserver) new ResizeObserver(report).observe(document.body);
  window.addEventListener('load', report);
  report();

  // --- amount chips ---
  var chips = [].slice.call(document.querySelectorAll('.chip'));
  chips.forEach(function (chip) {
    chip.addEventListener('click', function () {
      chips.forEach(function (c) { c.classList.toggle('is-on', c === chip); });
      amountEl.value = chip.getAttribute('data-amount');
      update();
    });
  });
  amountEl.addEventListener('input', function () {
    chips.forEach(function (c) { c.classList.toggle('is-on', c.getAttribute('data-amount') === amountEl.value); });
    update();
  });

  function update() {
    var a = parseFloat(amountEl.value) || 0;
    var q = parseInt(qtyEl.value, 10) || 1;
    totalEl.textContent = '£' + (a * q).toFixed(2);
  }

  // --- quantity ---
  function setQty(n) { qtyEl.value = String(Math.min(20, Math.max(1, n))); update(); }
  $('up').addEventListener('click', function () { setQty((parseInt(qtyEl.value, 10) || 1) + 1); });
  $('down').addEventListener('click', function () { setQty((parseInt(qtyEl.value, 10) || 1) - 1); });

  // --- deliver-to toggle ---
  [].forEach.call(document.querySelectorAll('input[name="deliver"]'), function (r) {
    r.addEventListener('change', function () {
      $('recipient').hidden = document.querySelector('input[name="deliver"]:checked').value === 'self';
      report();
    });
  });

  // --- submit ---
  $('f').addEventListener('submit', function (e) {
    e.preventDefault();
    errEl.hidden = true;
    update();

    var sendToSelf = document.querySelector('input[name="deliver"]:checked').value === 'self';
    var amount = parseFloat(amountEl.value);

    function fail(msg, focus) { errEl.textContent = msg; errEl.hidden = false; if (focus) focus.focus(); report(); }

    if (!isFinite(amount) || amount < 10) return fail('The minimum voucher amount is £10.', amountEl);
    if (amount > 1000) return fail('For vouchers over £1000, please contact UK Brewery Tours directly.', amountEl);
    if (!$('pname').value.trim()) return fail('Please enter your name.', $('pname'));
    if (!$('pemail').value.trim()) return fail('Please enter your email address.', $('pemail'));
    if (!sendToSelf) {
      if (!$('rname').value.trim()) return fail("Please enter the recipient's name.", $('rname'));
      if (!$('remail').value.trim()) return fail("Please enter the recipient's email.", $('remail'));
    }

    go.disabled = true;
    go.textContent = 'Taking you to payment…';

    fetch('/api/create-checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: amount,
        quantity: parseInt(qtyEl.value, 10) || 1,
        sendToSelf: sendToSelf,
        purchaserName: $('pname').value,
        purchaserEmail: $('pemail').value,
        recipientName: sendToSelf ? '' : $('rname').value,
        recipientEmail: sendToSelf ? '' : $('remail').value,
        message: sendToSelf ? '' : $('msg').value,
        widgetId: WIDGET_ID,
        hostUrl: HOST_URL,
      }),
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
        if (!framed) { window.location.href = data.url; return; }
        // Normal path: the loader on the host page navigates to Stripe.
        parent.postMessage({ ubtVoucher: 1, type: 'checkout', url: data.url }, '*');
        // Fallback if the loader was blocked: try the top window, then a new tab.
        setTimeout(function () {
          try { window.top.location.href = data.url; }
          catch (e2) { window.open(data.url, '_blank'); }
          go.disabled = false;
          go.textContent = 'Continue to payment';
        }, 1200);
      });
    }).catch(function (err) {
      fail(err.message);
      go.disabled = false;
      go.textContent = 'Continue to payment';
    });
  });

  update();
})();
</script>
</body>
</html>`;

  return new Response(html, { headers });
}

// The contact-form flavour of the widget. Same shell and messaging plumbing as
// the voucher form, but it posts to /api/contact and succeeds in place — no
// navigation, the host page never leaves.
function contactPageHtml(widget, accent, accentInk) {
  const heading = widget.heading || 'Get in touch';
  const blurb = widget.blurb
    || "Send us a message and we'll reply by email — usually within a few hours.";

  return `<!DOCTYPE html>
<html lang="en-GB">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(heading)} — UK Brewery Tours</title>
<style>
  :root { --accent: ${accent}; --accent-ink: ${accentInk}; --ink: #241505; --ink-soft: #6b5c4f;
          --line: #e5ddd0; --cream: #faf6ee; --red: #a13c37; --green: #33502a; }
  * { box-sizing: border-box; margin: 0; }
  html, body { background: transparent; }
  body { font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; color: var(--ink); }
  .card { background: #fff; border: 1px solid var(--line); border-radius: 14px; padding: 24px; }
  .head { margin-bottom: 18px; }
  .head h1 { font-size: 1.3rem; line-height: 1.25; }
  .head p { color: var(--ink-soft); font-size: .92rem; line-height: 1.55; margin-top: 6px; }
  form { display: flex; flex-direction: column; gap: 14px; }
  label { font-size: .8rem; font-weight: 600; letter-spacing: .03em; text-transform: uppercase;
          color: var(--ink-soft); margin-bottom: 6px; display: block; }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  @media (max-width: 480px) { .row { grid-template-columns: 1fr; } }
  .field { min-width: 0; }
  input[type="text"], input[type="email"], textarea {
    width: 100%; border: 1.5px solid var(--line); border-radius: 9px; padding: 10px 12px;
    font: inherit; font-size: .95rem; color: var(--ink); background: #fff;
  }
  input:focus, textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
  textarea { resize: vertical; line-height: 1.5; }
  .hp { position: absolute; left: -9999px; top: -9999px; height: 1px; width: 1px; overflow: hidden; }
  .err { color: var(--red); font-size: .9rem; }
  .submit { border: 0; border-radius: 999px; background: var(--accent); color: var(--accent-ink);
            font: inherit; font-weight: 700; font-size: 1rem; padding: 14px 20px; cursor: pointer; }
  .submit:disabled { opacity: .55; cursor: default; }
  .fine { text-align: center; font-size: .78rem; color: var(--ink-soft); line-height: 1.6; }
  .done { text-align: center; padding: 26px 6px; }
  .done .tick { font-size: 2rem; }
  .done h2 { font-size: 1.15rem; margin: 10px 0 8px; color: var(--green); }
  .done p { color: var(--ink-soft); font-size: .92rem; line-height: 1.6; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<div class="card">
  <div class="head">
    <h1>${esc(heading)}</h1>
    <p>${esc(blurb)}</p>
  </div>

  <form id="f" novalidate>
    <div class="row">
      <div class="field"><label for="name">Name</label>
        <input id="name" type="text" autocomplete="name" placeholder="Jamie Doe"></div>
      <div class="field"><label for="email">Email</label>
        <input id="email" type="email" autocomplete="email" placeholder="you@example.com"></div>
    </div>

    <div class="field"><label for="phone">Phone <span style="text-transform:none;letter-spacing:0;font-weight:400">(optional)</span></label>
      <input id="phone" type="tel" autocomplete="tel" inputmode="tel" placeholder="07123 456789"></div>

    <div class="field"><label for="msg">Message</label>
      <textarea id="msg" rows="5" maxlength="5000" placeholder="Tell us what you're after — dates, group size, anything else."></textarea></div>

    <!-- honeypot: real people never see or fill this -->
    <div class="hp" aria-hidden="true">
      <label for="company">Company</label>
      <input id="company" type="text" tabindex="-1" autocomplete="off">
    </div>

    <p class="err" id="err" hidden></p>
    <button class="submit" id="go" type="submit">Send message</button>
    <p class="fine">Messages go to
      <a href="https://www.ukbrewerytours.com/contact/" target="_blank" rel="noopener">UK Brewery Tours</a>
      &middot; replies come from info@ukbrewerytours.com</p>
  </form>

  <div class="done" id="done" hidden>
    <div class="tick">&#127866;</div>
    <h2>Message sent — cheers!</h2>
    <p>We've emailed you a confirmation and will reply personally, usually within a few hours.</p>
  </div>
</div>

<script>
(function () {
  'use strict';
  var WIDGET_ID = ${JSON.stringify(widget.id)};
  var HOST_URL = new URLSearchParams(location.search).get('host') || '';
  var framed = window.parent !== window;

  var $ = function (id) { return document.getElementById(id); };
  var errEl = $('err'), go = $('go');

  function report() {
    if (framed) parent.postMessage({ ubtVoucher: 1, type: 'size', height: document.documentElement.scrollHeight }, '*');
  }
  if (window.ResizeObserver) new ResizeObserver(report).observe(document.body);
  window.addEventListener('load', report);
  report();

  $('f').addEventListener('submit', function (e) {
    e.preventDefault();
    errEl.hidden = true;

    function fail(msg, focus) { errEl.textContent = msg; errEl.hidden = false; if (focus) focus.focus(); report(); }

    if (!$('name').value.trim()) return fail('Please enter your name.', $('name'));
    if (!$('email').value.trim()) return fail('Please enter your email address.', $('email'));
    if ($('msg').value.trim().length < 10) return fail('Please tell us a little more.', $('msg'));

    go.disabled = true;
    go.textContent = 'Sending…';

    fetch('/api/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: $('name').value,
        email: $('email').value,
        phone: $('phone').value,
        message: $('msg').value,
        company: $('company').value,
        widgetId: WIDGET_ID,
        hostUrl: HOST_URL,
      }),
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
        $('f').hidden = true;
        $('done').hidden = false;
        report();
      });
    }).catch(function (err) {
      fail(err.message);
      go.disabled = false;
      go.textContent = 'Send message';
    });
  });
})();
</script>
</body>
</html>`;
}
