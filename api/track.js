// Session tracker ingestion. POST text/plain (sendBeacon-friendly, no preflight)
// from the public sites. No auth by design (it's called from visitors'
// browsers); defenses are: known-site allowlist, hard caps, structure-only
// payloads (the tracker never sends values), and no IP/user identifiers stored.

const { PORTAL, sbWrite } = require('./_lib/config');

const SITES = new Set(['daspa', 'abnassist', 'gstregister', 'cgt']);
const TYPES = new Set(['pageview', 'click', 'form_start', 'field_focus', 'form_submit', 'scroll', 'jserror', 'end']);

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).end();
  try {
    const raw = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    if (!SITES.has(raw.site) || typeof raw.sid !== 'string' || !Array.isArray(raw.events)) return res.status(204).end();
    const sid = raw.sid.slice(0, 40);
    const device = ['mobile', 'tablet', 'desktop'].includes(raw.device) ? raw.device : 'desktop';
    const rows = raw.events.slice(0, 100)
      .filter((e) => e && TYPES.has(e.t))
      .map((e) => ({
        site: raw.site, session_id: sid, device,
        type: e.t, path: String(e.p || '/').slice(0, 200),
        detail: e.d && typeof e.d === 'object' ? JSON.parse(JSON.stringify(e.d).slice(0, 500)) : null,
      }));
    if (rows.length) await sbWrite(PORTAL, 'portal_usage_events', 'POST', rows);
    return res.status(204).end();
  } catch (e) {
    console.error('track:', e.message);
    return res.status(204).end(); // never make a visitor's browser retry
  }
};
