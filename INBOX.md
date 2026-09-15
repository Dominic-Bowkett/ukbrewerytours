# Enquiry inbox, live chat & voucher checking

Every way a customer gets in touch — on ukbrewerytours.com, londonbrewerytour.com
and bristolbrewerytours.com — lands in **Admin → Inbox** as a conversation.
WhatsApp is gone from all three sites; the live chat bubble replaced it.

## Where enquiries come from

| Source | Type it arrives as | Channel |
| --- | --- | --- |
| `/redeem/` form (UKBT) | Voucher redemption (code, tour, date sent as fields) | Website form |
| `/group-tours/#enquire` form (UKBT) | Group booking (city, size, dates, occasion) | Website form |
| `/contact/` form (UKBT) | Whatever the "What's it about?" select says | Website form |
| Embedded contact widgets (London `wgt_7YRU5N9CJG`, Bristol `wgt_M6FHAW5RHX`, others) | The widget's topic select, pre-guessed from the host page URL | Embedded form |
| Chat bubble on all three sites | The topic chip picked (Book a tour / Group booking / Redeem a voucher / Gift vouchers / Something else) | Live chat |
| Customer replying on `/messages/<token>` | — (adds to the existing conversation) | Messages page |

All of them post to `POST /api/contact` (first message) and `POST /api/thread`
(follow-ups). The site is recorded from the page URL (`site` = hostname without www).

## What happens on a new enquiry

1. Stored first (`enquiries` + `enquiry_messages`), so a failed email never loses it.
2. **Alert to `dom@ukbrewerytours.com`** (override with the `ALERT_EMAIL` Pages
   variable): type, site, message, contact details, a **voucher check** and an
   "Open & reply in admin" button → `/admin/#inbox/<id>`. If not signed in, the
   login page returns you to that conversation. Follow-up messages alert again,
   throttled to one email per conversation per 10 minutes (reset when you reply).
3. Confirmation to the customer with a **View your conversation** link.

## Working a conversation (Admin → Inbox)

- Filters: status chips (Open = everything not closed, New, Dealing with,
  Awaiting customer, Closed, All), type, website, and search (name, email, phone,
  voucher code, any message text).
- Status buttons at the top of a thread; type can be changed from the dropdown.
  Every change is logged on the timeline.
- **Reply** emails the customer from `FROM_EMAIL` (info@ukbrewerytours.com), quotes
  their last message, and includes a "Reply to this message" button to their
  conversation page. Choose what the status becomes afterwards (default Awaiting
  customer). Ctrl+Enter sends. Drafts are kept per conversation in the browser.
- **Internal note** is never shown or sent to the customer.
- A customer writing again reopens a closed/awaiting thread as *Dealing with* and
  marks it unread.
- **Delete (spam)** removes the conversation permanently — close real ones instead.
- The list refreshes every minute; the Inbox tab badge = unread open conversations.

## Assigning conversations to team members

The admin sees everything. A team member sees **only** what is assigned to them.

- **Give someone access:** Inbox → **Team access** → fill in name, login email and the
  address their replies go out from → a password is shown **once**. They sign in at
  `/team/`, are asked to set their own password, and land on **My messages**.
  (An inbox-only member has no Stripe account, so the Payments tab never appears.)
- **Assign:** open a conversation → the dropdown in the header (`Assign to …`). They get
  an email with a link straight to it, and it shows in their portal. Every assignment,
  reassignment and hand-back is logged on the timeline.
- **Alerts follow the assignment:** once assigned, new customer messages alert the
  assignee instead of `ALERT_EMAIL`. Unassigned conversations still alert the admin.
- **Their replies** go out from their own `inbox_from_email` (e.g. london@ukbrewerytours.com)
  with Reply-To the same; the admin's replies still go from info@. Everything is saved
  on the one conversation, so the admin sees exactly what the customer was told.
- **They can:** reply, add internal notes, change status, and see the voucher check
  (read-only). **They cannot:** see anything unassigned or assigned to someone else,
  assign, delete, redeem vouchers, or reach any admin route (`/api/admin/*` → 401).
- **Take it back:** set the dropdown to "Not assigned". **Remove access:** Team access →
  Remove access — their session is cut immediately (`session_epoch` bump) and any
  conversations they held stay put for you to reassign.

Scope is enforced server-side: every `/api/team/inbox*` query binds `assigned_to` to the
session's member id (`functions/api/team/inbox/*`), and the team gate additionally
requires `inbox_access = 1`. There is no parameter that widens it.

## Voucher check

Each conversation is scanned for codes: the explicit voucher code field (split on
`+ , & /` and "and"), any `UBT-XXXX-XXXX` in the text, and code-looking tokens.
They're looked up in **our vouchers** and in **imported codes** from other systems.
Matches show source, status, balance and holder with redeem controls; explicit
codes that match nothing are flagged. "Check a code" looks up anything by hand.

