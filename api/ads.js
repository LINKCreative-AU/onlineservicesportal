// Google Ads spend + ROI per business. GET, ADMIN only. ?days=30
//
// Needs: GOOGLE_ADS_DEV_TOKEN, GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET,
// GOOGLE_ADS_MCC_ID (10-digit manager account id, no dashes), and a refresh
// token created by the in-portal "connect google ads" flow (api/google-oauth.js,
// stored in portal_connections). Campaigns map to businesses by name:
// a campaign containing daspa/abn/gst/cgt counts toward that site.
//
// The panel shows a setup card listing exactly what's missing until then.

const { SITES, PORTAL, sbGet, requireAdmin } = require('./_lib/config');

const SITE_PATTERNS = [
  ['daspa', /dasp/i],
  ['abnassist', /abn/i],
  ['gstregister', /gst/i],
  ['cgt', /cgt|capital gains/i],
];

async function accessToken() {
  const conn = ((await sbGet(PORTAL, "portal_connections?id=eq.google_ads&select=*")) || [])[0];
  const refresh = conn && conn.data && conn.data.refresh_token;
  if (!refresh) return { missing: 'oauth' };
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID, client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      refresh_token: refresh, grant_type: 'refresh_token',
    }),
  });
  const data = await r.json();
  if (!r.ok || !data.access_token) throw new Error('google token refresh failed: ' + JSON.stringify(data).slice(0, 200));
  return { token: data.access_token };
}

async function gaql(token, customerId, query) {
  const r = await fetch(`https://googleads.googleapis.com/v18/customers/${customerId}/googleAds:searchStream`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'developer-token': process.env.GOOGLE_ADS_DEV_TOKEN,
      'login-customer-id': process.env.GOOGLE_ADS_MCC_ID,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`google ads ${r.status}: ${text.slice(0, 300)}`);
  const chunks = JSON.parse(text);
  return (Array.isArray(chunks) ? chunks : [chunks]).flatMap((c) => c.results || []);
}

module.exports = async (req, res) => {
  const user = requireAdmin(req, res); if (!user) return;
  try {
    const missing = [];
    if (!process.env.GOOGLE_ADS_DEV_TOKEN) missing.push('GOOGLE_ADS_DEV_TOKEN env var');
    if (!process.env.GOOGLE_OAUTH_CLIENT_ID || !process.env.GOOGLE_OAUTH_CLIENT_SECRET) missing.push('GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET env vars (OAuth client from Google Cloud console)');
    if (!process.env.GOOGLE_ADS_MCC_ID) missing.push('GOOGLE_ADS_MCC_ID env var (manager account id, digits only)');
    let auth = null;
    if (!missing.length) {
      auth = await accessToken();
      if (auth.missing) missing.push('Google sign-in — click “connect google ads” below (signs in as the MCC user and stores a refresh token)');
    }
    if (missing.length) return res.status(200).json({ configured: false, missing });

    const days = Math.min(Math.max(parseInt((req.query || {}).days || '30', 10) || 30, 7), 90);
    const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
    const until = new Date().toISOString().slice(0, 10);

    // every client account under the MCC
    const clients = await gaql(auth.token, process.env.GOOGLE_ADS_MCC_ID,
      `SELECT customer_client.id, customer_client.descriptive_name FROM customer_client WHERE customer_client.manager = false AND customer_client.status = 'ENABLED'`);

    const spendBySite = {}; const spendByDay = {}; const campaigns = [];
    for (const c of clients) {
      const cid = String(c.customerClient.id);
      let rows;
      try {
        rows = await gaql(auth.token, cid,
          `SELECT campaign.name, segments.date, metrics.cost_micros, metrics.clicks, metrics.impressions
           FROM campaign WHERE segments.date BETWEEN '${since}' AND '${until}' AND metrics.cost_micros > 0`);
      } catch (e) { console.error(`ads query failed for ${cid}`, e.message); continue; }
      for (const row of rows) {
        const name = row.campaign.name || '';
        const siteId = (SITE_PATTERNS.find(([, re]) => re.test(name) || re.test(c.customerClient.descriptiveName || '')) || ['other'])[0];
        const cents = Math.round((row.metrics.costMicros || 0) / 10000);
        spendBySite[siteId] = (spendBySite[siteId] || 0) + cents;
        ((spendByDay[row.segments.date] ||= {})[siteId] = (spendByDay[row.segments.date]?.[siteId] || 0) + cents);
        let camp = campaigns.find((x) => x.name === name);
        if (!camp) campaigns.push(camp = { name, siteId, account: c.customerClient.descriptiveName, spend_cents: 0, clicks: 0, impressions: 0 });
        camp.spend_cents += cents; camp.clicks += +(row.metrics.clicks || 0); camp.impressions += +(row.metrics.impressions || 0);
      }
    }
    campaigns.sort((a, b) => b.spend_cents - a.spend_cents);
    return res.status(200).json({
      configured: true, days, spendBySite, spendByDay, campaigns,
      sites: Object.fromEntries(Object.entries(SITES).map(([k, s]) => [k, { label: s.label, color: s.color }])),
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'ads fetch failed: ' + e.message });
  }
};
