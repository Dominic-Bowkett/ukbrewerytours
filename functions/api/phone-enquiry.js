// POST /api/phone-enquiry — a call taken by the phone agent becomes a conversation in the inbox,
// exactly like a form or a chat, so the team work from one place.
//
// Called machine-to-machine by the phone relay worker, so it is not public: the caller must present
// the shared secret. The call summary is the customer-visible first message; the full transcript is
// added as an internal note.

import { createEnquiry, alertAdmin, voucherCheck, cleanFields, logEvent, TYPES } from '../_lib/inbox.js';

const clean = (s, max) => String(s ?? '').trim().slice(0, max);
const isEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim());

// What the agent recorded → the inbox's own types.
const TYPE_MAP = {
  'voucher redemption': 'redemption',
  'voucher purchase': 'voucher',
  'group or private tour': 'group',
  'existing booking': 'booking',
  'tour question': 'general',
  other: 'general',
  'sales call': 'general',
};

function timingSafeEqual(a, b) {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.byteLength !== y.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export async function onRequestPost({ request, env }) {
  const secret = String(env.PHONE_AGENT_SECRET || '');
  const given = request.headers.get('x-phone-secret') || '';
  if (!secret || !given || !timingSafeEqual(given, secret)) {
    return Response.json({ error: 'Not authorised.' }, { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const name = clean(body.name, 100) || 'Phone caller';
  // A caller often gives no email; the conversation still belongs in the inbox.
  const email = isEmail(body.email) ? clean(body.email, 200) : '';
  const phone = clean(body.phone, 40).replace(/[^\d+()\-.\s]/g, '').trim();
  const summary = clean(body.summary, 4000);
  const transcript = clean(body.transcript, 20000);
  const type = TYPES[body.type] ? body.type : (TYPE_MAP[clean(body.enquiry_type, 60).toLowerCase()] || 'general');
  const site = ['ukbrewerytours.com', 'londonbrewerytour.com', 'bristolbrewerytours.com'].includes(clean(body.site, 60))
    ? clean(body.site, 60)
    : 'ukbrewerytours.com';
  const fields = cleanFields(body.fields);
  const voucherCode = clean(body.voucher_code, 200) || null;
  const recording = clean(body.recording_url, 300);
  const when = clean(body.when, 100);
  const duration = clean(body.duration, 20);

  if (/[\r\n]/.test(name) || /[\r\n]/.test(email)) {
    return Response.json({ error: 'Invalid characters in name or email.' }, { status: 400 });
  }

  const message = [
    `Phone call${when ? ` — ${when}` : ''}${duration ? ` (${duration})` : ''}`,
    phone ? `Number: ${phone}` : 'Number: withheld',
    email ? `Email: ${email}` : 'Email: not given',
    '',
    summary || 'No summary was recorded for this call.',
  ].join('\n');

  let created;
  try {
    created = await createEnquiry(env, {
      name, email, phone, message, page: null, ip: null,
      widgetId: null, widgetOrigin: null,
      type, channel: 'phone', site, fields, voucherCode,
    });
  } catch (err) {
    console.error('phone enquiry insert failed', err);
    return Response.json({ error: 'Could not save the call.' }, { status: 502 });
  }

  // The transcript is for the team only, so it goes on the timeline as a note.
  if (transcript) {
    try {
      await logEvent(env, created.id, `Call transcript:\n\n${transcript}${recording ? `\n\nRecording: ${recording}` : ''}`, 'phone agent');
    } catch (err) {
      console.error('phone transcript note failed', err);
    }
  }

  try {
    const { matches, unmatched } = await voucherCheck(env, { ...created, name, email, phone, type, channel: 'phone', site, voucher_code: voucherCode }, [summary, transcript]);
    await alertAdmin(env, { id: created.id, token: created.token, name, email, phone, type, channel: 'phone', site, voucher_code: voucherCode }, { body: summary || message, matches, unmatched });
  } catch (err) {
    console.error('phone enquiry alert failed', err);
  }

  return Response.json({ ok: true, id: created.id, token: created.token });
}
