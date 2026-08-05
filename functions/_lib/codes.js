// Voucher code generation. Format: UBT-XXXX-XXXX
// Alphabet excludes I, O, 0, 1 so codes are unambiguous when read aloud or written down.
const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateCode() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let s = '';
  // Rejection-free modulo is fine here: 256 % 32 === 0, so the mapping is uniform.
  for (const b of bytes) s += CHARSET[b % CHARSET.length];
  return `UBT-${s.slice(0, 4)}-${s.slice(4)}`;
}

/** Normalise user-typed codes: strip spaces, upper-case, re-insert dashes. */
export function normaliseCode(input) {
  const raw = String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const body = raw.startsWith('UBT') ? raw.slice(3) : raw;
  if (body.length !== 8) return raw.startsWith('UBT') ? `UBT-${body}` : body;
  return `UBT-${body.slice(0, 4)}-${body.slice(4)}`;
}

export function formatMoney(pence) {
  return `£${(pence / 100).toFixed(2)}`;
}
