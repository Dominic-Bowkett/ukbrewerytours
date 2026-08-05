// Printable gift vouchers. Renders one A4 sheet per voucher from a signed
// order link, and lets the customer choose which ones to include before
// printing (browser "Save as PDF" produces the file — nothing server-side).
(function () {
  const sheets = document.querySelector('[data-print-sheets]');
  if (!sheets) return;

  const toolbar = document.querySelector('[data-print-toolbar]');
  const pick = document.querySelector('[data-print-pick]');
  const opts = document.querySelector('[data-print-opts]');
  const allToggle = document.querySelector('[data-print-all-toggle]');
  const errorEl = document.querySelector('[data-print-error]');
  const loadingEl = document.querySelector('[data-print-loading]');

  const money = p => '£' + (p / 100).toFixed(2);
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const params = new URLSearchParams(location.search);
  const order = params.get('order');
  const token = params.get('t');

  const fail = (msg) => {
    loadingEl.hidden = true;
    errorEl.textContent = msg;
    errorEl.hidden = false;
  };

  if (!order || !token) {
    fail('This link is incomplete. Please use the link from your voucher email.');
    return;
  }

  function sheetHtml(v, o) {
    const spent = v.amount_pence - v.balance_pence;
    return `
      <article class="vsheet" data-sheet data-code="${esc(v.code)}">
        <div class="vsheet__inner">
          <header class="vsheet__head">
            <div class="vsheet__brand">🍺 UK Brewery Tours</div>
            <div class="vsheet__est">Est. 2014</div>
          </header>

          <div class="vsheet__body">
            <div class="vsheet__kicker">Gift voucher</div>
            <div class="vsheet__amount">${money(v.amount_pence)}</div>
            ${spent > 0 ? `<div class="vsheet__part">Remaining balance: <strong>${money(v.balance_pence)}</strong></div>` : ''}

            ${o.recipient_name ? `<div class="vsheet__to">For <strong>${esc(o.recipient_name)}</strong></div>` : ''}
            ${o.message ? `<blockquote class="vsheet__msg">${esc(o.message)}${o.from_name ? `<footer>— ${esc(o.from_name)}</footer>` : ''}</blockquote>` : ''}

            <div class="vsheet__codebox">
              <div class="vsheet__codelabel">Voucher code</div>
              <div class="vsheet__code">${esc(v.code)}</div>
            </div>

            ${o.tour_name ? `<div class="vsheet__tour">Suggested experience: <strong>${esc(o.tour_name)}</strong></div>` : ''}
          </div>

          <footer class="vsheet__foot">
            <div class="vsheet__how">
              <strong>How to redeem</strong>
              Email <span class="nowrap">info@ukbrewerytours.com</span> or message us on WhatsApp quoting the code above,
              and we'll book you onto the date you want. Browse everything at ukbrewerytours.com/tours
            </div>
            <div class="vsheet__terms">
              This voucher never expires and can be used across more than one booking until the balance runs out.
              Not exchangeable for cash.
            </div>
          </footer>
        </div>
      </article>`;
  }

  function setupPicker(vouchers) {
    if (vouchers.length < 2) return; // nothing to choose between
    pick.hidden = false;
    opts.innerHTML = vouchers.map((v, i) => `
      <label class="print-pick__opt">
        <input type="checkbox" value="${esc(v.code)}" checked>
        <span>Voucher ${i + 1} <em>${esc(v.code)}</em></span>
      </label>`).join('');

    const boxes = () => [...opts.querySelectorAll('input[type="checkbox"]')];

    const sync = () => {
      const chosen = new Set(boxes().filter(b => b.checked).map(b => b.value));
      document.querySelectorAll('[data-sheet]').forEach(s => {
        // 'skip' hides it from print without affecting on-screen review
        s.classList.toggle('skip', !chosen.has(s.dataset.code));
      });
      const all = boxes().every(b => b.checked);
      allToggle.textContent = all ? 'Select none' : 'Select all';
    };

    opts.addEventListener('change', sync);
    allToggle.addEventListener('click', () => {
      const all = boxes().every(b => b.checked);
      boxes().forEach(b => { b.checked = !all; });
      sync();
    });
    sync();
  }

  fetch(`/api/my-vouchers?order=${encodeURIComponent(order)}&t=${encodeURIComponent(token)}`)
    .then(async (res) => {
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not load your vouchers.');
      return data;
    })
    .then(({ order: o, vouchers }) => {
      loadingEl.hidden = true;
      toolbar.hidden = false;
      sheets.innerHTML = vouchers.map(v => sheetHtml(v, o)).join('');
      setupPicker(vouchers);
      document.querySelector('[data-print-go]').addEventListener('click', () => window.print());
    })
    .catch(err => fail(err.message + ' If you need a copy, just reply to your voucher email and we\'ll help.'));
})();
