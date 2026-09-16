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
- **They never see the customer's email address.** `/api/team/inbox*` doesn't select
  it; message bodies, list snippets and voucher holder records are scrubbed of that
  one address (`hideEmails()` masks the customer's own address only — one they typed
  for someone else is content and stays); their search doesn't match the email column,
  which would otherwise confirm an address by guessing; and the alert and assignment
  emails they receive show the phone number instead. What they get instead is
  **click-to-call**: a Call button beside the name and a tappable number on each list
  row. The admin has the same Call button and still sees the address.
- **Take it back:** set the dropdown to "Not assigned". **Remove access:** Team access →
  Remove access — their session is cut immediately (`session_epoch` bump) and any
  conversations they held stay put for you to reassign.

Scope is enforced server-side: every `/api/team/inbox*` query binds `assigned_to` to the
session's member id (`functions/api/team/inbox/*`), and the team gate additionally
requires `inbox_access = 1`. There is no parameter that widens it.

## Phone calls (no email address)

A caller often leaves only a number, so `enquiries.email` is empty. On those
conversations the composer is **notes-only** in both the admin and the team
portal: the Reply tab is replaced by "No email address — call them back", Notes
opens selected, and the Call button sits beside the name. Both reply endpoints
refuse with the same message (naming the number), and the team API exposes
`can_email` — a boolean, never the address — so the portal knows without being
told who the customer is. Opening a different conversation resets the composer
to Reply. **Notes work on every conversation**, for the admin and the assigned
team member, whether or not a reply is possible.

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

## Customer replies by email (per-conversation reply addresses)

Every outbound email's Reply-To is that conversation's own address —
`reply-<token>@<INBOUND_REPLY_DOMAIN>` (`replyAddress()` in `_lib/inbox.js`) — so a
reply names its own thread and needs no guesswork. Unset `INBOUND_REPLY_DOMAIN` and
Reply-To falls back to info@; nothing breaks, replies just stop coming back in.

`POST /api/inbound-email` is Resend's `email.received` webhook:
Svix-signed (`INBOUND_WEBHOOK_SECRET`, 5-minute replay window), fetches the body from
`GET /emails/receiving/{id}`, trims the quoted history, and then:
1. **token in the recipient** → that conversation;
2. **no token, known sender** → their most recent conversation of the last 90 days;
3. **otherwise** → a new conversation (channel `email`, type guessed from the subject).
Retries dedupe on `message_id` (stored in `enquiry_messages.email_id`). Machine-written
mail becomes a **notification** instead (see below). Alerts then follow the normal rules
(assignee, else admin).

**LIVE since 16 Sep 2026.** As configured:
- Resend domain `reply.ukbrewerytours.com` (id `1f42835a-b40a-4ab7-9777-a563fa14c0a5`),
  **receive-only** — capabilities `{sending: disabled, receiving: enabled}`. DNS on the
  ukbrewerytours.com zone: `reply` MX → `inbound-smtp.eu-west-1.amazonaws.com` (prio 10,
  verified) plus the DKIM TXT `resend._domainkey.reply`. The apex keeps its Google
  Workspace MX — never enable Cloudflare Email Routing on the apex.
- Resend webhook `c39e3c7a-…` → `https://www.ukbrewerytours.com/api/inbound-email`,
  event `email.received`.
