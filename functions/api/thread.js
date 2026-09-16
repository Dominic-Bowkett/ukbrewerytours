// /api/thread — the customer's side of a conversation, keyed by its token.
//
//   GET  /api/thread?t=<token>          messages so far (the chat widget polls this)
//   POST /api/thread { t, message }     a follow-up from the customer
//
// The token is 128 random bits and is the only key: it is minted when the
// enquiry is created and handed to the sender (chat widget storage, the link
// in their confirmation email). Internal notes and events are never returned.

import { TOKEN_RE, appendCustomerMessage, alertAdmin, brandFor, voucherCheck } from '../_lib/inbox.js';

const HEADERS = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex' };
const MAX_PER_HOUR_THREAD = 30;
const MAX_PER_HOUR_IP = 60;

const json = (data, status = 200) => Response.json(data, { status, headers: HEADERS });

async function findThread(env, token) {
  token = String(token || '').toLowerCase();
  if (!TOKEN_RE.test(token)) return null;
  return env.DB.prepare('SELECT * FROM enquiries WHERE token = ? AND deleted_at IS NULL').bind(token).first();
}

async function threadPayload(env, enquiry) {
  const { results } = await env.DB.prepare(
    `SELECT id, direction, channel, body, author, created_at FROM enquiry_messages
      WHERE enquiry_id = ? AND direction IN ('in','out') ORDER BY id`,
  ).bind(enquiry.id).all();
  return {
    ok: true,
    name: enquiry.name,
    email: enquiry.email,
    brand: brandFor(enquiry.site),
    closed: enquiry.status === 'closed',
    messages: (results || []).map(m => ({
      id: m.id,
      from: m.direction === 'out' ? 'team' : 'you',
      body: m.body,
      at: m.created_at,
    })),
  };
}

export async function onRequestGet({ request, env }) {
  const enquiry = await findThread(env, new URL(request.url).searchParams.get('t'));
  if (!enquiry) return json({ error: 'Conversation not found.' }, 404);
  return json(await threadPayload(env, enquiry));
}

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid request.' }, 400);
  }
  if (String(body.company || '').trim()) return json({ ok: true, messages: [] });   // honeypot

  const enquiry = await findThread(env, body.t);
  if (!enquiry) return json({ error: 'Conversation not found.' }, 404);

  const message = String(body.message ?? '').trim().slice(0, 5000);
  if (message.length < 1) return json({ error: 'Please type a message.' }, 400);

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const channel = body.channel === 'chat' ? 'chat' : 'web';
  try {
    const row = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM enquiry_messages WHERE enquiry_id = ? AND direction = 'in' AND created_at > datetime('now','-1 hour')) AS thread_n,
         (SELECT COUNT(*) FROM enquiry_messages WHERE ip = ? AND created_at > datetime('now','-1 hour')) AS ip_n`,
    ).bind(enquiry.id, ip).first();
    if ((row?.thread_n || 0) >= MAX_PER_HOUR_THREAD || (row?.ip_n || 0) >= MAX_PER_HOUR_IP) {
      return json({ error: "You've sent a lot of messages — we'll be in touch soon." }, 429);
    }
  } catch (err) {
    console.error('thread rate-limit check failed', err);
  }

  await appendCustomerMessage(env, enquiry, { body: message, channel, author: enquiry.name, ip });

  try {
    const { matches, unmatched } = await voucherCheck(env, enquiry, [message]);
    await alertAdmin(env, enquiry, { body: message, followUp: true, matches, unmatched });
  } catch (err) {
    console.error('thread alert failed', err);
  }

  return json(await threadPayload(env, { ...enquiry, status: enquiry.status === 'closed' ? 'dealing' : enquiry.status }));
}
