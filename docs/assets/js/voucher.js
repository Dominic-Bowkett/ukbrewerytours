// In-house gift voucher form: prefill from the tour page, quantity stepper,
// live total, then hand off to Stripe Checkout.
(function () {
  const modal = document.querySelector('[data-voucher-modal]');
  if (!modal) return;

  const form = modal.querySelector('[data-voucher-form]');
  const amountEl = modal.querySelector('#vf-amount');
  const qtyEl = modal.querySelector('#vf-qty');
  const totalEl = modal.querySelector('[data-voucher-total]');
  const hintEl = modal.querySelector('[data-voucher-amount-hint]');
  const blurbEl = modal.querySelector('[data-voucher-blurb]');
  const recipientWrap = modal.querySelector('[data-voucher-recipient]');
  const messageEl = modal.querySelector('#vf-message');
  const errorEl = modal.querySelector('[data-voucher-error]');
  const submitBtn = modal.querySelector('[data-voucher-submit]');
  const deliverRadios = [...modal.querySelectorAll('input[name="vf-deliver"]')];

  const MIN = 10;
  const MAX_QTY = 20;
  let tour = { name: '', price: '', slug: '' };
  let messageDirty = false;

  const money = n => '£' + n.toFixed(2);

  function updateTotal() {
    const amount = parseFloat(amountEl.value) || 0;
    const qty = parseInt(qtyEl.value, 10) || 1;
    totalEl.textContent = money(amount * qty);
  }

  function defaultMessage() {
    if (!tour.name) return '';
    return `I thought you'd love this — the ${tour.name} with UK Brewery Tours. `
      + `Use this voucher towards it, or any other tour they run. Enjoy!`;
  }

  function syncMessage() {
    // Leave alone once the buyer has typed their own words.
    if (messageDirty) return;
    messageEl.value = defaultMessage();
  }

  function openModal(opener) {
    tour = {
      name: opener?.dataset.tourName || '',
      price: opener?.dataset.tourPrice || '',
      slug: opener?.dataset.tourSlug || '',
    };

    if (tour.price) {
      const p = parseFloat(tour.price);
      if (Number.isFinite(p) && p >= MIN) {
        amountEl.value = String(p);
        hintEl.textContent = `Prefilled with the ${tour.name} price (per person) — edit if you like`;
      }
    } else {
      hintEl.textContent = `Minimum £${MIN}`;
    }

    if (blurbEl) {
      blurbEl.textContent = tour.name
        ? `Give the ${tour.name} — or let them choose any UK Brewery Tours experience. Vouchers never expire.`
        : 'Monetary vouchers for any UK Brewery Tours experience — delivered by email, and they never expire.';
    }

    syncMessage();
    updateTotal();
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
  }

  function closeModal() {
    modal.hidden = true;
    document.body.style.overflow = '';
  }

  // --- open / close ---
  document.addEventListener('click', (e) => {
    const opener = e.target.closest('[data-voucher-open]');
    if (opener) { e.preventDefault(); openModal(opener); return; }
    if (e.target.closest('[data-voucher-close]')) closeModal();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) closeModal(); });

  // --- quantity stepper ---
  const setQty = (n) => {
    qtyEl.value = String(Math.min(MAX_QTY, Math.max(1, n)));
    updateTotal();
  };
  modal.querySelector('[data-qty-up]').addEventListener('click', () => setQty((parseInt(qtyEl.value, 10) || 1) + 1));
  modal.querySelector('[data-qty-down]').addEventListener('click', () => setQty((parseInt(qtyEl.value, 10) || 1) - 1));

  // 'input' misses programmatic writes and browser autofill; 'change' catches the rest.
  amountEl.addEventListener('input', updateTotal);
  amountEl.addEventListener('change', updateTotal);
  messageEl.addEventListener('input', () => { messageDirty = true; });

  // --- deliver-to toggle ---
  deliverRadios.forEach(r => r.addEventListener('change', () => {
    const self = r.value === 'self' && r.checked;
    recipientWrap.hidden = self;
  }));

  // --- submit ---
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.hidden = true;
    updateTotal(); // never show a stale total next to a validation error

    const sendToSelf = modal.querySelector('input[name="vf-deliver"]:checked').value === 'self';
    const amount = parseFloat(amountEl.value);

    const fail = (msg, focus) => {
      errorEl.textContent = msg;
      errorEl.hidden = false;
      if (focus) focus.focus();
      return true;
    };

    if (!Number.isFinite(amount) || amount < MIN) return fail(`The minimum voucher amount is £${MIN}.`, amountEl);
    if (!modal.querySelector('#vf-pname').value.trim()) return fail('Please enter your name.', modal.querySelector('#vf-pname'));
    if (!modal.querySelector('#vf-pemail').value.trim()) return fail('Please enter your email address.', modal.querySelector('#vf-pemail'));
    if (!sendToSelf) {
      if (!modal.querySelector('#vf-rname').value.trim()) return fail("Please enter the recipient's name.", modal.querySelector('#vf-rname'));
      if (!modal.querySelector('#vf-remail').value.trim()) return fail("Please enter the recipient's email.", modal.querySelector('#vf-remail'));
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Taking you to payment…';

    try {
      const res = await fetch('/api/create-checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount,
          quantity: parseInt(qtyEl.value, 10) || 1,
          sendToSelf,
          purchaserName: modal.querySelector('#vf-pname').value,
          purchaserEmail: modal.querySelector('#vf-pemail').value,
          recipientName: sendToSelf ? '' : modal.querySelector('#vf-rname').value,
          recipientEmail: sendToSelf ? '' : modal.querySelector('#vf-remail').value,
          message: sendToSelf ? '' : messageEl.value,
          tourName: tour.name,
          tourSlug: tour.slug,
          demo: document.body.dataset.voucherDemo === '1',
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
      window.location.href = data.url;
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
      submitBtn.disabled = false;
      submitBtn.textContent = 'Continue to payment';
    }
  });

  updateTotal();
})();
