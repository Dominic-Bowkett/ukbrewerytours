// Attachments on inbox messages. The bytes live in R2 (MAIL_FILES); the
// enquiry_attachments table is the index. Three ways in:
//   - inbound email: saveInbound() pulls them from Resend after the webhook;
//   - replies and new emails: storeUploads() keeps what the admin attached;
//   - backfill: saveInbound() again, for emails received before this existed.
// Served by /api/admin/inbox/:id/attachments/:aid (and the team equivalent).

/** Per file, and per outgoing email (Resend's cap is 40MB after base64). */
export const MAX_FILE = 25 * 1024 * 1024;
export const MAX_OUT_TOTAL = 25 * 1024 * 1024;

/**
 * Types a browser may render on our own origin. Everything else downloads:
 * an HTML or SVG file someone emailed in must never run as this site.
 */
const INLINE_TYPES = /^(image\/(jpeg|png|gif|webp|avif|bmp)|application\/pdf|text\/plain|video\/(mp4|webm|quicktime)|audio\/(mpeg|mp4|ogg|wav))$/i;

export const isImage = type => /^image\/(jpeg|png|gif|webp|avif|bmp)$/i.test(String(type || ''));

function safeName(name) {
  const clean = String(name || 'file').replace(/[\u0000-\u001f\\/:*?"<>|]+/g, '_').trim().slice(0, 150);
  return clean || 'file';
}

/** Images without a filename (common for pasted/inline photos) get one from their type. */
function nameFor(filename, contentType, n) {
  if (filename) return safeName(filename);
  const ext = (String(contentType || '').split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 5);
  return `attachment-${n}.${ext || 'bin'}`;
}

function key(prefix, enquiryId, name) {
  const rand = crypto.randomUUID().slice(0, 8);
  return `${prefix}/${enquiryId}/${Date.now()}-${rand}-${safeName(name).replace(/\s+/g, '_')}`;
}

/**
 * Fetch a received email's attachments (and its HTML body) from Resend and keep
 * them against a message. Safe to run twice: a message that already has its
 * attachments is skipped. Returns the number saved.
 */
export async function saveInbound(env, { enquiryId, messageId, inboundId, html }) {
  if (!env.MAIL_FILES || !inboundId) return 0;
  const apiKey = env.INBOUND_API_KEY || env.RESEND_API_KEY;
  if (!apiKey) return 0;

  const have = await env.DB.prepare('SELECT COUNT(*) AS n FROM enquiry_attachments WHERE message_id = ?').bind(messageId).first();
  if (have?.n) return 0;

  // The original HTML, so "View original" can show the email as it was sent,
  // inline photos and all.
  if (html) {
    const htmlKey = key('html', enquiryId, `${messageId}.html`);
    await env.MAIL_FILES.put(htmlKey, html, { httpMetadata: { contentType: 'text/html; charset=utf-8' } });
    await env.DB.prepare('UPDATE enquiry_messages SET html_key = ? WHERE id = ?').bind(htmlKey, messageId).run();
  }

  const res = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(inboundId)}/attachments`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Resend attachments ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const list = (await res.json())?.data || [];

  let saved = 0;
  for (const [i, a] of list.entries()) {
    if (!a.download_url) continue;
    if (a.size && a.size > MAX_FILE) {
      console.error('attachment too big, skipped', a.filename, a.size);
      continue;
    }
    const file = await fetch(a.download_url, { signal: AbortSignal.timeout(60000) });
    if (!file.ok) {
      console.error('attachment download failed', a.filename, file.status);
      continue;
    }
    const bytes = await file.arrayBuffer();
    const name = nameFor(a.filename, a.content_type, i + 1);
    const type = a.content_type || file.headers.get('content-type') || 'application/octet-stream';
    const r2Key = key('in', enquiryId, name);
    await env.MAIL_FILES.put(r2Key, bytes, { httpMetadata: { contentType: type } });
    await env.DB.prepare(
      `INSERT INTO enquiry_attachments (enquiry_id, message_id, filename, content_type, size, r2_key, content_id, inline)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).bind(
      enquiryId, messageId, name, type, bytes.byteLength, r2Key,
      a.content_id ? String(a.content_id).replace(/^<|>$/g, '') : null,
      /inline/i.test(a.content_disposition || '') ? 1 : 0,
    ).run();
    saved++;
  }
  return saved;
}

/**
 * Files the admin attached to an outgoing email: checked, kept in R2, and
 * returned in the shape Resend wants. Throws a readable message when they
 * will not fit.
 */
export async function readUploads(files) {
  const list = (files || []).filter(f => f && typeof f === 'object' && f.size > 0);
  let total = 0;
  const out = [];
  for (const f of list) {
    if (f.size > MAX_FILE) throw new Error(`${f.name} is too big — the limit is 25MB a file.`);
    total += f.size;
    if (total > MAX_OUT_TOTAL) throw new Error('Those attachments add up to more than 25MB, which is too big to email.');
    const bytes = await f.arrayBuffer();
    out.push({ name: safeName(f.name), type: f.type || 'application/octet-stream', bytes });
  }
  return out;
}

/** Base64 for Resend, in chunks so a large photo does not blow the call stack. */
export function toBase64(bytes) {
  const u8 = new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}

export const forResend = uploads => uploads.map(u => ({ filename: u.name, content: toBase64(u.bytes) }));

