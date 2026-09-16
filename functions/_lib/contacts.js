// The admin's address book — the people Dom emails who have not written in:
// venue managers, brewery contacts, coach firms, past group organisers.
//
// Admin only. A team member has no route to this table: their replies go to the
// customer on a conversation they were given, and nowhere else.

export const isEmail = v => /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/.test(String(v || '').trim());

const text = (v, max) => String(v ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);

/** Split a typed recipient list — commas, semicolons or newlines — into addresses. */
export function parseRecipients(value, max = 20) {
  const seen = new Set();
  return String(value ?? '')
    .split(/[,;\n]+/)
    .map(s => {
      // Accept "Jane Smith <jane@example.com>" as well as a bare address.
      const m = /<([^>]+)>/.exec(s);
      return (m ? m[1] : s).trim().toLowerCase();
    })
    .filter(a => a && isEmail(a) && !seen.has(a) && seen.add(a))
    .slice(0, max);
}

/** The subset of a submitted contact we store, trimmed to sane lengths. */
export function cleanContact(input = {}) {
  return {
    name: text(input.name, 120),
    email: text(input.email, 200).toLowerCase(),
    phone: text(input.phone, 40) || null,
    company: text(input.company, 120) || null,
    notes: String(input.notes ?? '').trim().slice(0, 2000) || null,
  };
}

/**
 * Save a contact, merging into the existing card for that address rather than
 * creating a second one. Fields left blank never overwrite what is already
 * known — saving from the composer, where only the address is typed, must not
 * wipe the phone number and notes on the card.
 */
export async function upsertContact(env, input) {
  const c = cleanContact(input);
  if (!isEmail(c.email)) return null;
  if (!c.name) c.name = c.email.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase());

  const existing = await env.DB.prepare('SELECT * FROM contacts WHERE lower(email) = ?').bind(c.email).first();
  if (existing) {
    await env.DB.prepare(
      `UPDATE contacts SET name = ?, phone = COALESCE(?, phone), company = COALESCE(?, company),
         notes = COALESCE(?, notes), updated_at = datetime('now')
       WHERE id = ?`,
    ).bind(c.name || existing.name, c.phone, c.company, c.notes, existing.id).run();
    return { ...existing, ...c, phone: c.phone ?? existing.phone, company: c.company ?? existing.company, notes: c.notes ?? existing.notes };
  }

  const id = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO contacts (id, name, email, phone, company, notes) VALUES (?,?,?,?,?,?)',
  ).bind(id, c.name, c.email, c.phone, c.company, c.notes).run();
  return { id, ...c };
}
