// /api/admin/contacts
//   GET   the address book, newest contact first, or ?q= to search it.
//   POST  { name, email, phone?, company?, notes? } — add or update a contact.
//
// Admin only, like everything under /api/admin. Team members never see it.

import { cleanContact, isEmail, upsertContact } from '../../../_lib/contacts.js';

const PAGE_SIZE = 200;

export async function onRequestGet({ request, env }) {
  const q = (new URL(request.url).searchParams.get('q') || '').trim().slice(0, 100);
  const args = [];
  let clause = '';
  if (q) {
    const like = `%${q.replace(/[%_]/g, m => '\\' + m)}%`;
    clause = `WHERE (name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' OR company LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\')`;
    args.push(like, like, like, like);
  }

  const { results } = await env.DB.prepare(
    `SELECT id, name, email, phone, company, notes, created_at, last_emailed_at
       FROM contacts ${clause} ORDER BY lower(name) LIMIT ?`,
  ).bind(...args, PAGE_SIZE).all();

  return Response.json({ contacts: results || [] }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return Response.json({ error: 'Invalid request.' }, { status: 400 }); }

  const c = cleanContact(body);
  if (!isEmail(c.email)) return Response.json({ error: 'That does not look like an email address.' }, { status: 400 });
  if (!c.name) return Response.json({ error: 'Give them a name.' }, { status: 400 });

  const contact = await upsertContact(env, c);
  return Response.json({ ok: true, contact });
}
