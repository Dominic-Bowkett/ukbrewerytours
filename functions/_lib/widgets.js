// Embeddable voucher widgets — id minting and admin-input validation, shared
// by the create and update endpoints so the rules can't drift apart.

const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // same unambiguous alphabet as voucher codes

export function generateWidgetId() {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += CHARSET[b % CHARSET.length];
  return `wgt_${s}`;
}

const clean = (s, max) => String(s ?? '').trim().slice(0, max);

/**
 * Validate the admin form for a widget. Returns { error } or { fields } with
 * everything ready to bind: preset_amounts / allowed_origins as JSON strings.
 *
 * `kind` decides which rules apply: 'voucher' validates amounts, 'contact'
 * ignores them (a contact form has nothing to price). Kind is set at creation
 * and never changed by updates — swapping a live embed from selling vouchers
 * to collecting messages under the same id would only cause confusion.
 */
export function parseWidgetInput(body, kind = 'voucher') {
  const name = clean(body.name, 100);
  if (!name) return { error: 'Give the widget a name — e.g. the website it will live on.' };

  const heading = clean(body.heading, 120);
  const blurb = clean(body.blurb, 300);

  const accent = clean(body.accent_color, 7);
  if (accent && !/^#[0-9a-fA-F]{6}$/.test(accent)) {
    return { error: 'The accent colour must be a hex value like #7a1f2b.' };
  }

  // Presets arrive as "25, 50, 100" (pounds). Stored as pence, deduped, sorted.
  const rawPresets = Array.isArray(body.presets)
    ? body.presets
    : String(body.presets ?? '').split(/[,\s]+/).filter(Boolean);
  const pence = [];
  if (kind === 'voucher') {
    for (const p of rawPresets) {
      const v = Math.round(Number(p) * 100);
      if (!Number.isFinite(v)) return { error: `"${p}" is not an amount.` };
      if (v < 1000 || v > 100000) return { error: 'Preset amounts must be between £10 and £1000.' };
      if (!pence.includes(v)) pence.push(v);
    }
    if (pence.length > 6) return { error: 'Six preset amounts at most — more than that overwhelms the form.' };
    pence.sort((a, b) => a - b);
  }

  const allowCustom = body.allow_custom === true || body.allow_custom === 'true' || body.allow_custom === 1;
  if (kind === 'voucher' && !pence.length && !allowCustom) {
    return { error: 'Add at least one preset amount, or allow customers to choose their own.' };
  }

  // Optional embed lock: only these sites may iframe the widget.
  const rawOrigins = String(body.allowed_origins ?? '').split(/[,\s]+/).filter(Boolean);
  const origins = [];
  for (const o of rawOrigins) {
    try {
      const u = new URL(o.includes('://') ? o : `https://${o}`);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error();
      if (!origins.includes(u.origin)) origins.push(u.origin);
    } catch {
      return { error: `"${o}" is not a website address. Use e.g. https://bristolbrewerytours.co.uk` };
    }
  }

  const status = body.status === 'paused' ? 'paused' : 'active';

  // Voucher-only: suggested gift message, prefilled for the buyer to edit.
  const giftMessage = kind === 'voucher' ? clean(body.gift_message, 500) : '';

  return {
    fields: {
      name,
      heading,
      blurb,
      accent_color: accent,
      preset_amounts: JSON.stringify(pence),
      allow_custom: allowCustom ? 1 : 0,
      allowed_origins: JSON.stringify(origins),
      status,
      gift_message: giftMessage,
    },
  };
}

/** Per-widget activity subqueries, reused by list and detail. */
export const WIDGET_STATS_SQL = `
  (SELECT COUNT(*) FROM orders o WHERE o.widget_id = w.id AND o.status = 'paid') AS sales,
  (SELECT COALESCE(SUM(o.total_pence), 0) FROM orders o WHERE o.widget_id = w.id AND o.status = 'paid') AS revenue_pence,
  (SELECT COUNT(*) FROM enquiries e WHERE e.widget_id = w.id) AS enquiries`;
