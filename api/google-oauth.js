// One-click Google Ads connection.
//   POST {action:'start'} (Bearer, admin)  -> { url }  — consent URL with a signed state
//   GET  ?code=..&state=..                 — Google's callback: verifies state,
//        exchanges the code, stores the refresh token in portal_connections,
//        bounces back to /?connected=google-ads
//
// Env: GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, PORTAL_URL
// (register <PORTAL_URL>/api/google-oauth as the OAuth client's redirect URI).

const { PORTAL, sbGet, sbWrite, sign, verify, requireAdmin } = require('./_lib/config');

const PORTAL_URL = process.env.PORTAL_URL || 'https://registrationoffice.com.au';
const REDIRECT = `${PORTAL_URL}/api/google-oauth`;

module.exports = async (req, res) => {
  try {
    if (req.method === 'POST') {
      const user = requireAdmin(req, res); if (!user) return;
      if (!process.env.GOOGLE_OAUTH_CLIENT_ID) return res.status(400).json({ error: 'GOOGLE_OAUTH_CLIENT_ID not set' });
      const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
        client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
        redirect_uri: REDIRECT,
        response_type: 'code',
        scope: 'https://www.googleapis.com/auth/adwords',
        access_type: 'offline',
        prompt: 'consent',
        state: sign({ kind: 'gads', by: user.email }, 900),
      });
      return res.status(200).json({ url });
    }

    // Google callback
    const q = req.query || {};
    if (!q.code || !q.state || !verify(q.state) || verify(q.state).kind !== 'gads') {
      res.statusCode = 302; res.setHeader('Location', '/?connected=failed'); return res.end();
    }
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: q.code, client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
        client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
        redirect_uri: REDIRECT, grant_type: 'authorization_code',
      }),
    });
    const data = await r.json();
    if (!r.ok || !data.refresh_token) {
      console.error('oauth exchange failed', JSON.stringify(data).slice(0, 300));
      res.statusCode = 302; res.setHeader('Location', '/?connected=failed'); return res.end();
    }
    const existing = ((await sbGet(PORTAL, "portal_connections?id=eq.google_ads&select=id")) || [])[0];
    const body = { data: { refresh_token: data.refresh_token, connected_by: verify(q.state).by }, updated_at: new Date().toISOString() };
    if (existing) await sbWrite(PORTAL, "portal_connections?id=eq.google_ads", 'PATCH', body);
    else await sbWrite(PORTAL, 'portal_connections', 'POST', { id: 'google_ads', ...body });
    res.statusCode = 302; res.setHeader('Location', '/?connected=google-ads'); return res.end();
  } catch (e) {
    console.error(e);
    res.statusCode = 302; res.setHeader('Location', '/?connected=failed'); return res.end();
  }
};
