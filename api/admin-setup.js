// Temporary go-live helper — remove after launch.
// GET /api/admin-setup?secret=<SETUP_SECRET>            connector status + Resend
//     &action=resend-verify                             trigger Resend domain verification
//
// Reports: env var presence, portal table existence, Resend domain state for
// registrationoffice.com.au — creating the domain in Resend on first call and
// echoing the exact DNS records to add at GoDaddy.

const { PORTAL, sbGet } = require('./_lib/config');

const RESEND = 'https://api.resend.com';
const DOMAIN = (process.env.PORTAL_URL || 'https://registrationoffice.com.au').replace(/^https?:\/\/(www\.)?/, '');

const rs = (path, opts) => fetch(`${RESEND}${path}`, {
  ...opts,
  headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json', ...(opts && opts.headers) },
});

module.exports = async (req, res) => {
  const q = req.query || {};
  if (!process.env.SETUP_SECRET || q.secret !== process.env.SETUP_SECRET) return res.status(401).json({ error: 'bad secret' });
  try {
    const out = { domain: DOMAIN };

    out.env = Object.fromEntries([
      'PORTAL_SUPABASE_URL', 'ARO_SUPABASE_URL', 'ARO_SUPABASE_KEY', 'DASPA_SUPABASE_URL', 'DASPA_SUPABASE_KEY',
      'AHREFS_API_KEY', 'RESEND_API_KEY', 'EMAIL_FROM', 'GOOGLE_ADS_DEV_TOKEN', 'GOOGLE_OAUTH_CLIENT_ID',
      'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_ADS_MCC_ID', 'SETUP_SECRET',
    ].map((k) => [k, process.env[k] ? 'set' : 'MISSING']));

    out.tables = {};
    for (const t of ['portal_users', 'portal_lead_state', 'portal_lead_events', 'portal_seo_snapshots', 'portal_connections']) {
      try { await sbGet(PORTAL, `${t}?select=*&limit=1`); out.tables[t] = 'ok'; }
      catch (e) { out.tables[t] = /does not exist|schema cache/i.test(e.message) ? 'MISSING — run the SQL' : 'error: ' + e.message.slice(0, 120); }
    }
    out.sqlEditor = 'https://supabase.com/dashboard/project/' + String(process.env.PORTAL_SUPABASE_URL || process.env.ARO_SUPABASE_URL || '').replace(/^https?:\/\//, '').split('.')[0] + '/sql/new';

    if (process.env.RESEND_API_KEY) {
      const list = await (await rs('/domains')).json();
      let dom = (list.data || []).find((d) => d.name === DOMAIN);
      if (!dom) {
        const created = await (await rs('/domains', { method: 'POST', body: JSON.stringify({ name: DOMAIN, region: 'us-east-1' }) })).json();
        dom = created.id ? created : { error: created };
      }
      if (dom && dom.id) {
        if (q.action === 'resend-verify') await rs(`/domains/${dom.id}/verify`, { method: 'POST' });
        const detail = await (await rs(`/domains/${dom.id}`)).json();
        out.resend = {
          status: detail.status,
          addTheseAtGoDaddy: (detail.records || []).map((r) => ({
            type: r.record || r.type, name: r.name, value: r.value, priority: r.priority ?? undefined, status: r.status,
          })),
          note: detail.status !== 'verified' ? 'Add the records above at GoDaddy, then call again with &action=resend-verify' : 'Domain verified — invite emails will send.',
        };
      } else out.resend = { error: dom && dom.error ? dom.error : 'could not create/find domain' };
    } else out.resend = 'RESEND_API_KEY missing';

    return res.status(200).json(out);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
};
