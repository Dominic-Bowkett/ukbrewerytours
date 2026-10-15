// /api/hub/* — the feed for Dom's hub (hub.dominicbowkett.com).
//
// Server-to-server only: the hub Worker sends X-Hub-Key, checked against the
// HUB_KEY secret. No cookie, no browser. Every write goes through the admin
// handlers themselves, so a reply from the hub is the same email the admin
// sends — from info@ukbrewerytours.com, quoted, threaded, logged — never from
// any hub or dominicbowkett.com address.
//
//   GET  /api/hub/items                 conversations waiting on us, plus the team list
//   GET  /api/hub/items/:id             one conversation, its messages (marks it read)
//   POST /api/hub/items/:id/reply       { body }            → the admin reply handler
//   POST /api/hub/items/:id/assign      { assigned_to }     → the admin triage handler

import { BASE_URL, STATUSES, siteLabel } from '../../_lib/inbox.js';
import { onRequestGet as adminThread, onRequestPatch as adminPatch } from '../admin/inbox/[id].js';
import { onRequestPost as adminReply } from '../admin/inbox/[id]/reply.js';

const AUTHOR = 'Dom (hub)';

const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });

async function keyOk(request, env) {
  const given = request.headers.get('x-hub-key') || '';
  if (!env.HUB_KEY || !given) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([given, env.HUB_KEY].map(s => crypto.subtle.digest('SHA-256', enc.encode(s))));
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// D1 datetime('now') is UTC without a zone.
const iso = s => (s ? String(s).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? '' : 'Z') : null);
const link = id => `${BASE_URL}/admin/#inbox/${id}`;

// Hand an admin handler a request of our own making, so it runs exactly as it
// does for the admin page.
function forward(request, method, body) {
  return new Request(request.url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

export async function onRequest(ctx) {
  const { request, env } = ctx;
  if (!(await keyOk(request, env))) return json({ ok: false, error: 'Unauthorised' }, 401);

  const parts = [].concat(ctx.params.path || []);
  const [head, id, action] = parts;
  if (head !== 'items') return json({ ok: false, error: 'Not found' }, 404);
  const data = { user: { email: AUTHOR } };

  if (!id && request.method === 'GET') {
    const [list, team] = await env.DB.batch([
      env.DB.prepare(
        `SELECT e.id, e.name, e.email, e.phone, e.site, e.status, e.unread, e.subject, e.created_at, e.last_message_at,
                e.last_inbound_at, e.assigned_to,
                (SELECT name FROM team_members t WHERE t.id = e.assigned_to) AS assignee_name,
                (SELECT substr(body, 1, 200) FROM enquiry_messages m WHERE m.enquiry_id = e.id AND m.direction = 'in' ORDER BY m.id DESC LIMIT 1) AS snippet,
                (SELECT direction FROM enquiry_messages m WHERE m.enquiry_id = e.id AND m.direction IN ('in','out') ORDER BY m.id DESC LIMIT 1) AS last_direction
           FROM enquiries e
          WHERE e.deleted_at IS NULL AND e.is_notification = 0 AND e.status != 'closed'
          ORDER BY COALESCE(e.last_inbound_at, e.created_at) DESC
          LIMIT 200`,
      ),
      env.DB.prepare('SELECT id, name FROM team_members WHERE inbox_access = 1 AND active = 1 ORDER BY name'),
    ]);
    const items = (list.results || [])
      // Waiting on us: the customer spoke last, or nobody has opened it yet.
      .filter(r => r.last_direction === 'in' || r.unread === 1)
      .map(r => ({
        id: String(r.id),
        name: r.name || r.email || r.phone || 'Unknown',
        contact: r.email || r.phone || '',
        subject: r.subject || null,
        preview: r.snippet || '',
        waiting_since: iso(r.last_inbound_at || r.created_at),
        unread: r.unread === 1,
        status: STATUSES[r.status] || r.status,
        group: siteLabel(r.site),
        assigned_to: r.assigned_to || null,
        assignee_name: r.assignee_name || null,
        can_reply: { email: !!String(r.email || '').trim(), sms: false },
        link: link(r.id),
      }));
    return json({ ok: true, admin_url: `${BASE_URL}/admin/#inbox`, team: team.results || [], items });
  }

  if (id && !action && request.method === 'GET') {
    const res = await adminThread({ params: { id }, env, request });
    const body = await res.json();
    if (!res.ok) return json({ ok: false, error: body.error || 'Not found' }, res.status);
    const e = body.enquiry;
    return json({
      ok: true,
      item: {
        id: String(e.id), name: e.name || e.email || 'Unknown', contact: e.email || e.phone || '',
        email: e.email || null, phone: e.phone || null, subject: e.subject || null,
        group: e.site_label, status: STATUSES[e.status] || e.status,
        assigned_to: e.assigned_to || null, assignee_name: e.assignee_name || null,
        can_reply: { email: !!String(e.email || '').trim(), sms: false },
        sender: 'info@ukbrewerytours.com',
        link: link(e.id),
      },
      messages: (body.messages || []).map(m => ({
        dir: m.direction === 'in' ? 'in' : m.direction === 'out' ? 'out' : 'note',
        channel: m.channel, body: m.body || '', at: iso(m.created_at), who: m.author || null,
      })),
    });
  }

  if (id && action === 'reply' && request.method === 'POST') {
    let input = {};
    try { input = await request.json(); } catch {}
    const res = await adminReply({ params: { id }, env, data, request: forward(request, 'POST', { body: input.body, status: 'waiting' }) });
    const body = await res.json().catch(() => ({}));
    return json(res.ok ? { ok: true, sent_from: 'info@ukbrewerytours.com' } : { ok: false, error: body.error || 'Reply failed' }, res.status);
  }

  if (id && action === 'assign' && request.method === 'POST') {
    let input = {};
    try { input = await request.json(); } catch {}
    const res = await adminPatch({ params: { id }, env, data, request: forward(request, 'PATCH', { assigned_to: input.assigned_to || null }) });
    const body = await res.json().catch(() => ({}));
    return json(res.ok ? { ok: true } : { ok: false, error: body.error || 'Assign failed' }, res.status);
  }

  return json({ ok: false, error: 'Not found' }, 404);
}
