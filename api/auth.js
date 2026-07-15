// Portal auth. POST { action, ... }:
//   login            { email, password }              -> { token, email, name, role, mustChange }
//   me               (Bearer token)                   -> { email, name, role }
//   users            (Bearer token)                   -> [{ email, name, role }] for assignment dropdowns
//   change-password  (Bearer) { current, password }   -> { ok }
//   bootstrap        { secret, users? }               -> creates the five accounts once, returns temp passwords ONCE
//
// Bootstrap is guarded by SETUP_SECRET and refuses to run twice.

const crypto = require('crypto');
const { PORTAL, sbGet, sbWrite, hashPass, sign, verify, requireUser, requireAdmin } = require('./_lib/config');

const PORTAL_URL = process.env.PORTAL_URL || 'https://registrationoffice.com.au';
const EMAIL_FROM = process.env.EMAIL_FROM || 'registration office <no-reply@registrationoffice.com.au>';

// Emails a set-password link (used for both invites and resets).
// Requires RESEND_API_KEY and a verified sender domain in Resend.
async function sendSetPasswordEmail(acct, kindLabel) {
  const tok = sign({ kind: 'invite', email: acct.email }, 7 * 24 * 3600);
  const link = `${PORTAL_URL}/?invite=${encodeURIComponent(tok)}`;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: EMAIL_FROM, to: acct.email,
      subject: kindLabel === 'reset' ? 'reset your registration office password' : 'your registration office login',
      html: `
<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;padding:28px 8px;color:#0F0F10">
  <div style="font-size:24px;font-weight:800;letter-spacing:-0.5px">registration office<span style="color:#2F54EB">.</span></div>
  <p style="color:#55555C">the LINK online services portal</p>
  <p>Hi ${String(acct.full_name || '').split(' ')[0]},</p>
  <p>${kindLabel === 'reset'
    ? 'Someone (hopefully you) asked to reset your portal password.'
    : `Your portal account is ready — you're set up as <b>${acct.role === 'admin' ? 'an admin' : 'a team member'}</b>.`}
  Click below to ${kindLabel === 'reset' ? 'set a new' : 'create your'} password:</p>
  <p style="margin:26px 0"><a href="${link}" style="background:#0F0F10;color:#fff;text-decoration:none;font-weight:700;padding:13px 26px;border-radius:99px">set my password</a></p>
  <p style="color:#8B8B93;font-size:13px">The link works for 7 days and signs you straight in once your password is set.<br>Didn't expect this email? You can safely ignore it.</p>
</div>`,
    }),
  });
  if (!r.ok) throw new Error(`resend failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
}

// Just James and Juan to start — add the rest later with {action:'add-user'}
// (admin-only: creates the account and emails the invite).
const DEFAULT_USERS = [
  { email: 'james@link.com.au', name: 'James', role: 'admin' },
  { email: 'juan@link.com.au',  name: 'Juan',  role: 'admin' },
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
      const canEmail = !!process.env.RESEND_API_KEY;
      const out = [];
      for (const u of wanted) {
        const temp = crypto.randomBytes(12).toString('base64url');
        const salt = crypto.randomBytes(16).toString('hex');
        const acct = {
          id: crypto.randomUUID(), email: String(u.email).toLowerCase(), full_name: u.name,
          role: u.role === 'admin' ? 'admin' : 'team',
          pass_hash: hashPass(temp, salt), pass_salt: salt, must_change_password: true,
        };
        await sbWrite(PORTAL, 'portal_users', 'POST', acct);
        if (canEmail) {
          try { await sendSetPasswordEmail(acct, 'invite'); out.push({ email: acct.email, name: u.name, role: acct.role, invited: true }); }
          catch (e) { out.push({ email: acct.email, name: u.name, role: acct.role, invited: false, emailError: e.message, tempPassword: temp }); }
        } else out.push({ email: acct.email, name: u.name, role: acct.role, tempPassword: temp });
      }
      return res.status(200).json({
        created: out,
        note: canEmail
          ? 'Invite emails sent — each person clicks their link to set a password. Any rows with emailError fall back to the included temp password.'
          : 'RESEND_API_KEY not set — temp passwords shown ONCE; share securely.',
      });
    }

    if (action === 'add-user') {
      const admin = requireAdmin(req, res); if (!admin) return;
      if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email.' });
      if (await byEmail(email)) return res.status(409).json({ error: 'That email already has an account.' });
      const temp = crypto.randomBytes(12).toString('base64url');
      const salt = crypto.randomBytes(16).toString('hex');
      const acct = {
        id: crypto.randomUUID(), email, full_name: String(req.body.name || '').trim().slice(0, 120) || email.split('@')[0],
        role: req.body.role === 'admin' ? 'admin' : 'team',
        pass_hash: hashPass(temp, salt), pass_salt: salt, must_change_password: true,
      };
      await sbWrite(PORTAL, 'portal_users', 'POST', acct);
      if (process.env.RESEND_API_KEY) {
        try { await sendSetPasswordEmail(acct, 'invite'); return res.status(200).json({ created: acct.email, invited: true }); }
        catch (e) { return res.status(200).json({ created: acct.email, invited: false, emailError: e.message, tempPassword: temp }); }
      }
      return res.status(200).json({ created: acct.email, invited: false, tempPassword: temp });
    }

    if (action === 'invite') {
      const admin = requireAdmin(req, res); if (!admin) return;
      const acct = await byEmail(email);
      if (!acct) return res.status(404).json({ error: 'no account for that email' });
      if (!process.env.RESEND_API_KEY) return res.status(400).json({ error: 'RESEND_API_KEY not set' });
      await sendSetPasswordEmail(acct, 'invite');
      return res.status(200).json({ sent: true });
    }

    if (action === 'accept-invite') {
      const payload = verify(req.body.token);
      if (!payload || payload.kind !== 'invite') return res.status(401).json({ error: 'That link has expired — ask an admin to send a new one.' });
      const { password } = req.body;
      if (!password || String(password).length < 10) return res.status(400).json({ error: 'Password needs at least 10 characters.' });
      const acct = await byEmail(payload.email);
      if (!acct) return res.status(404).json({ error: 'account not found' });
      const salt = crypto.randomBytes(16).toString('hex');
      await sbWrite(PORTAL, `portal_users?id=eq.${acct.id}`, 'PATCH', {
        pass_hash: hashPass(password, salt), pass_salt: salt, must_change_password: false,
        last_login_at: new Date().toISOString(),
      });
      return res.status(200).json({
        token: sign({ email: acct.email, name: acct.full_name, role: acct.role }, 7 * 24 * 3600),
        email: acct.email, name: acct.full_name, role: acct.role, mustChange: false,
      });
    }

    if (action === 'reset-request') {
      const acct = await byEmail(email);
      if (acct && process.env.RESEND_API_KEY) await sendSetPasswordEmail(acct, 'reset').catch((e) => console.error(e));
      // same answer whether or not the account exists
      return res.status(200).json({ ok: true, note: 'If that email has an account, a set-password link is on its way.' });
    }

    return res.status(400).json({ error: 'unknown action' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'something went wrong — try again' });
  }
};
