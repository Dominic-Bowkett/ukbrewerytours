// Contact form → /api/contact (Resend). Submits without leaving the page and
// swaps in a confirmation panel on success.
(function () {
  const form = document.querySelector('[data-contact-form]');
  if (!form) return;

  const errorEl = form.querySelector('[data-contact-error]');
  const submit = form.querySelector('[data-contact-submit]');
  const success = document.querySelector('[data-contact-success]');

  const fail = (msg, focus) => {
    errorEl.textContent = msg;
    errorEl.hidden = false;
    if (focus) focus.focus();
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.hidden = true;

    const name = form.querySelector('#f-name');
    const email = form.querySelector('#f-email');
    const message = form.querySelector('#f-message');

    if (!name.value.trim()) return fail('Please enter your name.', name);
    if (!email.value.trim() || !email.checkValidity()) return fail('Please enter a valid email address.', email);
    if (message.value.trim().length < 10) return fail('Please tell us a little more about what you need.', message);

    submit.disabled = true;
    submit.textContent = 'Sending…';

    try {
      const res = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.value,
          email: email.value,
          message: message.value,
          company: form.querySelector('[name="company"]').value, // honeypot
          page: location.pathname,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Something went wrong.');

      const intro = document.querySelector('[data-contact-intro]');
      if (intro) intro.hidden = true;
      form.hidden = true;
      success.hidden = false;
      success.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } catch (err) {
      fail(err.message);
      submit.disabled = false;
      submit.textContent = 'Send message';
    }
  });
})();
