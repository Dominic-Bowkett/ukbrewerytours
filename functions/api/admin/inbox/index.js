// GET /api/admin/inbox — the conversation list, with per-status and per-type counts.
// Query: status (open|new|dealing|waiting|closed|all), type, site, q, page

import { TYPES, STATUSES, siteLabel } from '../../../_lib/inbox.js';

const PAGE_SIZE = 30;

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const status = url.searchParams.get('status') || 'open';
  const type = url.searchParams.get('type') || '';
  const site = url.searchParams.get('site') || '';
  const q = (url.searchParams.get('q') || '').trim().slice(0, 100);
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);

  // Filters other than status/type, shared by the list and both count queries.
  const base = [];
  const baseArgs = [];
  if (site) { base.push('e.site = ?'); baseArgs.push(site); }
  if (q) {
    const like = `%${q.replace(/[%_]/g, m => '\\' + m)}%`;
    base.push(`(e.name LIKE ? ESCAPE '\\' OR e.email LIKE ? ESCAPE '\\' OR e.voucher_code LIKE ? ESCAPE '\\' OR e.phone LIKE ? ESCAPE '\\'
      OR e.id IN (SELECT enquiry_id FROM enquiry_messages WHERE body LIKE ? ESCAPE '\\')${/^\d+$/.test(q) ? ' OR e.id = ?' : ''})`);
    baseArgs.push(like, like, like, like, like);
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
           e.created_at, e.last_message_at,
           (SELECT substr(body, 1, 160) FROM enquiry_messages m WHERE m.enquiry_id = e.id AND m.direction IN ('in','out') ORDER BY m.id DESC LIMIT 1) AS snippet,
           (SELECT direction FROM enquiry_messages m WHERE m.enquiry_id = e.id AND m.direction IN ('in','out') ORDER BY m.id DESC LIMIT 1) AS last_direction,
           (SELECT COUNT(*) FROM enquiry_messages m WHERE m.enquiry_id = e.id AND m.direction IN ('in','out')) AS message_count
      FROM enquiries e
      ${where(base, statusClause, typeClause)}
     ORDER BY COALESCE(e.last_message_at, e.created_at) DESC, e.id DESC
     LIMIT ? OFFSET ?`;

  const [list, byStatus, byType, sites, unread] = await env.DB.batch([
    env.DB.prepare(listSql).bind(...baseArgs, ...statusArgs, ...typeArgs, PAGE_SIZE + 1, (page - 1) * PAGE_SIZE),
    env.DB.prepare(`SELECT e.status, COUNT(*) AS n, SUM(e.unread) AS unread FROM enquiries e ${where(base, typeClause)} GROUP BY e.status`)
      .bind(...baseArgs, ...typeArgs),
    env.DB.prepare(`SELECT e.type, COUNT(*) AS n FROM enquiries e ${where(base, statusClause)} GROUP BY e.type`)
      .bind(...baseArgs, ...statusArgs),
    env.DB.prepare('SELECT site, COUNT(*) AS n FROM enquiries GROUP BY site ORDER BY n DESC'),
    env.DB.prepare("SELECT COUNT(*) AS n FROM enquiries WHERE unread = 1 AND status != 'closed'"),
  ]);

  const rows = list.results || [];
  const statusCounts = { open: 0, all: 0, unread_open: 0 };
  for (const r of byStatus.results || []) {
    statusCounts[r.status] = r.n;
    statusCounts.all += r.n;
    if (r.status !== 'closed') { statusCounts.open += r.n; statusCounts.unread_open += r.unread || 0; }
  }

  return Response.json({
    enquiries: rows.slice(0, PAGE_SIZE).map(r => ({ ...r, site_label: siteLabel(r.site) })),
    hasMore: rows.length > PAGE_SIZE,
    counts: {
      status: statusCounts,
      type: Object.fromEntries((byType.results || []).map(r => [r.type, r.n])),
    },
    sites: (sites.results || []).map(s => ({ site: s.site, label: siteLabel(s.site), n: s.n })),
    unread: unread.results?.[0]?.n || 0,
    labels: { types: TYPES, statuses: STATUSES },
  }, { headers: { 'Cache-Control': 'no-store' } });
}
