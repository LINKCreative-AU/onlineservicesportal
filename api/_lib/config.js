// Registration Office portal — shared config, Supabase helpers, auth/session.
//
// Each site keeps its own Supabase project; the portal reads them with
// service-role keys and never exposes any key to the browser (every request
// goes through /api with a signed session token).
//
// Env vars (Vercel):
//   PORTAL_SUPABASE_URL / PORTAL_SUPABASE_KEY   portal's own tables (users, lead state/events)
//   DASPA_SUPABASE_URL  / DASPA_SUPABASE_KEY    DASPA claims project
//   ARO_SUPABASE_URL    / ARO_SUPABASE_KEY      shared ARO project (abn_orders, gst_orders, gst_leads)
//   GSTR_SUPABASE_URL   / GSTR_SUPABASE_KEY     only if GST Register ever moves off the shared project
//   SETUP_SECRET                                guards /api/auth bootstrap
//   PORTAL_SESSION_SECRET                       optional; falls back to a hash of PORTAL_SUPABASE_KEY

const crypto = require('crypto');

const env = (name, fallback) => process.env[name] || (fallback ? process.env[fallback] : undefined);

const PORTAL = { url: env('PORTAL_SUPABASE_URL', 'ARO_SUPABASE_URL'), key: env('PORTAL_SUPABASE_KEY', 'ARO_SUPABASE_KEY') };

// DASPA's fee is fixed ($149 + GST inc = $163.90); order tables carry total_cents.
const SITES = {
  daspa: {
    label: 'DASPA',
    color: '#2F54EB',
    db: () => ({ url: env('DASPA_SUPABASE_URL'), key: env('DASPA_SUPABASE_KEY') }),
    table: 'claims',
    fields: 'id,created_at,full_name,email,phone,visa_subclass,payment_status,paid_at,claim_status,verification_status',
    normalize: (r) => ({
      site: 'daspa', id: r.id, created_at: r.created_at,
      name: r.full_name, email: r.email, phone: r.phone,
      service: `DASP claim${r.visa_subclass ? ' · visa ' + r.visa_subclass : ''}`,
      amount_cents: r.payment_status === 'paid' ? 16390 : 0,
      payment_status: r.payment_status,
      source_status: r.claim_status,
    }),
  },
  abnassist: {
    label: 'ABN Assist',
    color: '#0D9488',
    db: () => ({ url: env('ARO_SUPABASE_URL'), key: env('ARO_SUPABASE_KEY') }),
    table: 'abn_orders',
    fields: 'id,created_at,full_name,email,mobile,service_type,total_cents,payment_status,order_status',
    normalize: (r) => ({
      site: 'abnassist', id: r.id, created_at: r.created_at,
      name: r.full_name, email: r.email, phone: r.mobile,
      service: `ABN ${r.service_type}`,
      amount_cents: r.payment_status === 'paid' ? (r.total_cents || 0) : 0,
      payment_status: r.payment_status,
      source_status: r.order_status,
    }),
  },
  gstregister: {
    label: 'GST Register',
    color: '#D97706',
    db: () => ({ url: env('GSTR_SUPABASE_URL', 'ARO_SUPABASE_URL'), key: env('GSTR_SUPABASE_KEY', 'ARO_SUPABASE_KEY') }),
    table: 'gst_orders',
    fields: 'id,created_at,full_name,email,mobile,abn,service_type,total_cents,payment_status,order_status',
    leadsTable: 'gst_leads', // abandoned checkouts, chased by the site's own nudge cron
    normalize: (r) => ({
      site: 'gstregister', id: r.id, created_at: r.created_at,
      name: r.full_name, email: r.email, phone: r.mobile,
      service: `GST ${r.service_type}`,
      amount_cents: r.payment_status === 'paid' ? (r.total_cents || 0) : 0,
      payment_status: r.payment_status,
      source_status: r.order_status,
    }),
  },
  cgt: {
    label: 'CGT Clearance',
    color: '#DB2777',
    db: () => ({ url: env('CGT_SUPABASE_URL'), key: env('CGT_SUPABASE_KEY') }), // wired when the rebuild lands
    table: null,
  },
};

const PIPELINE = ['new', 'in_progress', 'lodged', 'cleared', 'refunded', 'dead'];

// ---------------------------------------------------------------- supabase REST
const sbHeaders = (key, extra) => ({
  'Content-Type': 'application/json',
  apikey: key,
  Authorization: `Bearer ${key}`,
  ...extra,
});

async function sbGet(db, path) {
  if (!db.url || !db.key) return null; // site not wired yet — panels degrade gracefully
  const r = await fetch(`${db.url}/rest/v1/${path}`, { headers: sbHeaders(db.key) });
  if (!r.ok) throw new Error(`supabase get ${path.split('?')[0]}: ${r.status} ${await r.text()}`);
  return r.json();
}
async function sbWrite(db, path, method, body, prefer) {
  const r = await fetch(`${db.url}/rest/v1/${path}`, {
    method, headers: sbHeaders(db.key, { Prefer: prefer || 'return=minimal' }), body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`supabase ${method} ${path.split('?')[0]}: ${r.status} ${await r.text()}`);
  return prefer && prefer.includes('representation') ? r.json() : null;
}

// ---------------------------------------------------------------- auth
const SECRET = process.env.PORTAL_SESSION_SECRET
  ? crypto.createHash('sha256').update(process.env.PORTAL_SESSION_SECRET).digest()
  : crypto.createHash('sha256').update(String(PORTAL.key) + ':ro-portal-v1').digest();

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const hashPass = (password, salt) => crypto.scryptSync(String(password), salt, 64).toString('hex');

function sign(payload, ttlSec) {
  const body = b64u(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec }));
  return `${body}.${b64u(crypto.createHmac('sha256', SECRET).update(body).digest())}`;
}
function verify(token) {
  try {
    const [body, sig] = String(token).split('.');
    const expect = b64u(crypto.createHmac('sha256', SECRET).update(body).digest());
    const a = Buffer.from(sig, 'utf8'); const b = Buffer.from(expect, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Date.now() / 1000) return null;
    return payload;
  } catch { return null; }
}

// Every API route calls this; returns {email, name, role} or sends 401 itself.
function requireUser(req, res) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) { res.status(401).json({ error: 'no session token on request' }); return null; }
  const payload = verify(token);
  if (!payload) {
    let reason = 'bad signature';
    try {
      const body = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
      if (body.exp && body.exp < Date.now() / 1000) reason = 'expired';
    } catch { reason = 'malformed'; }
    res.status(401).json({ error: `session rejected (${reason}) — log in again` });
    return null;
  }
  return payload;
}
const requireAdmin = (req, res) => {
  const user = requireUser(req, res);
  if (user && user.role !== 'admin') { res.status(403).json({ error: 'admin only' }); return null; }
  return user;
};

module.exports = { SITES, PIPELINE, PORTAL, sbGet, sbWrite, hashPass, sign, verify, requireUser, requireAdmin };
