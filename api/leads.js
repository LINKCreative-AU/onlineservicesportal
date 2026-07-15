// Unified lead feed across the sites. GET, Bearer auth.
//   ?site=all|daspa|abnassist|gstregister[&status=..][&q=..][&limit=100]   list
//   ?site=..&id=..                                                         full detail (raw row + payload + state + events)
//   ?since=ISO                                                             lightweight new-lead poll for notifications
//
// Portal pipeline state (status/assignee) lives in the portal's own tables and
// overlays the site rows; the sites' own databases are never written to.

const { SITES, PORTAL, sbGet, requireUser } = require('./_lib/config');

const stateKey = (site, id) => `${site}:${id}`;

async function portalStates(pairs) {
  if (!pairs.length) return {};
  const ors = pairs.map((p) => `and(site.eq.${p.site},lead_id.eq.${p.id})`).join(',');
  const rows = (await sbGet(PORTAL, `portal_lead_state?or=(${ors})&select=*`)) || [];
  const map = {};
  for (const r of rows) map[stateKey(r.site, r.lead_id)] = r;
  return map;
}

async function fetchSite(siteId, { limit = 100, sinceIso = null } = {}) {
  const site = SITES[siteId];
  if (!site || !site.table) return [];
  const db = site.db();
  const since = sinceIso ? `&created_at=gt.${encodeURIComponent(sinceIso)}` : '';
  let rows;
  try {
    rows = (await sbGet(db, `${site.table}?select=${site.fields}&order=created_at.desc&limit=${limit}${since}`)) || [];
  } catch (e) { console.error(`${siteId} fetch failed`, e.message); return []; }
  const leads = rows.map(site.normalize);

  // GST Register also captures abandoned checkouts worth chasing
  if (site.leadsTable && !sinceIso) {
    try {
      const ab = (await sbGet(db, `${site.leadsTable}?select=id,created_at,full_name,email,mobile,abn,business_name,step,completed&completed=eq.false&order=created_at.desc&limit=50`)) || [];
      leads.push(...ab.map((r) => ({
        site: siteId, id: r.id, created_at: r.created_at,
        name: r.full_name, email: r.email, phone: r.mobile,
        service: `GST registration (abandoned at step ${r.step || '?'})`,
        amount_cents: 0, payment_status: 'unpaid', source_status: 'abandoned', abandoned: true,
      })));
    } catch (e) { console.error('gst_leads fetch failed', e.message); }
  }
  return leads;
}

module.exports = async (req, res) => {
  const user = requireUser(req, res); if (!user) return;
  try {
    const q = req.query || {};
    const siteIds = q.site && q.site !== 'all' ? [q.site] : Object.keys(SITES);

    // ---- notification poll: cheap count of arrivals since the client's watermark
    if (q.since) {
      const batches = await Promise.all(siteIds.map((s) => fetchSite(s, { limit: 20, sinceIso: q.since })));
      const fresh = batches.flat().sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      return res.status(200).json({
        count: fresh.length,
        latest: fresh.slice(0, 5).map((l) => ({ site: l.site, siteLabel: SITES[l.site].label, name: l.name, service: l.service, created_at: l.created_at })),
      });
    }

    // ---- single lead detail: full raw row + portal overlay + event history
    if (q.id && q.site && SITES[q.site]) {
      const site = SITES[q.site];
      const raw = ((await sbGet(site.db(), `${site.table}?id=eq.${encodeURIComponent(q.id)}&select=*`)) || [])[0]
        || (site.leadsTable ? ((await sbGet(site.db(), `${site.leadsTable}?id=eq.${encodeURIComponent(q.id)}&select=*`)) || [])[0] : null);
      if (!raw) return res.status(404).json({ error: 'lead not found' });
      const state = ((await sbGet(PORTAL, `portal_lead_state?site=eq.${q.site}&lead_id=eq.${encodeURIComponent(q.id)}&select=*`)) || [])[0] || null;
      const events = (await sbGet(PORTAL, `portal_lead_events?site=eq.${q.site}&lead_id=eq.${encodeURIComponent(q.id)}&select=*&order=created_at.desc&limit=100`)) || [];
      return res.status(200).json({ site: q.site, raw, state, events });
    }

    // ---- list
    const limit = Math.min(parseInt(q.limit || '100', 10) || 100, 300);
    const batches = await Promise.all(siteIds.map((s) => fetchSite(s, { limit })));
    let leads = batches.flat();

    const states = await portalStates(leads.map((l) => ({ site: l.site, id: l.id })));
    leads = leads.map((l) => {
      const st = states[stateKey(l.site, l.id)];
      return {
        ...l,
        siteLabel: SITES[l.site].label,
        status: st ? st.status : (l.abandoned ? 'abandoned' : 'new'),
        assignee: st ? st.assignee_email : null,
        assignee_name: st ? st.assignee_name : null,
      };
    });

    if (q.status) leads = leads.filter((l) => l.status === q.status);
    if (q.q) {
      const needle = String(q.q).toLowerCase();
      leads = leads.filter((l) => [l.name, l.email, l.phone, l.service].some((v) => v && String(v).toLowerCase().includes(needle)));
    }
    leads.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    return res.status(200).json({ leads: leads.slice(0, limit), serverTime: new Date().toISOString() });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'lead fetch failed — try again' });
  }
};
