// GET /api/admin/inbox — the conversation list, with per-status and per-type counts.
// Query: status (open|new|dealing|waiting|closed|all), type, site, q, page,
//        view (inbox|notifications)
//
// Notifications are the machine-written mail that arrives at info@: Stripe
// receipts, DesignMyNight bookings, Google security notices. They live in the
// same table behind is_notification, so they are searchable and can be promoted
// into the inbox, but they never appear in it, never count towards the badge,
// and never reach a team member.

import { TYPES, STATUSES, BIN_DAYS, siteLabel, purgeBin } from '../../../_lib/inbox.js';

const PAGE_SIZE = 30;

export async function onRequestGet({ request, env, waitUntil }) {
  // The cron Worker empties the bin every five minutes; this is the belt to its
  // braces, so the seven days hold even if that Worker is down. After the
  // response, never in front of it.
  if (waitUntil) waitUntil(purgeBin(env).catch(err => console.error('bin purge failed', err)));

  const url = new URL(request.url);
  const status = url.searchParams.get('status') || 'open';
  const type = url.searchParams.get('type') || '';
  const site = url.searchParams.get('site') || '';
  const q = (url.searchParams.get('q') || '').trim().slice(0, 100);
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);

  const asked = url.searchParams.get('view');
  const view = asked === 'notifications' || asked === 'bin' ? asked : 'inbox';

  // Filters other than status/type, shared by the list and both count queries.
  // The bin cuts across the other two: a binned notification is in the bin.
  const base = [view === 'bin' ? 'e.deleted_at IS NOT NULL' : 'e.deleted_at IS NULL'];
  const baseArgs = [];
  if (view !== 'bin') {
    base.push('e.is_notification = ?');
    baseArgs.push(view === 'notifications' ? 1 : 0);
  }
  if (site) { base.push('e.site = ?'); baseArgs.push(site); }
  // assignee=<member id> | none (unassigned) | mine is not a thing here: the admin sees all.
  const assignee = url.searchParams.get('assignee') || '';
  if (assignee === 'none') base.push('e.assigned_to IS NULL');
  else if (assignee) { base.push('e.assigned_to = ?'); baseArgs.push(assignee); }
  if (q) {
    const like = `%${q.replace(/[%_]/g, m => '\\' + m)}%`;
    // Subject included: a notification is remembered by its subject line
    // ("the Stripe payout one"), not by who sent it.
    base.push(`(e.name LIKE ? ESCAPE '\\' OR e.email LIKE ? ESCAPE '\\' OR e.voucher_code LIKE ? ESCAPE '\\' OR e.phone LIKE ? ESCAPE '\\'
      OR e.subject LIKE ? ESCAPE '\\'
      OR e.id IN (SELECT enquiry_id FROM enquiry_messages WHERE body LIKE ? ESCAPE '\\')${/^\d+$/.test(q) ? ' OR e.id = ?' : ''})`);
    baseArgs.push(like, like, like, like, like, like);
    if (/^\d+$/.test(q)) baseArgs.push(Number(q));
  }

  const statusClause = status === 'all' ? null
    : status === 'open' ? "e.status != 'closed'"
    : STATUSES[status] ? 'e.status = ?' : null;
  const statusArgs = statusClause === 'e.status = ?' ? [status] : [];
  const typeClause = TYPES[type] ? 'e.type = ?' : null;
  const typeArgs = typeClause ? [type] : [];

  const where = (...parts) => {
    const all = parts.flat().filter(Boolean);
    return all.length ? 'WHERE ' + all.join(' AND ') : '';
  };

  const listSql = `
    SELECT e.id, e.name, e.email, e.phone, e.type, e.channel, e.site, e.status, e.unread, e.voucher_code,
           e.created_at, e.last_message_at, e.assigned_to, e.subject, e.is_notification, e.notification_reason,
           e.deleted_at,
           (SELECT name FROM team_members t WHERE t.id = e.assigned_to) AS assignee_name,
           (SELECT substr(body, 1, 160) FROM enquiry_messages m WHERE m.enquiry_id = e.id AND m.direction IN ('in','out') ORDER BY m.id DESC LIMIT 1) AS snippet,
           (SELECT direction FROM enquiry_messages m WHERE m.enquiry_id = e.id AND m.direction IN ('in','out') ORDER BY m.id DESC LIMIT 1) AS last_direction,
           (SELECT COUNT(*) FROM enquiry_messages m WHERE m.enquiry_id = e.id AND m.direction IN ('in','out')) AS message_count
      FROM enquiries e
      ${where(base, statusClause, typeClause)}
     ORDER BY COALESCE(e.last_message_at, e.created_at) DESC, e.id DESC
     LIMIT ? OFFSET ?`;

  // ?since=<server time from the previous response> also returns conversations a
  // customer has written to since then, for the admin's new-message alerts.
  const since = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(url.searchParams.get('since') || '')
    ? url.searchParams.get('since') : null;

  const [nowRow, list, byStatus, byType, sites, team, unread, recent, notifications, binned] = await env.DB.batch([
    env.DB.prepare("SELECT datetime('now') AS now"),
    env.DB.prepare(listSql).bind(...baseArgs, ...statusArgs, ...typeArgs, PAGE_SIZE + 1, (page - 1) * PAGE_SIZE),
    env.DB.prepare(`SELECT e.status, COUNT(*) AS n, SUM(e.unread) AS unread FROM enquiries e ${where(base, typeClause)} GROUP BY e.status`)
      .bind(...baseArgs, ...typeArgs),
    env.DB.prepare(`SELECT e.type, COUNT(*) AS n FROM enquiries e ${where(base, statusClause)} GROUP BY e.type`)
      .bind(...baseArgs, ...statusArgs),
    env.DB.prepare('SELECT site, COUNT(*) AS n FROM enquiries WHERE is_notification = 0 AND deleted_at IS NULL GROUP BY site ORDER BY n DESC'),
    // Who conversations can be handed to, and how much each is holding.
    env.DB.prepare(
      `SELECT t.id, t.name, t.email, t.inbox_from_email,
              (SELECT COUNT(*) FROM enquiries e WHERE e.assigned_to = t.id AND e.status != 'closed') AS open_count
         FROM team_members t WHERE t.inbox_access = 1 AND t.active = 1 ORDER BY t.name`,
    ),
    // The badge counts people waiting for an answer. Notifications never do.
    env.DB.prepare("SELECT COUNT(*) AS n FROM enquiries WHERE unread = 1 AND status != 'closed' AND is_notification = 0 AND deleted_at IS NULL"),
    // >= and a client-side dedupe: timestamps are whole seconds.
    env.DB.prepare(
      `SELECT e.id, e.name, e.last_inbound_at,
              (SELECT substr(body, 1, 140) FROM enquiry_messages m WHERE m.enquiry_id = e.id AND m.direction = 'in' ORDER BY m.id DESC LIMIT 1) AS snippet
         FROM enquiries e WHERE ? IS NOT NULL AND e.last_inbound_at >= ? AND e.is_notification = 0 AND e.deleted_at IS NULL
        ORDER BY e.last_inbound_at DESC LIMIT 5`,
    ).bind(since, since),
    env.DB.prepare(
      "SELECT COUNT(*) AS n, COALESCE(SUM(unread), 0) AS unread FROM enquiries WHERE is_notification = 1 AND status != 'closed' AND deleted_at IS NULL",
    ),
    env.DB.prepare('SELECT COUNT(*) AS n FROM enquiries WHERE deleted_at IS NOT NULL'),
  ]);

  const rows = list.results || [];
  const statusCounts = { open: 0, all: 0, unread_open: 0 };
  for (const r of byStatus.results || []) {
    statusCounts[r.status] = r.n;
    statusCounts.all += r.n;
    if (r.status !== 'closed') { statusCounts.open += r.n; statusCounts.unread_open += r.unread || 0; }
  }

  return Response.json({
    view,
    enquiries: rows.slice(0, PAGE_SIZE).map(r => ({ ...r, site_label: siteLabel(r.site) })),
    hasMore: rows.length > PAGE_SIZE,
    counts: {
      status: statusCounts,
      type: Object.fromEntries((byType.results || []).map(r => [r.type, r.n])),
      notifications: notifications.results?.[0]?.n || 0,
      notifications_unread: notifications.results?.[0]?.unread || 0,
      bin: binned.results?.[0]?.n || 0,
    },
    bin_days: BIN_DAYS,
    sites: (sites.results || []).map(s => ({ site: s.site, label: siteLabel(s.site), n: s.n })),
    team: team.results || [],
    unread: unread.results?.[0]?.n || 0,
    server_now: nowRow.results?.[0]?.now || null,
    recent_inbound: recent.results || [],
    labels: { types: TYPES, statuses: STATUSES },
  }, { headers: { 'Cache-Control': 'no-store' } });
}
