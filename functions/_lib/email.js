// Transactional email via the Resend REST API (no SDK).
// Emails are inline-styled: mail clients strip <style> blocks and external CSS.

import { formatMoney } from './codes.js';

const STOUT = '#201611';
const CREAM = '#f7f1e5';
const AMBER = '#e0932f';
const PAPER = '#fffcf5';
const INK_SOFT = '#6b5c4f';

const esc = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

export async function sendEmail(env, { to, subject, html, replyTo }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.FROM_EMAIL || 'UK Brewery Tours <info@ukbrewerytours.com>',
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
      ...(replyTo ? { reply_to: replyTo } : {}),
    }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
  return res.json();
}

function shell(inner) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:${CREAM};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CREAM};padding:24px 12px;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:${PAPER};border-radius:14px;overflow:hidden;font-family:'Segoe UI',Helvetica,Arial,sans-serif;color:${STOUT};">
      <tr><td style="background:${STOUT};padding:22px 28px;">
        <span style="color:${PAPER};font-size:19px;font-weight:700;letter-spacing:.2px;">🍺 UK Brewery Tours</span>
        <span style="color:${AMBER};font-size:12px;display:block;margin-top:3px;">Est. 2014</span>
      </td></tr>
      ${inner}
      <tr><td style="background:${CREAM};padding:20px 28px;font-size:12px;color:${INK_SOFT};line-height:1.6;">
        UK Brewery Tours ·
        <a href="mailto:info@ukbrewerytours.com" style="color:${INK_SOFT};">info@ukbrewerytours.com</a> ·
        <a href="https://www.ukbrewerytours.com" style="color:${INK_SOFT};">ukbrewerytours.com</a>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

/** The big amber-bordered ticket containing one voucher code. */
function voucherTicket(v) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px;border:2px dashed ${AMBER};border-radius:12px;background:${CREAM};">
  <tr><td align="center" style="padding:22px 18px;">
    <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:${INK_SOFT};">Gift voucher</div>
    <div style="font-size:34px;font-weight:700;margin:6px 0 12px;color:${STOUT};">${formatMoney(v.amount_pence)}</div>
    <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:${INK_SOFT};">Voucher code</div>
    <div style="font-family:'Courier New',monospace;font-size:25px;font-weight:700;letter-spacing:3px;margin-top:6px;color:${STOUT};">${esc(v.code)}</div>
  </td></tr>
</table>`;
}

const HOW_TO_REDEEM = `<div style="background:${CREAM};border-radius:10px;padding:16px 18px;margin:22px 0 0;font-size:14px;line-height:1.7;">
  <strong style="display:block;margin-bottom:6px;">How to redeem</strong>
  Browse tours at <a href="https://www.ukbrewerytours.com/tours/" style="color:#b3701d;">ukbrewerytours.com/tours</a>,
  then email <a href="mailto:info@ukbrewerytours.com" style="color:#b3701d;">info@ukbrewerytours.com</a>
  or message us on WhatsApp with your voucher code to book a date.
  <div style="margin-top:8px;color:${INK_SOFT};">Vouchers never expire and can be used across multiple bookings until the balance runs out.</div>