- Pages secrets: `INBOUND_WEBHOOK_SECRET` (the webhook's signing secret),
  `INBOUND_API_KEY` (a full-access Resend key named `ukbrewerytours-inbound`;
  reading a *received* email needs more than sending access), and
  `INBOUND_REPLY_DOMAIN=reply.ukbrewerytours.com`. Pages applies variables at deploy
  time, so a push is needed after changing them.

Two things that cost time and will again:
- **Signing-secret whitespace.** Piping a secret into `wrangler pages secret put` can
  append a newline, which decodes to a different key and fails every signature.
  `verifySvix` now trims, but store it clean.
- **Header names.** Svix sends `svix-id/-timestamp/-signature` OR the standard
  `webhook-*` pair; both are accepted.
- The domain reads "pending" in Resend because the DKIM record belongs to sending,
  which is disabled here. Receiving only needs the MX, which is verified — this is
  expected, not a fault.

## Notifications (machine-written mail)

Most of what arrives at info@ is written by a machine: Stripe receipts,
DesignMyNight bookings, Google security notices, bounces, out-of-office replies.
None of it is a customer waiting for an answer, so it is filed away rather than
answered — and rather than deleted, because the one you want back is always the
one that was thrown away.

`notificationReason()` in `_lib/inbound.js` returns a short human reason
("automated mail from stripe.com", "a no-reply sender", "bulk mail") or null when
a person wrote it. It matches a sender list — narrow on purpose, and it must
never contain gmail/outlook/yahoo, which is where customers write from — plus the
familiar headers (`Auto-Submitted`, `Precedence`, `List-Unsubscribe`) and
no-reply-ish local parts. `NOTIFICATION_SENDERS` (comma-separated domains) adds
to the list without a deploy.

What that means in practice:
- `enquiries.is_notification` = 1, with the reason in `notification_reason`.
- It never appears in the inbox, never counts towards the badge, never fires an
  alert email or a browser notification, and is invisible to every team member
  (`is_notification = 0` is on every team query, not just on assignment).
- The admin's **Notifications** tab lists them, searchable by subject — the way
  you actually remember one. **Move into the inbox** promotes a wrong guess;
  **File away** on any conversation does the reverse, taking it off a team
  member's desk as it goes.
- Automated mail addressed to a conversation's own reply address — an
  out-of-office, a bounce — is filed *on that conversation* instead, quietly:
  `appendCustomerMessage(..., { silent: true })` leaves the status, the unread
  flag and the alert clock alone.

### Routing info@ into the helpdesk

Decided 16 Sep 2026: keep a Gmail copy for now, and file automated mail under
Notifications. The receiving side is already live, so what remains is one setting
in Gmail, on the info@ mailbox:

1. **Settings → Forwarding and POP/IMAP → Add a forwarding address** →
   `info@reply.ukbrewerytours.com`.
2. Google emails a confirmation code to that address. It arrives here as a
   **notification** (it is from `forwarding-noreply@google.com`) — find it under
   the Notifications tab, subject "Gmail Forwarding Confirmation".
3. Back in Gmail, enter the code, then choose **Forward a copy of incoming mail
   to … and keep Gmail's copy in the Inbox.**

Everything then lands in both places. Once the helpdesk has proved itself, change
that last setting to "archive Gmail's copy" and info@ lives here alone. dom@ is
untouched either way and stays on Gmail.

## Emailing someone first (admin only)

**✉️ New email** in the inbox opens a composer: To (several addresses allowed),
Cc, Bcc, Subject, message, and a Reply-to override. `POST /api/admin/compose`
sends it and starts a conversation, so the reply comes back to the thread like
any other — that is the point of it, rather than emailing from Gmail and losing
the thread. The Reply-to override exists for handing something to another
mailbox; fill it in and the reply goes there and never reaches the inbox, which
the field says out loud. Cc, Bcc and any extra recipients are recorded as a
timeline event, because the email itself does not show them.

The **Contacts** button is the address book behind it: `contacts`, one card per
address (the unique index is on `lower(email)`), searchable by name, company,
email or phone, with `last_emailed_at` stamped on every send. Saving the same
address again merges into the existing card and never blanks what it already
knew. Admin only — `/api/admin/*` is behind the admin session, and nothing in the
team portal reads or writes it.

## A team member's addresses

Three different things, deliberately separate:
- **login email** — `team_members.email`, just a username (london@ukbrewerytours.com
  has no mailbox);
- **inbox_from_email** — what customers see their replies coming from; must be on a
  Resend-verified domain, needs no mailbox;
- **notify_email** — where that member's own alerts and assignments are sent; must be
  a real mailbox (falls back to the login email when null).

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
- `migrations/0013_inbound_email.sql` — `team_members.notify_email`, the email-id index
- `migrations/0014_notifications_contacts.sql` — `enquiries.is_notification/notification_reason`,
  the `contacts` table
- `functions/api/admin/compose.js`, `functions/api/admin/contacts/*`,
  `functions/_lib/contacts.js` — emailing out, and the address book
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
hour (`CONTACT_MAX_PER_HOUR` overrides it — set it high locally, since every local
request shares the IP "unknown"). `.dev.vars` changes need a dev-server restart.
