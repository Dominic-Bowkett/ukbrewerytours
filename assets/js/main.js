// Gift voucher popup modal — opened by any [data-giftup-open] control, closed by backdrop/close/Escape
const giftModal = document.querySelector('[data-giftup-modal]');
if (giftModal) {
  const openModal = () => { giftModal.hidden = false; document.body.style.overflow = 'hidden'; };
  const closeModal = () => { giftModal.hidden = true; document.body.style.overflow = ''; };
  document.addEventListener('click', (e) => {
    const opener = e.target.closest('[data-giftup-open]');
    if (opener) { e.preventDefault(); openModal(); return; }
    if (e.target.closest('[data-giftup-close]')) closeModal();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !giftModal.hidden) closeModal(); });
}

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
  const regionSel = filterForm.querySelector('[data-filter-region]');
  const citySel = filterForm.querySelector('[data-filter-city]');
  const typeSel = filterForm.querySelector('[data-filter-type]');
  const qInput = filterForm.querySelector('[data-filter-q]');
  const grid = document.querySelector('[data-tours-grid]');
  const countEl = document.querySelector('[data-filter-count]');
  const emptyEl = document.querySelector('[data-filter-empty]');
  const cards = grid ? [...grid.querySelectorAll('[data-card]')] : [];

  const apply = () => {
    const region = regionSel ? regionSel.value : '';
    const city = citySel.value;
    const type = typeSel ? typeSel.value : '';
    const q = qInput.value.trim().toLowerCase();
    let visible = 0;
    for (const c of cards) {
      const okRegion = !region || c.dataset.region === region;
      const okCity = !city || c.dataset.city === city;
      const okType = !type || (c.dataset.type || 'beer') === type;
      const okQ = !q || (c.dataset.name || '').includes(q) || (c.dataset.city || '').toLowerCase().includes(q);
      const show = okRegion && okCity && okType && okQ;
      c.hidden = !show;
      if (show) visible++;
    }
    if (countEl) {
      countEl.textContent = (region || city || type || q)
        ? `Showing ${visible} tour${visible === 1 ? '' : 's'} & experience${visible === 1 ? '' : 's'}`
        : `${cards.length} tours & experiences`;
    }
    if (emptyEl) emptyEl.hidden = visible !== 0;
  };

  if (regionSel) regionSel.addEventListener('change', apply);
  citySel.addEventListener('change', apply);
  if (typeSel) typeSel.addEventListener('change', apply);
  qInput.addEventListener('input', apply);
  document.querySelectorAll('[data-filter-reset]').forEach(btn =>
    btn.addEventListener('click', () => { if (regionSel) regionSel.value = ''; citySel.value = ''; if (typeSel) typeSel.value = ''; qInput.value = ''; apply(); }));

  // Deep-link support: /tours/?region=Scotland&city=Manchester&type=wine&q=beer
  const params = new URLSearchParams(location.search);
  const preRegion = params.get('region');
  if (preRegion && regionSel && [...regionSel.options].some(o => o.value === preRegion)) regionSel.value = preRegion;
  const preCity = params.get('city');
  if (preCity && [...citySel.options].some(o => o.value === preCity)) citySel.value = preCity;
  const preType = params.get('type');
  if (preType && typeSel && [...typeSel.options].some(o => o.value === preType)) typeSel.value = preType;
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
