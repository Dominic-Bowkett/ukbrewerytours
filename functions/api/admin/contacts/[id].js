// /api/admin/contacts/:id
//   PATCH   { name?, email?, phone?, company?, notes? }
//   DELETE  remove the card. Nothing else references it, so nothing else changes.

import { cleanContact, isEmail } from '../../../_lib/contacts.js';

const find = (env, id) => env.DB.prepare('SELECT * FROM contacts WHERE id = ?').bind(String(id)).first();

export async function onRequestPatch({ params, request, env }) {
  const contact = await find(env, params.id);
  if (!contact) return Response.json({ error: 'Contact not found.' }, { status: 404 });

  let body;
  try { body = await request.json(); } catch { return Response.json({ error: 'Invalid request.' }, { status: 400 }); }

  const c = cleanContact({ ...contact, ...body });
  if (!isEmail(c.email)) return Response.json({ error: 'That does not look like an email address.' }, { status: 400 });
  if (!c.name) return Response.json({ error: 'Give them a name.' }, { status: 400 });

  // The address book holds one card per address, so a rename onto someone else's
  // address would silently merge two people. Say so instead.
  if (c.email !== String(contact.email).toLowerCase()) {
    const clash = await env.DB.prepare('SELECT id FROM contacts WHERE lower(email) = ? AND id != ?')
      .bind(c.email, contact.id).first();
    if (clash) return Response.json({ error: 'Another contact already uses that address.' }, { status: 409 });
  }

  await env.DB.prepare(
    `UPDATE contacts SET name = ?, email = ?, phone = ?, company = ?, notes = ?, updated_at = datetime('now')
      WHERE id = ?`,
  ).bind(c.name, c.email, c.phone, c.company, c.notes, contact.id).run();

  return Response.json({ ok: true, contact: { ...contact, ...c } });
}

export async function onRequestDelete({ params, env }) {
  const contact = await find(env, params.id);
  if (!contact) return Response.json({ error: 'Contact not found.' }, { status: 404 });
  await env.DB.prepare('DELETE FROM contacts WHERE id = ?').bind(contact.id).run();
  return Response.json({ ok: true });
}
