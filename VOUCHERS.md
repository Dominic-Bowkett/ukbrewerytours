# In-house gift vouchers — setup & operations

Replaces GiftUp with our own Stripe Checkout flow, so there are no per-voucher
platform fees. Vouchers are emailed as branded HTML with a unique code, never
expire, and are redeemed (fully or partially) from `/admin/`.

Runs entirely on the **Cloudflare free tier** — no npm packages ship to
production (Stripe and Resend are plain `fetch` calls; hashing and signature
checks use Web Crypto), so nothing comes close to the 10 ms CPU limit.

**Nothing on the public site has changed yet.** The GiftUp widget is still live
everywhere. The new flow is only on the hidden demo page until you sign it off —
see [Going live](#7-going-live).

---

## What was added

| Path | Purpose |
|---|---|
| `functions/api/create-checkout.js` | Validates the form, reserves codes, opens Stripe Checkout |
| `functions/api/stripe-webhook.js` | Confirms payment, activates codes, sends the emails |
| `functions/api/my-vouchers.js` | Token-secured voucher data for the printable page |
| `functions/api/admin/*` | Login, session gate, voucher list/detail/redeem/refund |
| `functions/_lib/*` | Shared helpers: codes, auth, Stripe, email templates |
| `migrations/0001_initial.sql` | D1 schema (`orders`, `vouchers`, `redemptions`, `admin_users`) |
| `admin/` | Admin dashboard + login page (copied to `docs/admin/` at build) |
| `templates/voucher-modal.html` | The buy-a-voucher form |
| `assets/js/voucher.js` | Form behaviour: prefill, stepper, totals, checkout |
| `pages/demo-gift-voucher.html` | Hidden test page (`/demo/gift-voucher/`) |
| `pages/voucher-thank-you.html` | Post-payment landing page |
| `pages/my-vouchers.html` + `assets/js/voucher-print.js` | Printable A4 vouchers, one per page |
| `scripts/create-admin.mjs` | Generates admin logins |

---

## Setup status

| Step | Status |
|---|---|
| D1 database created (`638775d1-…`, region WEUR) + bound in `wrangler.toml` | ✅ done |
| Tables created in production | ✅ done |
| Admin login for `info@ukbrewerytours.com` | ✅ done |
| `ADMIN_SESSION_SECRET`, `FROM_EMAIL` set | ✅ done |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY` | ⬜ **you** — steps 1–3 below |
| Stripe webhook endpoint registered | ⬜ **you** — step 2 |
| Resend domain verified | ⬜ **you** — step 3 |

Cloudflare account: `info@dominicbowkett.com` (`e2bdf844902d43c877a78ddd56a4e5ad`),
Pages project `ukbrewerytours`.

---

## 1. Add the Stripe secret key

Stripe → **Developers → API keys** → copy the **Secret key** (`sk_live_…`).
Never paste it into a chat window or commit it. Set it with:

```bash
npx wrangler pages secret put STRIPE_SECRET_KEY --project-name=ukbrewerytours
```

It prompts for the value without echoing it. (Or use the dashboard:
**Workers & Pages → ukbrewerytours → Settings → Variables and Secrets**,
type **Secret**, environment **Production**.)

## 2. Register the Stripe webhook

Stripe → **Developers → Webhooks → Add endpoint**

- **URL:** `https://www.ukbrewerytours.com/api/stripe-webhook`
- **Event:** `checkout.session.completed` (that one only)

Copy the **Signing secret** it shows (`whsec_…`), then:

```bash
npx wrangler pages secret put STRIPE_WEBHOOK_SECRET --project-name=ukbrewerytours
```

> Without this, payments succeed but no voucher email is ever sent.

## 3. Resend: verify the domain, then add the key

Resend → **Domains → Add domain** → `ukbrewerytours.com`, then add the DNS
records it gives you in Cloudflare DNS. Until verified, Resend refuses to send
from `info@ukbrewerytours.com`.

Then Resend → **API Keys** → create one (`re_…`) and:

```bash
npx wrangler pages secret put RESEND_API_KEY --project-name=ukbrewerytours
```

## Re-issuing an admin password

```bash
node scripts/create-admin.mjs info@ukbrewerytours.com
```

Prints a new password **once** and the `wrangler d1 execute …` command to apply
it. Pass a second argument to choose your own. Add another admin by using a
different email.

## Where the voucher form appears

GiftUp has been fully removed. The in-house form is live everywhere: the modal
is injected into every page by `templates/layout.html` (`voucherEverywhere` in
`build.js`), and any control with `data-voucher-open` opens it.

Tour and experience pages carry `data-tour-name`, `data-tour-price` and
`data-tour-slug` on their button, so the amount prefills with that tour's
per-person price and the gift message is pre-written recommending it. Generic
buttons (home, gift vouchers, contact) open the same form with a blank amount.

Tours with no price simply leave the amount empty for the buyer to fill in.

## Embeddable widgets — sell vouchers and take enquiries on OTHER websites

**Admin → Voucher widgets** creates widgets you can paste into any site
(Bristol Brewery Tours, London Brewery Tours, a partner's blog). Two kinds:

- **Gift vouchers** — a self-contained voucher shop; sales go through the
  normal Stripe flow below. Supports an admin-set **suggested gift message**,
  prefilled into the message box for the buyer to edit.
- **Contact form** — name/email/message; submissions email
  `info@ukbrewerytours.com` (reply-to the sender) through the same
  `/api/contact` endpoint as the site's own form: honeypot, per-IP rate limit,
  logged to `enquiries` with `widget_id`/`widget_origin`, auto-reply to the
  sender. The subject line names the widget ("Enquiry via Bristol …").

Each widget has its own embed code:

```html
<div data-ubt-widget="wgt_XXXXXXXXXX"></div>
<script async src="https://www.ukbrewerytours.com/embed/widget.js"></script>
```

(`data-ubt-voucher` + `/embed/voucher.js` are the original voucher-only names —
both still work; the two loader files are identical copies.)

How it works: the loader script injects an iframe of `/embed/widget/<id>`
(rendered by `functions/embed/widget/[id].js` from the `widgets` D1 table).
Because the iframe is ours, its call to `/api/create-checkout` is same-origin —
the host site needs no CORS and never touches the payment. Stripe won't run
inside an iframe, so the checkout URL is posted up to the loader, which
navigates the host page; cancelling returns the customer to the page they were
on. The iframe reports its height so it never scrolls internally.

Per widget you control: the internal name (which site it's for), customer-facing
heading and intro line, accent colour, preset amounts, whether a custom amount
is allowed (presets are enforced server-side when not), and an optional list of
sites allowed to embed it (`frame-ancestors` CSP — blank = anywhere). Pausing a
widget swaps it for a polite "temporarily unavailable" card and blocks checkout;
deleting kills the embed for good (past sales are unaffected).

Sales are ordinary UK Brewery Tours vouchers: same codes, same emails, same
redemption screen. The order records `widget_id` + `widget_origin`, the sale
notification email says which widget/site it came from, and the admin voucher
detail shows "Sold via widget". Widget sales totals are on the Voucher widgets
tab.

## Sale notifications

Every completed sale emails `info@ukbrewerytours.com` with the amount, buyer,
delivery details, the tour page it came from, the codes issued and a link
straight into the admin. Set `NOTIFY_EMAIL` to send elsewhere.

It is sent after the customer's emails and failures are swallowed, so a problem
with the internal notification can never affect the customer or trigger a
resend.

---

## Running it locally

```bash
npm run dev
```

Serves on `http://localhost:8788` with a local database — no real charges.
Local secrets live in `.dev.vars` (gitignored). To exercise a real payment
locally, use Stripe test keys and forward webhooks:

```bash
stripe listen --forward-to localhost:8788/api/stripe-webhook
```

---

## Day-to-day: redeeming a voucher

1. Go to **https://www.ukbrewerytours.com/admin/** and sign in.
2. Search the code (or the customer's name/email).
3. **View** → either:
   - enter an amount and **Redeem amount** — partial, balance stays on the code; or
   - **Redeem full £X** — clears the remaining balance.
4. Add a note (e.g. "Bristol tour, 12 Aug") so the history is readable later.

Every redemption is logged with the amount, resulting balance, your email and
the note. A voucher can be part-redeemed any number of times until it hits £0.

**Voucher codes** look like `UBT-K7M2-P9WR`. They're case-insensitive and the
dashes are optional when searching. The alphabet excludes `I`, `O`, `0` and `1`
so codes are unambiguous over the phone.

## Refunding a voucher

Same screen, the red **Refund** panel below Redeem. Enter an amount (or
**Refund full £X**), pick a reason, add a note, and confirm.

This calls Stripe and puts the money back on the card the customer paid with —
it takes 5–10 days to reach their statement. The refunded value is taken off
the voucher balance at the same time, so a refunded voucher can't still be
spent on a tour. Refund history is logged alongside redemptions.

- Partial refunds are fine, and can be repeated up to the original amount.
- Refunding is blocked on unpaid vouchers and on anything already fully refunded.
- If Stripe rejects the refund, nothing is written locally — the voucher is
  left exactly as it was.

## Printable vouchers

**The email is the voucher.** It contains the code and is all a customer needs
to book — nothing is posted, and no PDF is attached.

The email also carries a **Print or save as PDF** button linking to
`/my-vouchers/`, where they can print or use their browser's "Save as PDF".
Each voucher renders on its own A4 page, and when an order has several the
customer can tick which ones to include.

That page is secured by a signed token in the link (an HMAC of the order id).
Without a valid token it returns 403, so codes can't be guessed or enumerated,
and unpaid orders never expose a code. The page returns no emails or payment
details and is marked `no-store` so no shared cache retains it.

Because the PDF is produced by the browser, none of this costs CPU on the
Cloudflare free tier.

---

## How the money flow works

1. Customer submits the form → `create-checkout` validates it (min **£10**,
   max £1000/voucher, max 20 vouchers), writes a `pending` order plus one
   `pending` voucher row per code, and returns a Stripe Checkout URL.
2. Customer pays on Stripe's hosted page.
3. Stripe calls `stripe-webhook`. The signature is verified (HMAC-SHA256 over
   the raw body, 5-minute replay window) before anything is trusted.
4. The order flips to `paid`, codes become `active`, then the voucher email
   goes to the recipient and a receipt to the buyer.

**Unpaid orders never produce a live code** — abandoned checkouts just leave
`pending` rows, which are hidden from the admin list by default.

**If email delivery fails**, the payment is still recorded and `email_sent`
stays `0`; the endpoint returns 500 so Stripe retries and only the email is
re-attempted. Nothing is ever double-sent, because a successful send flips
`email_sent` to `1` and later retries short-circuit.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Paid but no email | Check the Resend domain is verified, and that the webhook secret matches. Stripe → Webhooks shows failed deliveries and lets you resend. |
| "Payments are not configured yet." | `STRIPE_SECRET_KEY` is missing from the environment. |
| Admin login 503 | `ADMIN_SESSION_SECRET` is missing. |
| Signed out constantly | `ADMIN_SESSION_SECRET` changed, or sessions expired (12 h). |
| Voucher missing from admin | It's `pending` (never paid). Filter by "Unpaid / abandoned" to confirm. |
| Forgotten admin password | Re-run `scripts/create-admin.mjs` for the same email. |

To inspect the database directly:

```bash
npx wrangler d1 execute ukbrewerytours-vouchers --remote \
  --command "SELECT code, status, balance_pence FROM vouchers ORDER BY id DESC LIMIT 20"
```

---

## Refunds

Refund the payment in the Stripe dashboard, then void the code so it can't be
used:

```bash
npx wrangler d1 execute ukbrewerytours-vouchers --remote \
  --command "UPDATE vouchers SET status='void', balance_pence=0 WHERE code='UBT-XXXX-XXXX'"
```
