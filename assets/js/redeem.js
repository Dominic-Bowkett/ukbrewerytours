// Voucher redemption form → /api/contact. The structured fields are folded
// into the message body so the enquiry pipeline (rate limit, log, auto-reply)
// is reused unchanged; the endpoint upgrades the subject line for /redeem/.
(function () {
  const form = document.querySelector('[data-redeem-form]');
  if (!form) return;

  const errorEl = form.querySelector('[data-redeem-error]');
  const submit = form.querySelector('[data-redeem-submit]');
  const success = document.querySelector('[data-redeem-success]');

  const fail = (msg, focus) => {
    errorEl.textContent = msg;
    errorEl.hidden = false;
    if (focus) focus.focus();
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.hidden = true;

    const name = form.querySelector('#r-name');
    const email = form.querySelector('#r-email');
    const tel = form.querySelector('#r-tel');
    const code = form.querySelector('#r-code');
    const tour = form.querySelector('#r-tour');
    const when = form.querySelector('#r-when');
    const message = form.querySelector('#r-message');

    if (!name.value.trim()) return fail('Please enter your name.', name);
    if (!email.value.trim() || !email.checkValidity()) return fail('Please enter a valid email address.', email);
    if (!code.value.trim()) return fail('Please enter your voucher code — it’s in your voucher email.', code);
    if (!tour.value.trim()) return fail('Please tell us which tour you’d like.', tour);
    if (!when.value.trim()) return fail('Please tell us your preferred date and time.', when);

    submit.disabled = true;
    submit.textContent = 'Sending…';

    const body = [
      'Voucher code: ' + code.value.trim().toUpperCase(),
      'Tour: ' + tour.value.trim(),
      'Preferred date & time: ' + when.value.trim(),
      message.value.trim() ? '\n' + message.value.trim() : '',
    ].join('\n');

    try {
      const res = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.value,
          email: email.value,
          phone: tel.value,
          message: body,
          company: form.querySelector('[name="company"]').value, // honeypot
          page: location.pathname,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Something went wrong.');

      const intro = document.querySelector('[data-redeem-intro]');
      if (intro) intro.hidden = true;
      form.hidden = true;
      success.hidden = false;
      success.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } catch (err) {
      fail(err.message);
      submit.disabled = false;
      submit.textContent = 'Send redemption request';
    }
  });
})();
