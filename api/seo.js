// SEO rankings per site, from the Ahrefs API (v3). GET, Bearer auth.
//   ?site=daspa|abnassist|gstregister   (default: all)
//
// Uses organic keywords for each site's domain, flags our target keywords
// (seeded from each repo's SEO roadmap), and snapshots results into
// portal_seo_snapshots so position movement can be shown over time.
// Env: AHREFS_API_KEY. Degrades to a "connect" status card without it.

const { PORTAL, sbGet, sbWrite, requireUser } = require('./_lib/config');

const TARGETS = {
  daspa: {
    domain: 'daspa.com.au',
    keywords: ['dasp', 'departing australia superannuation payment', 'dasp online application', 'dasp application form',
      'dasp tax calculator', 'dasp calculator', 'withdraw super leaving australia', 'claim superannuation leaving australia',
      'superannuation refund calculator', 'nat 7204'],
  },
  abnassist: {
    domain: 'abnassist.com.au',
    keywords: ['abn registration', 'apply for abn', 'abn application', 'reactivate abn', 'cancel abn',
      'abn vs tfn', 'abn vs acn', 'business name registration', 'abn for uber'],
  },
  gstregister: {
    domain: 'gstregister.com.au',
    keywords: ['gst registration', 'register for gst', 'gst registration online', 'cancel gst registration',
      'uber gst registration', 'gst calculator', 'bas due dates', 'gst threshold'],
  },
};

async function ahrefsOrganic(domain, key) {
  const params = new URLSearchParams({
    target: domain, mode: 'subdomains', country: 'au',
    date: new Date().toISOString().slice(0, 10),
    select: 'keyword,best_position,volume,sum_traffic',
    order_by: 'sum_traffic:desc', limit: '100', output: 'json',
  });
  const r = await fetch(`https://api.ahrefs.com/v3/site-explorer/organic-keywords?${params}`, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`ahrefs ${r.status}: ${text.slice(0, 300)}`);
  const data = JSON.parse(text);
  const rows = data.keywords || data.rows || (Array.isArray(data) ? data : []);
  return rows.map((row) => ({
    keyword: row.keyword,
    position: row.best_position ?? row.position ?? null,
    volume: row.volume ?? row.keyword_volume ?? null,
    traffic: row.sum_traffic ?? row.traffic ?? null,
  })).filter((k) => k.keyword);
}

const snapKey = (site) => `seo:${site}`;

module.exports = async (req, res) => {
  const user = requireUser(req, res); if (!user) return;
  const key = process.env.AHREFS_API_KEY;
  if (!key) return res.status(200).json({ configured: false, note: 'Add AHREFS_API_KEY in Vercel env vars to light this panel up.' });
  try {
    const siteIds = req.query && req.query.site ? [req.query.site] : Object.keys(TARGETS);
    const out = {};
    for (const siteId of siteIds) {
      const t = TARGETS[siteId]; if (!t) continue;

      // previous snapshot (for movement) — refresh at most every 20h to save API units
      const prevRows = (await sbGet(PORTAL, `portal_seo_snapshots?site=eq.${siteId}&select=*&order=created_at.desc&limit=2`)) || [];
      const latest = prevRows[0] || null;
      const fresh = !latest || (Date.now() - new Date(latest.created_at)) > 20 * 3600e3;

      let current;
      if (fresh) {
        try { current = await ahrefsOrganic(t.domain, key); }
        catch (e) {
          if (latest) current = latest.data; // fall back to snapshot, still show the panel
          else { out[siteId] = { error: e.message }; continue; }
        }
        if (current !== (latest && latest.data)) {
          sbWrite(PORTAL, 'portal_seo_snapshots', 'POST', { site: siteId, data: current }).catch(() => {});
        }
      } else current = latest.data;

      const prev = fresh ? latest : prevRows[1] || null;
      const prevPos = {};
      if (prev) for (const k of prev.data || []) prevPos[k.keyword] = k.position;

      const targetSet = new Set(t.keywords.map((k) => k.toLowerCase()));
      const rows = (current || []).map((k) => ({
        ...k,
        target: targetSet.has(String(k.keyword).toLowerCase()),
        change: prevPos[k.keyword] != null && k.position != null ? prevPos[k.keyword] - k.position : null, // + = moved up
      }));
      const missingTargets = t.keywords.filter((k) => !rows.some((r) => String(r.keyword).toLowerCase() === k));
      out[siteId] = { domain: t.domain, rows, missingTargets, asOf: fresh ? new Date().toISOString() : latest.created_at };
    }
    return res.status(200).json({ configured: true, sites: out });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'seo fetch failed — try again' });
  }
};
