# Connect design review — findings

Before writing any code, three designs (schema, team auth, money path) were each
attacked from three angles: a payments auditor, a penetration tester, and an
on-call engineer. **91 flaws were raised — 17 critical, 36 high.**

They are worth reading because several would have taken or lost real money on a
third party's Stripe account.

---

## The ones that would have cost money

**Double charge from two tabs.** The design stored one `stripe_checkout_session_id`
per request. Two tabs (or a forwarded link opened at the same moment) mint two
Checkout Sessions; the column keeps only the second. The client can pay both, and
the webhook for the first finds no matching row — so one real charge is invisible:
no receipt, no refund trail, and the *member* carries the liability.
→ Sessions move to their own table so any session id resolves to a request, plus
a single-flight claim and a Stripe idempotency key.

**Payments silently discarded.** The mark-paid guard was
`WHERE status IN ('sent','sending')`. If a request expires or is cancelled while
the client is in Checkout — 3-D Secure takes a minute — the payment lands, the
UPDATE matches zero rows, and the handler returns 200. Money on the connected
account, no record anywhere. And because the row was never marked paid, the client
can later be charged again.
→ Guard widens to `NOT IN ('paid','refunded')`, out-of-band arrivals are flagged
for triage, and zero-rows-changed becomes an alert rather than a shrug.

**Cancel didn't cancel.** Nothing expired the Stripe session, so a withdrawn
request stayed payable from the link the client already had.
→ Cancel and expiry now call Stripe's session-expire endpoint first.

**Refunds kept the platform's 20%.** A full refund returned £100 to the client but
the platform retained its £20 fee — taken out of the member's pocket, on a booking
that earned nothing. There was no fee-reversal field at all, and the existing
`createRefund()` doesn't send a `Stripe-Account` header, so it would 404 against a
connected-account payment anyway.
→ Fee reversal recorded and defaulted on, `createRefund()` extended for Connect.

**Zero-fee settlement.** The webhook's metadata fallback accepted any session
carrying the right id. A connected account could mint its own 30p session with
forged metadata and mark its own request paid — with no platform fee.
→ The fallback now requires matching account, amount, currency *and* expected fee.

**Webhook retries swallowed forever.** Dedupe inserted the event row *before* doing
the work. A crash in between meant every Stripe retry for three days saw the row,
did nothing, and returned 200.
→ Dedupe becomes a completion marker (`processed_at`), matching the two-flag
pattern already used for vouchers.

---

## The ones that would have broken access control

**Team session satisfying the admin gate.** Separation rested on two env vars
differing and a cookie name. No audience claim in the token.
→ An `aud` claim inside the signed payload, verified on every route.

**Stored XSS in the admin dashboard.** Team-supplied strings rendered unescaped in
admin — a team→admin escalation that defeats every cookie separation.

**SQL injection via the helper meant to prevent it.** The proposed `ownedUpdate()`
interpolated caller-supplied SET/guard fragments with no column allowlist.
→ Explicit parameterised statements per purpose; no generic SQL-fragment helper.

**No revocation.** Deactivating a member left their token valid for 12 hours, and
their outstanding pay links kept charging money to their account.
→ `token_version` bumped on deactivate/password change, verified per request.

---

## The ones that simply wouldn't have worked

**`/pay/<token>` would 404.** `docs/_routes.json` routes only `/api/*` to Functions.

**Scheduled sends would never fire.** Pages Functions cannot receive cron triggers
at all — this needs a separate scheduled Worker bound to the same D1.

**Two colliding `0004_` migrations.** `CREATE TABLE IF NOT EXISTS` would silently
no-op and every query would hit missing columns mid-payment.

**`send_at` sort order.** Stored as ISO-8601 with a `T`, it sorts above
`datetime('now')` output, so nothing due would ever be selected.

---

## What this changes about the build

The first three steps in `CONNECT-PLAN.md` stand, but the money path now has a
materially different shape: a sessions child table, single-flight session
creation, fee-reversal accounting, and a webhook that verifies account, amount,
currency and fee before trusting anything.

Everything is still built and tested in **Stripe test mode** before a live key is
used, and no email goes to Alehunters at any point.