/** Keep what was sent against the message it went out with. */
export async function storeUploads(env, enquiryId, messageId, uploads) {
  if (!env.MAIL_FILES || !uploads?.length) return;
  for (const u of uploads) {
    const r2Key = key('out', enquiryId, u.name);
    await env.MAIL_FILES.put(r2Key, u.bytes, { httpMetadata: { contentType: u.type } });
    await env.DB.prepare(
      'INSERT INTO enquiry_attachments (enquiry_id, message_id, filename, content_type, size, r2_key) VALUES (?,?,?,?,?,?)',
    ).bind(enquiryId, messageId, u.name, u.type, u.bytes.byteLength, r2Key).run();
  }
}

/**
 * Read a request that may be JSON or multipart (when files are attached).
 * Returns { body, files } — body as a plain object either way.
 */
export async function readBody(request) {
  const type = request.headers.get('content-type') || '';
  if (type.includes('multipart/form-data')) {
    const form = await request.formData();
    const body = {};
    for (const [k, v] of form.entries()) if (typeof v === 'string') body[k] = v;
    return { body, files: form.getAll('files') };
  }
  return { body: await request.json(), files: [] };
}

/** Attachments for a set of messages, grouped by message id, for the timeline. */
export async function attachmentsByMessage(env, enquiryId, base) {
  const { results } = await env.DB.prepare(
    'SELECT id, message_id, filename, content_type, size, inline FROM enquiry_attachments WHERE enquiry_id = ? ORDER BY id',
  ).bind(enquiryId).all();
  const map = {};
  for (const a of results || []) {
    (map[a.message_id] ||= []).push({
      id: a.id,
      filename: a.filename,
      content_type: a.content_type,
      size: a.size,
      inline: a.inline,
      is_image: isImage(a.content_type),
      url: `${base}/${enquiryId}/attachments/${a.id}`,
    });
  }
  return map;
}

/** Hang each message's attachments (and whether it has an original) on it. */
export function withAttachments(messages, map, base, enquiryId) {
  return messages.map(m => ({
    ...m,
    attachments: map[m.id] || [],
    original_url: m.html_key ? `${base}/${enquiryId}/messages/${m.id}/original` : null,
    html_key: undefined,
  }));
}

/** Stream one attachment. Only safe types are shown in the browser; the rest download. */
export async function serveAttachment(env, att, { download = false } = {}) {
  if (!env.MAIL_FILES) return new Response('Attachments are not configured.', { status: 503 });
  const obj = await env.MAIL_FILES.get(att.r2_key);
  if (!obj) return new Response('That file has gone.', { status: 404 });
  const type = att.content_type || 'application/octet-stream';
  const inline = !download && INLINE_TYPES.test(type);
  const name = att.filename.replace(/"/g, '');
  return new Response(obj.body, {
    headers: {
      'Content-Type': inline ? type : 'application/octet-stream',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      'X-Content-Type-Options': 'nosniff',
      // Chrome will not render a PDF under a sandbox policy; its viewer is sandboxed anyway.
      ...(/pdf/i.test(type) ? {} : { 'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'" }),
      'Cache-Control': 'private, max-age=86400',
    },
  });
}

/**
 * The email as it was sent, inline photos pointing at our copies. Served in a
 * sandbox with no scripts, so whatever the sender put in the HTML cannot run.
 */
export async function serveOriginal(env, message, base, enquiryId) {
  if (!env.MAIL_FILES || !message?.html_key) return new Response('No original kept for this message.', { status: 404 });
  const obj = await env.MAIL_FILES.get(message.html_key);
  if (!obj) return new Response('That original has gone.', { status: 404 });
  let html = await obj.text();
  // Inline photos go in as data: URIs. The page is sandboxed (an opaque origin),
  // so the browser would not send the admin cookie with a request for our copy.
  const { results } = await env.DB.prepare(
    'SELECT id, content_id, content_type, r2_key FROM enquiry_attachments WHERE message_id = ? AND content_id IS NOT NULL',
  ).bind(message.id).all();
  for (const a of results || []) {
    const cid = a.content_id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`cid:${cid}`, 'gi');
    if (!re.test(html) || !isImage(a.content_type)) continue;
    const img = await env.MAIL_FILES.get(a.r2_key);
    if (!img) continue;
    const uri = `data:${a.content_type};base64,${toBase64(await img.arrayBuffer())}`;
    html = html.replace(new RegExp(`cid:${cid}`, 'gi'), () => uri);
  }
  return new Response(`<!doctype html><meta charset="utf-8"><base target="_blank">${html}`, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // No scripts, no forms, no navigation of this page. Remote images load, as in a mail client.
      'Content-Security-Policy': "sandbox allow-popups allow-popups-to-escape-sandbox; default-src 'none'; img-src 'self' https: data:; style-src 'unsafe-inline' https:; font-src https: data:",
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    },
  });
}

/** R2 objects belonging to these conversations — called before they are deleted for good. */
export async function deleteFilesFor(env, enquiryIds) {
  if (!enquiryIds.length) return;
  const list = enquiryIds.map(() => '?').join(',');
  const [atts, htmls] = await env.DB.batch([
    env.DB.prepare(`SELECT r2_key FROM enquiry_attachments WHERE enquiry_id IN (${list})`).bind(...enquiryIds),
    env.DB.prepare(`SELECT html_key FROM enquiry_messages WHERE enquiry_id IN (${list}) AND html_key IS NOT NULL`).bind(...enquiryIds),
  ]);
  const keys = [...(atts.results || []).map(r => r.r2_key), ...(htmls.results || []).map(r => r.html_key)];
  if (env.MAIL_FILES) {
    // R2 deletes up to 1000 keys a call.
    for (let i = 0; i < keys.length; i += 1000) await env.MAIL_FILES.delete(keys.slice(i, i + 1000));
  }
  await env.DB.prepare(`DELETE FROM enquiry_attachments WHERE enquiry_id IN (${list})`).bind(...enquiryIds).run();
}
