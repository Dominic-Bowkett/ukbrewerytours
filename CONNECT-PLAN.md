# Team payment requests via Stripe Connect — plan

Team members with their own Stripe Connect accounts log in, raise a payment
request for a client (tour, date, amount, terms), and the client gets an email
linking to a branded page that explains the booking and leads to Stripe
Checkout. The charge is a **direct charge on the team member's account** — in
their name and their liability — with a platform fee (20% by default) to
UK Brewery Tours.

Nothing here is built yet. This is for review before any code is written.

---

## What's already in place

Checked against the live Stripe account on 2026-08-05:

- Connect is enabled; `platform_payments` is active on the platform account.
- **41 connected accounts**, of which **30 are charge-ready**.
- Mix of `standard` (majority), `express` and a few `custom`; all GB / GBP.
- Almost none have `business_profile.name` set, so the admin list has to fall
  back to email, and a friendly label needs storing on our side.

### First account, verified

`acct_1IpYpgJ48IaKbIcX` — Alehunters Ltd, `hello@alehunters.co.uk`, Standard,
GB/GBP, `charges_enabled=true`, with `card_payments` and `platform_payments`
active.

The direct-charge call shape was probed against this account: Stripe accepted
the `Stripe-Account` header and `payment_intent_data[application_fee_amount]`,
rejecting only a deliberately-zero amount. So the mechanism works here — no
session was created and nothing was charged.

Reused as-is: D1, the admin session/auth pattern, `_lib/stripe.js`,
`_lib/email.js`, and the Resend sender.

---

## Decisions taken

| Question | Decision |
|---|---|
| Connect onboarding | Not needed — accounts already exist. Admin picks from the live list. |
| Team login | **Separate** logins per team member, in their own area. No access to the voucher admin. |
| Client experience | **Branded page first** (tour, date, amount, terms), then Stripe Checkout. |
| Charge type | **Direct charge** on the connected account, `application_fee_amount` to the platform. |
| Default platform fee | **20% included**, overridable per team member and per request by admin. |
| First account | **Alehunters Ltd** only (`acct_1IpYpgJ48IaKbIcX`) — the other 40 stay untouched. |
| Emails to Alehunters | **None during setup.** All test mail goes to Dom. |

### Fee is included, not added

A £100 tour means the client pays **£100**. Alehunters receives £80 minus
Stripe's processing fee (Standard accounts bear that), and £20 goes to the
platform as `application_fee_amount`. The client never sees a separate fee.

---

## Roles and areas

Three separate areas, three separate logins:

| Area | Who | Can do |
|---|---|---|
| `/admin/` | You | Everything: vouchers, refunds, plus the new Connect settings — link accounts to team members, set fee %, see every request |
| `/team/` | Team members | Their own connected account only: raise requests, see their own clients and payment history. **No** voucher admin, no other members' data |
| `/pay/<token>` | Clients | Public, unguessable link: view the booking and pay |

Team logins are a **separate table** from `admin_users` and a separate cookie,
so a team session can never satisfy an admin route even if something is
misconfigured.

---

## Data model (migration `0004_connect.sql`)

```sql
team_members
  id, email UNIQUE, name, password_hash, password_salt, iterations,
  stripe_account_id,            -- acct_… chosen by admin from the live list
  fee_percent,                  -- NULL = use platform default (20)
  active, created_at, last_login_at

payment_requests
  id, public_token UNIQUE,      -- HMAC-derived, what the client link carries
  team_member_id,
  client_name, client_email,
  tour_name, tour_date, tour_details,   -- shown on the client page
  amount_pence, currency DEFAULT 'GBP',
  fee_percent, fee_pence,       -- resolved at send time, stored for the record
  terms_snapshot,               -- terms as they were when sent
  status,                       -- draft | scheduled | sent | viewed | paid | cancelled | expired
  send_at,                      -- when to send (NULL = immediately)
  send_rule,                    -- e.g. 'days_before_event:14', for the audit trail
  sent_at, viewed_at, paid_at,
  stripe_checkout_session_id, stripe_payment_intent, stripe_account_id,
  created_at

payment_request_events           -- audit trail
  id, payment_request_id, type, detail, created_at

platform_settings                -- single row
  default_fee_percent DEFAULT 20,
  default_terms,                 -- admin-editable, snapshotted onto each request
  updated_at
```

`fee_percent` resolves as: request override → team member → platform default.
Resolved **once at send time** and stored, so changing the default later never
rewrites the terms of a request a client has already received.

---

## Endpoints

