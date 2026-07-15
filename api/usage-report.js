// Usage analytics + the report writer.
//   GET ?range=daily|weekly|monthly  (Bearer auth)  -> aggregated report for the window + saved history
//   GET with Authorization: Bearer <CRON_SECRET>    -> Vercel cron (daily 5am AEST): compute yesterday, save it
//
// Aggregates the structure-only tracker events into: sessions, pageviews,
// devices, top pages, per-site form funnels (start -> submit), drop-off and
// exit pages, error hotspots — then writes plain-english recommendations.

const { SITES, PORTAL, sbGet, sbWrite, requireUser } = require('./_lib/config');

const RANGES = { daily: 1, weekly: 7, monthly: 30 };

async function fetchEvents(sinceIso, untilIso) {
  const until = untilIso ? `&created_at=lt.${encodeURIComponent(untilIso)}` : '';
  // paginate to a sane cap
  const all = [];
  for (let page = 0; page < 10; page++) {
    const rows = (await sbGet(PORTAL,
      `portal_usage_events?select=site,session_id,device,type,path,detail,created_at&created_at=gt.${encodeURIComponent(sinceIso)}${until}&order=created_at.asc&limit=2000&offset=${page * 2000}`)) || [];
    all.push(...rows);
    if (rows.length < 2000) break;
  }
  return all;
}

