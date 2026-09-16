// GET /api/team/inbox — the conversations assigned to the signed-in team member.
//
// SCOPE: every query here is bound to ctx.data.teamMemberId, which the team gate
// takes from the session and nothing else. A member can never see a conversation
// that is not assigned to them, and there is no parameter that widens this.

import { TYPES, STATUSES, siteLabel, hideEmails } from '../../../_lib/inbox.js';

const PAGE_SIZE = 30;

export async function onRequestGet({ request, env, data }) {
  const me = data.teamMemberId;
  const url = new URL(request.url);
  const status = url.searchParams.get('status') || 'open';
  const q = (url.searchParams.get('q') || '').trim().slice(0, 100);
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
  const since = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(url.searchParams.get('since') || '')
    ? url.searchParams.get('since') : null;

  const where = ['e.assigned_to = ?', 'e.is_notification = 0'];
  const args = [me];
  if (status === 'open') where.push("e.status != 'closed'");
  else if (STATUSES[status]) { where.push('e.status = ?'); args.push(status); }
  if (q) {
    const like = `%${q.replace(/[%_]/g, m => '\\' + m)}%`;
    // Searching e.email is deliberately absent: a team member could otherwise
    // confirm a customer's address by guessing at it.
    where.push(`(e.name LIKE ? ESCAPE '\\' OR e.phone LIKE ? ESCAPE '\\' OR e.voucher_code LIKE ? ESCAPE '\\'
      OR e.id IN (SELECT enquiry_id FROM enquiry_messages WHERE body LIKE ? ESCAPE '\\'))`);
    args.push(like, like, like, like);
  }
  const clause = 'WHERE ' + where.join(' AND ');

  const [nowRow, list, counts, recent] = await env.DB.batch([
    env.DB.prepare("SELECT datetime('now') AS now"),
    env.DB.prepare(`
      -- e.email is selected ONLY to mask it out of the snippets below; it is
      -- deleted before the response goes out. A team member never sees the
      -- customer's email address, only their name and phone number.
      SELECT e.id, e.name, e.email AS _mask, e.phone, e.type, e.channel, e.site, e.status, e.unread,
             e.voucher_code, e.created_at, e.last_message_at,
             (SELECT substr(body, 1, 160) FROM enquiry_messages m WHERE m.enquiry_id = e.id AND m.direction IN ('in','out') ORDER BY m.id DESC LIMIT 1) AS snippet,
             (SELECT direction FROM enquiry_messages m WHERE m.enquiry_id = e.id AND m.direction IN ('in','out') ORDER BY m.id DESC LIMIT 1) AS last_direction,
             (SELECT COUNT(*) FROM enquiry_messages m WHERE m.enquiry_id = e.id AND m.direction IN ('in','out')) AS message_count
        FROM enquiries e ${clause}
       ORDER BY COALESCE(e.last_message_at, e.created_at) DESC, e.id DESC
       LIMIT ? OFFSET ?`).bind(...args, PAGE_SIZE + 1, (page - 1) * PAGE_SIZE),
    env.DB.prepare(
      `SELECT status, COUNT(*) AS n, SUM(unread) AS unread FROM enquiries WHERE assigned_to = ? AND is_notification = 0 GROUP BY status`,
    ).bind(me),
    env.DB.prepare(
      `SELECT e.id, e.name, e.email AS _mask, e.last_inbound_at,
              (SELECT substr(body, 1, 140) FROM enquiry_messages m WHERE m.enquiry_id = e.id AND m.direction = 'in' ORDER BY m.id DESC LIMIT 1) AS snippet
         FROM enquiries e WHERE e.assigned_to = ? AND e.is_notification = 0 AND ? IS NOT NULL AND e.last_inbound_at >= ?
        ORDER BY e.last_inbound_at DESC LIMIT 5`,
    ).bind(me, since, since),
  ]);

  const rows = list.results || [];
  const statusCounts = { open: 0, all: 0 };
  let unread = 0;
  for (const r of counts.results || []) {
    statusCounts[r.status] = r.n;
    statusCounts.all += r.n;
    if (r.status !== 'closed') { statusCounts.open += r.n; unread += r.unread || 0; }
  }

  // Message previews can quote the customer's own address — mask it, then drop
  // the column that made that possible.
  const scrub = r => {
    const { _mask, ...rest } = r;
    return { ...rest, snippet: hideEmails(rest.snippet, _mask) };
  };

  return Response.json({
    enquiries: rows.slice(0, PAGE_SIZE).map(r => ({ ...scrub(r), site_label: siteLabel(r.site) })),
    hasMore: rows.length > PAGE_SIZE,
    counts: { status: statusCounts },
    unread,
    server_now: nowRow.results?.[0]?.now || null,
    recent_inbound: (recent.results || []).map(scrub),
    labels: { types: TYPES, statuses: STATUSES },
  });
}
