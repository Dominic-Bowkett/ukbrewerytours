// POST /api/admin/inbox/attachments-backfill  { after?, message_id? }
//
// Emails received before attachments were kept only say "[Attachments: …]" in
// their text. This finds those emails in Resend (matched on the Message-ID we
// stored), downloads their attachments and original HTML, and takes the
// placeholder line out of the text. A few pages of Resend's list per call;
// call again with the returned `after` until `next` is null.
//
// { message_id } instead retries one message that already knows its Resend id
// (a save that failed after the webhook).

import { saveInbound } from '../../../_lib/attachments.js';

const PAGES_PER_CALL = 5;
const PLACEHOLDER = /\n*\[Attachments: [^\]]*\]\s*$/;
const norm = id => String(id || '').trim().replace(/^<|>$/g, '').toLowerCase();

export async function onRequestPost({ request, env }) {
  if (!env.MAIL_FILES) return Response.json({ error: 'Attachment storage is not configured.' }, { status: 503 });
  const apiKey = env.INBOUND_API_KEY || env.RESEND_API_KEY;
  if (!apiKey) return Response.json({ error: 'Resend is not configured.' }, { status: 503 });
  let body = {};
  try { body = await request.json(); } catch { /* empty is fine */ }

  if (body.message_id) {
    const m = await env.DB.prepare(
      "SELECT id, enquiry_id, inbound_id FROM enquiry_messages WHERE id = ? AND direction = 'in' AND inbound_id IS NOT NULL",
    ).bind(Number(body.message_id)).first();
    if (!m) return Response.json({ error: 'That message has no Resend id to fetch from.' }, { status: 404 });
    const html = await fetchHtml(apiKey, m.inbound_id);
    const saved = await saveInbound(env, { enquiryId: m.enquiry_id, messageId: m.id, inboundId: m.inbound_id, html });
    return Response.json({ ok: true, saved });
  }

  const { results } = await env.DB.prepare(
    `SELECT id, enquiry_id, email_id, body FROM enquiry_messages
      WHERE direction = 'in' AND channel = 'email' AND inbound_id IS NULL
        AND email_id IS NOT NULL AND body LIKE '%[Attachments: %'`,
  ).all();
  const wanted = new Map((results || []).map(r => [norm(r.email_id), r]));
  if (!wanted.size) return Response.json({ ok: true, matched: 0, saved: 0, remaining: 0, next: null });

  let after = body.after || null;
  let matched = 0;
  let saved = 0;
  let more = true;
  for (let page = 0; page < PAGES_PER_CALL && more && wanted.size; page++) {
    const url = new URL('https://api.resend.com/emails/receiving');
    url.searchParams.set('limit', '100');
    if (after) url.searchParams.set('after', after);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return Response.json({ error: `Resend ${res.status}: ${(await res.text()).slice(0, 200)}` }, { status: 502 });
    const list = await res.json();
    const emails = list.data || [];
    more = Boolean(list.has_more) && emails.length > 0;
    if (emails.length) after = emails[emails.length - 1].id;

    for (const em of emails) {
      const row = wanted.get(norm(em.message_id));
      if (!row) continue;
      wanted.delete(norm(em.message_id));
      matched++;
      await env.DB.prepare('UPDATE enquiry_messages SET inbound_id = ? WHERE id = ?').bind(em.id, row.id).run();
      try {
        const html = await fetchHtml(apiKey, em.id);
        const n = await saveInbound(env, { enquiryId: row.enquiry_id, messageId: row.id, inboundId: em.id, html });
        saved += n;
        // The files are on the message now; the placeholder line has done its job.
        if (n) {
          const text = row.body.replace(PLACEHOLDER, '').trim() || `📎 Sent ${n === 1 ? 'an attachment' : `${n} attachments`}`;
          await env.DB.prepare('UPDATE enquiry_messages SET body = ? WHERE id = ?').bind(text, row.id).run();
        }
      } catch (err) {
        console.error('backfill failed for message', row.id, err);
      }
    }
  }

  return Response.json({ ok: true, matched, saved, remaining: wanted.size, next: more && wanted.size ? after : null });
}

async function fetchHtml(apiKey, inboundId) {
  try {
    const res = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(inboundId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10000),
    });
    return res.ok ? (await res.json()).html || null : null;
  } catch {
    return null;
  }
}
