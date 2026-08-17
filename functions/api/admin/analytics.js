// GET /api/admin/analytics?days=28 — key Google Analytics metrics for the
// three tour sites, side by side. Auth comes from the /api/admin middleware.
//
// Talks to the GA4 Data API as the claude-seo service account (which has
// viewer access to all three properties). Credentials live in two Pages
// secrets: GA_SA_EMAIL (client_email) and GA_SA_KEY (PEM private key).

const SITES = [
  { key: 'uk', label: 'ukbrewerytours.com', property: '444117614' },
  { key: 'london', label: 'londonbrewerytour.com', property: '540727225' },
  { key: 'bristol', label: 'bristolbrewerytours.com', property: '444093502' },
];

const enc = new TextEncoder();
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function importPem(pem) {
  const raw = atob(pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, ''));
  const bytes = Uint8Array.from(raw, c => c.charCodeAt(0));
  return crypto.subtle.importKey('pkcs8', bytes,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}

// One token per isolate — GA tokens last an hour, admin visits are sparse.
let cached = null;

async function accessToken(env) {
  if (cached && cached.exp > Date.now() / 1000 + 60) return cached.token;
  const iat = Math.floor(Date.now() / 1000);
  const claims = {
    iss: env.GA_SA_EMAIL,
    scope: 'https://www.googleapis.com/auth/analytics.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat, exp: iat + 3600,
  };
  const unsigned = b64url(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })))
    + '.' + b64url(enc.encode(JSON.stringify(claims)));
  const key = await importPem(env.GA_SA_KEY);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(unsigned));
  const jwt = unsigned + '.' + b64url(sig);

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${jwt}`,
  });
  if (!res.ok) throw new Error(`token exchange failed (${res.status})`);
  const data = await res.json();
  cached = { token: data.access_token, exp: iat + (data.expires_in || 3600) };
  return cached.token;
}

const runReport = (token, property, body) =>
  fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${property}:runReport`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async r => {
    if (!r.ok) throw new Error(`GA4 ${property}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    return r.json();
  });

const METRICS = ['totalUsers', 'sessions', 'screenPageViews'];

export async function onRequestGet({ request, env }) {
  if (!env.GA_SA_EMAIL || !env.GA_SA_KEY) {
    return Response.json({ error: 'Analytics credentials are not configured.' }, { status: 503 });
  }
  const url = new URL(request.url);
  let days = parseInt(url.searchParams.get('days') || '28', 10);
  if (![7, 28, 90].includes(days)) days = 28;

  let token;
  try { token = await accessToken(env); } catch (err) {
    console.error('GA auth failed', err);
    return Response.json({ error: 'Could not authenticate with Google Analytics.' }, { status: 502 });
  }

  const sites = await Promise.all(SITES.map(async site => {
    try {
      const [totals, pages] = await Promise.all([
        runReport(token, site.property, {
          dateRanges: [
            { startDate: `${days}daysAgo`, endDate: 'today' },
            { startDate: `${2 * days}daysAgo`, endDate: `${days + 1}daysAgo` },
          ],
          metrics: METRICS.map(name => ({ name })),
        }),
        runReport(token, site.property, {
          dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'today' }],
          dimensions: [{ name: 'pagePath' }],
          metrics: [{ name: 'sessions' }],
          orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
          limit: 5,
        }),
      ]);

      // With two date ranges and no dimensions, each row is one range,
      // tagged date_range_0 / date_range_1 in its dimensionValues.
      const byRange = {};
      for (const row of totals.rows || []) {
        const tag = row.dimensionValues?.[0]?.value || 'date_range_0';
        byRange[tag] = Object.fromEntries(
          METRICS.map((m, i) => [m, Number(row.metricValues[i].value)]));
      }
      const zero = Object.fromEntries(METRICS.map(m => [m, 0]));
      return {
        ...site,
        current: byRange.date_range_0 || zero,
        previous: byRange.date_range_1 || zero,
        topPages: (pages.rows || []).map(r => ({
          path: r.dimensionValues[0].value,
          sessions: Number(r.metricValues[0].value),
        })),
      };
    } catch (err) {
      console.error('GA report failed', site.key, err);
      return { ...site, error: 'Could not load this property.' };
    }
  }));

  return Response.json({ days, sites });
}