- UBT vouchers: Redeem amount / Redeem full → `POST /api/admin/redeem` with
  `enquiry_id`; the redemption is linked (`redemptions.enquiry_id`) and logged on
  the conversation timeline.
- Imported codes with a value: same, via `POST /api/admin/imported-voucher/:id`.
- Imported codes without a value ("tour for two"): Mark fully used / partly used /
  Reinstate.

## Codes from other voucher systems

Admin → Gift vouchers → **Codes from other systems → Import codes**. Name the
system, upload (or paste) a CSV, match its columns (code is the only required
one; value, balance, product, holder name/email, status, purchase and expiry
dates, notes are optional — the headers are auto-guessed), check the preview,
import. Money is read in pounds; dates UK-style (day first). A zero balance
imports as used. Codes are unique per source, so re-importing a file skips what's
already there. **Undo import** deletes a batch except codes that have been used.
Large files go up in 500-row chunks (the server takes the rows as one JSON
parameter because D1 caps bound parameters at 100).

## Live chat embed

```html
<script async src="https://www.ukbrewerytours.com/embed/chat.js" data-site="london"></script>
```

`data-site` = `ukbt` (default), `london` or `bristol` — branding only. Where it's installed:
UKBT `templates/layout.html`; London injected from `assets/js/main.js`; Bristol
`templates/layout.html`. Any element with `data-chat-open` (optionally
`data-chat-topic` and `data-chat-text`) opens the chat; the href is the no-JS
fallback. The iframe carries `data-ubt-chat="open|closed"` so a host can move the
closed bubble — London lifts it above the cookie banner, Bristol above the mobile
book bar.

The chat is an iframe of `/embed/chat/frame` (same-origin API calls, no CORS).
The conversation token lives in the iframe's localStorage (`ubt_chat_<site>`), so
a visitor sees their thread and team replies (polled every 12s while open, 60s
closed) on later visits. Replies are always emailed too.

## Customer replies by email — not routed yet

Reply-To on our emails is still `info@ukbrewerytours.com` (Google Workspace), so a
customer who hits Reply in their mail app reaches the info@ mailbox, **not** the
inbox. The emails steer people to the conversation page instead.

To bring email replies into conversations: route a subdomain (e.g.
`reply.ukbrewerytours.com`) to an inbound handler that looks up the token in
`reply-<token>@…` and calls `appendCustomerMessage`, then set the Pages variable
`INBOUND_REPLY_DOMAIN=reply.ukbrewerytours.com` — `replyAddress()` in
`functions/_lib/inbox.js` switches every Reply-To over. Do NOT enable Cloudflare
Email Routing on the apex: its MX records are Google Workspace's.

## Live updates

The open conversation polls `GET /api/admin/inbox/:id/updates?after=<id>&seen=1` every 4s
(20s while the tab is hidden — a covered window counts as hidden) and **appends** new
messages: the reply draft, caret and scroll position are never touched. Scrolled up, a
"New message" button appears instead of jumping. The list, counts and badge refresh every
15s; `?since=<server_now>` returns `recent_inbound`, which drives the in-page toast and the
optional browser notifications (bell button next to the search box). Drafts are kept per
conversation in localStorage. `build.js` stamps `/admin/` and `/team/` with a hash of their
files (`<meta name="admin-build">` + `version.json`), so a page left open across a deploy
offers a **Reload** bar rather than quietly running old code.

## Files

- `migrations/0011_inbox.sql` — inbox columns, `enquiry_messages`, `imported_vouchers`
  (+ redemptions), backfill (old enquiries arrive closed and read)
- `migrations/0012_inbox_assignment.sql` — `enquiries.assigned_to/at/by`,
  `team_members.inbox_access/inbox_from_email/inbox_from_name`
- `functions/api/team/inbox/*` — the team member's scoped API; `team/inbox.js` its UI
- `functions/_lib/inbox.js` — types/statuses, site detection, create/append, alerts, code matching
- `functions/_lib/chat-ui.js` — chat UI (frame + `/messages/` page)
- `functions/api/contact.js`, `functions/api/thread.js` — public endpoints
- `functions/api/admin/inbox/*`, `voucher-lookup.js`, `imported-vouchers.js`, `imported-voucher/[id].js`
- `admin/inbox.js`, `admin/imported.js` — admin UI (loaded deferred by `admin/index.html`)
- `embed/chat.js` — loader

## Local dev

`wrangler pages dev` here cannot reach Resend (the fetch hangs), so put
`EMAIL_DRY_RUN=1` (and `ALERT_EMAIL=delivered@resend.dev`) in `.dev.vars`; emails
are logged instead. The contact endpoint allows 5 new conversations per IP per
hour — local requests all share the IP "unknown".
