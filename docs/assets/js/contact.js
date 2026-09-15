// Enquiry forms → /api/contact → the admin inbox. Handles every
// [data-contact-form] on the page (contact page, group tours page). Submits
// without leaving the page and swaps in the confirmation panel of its card.
//
//   name / email / phone / message   inputs with those name attributes
//   type                             a select[name=type], else data-type on the form
//   fields                           any element with data-field="<key>"
(function () {
  const forms = document.querySelectorAll('[data-contact-form]');
  if (!forms.length) return;

  // "Plan a stag or hen" style links preselect the occasion on the form they jump to.
  document.querySelectorAll('[data-occasion]').forEach(link => {
    link.addEventListener('click', () => {
      const sel = document.querySelector('[data-field="occasion"]');
      if (sel) sel.value = link.dataset.occasion;
    });
  });

  forms.forEach(form => {
    const card = form.closest('.form-card') || document;
    const errorEl = form.querySelector('[data-contact-error]');
    const submit = form.querySelector('[data-contact-submit]');
    const submitLabel = submit.textContent;
    const success = card.querySelector('[data-contact-success]');
    const val = n => (form.querySelector(`[name="${n}"]`) || { value: '' }).value.trim();

    const fail = (msg, focus) => {
      errorEl.textContent = msg;
      errorEl.hidden = false;
      if (focus) focus.focus();
    };

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errorEl.hidden = true;

      for (const el of form.querySelectorAll('[required]')) {
        if (!el.value.trim()) {
          const label = form.querySelector(`label[for="${el.id}"]`);
          return fail(`Please fill in ${label ? label.textContent.trim().toLowerCase() : 'every required field'}.`, el);
        }
      }
      const emailEl = form.querySelector('[name="email"]');
      if (emailEl && !emailEl.checkValidity()) return fail('Please enter a valid email address.', emailEl);

      const fields = {};
      const summary = [];
      form.querySelectorAll('[data-field]').forEach(el => {
        const v = el.value.trim();
        if (!v) return;
        fields[el.dataset.field] = v;
        const label = form.querySelector(`label[for="${el.id}"]`);
        summary.push(`${label ? label.textContent.trim() : el.dataset.field}: ${v}`);
      });

      let message = val('message');
      const messageEl = form.querySelector('[name="message"]');
      if (!summary.length && message.length < 10) {
        return fail('Please tell us a little more about what you need.', messageEl);
      }
      // Structured forms: the details go in the message too, so the thread (and
      // any email quoting it) reads on its own.
      if (summary.length) message = summary.join('\n') + (message ? '\n\n' + message : '');

      submit.disabled = true;
      submit.textContent = 'Sending…';

      try {
        const res = await fetch('/api/contact', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: val('name'),
            email: val('email'),
            phone: val('phone'),
            message,
            type: val('type') || form.dataset.type || '',
            fields,
            company: val('company'), // honeypot
            page: location.pathname,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Something went wrong.');

        const intro = card.querySelector('[data-contact-intro]');
        if (intro) intro.hidden = true;
        form.hidden = true;
        success.hidden = false;
        const thread = success.querySelector('[data-contact-thread]');
        if (thread && data.token) { thread.href = '/messages/' + data.token; thread.hidden = false; }
        success.scrollIntoView({ block: 'center', behavior: 'smooth' });
      } catch (err) {
        fail(err.message);
        submit.disabled = false;
        submit.textContent = submitLabel;
      }
    });
  });
})();
