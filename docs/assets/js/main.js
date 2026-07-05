// Mobile nav toggle
const toggle = document.querySelector('[data-nav-toggle]');
const nav = document.querySelector('[data-nav]');
if (toggle && nav) {
  toggle.addEventListener('click', () => {
    const open = nav.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(open));
  });
}

// Tours page filtering (city / day / keyword)
const filterForm = document.querySelector('[data-filter]');
if (filterForm) {
  const citySel = filterForm.querySelector('[data-filter-city]');
  const daySel = filterForm.querySelector('[data-filter-day]');
  const qInput = filterForm.querySelector('[data-filter-q]');
  const ourGrid = document.querySelector('[data-our-grid]');
  const partnerGrid = document.querySelector('[data-partner-grid]');
  const countEl = document.querySelector('[data-filter-count]');
  const ourEmpty = document.querySelector('[data-filter-empty]');
  const partnerEmpty = document.querySelector('[data-partner-empty]');
  const ourCards = ourGrid ? [...ourGrid.querySelectorAll('[data-card]')] : [];
  const partnerCards = partnerGrid ? [...partnerGrid.querySelectorAll('[data-card]')] : [];

  const apply = () => {
    const city = citySel.value;
    const day = daySel.value;
    const q = qInput.value.trim().toLowerCase();
    let ourVisible = 0;
    for (const c of ourCards) {
      const okCity = !city || c.dataset.city === city;
      const okDay = !day || (c.dataset.days || '').split(',').includes(day);
      const okQ = !q || (c.dataset.name || '').includes(q) || (c.dataset.city || '').toLowerCase().includes(q);
      const show = okCity && okDay && okQ;
      c.hidden = !show;
      if (show) ourVisible++;
    }
    let partnerVisible = 0;
    for (const c of partnerCards) {
      const okCity = !city || c.dataset.city === city;
      const okQ = !q || (c.dataset.name || '').includes(q) || (c.dataset.city || '').toLowerCase().includes(q);
      const show = okCity && okQ;
      c.hidden = !show;
      if (show) partnerVisible++;
    }
    if (countEl) {
      const bits = [`${ourVisible} of our tour${ourVisible === 1 ? '' : 's'}`];
      if (partnerCards.length) bits.push(`${partnerVisible} partner experience${partnerVisible === 1 ? '' : 's'}`);
      countEl.textContent = (city || day || q) ? `Showing ${bits.join(' · ')}` : '';
    }
    if (ourEmpty) ourEmpty.hidden = ourVisible !== 0;
    if (partnerEmpty) partnerEmpty.hidden = partnerVisible !== 0;
  };

  citySel.addEventListener('change', apply);
  daySel.addEventListener('change', apply);
  qInput.addEventListener('input', apply);
  document.querySelectorAll('[data-filter-reset]').forEach(btn =>
    btn.addEventListener('click', () => { citySel.value = ''; daySel.value = ''; qInput.value = ''; apply(); }));

  // Deep-link support: /tours/?city=Manchester
  const params = new URLSearchParams(location.search);
  const preCity = params.get('city');
  if (preCity && [...citySel.options].some(o => o.value === preCity)) { citySel.value = preCity; }
  apply();
}

// Product gallery thumb swap
const gallery = document.querySelector('[data-gallery]');
if (gallery) {
  const main = gallery.querySelector('[data-gallery-main]');
  gallery.querySelectorAll('.thumbs button').forEach(btn => {
    btn.addEventListener('click', () => {
      main.src = btn.dataset.src;
      gallery.querySelectorAll('.thumbs button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });
}
