// Portal auth. POST { action, ... }:
//   login            { email, password }              -> { token, email, name, role, mustChange }
//   me               (Bearer token)                   -> { email, name, role }
//   users            (Bearer token)                   -> [{ email, name, role }] for assignment dropdowns
//   change-password  (Bearer) { current, password }   -> { ok }
//   bootstrap        { secret, users? }               -> creates the five accounts once, returns temp passwords ONCE
//
// Bootstrap is guarded by SETUP_SECRET and refuses to run twice.

const crypto = require('crypto');
const { PORTAL, sbGet, sbWrite, hashPass, sign, requireUser } = require('./_lib/config');

const DEFAULT_USERS = [
  { email: 'james@link.com.au',  name: 'James',  role: 'admin' },
  { email: 'chris@link.com.au',  name: 'Chris',  role: 'admin' },
  { email: 'juan@link.com.au',   name: 'Juan',   role: 'admin' },
  { email: 'france@link.com.au', name: 'France', role: 'team' },
  { email: 'mary@link.com.au',   name: 'Mary',   role: 'team' },
];

const byEmail = async (email) =>
  ((await sbGet(PORTAL, `portal_users?email=eq.${encodeURIComponent(email)}&select=*`)) || [])[0] || null;

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  try {
    const { action } = req.body || {};
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();

    if (action === 'login') {
      const acct = await byEmail(email);
      const bad = () => res.status(401).json({ error: 'Email or password doesn’t match.' });
      if (!acct || !req.body.password) return bad();
      const expect = Buffer.from(acct.pass_hash, 'hex');
      const got = Buffer.from(hashPass(req.body.password, acct.pass_salt), 'hex');
      if (expect.length !== got.length || !crypto.timingSafeEqual(expect, got)) return bad();
      sbWrite(PORTAL, `portal_users?id=eq.${acct.id}`, 'PATCH', { last_login_at: new Date().toISOString() }).catch(() => {});
      return res.status(200).json({
        token: sign({ email: acct.email, name: acct.full_name, role: acct.role }, 7 * 24 * 3600),
        email: acct.email, name: acct.full_name, role: acct.role,
        mustChange: !!acct.must_change_password,
      });
    }

    if (action === 'me') {
      const user = requireUser(req, res); if (!user) return;
      const acct = await byEmail(user.email);
      if (!acct) return res.status(401).json({ error: 'account not found' });
      return res.status(200).json({ email: acct.email, name: acct.full_name, role: acct.role, mustChange: !!acct.must_change_password });
    }

    if (action === 'users') {
      const user = requireUser(req, res); if (!user) return;
      const rows = (await sbGet(PORTAL, 'portal_users?select=email,full_name,role&order=full_name')) || [];
      return res.status(200).json(rows.map((r) => ({ email: r.email, name: r.full_name, role: r.role })));
    }

    if (action === 'change-password') {
      const user = requireUser(req, res); if (!user) return;
      const { current, password } = req.body;
      if (!password || String(password).length < 10) return res.status(400).json({ error: 'New password needs at least 10 characters.' });
      const acct = await byEmail(user.email);
      const expect = Buffer.from(acct.pass_hash, 'hex');
      const got = Buffer.from(hashPass(current || '', acct.pass_salt), 'hex');
      if (expect.length !== got.length || !crypto.timingSafeEqual(expect, got)) return res.status(401).json({ error: 'Current password doesn’t match.' });
      const salt = crypto.randomBytes(16).toString('hex');
      await sbWrite(PORTAL, `portal_users?id=eq.${acct.id}`, 'PATCH', {
        pass_hash: hashPass(password, salt), pass_salt: salt, must_change_password: false,
      });
      return res.status(200).json({ ok: true });
    }

    if (action === 'bootstrap') {
      if (!process.env.SETUP_SECRET || req.body.secret !== process.env.SETUP_SECRET) {
        return res.status(401).json({ error: 'bad secret' });
      }
      const existing = await sbGet(PORTAL, 'portal_users?select=id&limit=1');
      if (existing === null) return res.status(503).json({ error: 'portal_users table missing — run supabase/portal-schema.sql first' });
      if (existing.length) return res.status(409).json({ error: 'already bootstrapped — users exist' });
      const wanted = Array.isArray(req.body.users) && req.body.users.length ? req.body.users : DEFAULT_USERS;
      const out = [];
      for (const u of wanted) {
        const temp = crypto.randomBytes(9).toString('base64url'); // shown once, must change on first login
        const salt = crypto.randomBytes(16).toString('hex');
        await sbWrite(PORTAL, 'portal_users', 'POST', {
          id: crypto.randomUUID(), email: String(u.email).toLowerCase(), full_name: u.name,
          role: u.role === 'admin' ? 'admin' : 'team',
          pass_hash: hashPass(temp, salt), pass_salt: salt, must_change_password: true,
        });
        out.push({ email: u.email, name: u.name, role: u.role, tempPassword: temp });
      }
      return res.status(200).json({ created: out, note: 'Temp passwords are shown ONCE — share securely; everyone is forced to change on first login.' });
    }

    return res.status(400).json({ error: 'unknown action' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'something went wrong — try again' });
  }
};
