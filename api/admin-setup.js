// Temporary go-live helper — remove after launch.
// GET /api/admin-setup?secret=<SETUP_SECRET>            connector status + Resend
//     &action=resend-verify                             trigger Resend domain verification
//
// Reports: env var presence, portal table existence, Resend domain state for
// registrationoffice.com.au — creating the domain in Resend on first call and
// echoing the exact DNS records to add at GoDaddy.

const crypto = require('crypto');
const { PORTAL, sbGet, sbWrite, hashPass } = require('./_lib/config');

const RESEND = 'https://api.resend.com';
const DOMAIN = (process.env.PORTAL_URL || 'https://registrationoffice.com.au').replace(/^https?:\/\/(www\.)?/, '');

// Resend allows 2 req/s — pace every call and retry once on 429.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function rs(path, opts) {
  await sleep(650);
  let r = await fetch(`${RESEND}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json', ...(opts && opts.headers) },
  });
  if (r.status === 429) {
    await sleep(1200);
    r = await fetch(`${RESEND}${path}`, {
      ...opts,
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json', ...(opts && opts.headers) },
    });
  }
  return r;
}

module.exports = async (req, res) => {
  const q = req.query || {};
  if (!process.env.SETUP_SECRET || q.secret !== process.env.SETUP_SECRET) return res.status(401).json({ error: 'bad secret' });
  try {
    const out = { domain: DOMAIN };

    // Browser-triggered bootstrap: creates the default accounts and emails
    // each an invite link (no credentials in the URL or response). Same
    // idempotence as POST /api/auth bootstrap — refuses if users exist.
    if (q.action === 'bootstrap') {
      const auth = require('./auth');
      const existing = await sbGet(PORTAL, 'portal_users?select=id&limit=1');
      if (existing === null) return res.status(503).json({ error: 'portal_users table missing — run the SQL first' });
      if (existing.length) return res.status(409).json({ error: 'users already exist — log in at /' });
      const created = [];
      for (const u of auth.DEFAULT_USERS) {
        const salt = crypto.randomBytes(16).toString('hex');
        const acct = {
          id: crypto.randomUUID(), email: u.email, full_name: u.name, role: u.role,
          pass_hash: hashPass(crypto.randomBytes(18).toString('base64url'), salt), // unknown to anyone — invite link sets the real one
          pass_salt: salt, must_change_password: true,
        };
        await sbWrite(PORTAL, 'portal_users', 'POST', acct);
        try {
          await auth.sendSetPasswordEmail(acct, 'invite');
          created.push({ email: acct.email, invited: true });
        } catch (e) {
          await sbWrite(PORTAL, `portal_users?id=eq.${acct.id}`, 'DELETE');
          created.push({ email: acct.email, invited: false, error: e.message.slice(0, 160), note: 'account rolled back — reload this URL to retry' });
        }
      }
      return res.status(200).json({ bootstrap: created, next: 'check both inboxes for "your registration office login" and click the link' });
    }


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

    try {
      const users = (await sbGet(PORTAL, 'portal_users?select=email,full_name,role,must_change_password,last_login_at,pass_hash')) || [];
      out.users = users.map((u) => ({ email: u.email, name: u.full_name, role: u.role, mustChange: u.must_change_password, lastLogin: u.last_login_at, hashLen: (u.pass_hash || '').length }));
    } catch (e) { out.users = 'error: ' + e.message.slice(0, 120); }

    if (process.env.RESEND_API_KEY) {
      const list = await (await rs('/domains')).json();
      let dom = (list.data || []).find((d) => d.name === DOMAIN);
      if (!dom) {
        const created = await (await rs('/domains', { method: 'POST', body: JSON.stringify({ name: DOMAIN, region: 'us-east-1' }) })).json();
        dom = created.id ? created : { error: created };
      }
      if (dom && dom.id) {
        let verifyResult;
        if (q.action === 'resend-verify') {
          const v = await rs(`/domains/${dom.id}/verify`, { method: 'POST' });
          verifyResult = { http: v.status, body: await v.json().catch(() => null) };
        }
        const dRes = await rs(`/domains/${dom.id}`);
        const detail = await dRes.json().catch(() => ({}));
        if (!dRes.ok || !detail.status) {
          out.resend = { problem: 'unexpected domain response from Resend', http: dRes.status, raw: detail, domainId: dom.id, verifyResult };
        } else {
          out.resend = {
            status: detail.status,
            domainId: dom.id,
            verifyResult,
            dnsRecords: (detail.records || []).map((r) => ({
              type: r.record || r.type, name: r.name, value: r.value, priority: r.priority ?? undefined, status: r.status,
            })),
            note: detail.status === 'verified' ? 'Domain verified — invite emails will send.'
              : 'Records show their individual status above; once DNS has propagated call again with &action=resend-verify.',
          };
        }
      } else out.resend = { error: dom && dom.error ? dom.error : 'could not create/find domain' };
    } else out.resend = 'RESEND_API_KEY missing';

    return res.status(200).json(out);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
};