</div>`;

/** Button linking to the printable version — the email itself is the voucher. */
function printBlock(printUrl, count) {
  if (!printUrl) return '';
  return `<div style="text-align:center;margin:26px 0 0;">
    <a href="${printUrl}" style="display:inline-block;background:${AMBER};color:#2b1a05;text-decoration:none;font-weight:600;padding:13px 26px;border-radius:999px;font-size:15px;">
      Print or save as PDF
    </a>
    <div style="font-size:13px;color:${INK_SOFT};margin-top:10px;line-height:1.6;">
      This email is your voucher — the code above is all you need to book.
      Use the button if you'd like a printed copy${count > 1 ? ' (each voucher prints on its own page)' : ''}.
    </div>
  </div>`;
}

export function voucherEmailHtml({ order, vouchers, printUrl }) {
  const toSelf = order.send_to_self === 1;
  const greetingName = toSelf ? order.purchaser_name : order.recipient_name;
  const total = vouchers.reduce((s, v) => s + v.amount_pence, 0);

  const intro = toSelf
    ? `<p style="margin:0 0 16px;font-size:15px;line-height:1.7;">Thanks for your purchase — here ${vouchers.length === 1 ? 'is your gift voucher' : `are your ${vouchers.length} gift vouchers`}, ready to use or pass on.</p>`
    : `<p style="margin:0 0 16px;font-size:15px;line-height:1.7;">Good news — <strong>${esc(order.purchaser_name || 'someone')}</strong> has sent you ${vouchers.length === 1 ? 'a gift voucher' : `${vouchers.length} gift vouchers`} for UK Brewery Tours.</p>`;

  const message = order.message
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;">
        <tr><td style="border-left:3px solid ${AMBER};padding:4px 0 4px 14px;font-size:15px;line-height:1.7;font-style:italic;color:${STOUT};">
          ${esc(order.message).replace(/\n/g, '<br>')}
          ${!toSelf && order.purchaser_name ? `<div style="margin-top:8px;font-style:normal;font-size:13px;color:${INK_SOFT};">— ${esc(order.purchaser_name)}</div>` : ''}
        </td></tr>
      </table>`
    : '';

  const tourNote = order.tour_name
    ? `<p style="margin:0 0 20px;font-size:14px;line-height:1.7;color:${INK_SOFT};">Suggested experience: <strong style="color:${STOUT};">${esc(order.tour_name)}</strong>${order.tour_slug ? ` — <a href="https://www.ukbrewerytours.com/tours/${esc(order.tour_slug)}/" style="color:#b3701d;">view the tour</a>` : ''}</p>`
    : '';

  return shell(`<tr><td style="padding:30px 28px 8px;">
    <h1 style="margin:0 0 14px;font-size:24px;line-height:1.3;">${toSelf ? 'Your gift voucher' + (vouchers.length > 1 ? 's' : '') : `You've been gifted a brewery tour${vouchers.length > 1 ? ' — x' + vouchers.length : ''}`}</h1>
    ${greetingName ? `<p style="margin:0 0 12px;font-size:15px;">Hi ${esc(greetingName)},</p>` : ''}
    ${intro}
    ${message}
    ${vouchers.map(voucherTicket).join('')}
    ${vouchers.length > 1 ? `<p style="margin:0 0 16px;font-size:14px;color:${INK_SOFT};">Total value: <strong style="color:${STOUT};">${formatMoney(total)}</strong> — each code is redeemed separately.</p>` : ''}
    ${tourNote}
    ${HOW_TO_REDEEM}
    ${printBlock(printUrl, vouchers.length)}
    <p style="margin:26px 0 6px;font-size:14px;line-height:1.7;">Cheers,<br>The UK Brewery Tours team</p>
    <p style="margin:0 0 26px;font-size:12px;color:${INK_SOFT};">Keep this email safe — you'll need the code${vouchers.length > 1 ? 's' : ''} when booking.</p>
  </td></tr>`);
}

/** Website enquiry forwarded to info@. Reply-to is set to the sender. */
export function enquiryEmailHtml({ name, email, message, page }) {
  const body = esc(message).replace(/\n/g, '<br>');
  return shell(`<tr><td style="padding:30px 28px;">
    <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:${INK_SOFT};">Website enquiry</div>
    <h1 style="margin:6px 0 20px;font-size:22px;">${esc(name)}</h1>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e7ddcd;border-bottom:1px solid #e7ddcd;margin-bottom:22px;">
      <tr>
        <td style="padding:7px 14px 7px 0;font-size:14px;color:${INK_SOFT};">Email</td>
        <td style="padding:7px 0;font-size:14px;font-weight:600;"><a href="mailto:${esc(email)}" style="color:#b3701d;">${esc(email)}</a></td>
      </tr>
      ${page ? `<tr>
        <td style="padding:7px 14px 7px 0;font-size:14px;color:${INK_SOFT};">Sent from</td>
        <td style="padding:7px 0;font-size:14px;">${esc(page)}</td>
      </tr>` : ''}
    </table>

    <div style="font-size:15px;line-height:1.7;">${body}</div>

    <p style="margin:26px 0 0;font-size:13px;color:${INK_SOFT};">
      Hit reply to answer ${esc(name)} directly.
    </p>
  </td></tr>`);
}

/** Confirmation back to the person who sent the enquiry. */
export function enquiryAutoReplyHtml({ name, message }) {
  return shell(`<tr><td style="padding:30px 28px;">
    <h1 style="margin:0 0 14px;font-size:22px;">Thanks for getting in touch</h1>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.7;">
      Hi ${esc(name)}, we've got your message and will reply by email — usually within a few hours.
    </p>
    <p style="margin:0 0 20px;font-size:15px;line-height:1.7;">
      If it's urgent, message us on WhatsApp and we'll pick it up faster.
    </p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 22px;">
      <tr><td style="border-left:3px solid ${AMBER};padding:4px 0 4px 14px;font-size:14px;line-height:1.7;color:${INK_SOFT};">
        ${esc(message).replace(/\n/g, '<br>')}
      </td></tr>
    </table>

    <div style="background:${CREAM};border-radius:10px;padding:16px 18px;font-size:14px;line-height:1.7;">
      While you wait, have a look at
      <a href="https://www.ukbrewerytours.com/tours/" style="color:#b3701d;">our tours across the UK</a>
      or our <a href="https://www.ukbrewerytours.com/gift-vouchers/" style="color:#b3701d;">gift vouchers</a>.
    </div>

    <p style="margin:24px 0 0;font-size:14px;line-height:1.7;">Cheers,<br>The UK Brewery Tours team</p>
  </td></tr>`);
}

/** Internal heads-up to info@ when a voucher sells. */
export function saleNotificationHtml({ order, vouchers, widget }) {
  const row = (label, value) =>
    `<tr>
      <td style="padding:7px 14px 7px 0;font-size:14px;color:${INK_SOFT};white-space:nowrap;">${label}</td>
      <td style="padding:7px 0;font-size:14px;font-weight:600;">${value}</td>
    </tr>`;

  const delivery = order.send_to_self === 1
    ? `Bought for themselves`
    : `Gift for ${esc(order.recipient_name || '—')} &lt;${esc(order.recipient_email)}&gt;`;

  return shell(`<tr><td style="padding:30px 28px;">
    <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:${INK_SOFT};">New sale</div>
    <h1 style="margin:6px 0 4px;font-size:26px;">${formatMoney(order.total_pence)}</h1>
    <p style="margin:0 0 22px;font-size:14px;color:${INK_SOFT};">
      ${order.quantity} gift voucher${order.quantity > 1 ? 's' : ''} at ${formatMoney(order.amount_pence)} each
      ${order.is_demo ? ' · <strong style="color:#8a5a10;">DEMO PURCHASE</strong>' : ''}
    </p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e7ddcd;border-bottom:1px solid #e7ddcd;margin-bottom:20px;">
      ${row('Buyer', `${esc(order.purchaser_name || '—')}<br><span style="font-weight:400;color:${INK_SOFT};">${esc(order.purchaser_email)}</span>`)}
      ${row('Delivery', delivery)}
      ${order.tour_name ? row('From tour page', esc(order.tour_name)) : ''}
      ${order.widget_id ? row('Sold via widget', `${esc(widget?.name || order.widget_id)}${order.widget_origin ? `<br><span style="font-weight:400;color:${INK_SOFT};">${esc(order.widget_origin)}</span>` : ''}`) : ''}
      ${order.message ? row('Their message', `<span style="font-weight:400;font-style:italic;">${esc(order.message)}</span>`) : ''}
      ${row('Order ref', `<span style="font-family:'Courier New',monospace;font-size:12px;">${esc(order.id)}</span>`)}
    </table>

    <div style="font-size:13px;color:${INK_SOFT};line-height:1.9;">
      <strong style="color:${STOUT};">Code${vouchers.length > 1 ? 's' : ''} issued:</strong><br>
      ${vouchers.map(v => `<span style="font-family:'Courier New',monospace;font-size:14px;color:${STOUT};letter-spacing:1px;">${esc(v.code)}</span> — ${formatMoney(v.amount_pence)}`).join('<br>')}
    </div>

    <p style="margin:24px 0 0;">
      <a href="https://www.ukbrewerytours.com/admin/" style="display:inline-block;background:${AMBER};color:#2b1a05;text-decoration:none;font-weight:600;padding:11px 22px;border-radius:999px;font-size:14px;">Open voucher admin</a>
    </p>
  </td></tr>`);
}

export function receiptEmailHtml({ order, vouchers }) {
  const row = (label, value) =>
    `<tr>
      <td style="padding:7px 0;font-size:14px;color:${INK_SOFT};">${label}</td>
      <td style="padding:7px 0;font-size:14px;text-align:right;font-weight:600;">${value}</td>
    </tr>`;

  const delivery = order.send_to_self === 1
    ? `Sent to you (${esc(order.purchaser_email)})`
    : `Sent to ${esc(order.recipient_name || 'recipient')} (${esc(order.recipient_email)})`;

  return shell(`<tr><td style="padding:30px 28px;">
    <h1 style="margin:0 0 8px;font-size:22px;">Receipt</h1>
    <p style="margin:0 0 22px;font-size:15px;line-height:1.7;">Thanks${order.purchaser_name ? ` ${esc(order.purchaser_name)}` : ''} — your payment went through and the voucher${vouchers.length > 1 ? 's have' : ' has'} been emailed.</p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e7ddcd;border-bottom:1px solid #e7ddcd;margin-bottom:20px;">
      ${row('Voucher value', formatMoney(order.amount_pence))}
      ${row('Quantity', String(order.quantity))}
      ${row('Total paid', `<span style="font-size:17px;">${formatMoney(order.total_pence)}</span>`)}
      ${row('Delivery', delivery)}
      ${row('Order reference', `<span style="font-family:'Courier New',monospace;font-size:12px;">${esc(order.id.slice(0, 8).toUpperCase())}</span>`)}
    </table>

    <div style="font-size:13px;color:${INK_SOFT};line-height:1.8;">
      <strong style="color:${STOUT};">Voucher code${vouchers.length > 1 ? 's' : ''}:</strong><br>
      ${vouchers.map(v => `<span style="font-family:'Courier New',monospace;font-size:14px;color:${STOUT};letter-spacing:1px;">${esc(v.code)}</span> — ${formatMoney(v.amount_pence)}`).join('<br>')}
    </div>

    <p style="margin:22px 0 0;font-size:13px;color:${INK_SOFT};line-height:1.7;">
      Questions? Just reply to this email or contact
      <a href="mailto:info@ukbrewerytours.com" style="color:#b3701d;">info@ukbrewerytours.com</a>.
      See our <a href="https://www.ukbrewerytours.com/returns-policy/" style="color:#b3701d;">returns policy</a>.
    </p>
  </td></tr>`);
}
