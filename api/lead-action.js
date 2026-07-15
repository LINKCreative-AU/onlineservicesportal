// Pipeline actions on a lead. POST, Bearer auth.
//   { site, id, action: 'take' }                       assign to yourself
//   { site, id, action: 'assign', assignee, name }     assign to a teammate
//   { site, id, action: 'status', status }             new|in_progress|lodged|cleared|refunded|dead
//   { site, id, action: 'note', note }                 timeline note
//
// Everything is an event — the timeline is the audit trail the volume stats
// are computed from.

const { SITES, PIPELINE, PORTAL, sbGet, sbWrite, requireUser } = require('./_lib/config');

async function upsertState(site, id, patch, actor) {
  const existing = ((await sbGet(PORTAL, `portal_lead_state?site=eq.${site}&lead_id=eq.${encodeURIComponent(id)}&select=site`)) || [])[0];
  const body = { ...patch, updated_at: new Date().toISOString(), updated_by: actor };
  if (existing) {
    await sbWrite(PORTAL, `portal_lead_state?site=eq.${site}&lead_id=eq.${encodeURIComponent(id)}`, 'PATCH', body);
  } else {
    await sbWrite(PORTAL, 'portal_lead_state', 'POST', { site, lead_id: id, status: 'new', ...body });
  }
}
const logEvent = (site, id, actor, actorName, event, detail) =>
  sbWrite(PORTAL, 'portal_lead_events', 'POST', {
    site, lead_id: id, actor_email: actor, actor_name: actorName, event, detail: detail || null,
  });

module.exports = async (req, res) => {
  const user = requireUser(req, res); if (!user) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  try {
    const { site, id, action } = req.body || {};
    if (!SITES[site] || !id) return res.status(400).json({ error: 'bad site/id' });

    if (action === 'take') {
      await upsertState(site, id, { assignee_email: user.email, assignee_name: user.name }, user.email);
      await logEvent(site, id, user.email, user.name, 'assigned', `${user.name} took this lead`);
      return res.status(200).json({ ok: true });
    }
    if (action === 'assign') {
      const assignee = String(req.body.assignee || '').toLowerCase();
      if (!assignee) return res.status(400).json({ error: 'assignee required' });
      await upsertState(site, id, { assignee_email: assignee, assignee_name: req.body.name || assignee }, user.email);
      await logEvent(site, id, user.email, user.name, 'assigned', `${user.name} assigned to ${req.body.name || assignee}`);
      return res.status(200).json({ ok: true });
    }
    if (action === 'status') {
      const status = String(req.body.status || '');
      if (!PIPELINE.includes(status)) return res.status(400).json({ error: 'bad status' });
      await upsertState(site, id, { status }, user.email);
      await logEvent(site, id, user.email, user.name, `status:${status}`, `${user.name} moved to ${status.replace('_', ' ')}`);
      return res.status(200).json({ ok: true });
    }
    if (action === 'note') {
      const note = String(req.body.note || '').trim().slice(0, 2000);
      if (!note) return res.status(400).json({ error: 'empty note' });
      await logEvent(site, id, user.email, user.name, 'note', note);
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: 'unknown action' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'action failed — try again' });
  }
};