```
functions/api/team/
  login.js, logout.js, me.js        team session (separate cookie from admin)
  _middleware.js                    gate — team only
  requests.js                       GET list (own only) · POST create
  requests/[id].js                  GET detail · PATCH edit · DELETE cancel
  requests/[id]/send.js             POST send now (or re-send)
  clients.js                        GET distinct clients, for repeat requests

functions/api/admin/
  connect-accounts.js               GET live Stripe accounts (searchable)
  team.js                           GET list · POST create member (assign account + fee)
  team/[id].js                      PATCH edit · DELETE deactivate
  settings.js                       GET/PATCH default fee % and default terms
  payment-requests.js               GET every request across the team

functions/api/
  pay/[token].js                    GET public booking data for the client page
  pay/[token]/checkout.js           POST create the Checkout Session → returns URL
  stripe-connect-webhook.js         separate endpoint for connected-account events
```

### The direct charge

```js
// on the connected account, in their name and liability
fetch('https://api.stripe.com/v1/checkout/sessions', {
  headers: {
    Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
    'Stripe-Account': req.stripe_account_id,          // <- direct charge
  },
  body: params({
    mode: 'payment',
    'line_items[0][price_data][currency]': 'gbp',
    'line_items[0][price_data][unit_amount]': amountPence,
    'line_items[0][price_data][product_data][name]': tourName,
    'line_items[0][quantity]': 1,
    'payment_intent_data[application_fee_amount]': feePence,   // <- platform cut
    success_url, cancel_url,
    'metadata[payment_request_id]': req.id,
  }),
});
```

Because the charge lives on the connected account, its webhooks arrive with an
`account` field — hence a **separate webhook endpoint** with Connect events
enabled, rather than overloading the voucher one.

---

## Scheduling

You asked for send-now, send-at-a-date, and send-N-days-before-the-event. A
scheduled request is stored with `status='scheduled'` and a resolved `send_at`
timestamp (for the N-days rule, computed from `tour_date` at save time and
recomputed if the date is edited).

A **Cloudflare Cron Trigger** runs every 15 minutes, claims anything due, sends
it, and flips it to `sent`. Claiming uses a conditional update
(`WHERE status='scheduled' AND send_at <= now`) so two overlapping runs can't
double-send — the same guard already used for voucher redemptions.

> Cron Triggers on Pages need a small Worker alongside the Pages project (Pages
> Functions alone don't take cron). It's a thin scheduled Worker bound to the
> same D1. Worth flagging as the one piece of new infrastructure.

---

## Client experience

1. Email from `info@ukbrewerytours.com` — who it's from, the tour, date, amount,
   and a **View and pay** button.
2. `/pay/<token>` — branded page: tour name, date, what's included, the amount,
   the terms as sent, and who to contact. One clear **Pay now** button.
3. Stripe Checkout on the connected account (their business name on the
   statement).
4. Back to a thank-you page; the team member and client both get a receipt, and
   the request flips to `paid`.

The token is an HMAC of the request id — unguessable, and the page 404s for
anything cancelled or already paid rather than allowing a second charge.

---

## Security

- Separate table, separate cookie, separate middleware for team vs admin.
- Every team query is scoped by `team_member_id` from the session — a member
  cannot read or send for another's account even by guessing ids.
- `stripe_account_id` is set **by admin only**; a team member can never change
  which account they charge on.
- Fee percent bounded 0–100 server-side and resolved at send time.
- Public pay endpoint returns only what the page renders — no emails, no ids,
  `no-store`.
- Amount is fixed server-side from the stored request; the client page cannot
  influence what is charged.
- Rate limit on the public endpoints, as with the contact form.

---

## Build order

1. **Migration + admin Connect list** — see and search the 41 accounts, mark which
   are team members (read-only, proves the Stripe wiring before anything moves money).
2. **Team members + logins** — admin creates a member, assigns an account and fee,
   generated password shown once.
3. **Team area** — login, dashboard, create a request (no sending yet).
4. **Client page + direct-charge checkout** — the money path, tested end to end
   in Stripe **test mode** before any live key is used.
5. **Emails** — request to client, receipts, team notifications.
6. **Scheduling** — the cron Worker and the N-days-before rule.
7. **Admin oversight** — all requests across the team, fee overrides, default terms.

Each step is deployable on its own; nothing touches the existing voucher flow.

---

## Still open

1. **Refunds on connected accounts** — team members able to refund their own
   payments, or admin only? (Refunding a direct charge reverses the platform fee
   too unless told otherwise.) Assuming **admin only** for now, as the safer default.
2. **Terms** — one default set for everyone, or per team member? Building one
   editable default, snapshotted onto each request.
3. **Deposits / part payments** — repeat requests to the same client: independent
   requests, or linked as "deposit + balance" on one booking? Building them
   independent, with the client's details remembered for quick re-use.

None of these block the first three build steps.

## Testing without emailing Alehunters

The build uses Stripe **test mode** throughout, and every email during setup
goes to Dom, never to `hello@alehunters.co.uk`. The team-member record is
created with a password handed over directly rather than emailed. A suppression
check in the send path keeps that guarantee even if a code path is missed.