function analyze(events, days) {
  const bySite = {};
  for (const e of events) {
    const s = (bySite[e.site] ||= { sessions: {}, pageviews: 0, devices: {}, pages: {}, errors: {}, forms: {} });
    const sess = (s.sessions[e.session_id] ||= { device: e.device, paths: [], formStart: false, formSubmit: false, secs: 0, errors: 0 });
    if (e.type === 'pageview') { s.pageviews += 1; s.pages[e.path] = (s.pages[e.path] || 0) + 1; sess.paths.push(e.path); }
    if (e.type === 'form_start') { sess.formStart = true; const f = (s.forms[e.path] ||= { started: 0, submitted: 0 }); f.started += 1; }
    if (e.type === 'form_submit') { sess.formSubmit = true; const f = (s.forms[e.path] ||= { started: 0, submitted: 0 }); f.submitted += 1; }
    if (e.type === 'jserror') { sess.errors += 1; const key = `${e.path} — ${(e.detail && e.detail.msg) || '?'}`; s.errors[key] = (s.errors[key] || 0) + 1; }
    if (e.type === 'end' && e.detail && e.detail.secs) sess.secs = Math.max(sess.secs, Math.min(e.detail.secs, 3600));
    s.devices[e.device] = (s.devices[e.device] || 0) + 1;
  }

  const report = { days, generatedAt: new Date().toISOString(), sites: {}, recommendations: [] };
  for (const [siteId, s] of Object.entries(bySite)) {
    const sessions = Object.values(s.sessions);
    const n = sessions.length;
    const started = sessions.filter((x) => x.formStart).length;
    const submitted = sessions.filter((x) => x.formSubmit).length;
    const exits = {};
    for (const x of sessions) { const last = x.paths[x.paths.length - 1]; if (last) exits[last] = (exits[last] || 0) + 1; }
    const mobile = sessions.filter((x) => x.device === 'mobile');
    const mobileConv = mobile.length ? mobile.filter((x) => x.formSubmit).length / mobile.length : null;
    const desktop = sessions.filter((x) => x.device === 'desktop');
    const desktopConv = desktop.length ? desktop.filter((x) => x.formSubmit).length / desktop.length : null;

    report.sites[siteId] = {
      label: (SITES[siteId] || {}).label || siteId,
      sessions: n, pageviews: s.pageviews,
      avgSecs: n ? Math.round(sessions.reduce((t, x) => t + x.secs, 0) / n) : 0,
      devices: s.devices,
      funnel: { visited: n, formStarted: started, submitted, startRate: n ? started / n : 0, completionRate: started ? submitted / started : 0 },
      topPages: Object.entries(s.pages).sort((a, b) => b[1] - a[1]).slice(0, 8),
      topExits: Object.entries(exits).sort((a, b) => b[1] - a[1]).slice(0, 5),
      formDropoff: Object.entries(s.forms).map(([path, f]) => ({ path, ...f, rate: f.started ? f.submitted / f.started : 0 })).sort((a, b) => b.started - a.started).slice(0, 5),
      errors: Object.entries(s.errors).sort((a, b) => b[1] - a[1]).slice(0, 5),
    };

    // ---- plain-english recommendations, worst problems first
    const label = report.sites[siteId].label;
    if (started >= 10 && submitted / started < 0.4) {
      const worst = report.sites[siteId].formDropoff[0];
      report.recommendations.push({ site: siteId, severity: 'high', text: `${label}: only ${Math.round(submitted / started * 100)}% of people who start the form finish it (${started} starts → ${submitted} submits). Biggest leak: ${worst ? worst.path : 'the form page'} — shorten it, or move the hardest questions later and let "I don't know" answers through.` });
    }
    if (mobileConv != null && desktopConv != null && desktop.length >= 10 && mobile.length >= 10 && mobileConv < desktopConv * 0.6) {
      report.recommendations.push({ site: siteId, severity: 'high', text: `${label}: mobile converts at ${Math.round(mobileConv * 100)}% vs ${Math.round(desktopConv * 100)}% on desktop, and ${Math.round(mobile.length / n * 100)}% of traffic is mobile — audit the form on a phone (field sizes, keyboard types, error visibility).` });
    }
    if (report.sites[siteId].errors.length) {
      report.recommendations.push({ site: siteId, severity: 'high', text: `${label}: JavaScript errors are firing on ${report.sites[siteId].errors[0][0].split(' — ')[0]} (${report.sites[siteId].errors[0][1]}×) — errors on a page usually mean something visitors need is broken.` });
    }
    if (n >= 20 && started / n < 0.1) {
      const topExit = report.sites[siteId].topExits[0];
      report.recommendations.push({ site: siteId, severity: 'medium', text: `${label}: only ${Math.round(started / n * 100)}% of visitors ever touch the form. Most leave from ${topExit ? topExit[0] : 'content pages'} — add a clearer next-step CTA there.` });
    }
    if (n && report.sites[siteId].avgSecs < 20 && s.pageviews / n < 1.5) {
      report.recommendations.push({ site: siteId, severity: 'medium', text: `${label}: average visit is ${report.sites[siteId].avgSecs}s with barely one page viewed — traffic may be low-intent (check which campaigns/keywords are sending it) or the landing page isn't matching what people searched for.` });
    }
  }
  if (!report.recommendations.length && Object.keys(report.sites).length) {
    report.recommendations.push({ site: 'all', severity: 'low', text: 'No red flags in this window — funnels are holding up. Keep watching completion rate as traffic grows.' });
  }
  return report;
}

module.exports = async (req, res) => {
  try {
    // Vercel cron: compute + persist yesterday's daily report
    const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (process.env.CRON_SECRET && bearer === process.env.CRON_SECRET) {
      const today = new Date(); today.setUTCHours(0, 0, 0, 0);
      const start = new Date(today.getTime() - 864e5);
      const events = await fetchEvents(start.toISOString(), today.toISOString());
      const report = analyze(events, 1);
      await sbWrite(PORTAL, 'portal_usage_reports', 'POST', { period: 'daily', period_start: start.toISOString().slice(0, 10), data: report });
      return res.status(200).json({ saved: true, sessions: Object.values(report.sites).reduce((t, s) => t + s.sessions, 0) });
    }

    const user = requireUser(req, res); if (!user) return;
    const range = RANGES[(req.query || {}).range] ? (req.query || {}).range : 'daily';
    const days = RANGES[range];
    const events = await fetchEvents(new Date(Date.now() - days * 864e5).toISOString());
    const report = analyze(events, days);
    const saved = (await sbGet(PORTAL, 'portal_usage_reports?select=period,period_start,created_at&order=period_start.desc&limit=14')) || [];
    return res.status(200).json({ range, report, savedReports: saved, tracked: events.length });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'usage report failed — try again' });
  }
};
