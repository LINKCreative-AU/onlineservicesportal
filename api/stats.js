// Portal stats. GET, Bearer auth. ?days=30 (7–90)
//   Everyone:  volumes  — per-user pipeline activity from the event log
//              inflow   — leads per day per site
//   Admins:    revenue  — paid per day per site (from the sites' own databases),
//              totals   — today / range / average order value
//
// Revenue never leaves the server for team-tier users.

const { SITES, PORTAL, sbGet, requireUser } = require('./_lib/config');

const dayOf = (iso) => String(iso).slice(0, 10);

module.exports = async (req, res) => {
  const user = requireUser(req, res); if (!user) return;
  try {
    const days = Math.min(Math.max(parseInt((req.query || {}).days || '30', 10) || 30, 7), 90);
    const sinceIso = new Date(Date.now() - days * 864e5).toISOString();

    // ---- per-user volumes from the portal event log
    const events = (await sbGet(PORTAL,
      `portal_lead_events?created_at=gt.${encodeURIComponent(sinceIso)}&select=actor_email,actor_name,event,site&limit=5000`)) || [];
    const volumes = {};
    for (const e of events) {
      const v = (volumes[e.actor_email] ||= { name: e.actor_name, taken: 0, lodged: 0, cleared: 0, notes: 0, bySite: {} });
      if (e.event === 'assigned') v.taken += 1;
      else if (e.event === 'status:lodged') v.lodged += 1;
      else if (e.event === 'status:cleared') v.cleared += 1;
      else if (e.event === 'note') v.notes += 1;
      if (e.event.startsWith('status:') || e.event === 'assigned') v.bySite[e.site] = (v.bySite[e.site] || 0) + 1;
    }

    // ---- inflow + (admin) revenue, straight from each site's database
    const inflow = {}; const revenue = {}; const totals = { range_cents: 0, today_cents: 0, paid_count: 0 };
    const today = dayOf(new Date().toISOString());
    await Promise.all(Object.entries(SITES).map(async ([siteId, site]) => {
      if (!site.table) return;
      let rows;
      try {
        rows = (await sbGet(site.db(),
          `${site.table}?select=${site.fields}&created_at=gt.${encodeURIComponent(sinceIso)}&order=created_at.asc&limit=2000`)) || [];
      } catch { return; }
      for (const raw of rows) {
        const l = site.normalize(raw);
        const d = dayOf(l.created_at);
        ((inflow[d] ||= {})[siteId] = (inflow[d]?.[siteId] || 0) + 1);
        if (l.payment_status === 'paid' && l.amount_cents) {
          ((revenue[d] ||= {})[siteId] = (revenue[d]?.[siteId] || 0) + l.amount_cents);
          totals.range_cents += l.amount_cents;
          totals.paid_count += 1;
          if (d === today) totals.today_cents += l.amount_cents;
        }
      }
    }));

    const base = { days, sites: Object.fromEntries(Object.entries(SITES).map(([k, s]) => [k, { label: s.label, color: s.color }])), volumes, inflow };
    if (user.role !== 'admin') return res.status(200).json(base);
    totals.avg_cents = totals.paid_count ? Math.round(totals.range_cents / totals.paid_count) : 0;
    return res.status(200).json({ ...base, revenue, totals });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'stats failed — try again' });
  }
};
