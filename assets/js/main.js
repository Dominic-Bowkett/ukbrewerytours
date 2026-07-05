// Mobile nav toggle
const toggle = document.querySelector('[data-nav-toggle]');
const nav = document.querySelector('[data-nav]');
if (toggle && nav) {
  toggle.addEventListener('click', () => {
    const open = nav.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(open));
  });
}

// Tours page filtering (city / day / keyword) over one merged grid
const filterForm = document.querySelector('[data-filter]');
if (filterForm) {
  const citySel = filterForm.querySelector('[data-filter-city]');
  const daySel = filterForm.querySelector('[data-filter-day]');
  const qInput = filterForm.querySelector('[data-filter-q]');
  const grid = document.querySelector('[data-tours-grid]');
  const countEl = document.querySelector('[data-filter-count]');
  const emptyEl = document.querySelector('[data-filter-empty]');
  const cards = grid ? [...grid.querySelectorAll('[data-card]')] : [];

  const apply = () => {
    const city = citySel.value;
    const day = daySel.value;
    const q = qInput.value.trim().toLowerCase();
    let visible = 0;
    for (const c of cards) {
      const days = c.dataset.days || '';
      const okCity = !city || c.dataset.city === city;
      // Partner experiences carry no day tags — they run various days, so keep them for any day.
      const okDay = !day || days === '' || days.split(',').includes(day);
      const okQ = !q || (c.dataset.name || '').includes(q) || (c.dataset.city || '').toLowerCase().includes(q);
      const show = okCity && okDay && okQ;
      c.hidden = !show;
      if (show) visible++;
    }
    if (countEl) {
      countEl.textContent = (city || day || q)
        ? `Showing ${visible} tour${visible === 1 ? '' : 's'} & experience${visible === 1 ? '' : 's'}`
        : `${cards.length} tours & experiences`;
    }
    if (emptyEl) emptyEl.hidden = visible !== 0;
  };

  citySel.addEventListener('change', apply);
  daySel.addEventListener('change', apply);
  qInput.addEventListener('input', apply);
  document.querySelectorAll('[data-filter-reset]').forEach(btn =>
    btn.addEventListener('click', () => { citySel.value = ''; daySel.value = ''; qInput.value = ''; apply(); }));

  // Deep-link support: /tours/?city=Manchester&day=Sat&q=beer (e.g. from the home search)
  const params = new URLSearchParams(location.search);
  const preCity = params.get('city');
  if (preCity && [...citySel.options].some(o => o.value === preCity)) citySel.value = preCity;
  const preDay = params.get('day');
  if (preDay && [...daySel.options].some(o => o.value === preDay)) daySel.value = preDay;
  const preQ = params.get('q');
  if (preQ) qInput.value = preQ;
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
