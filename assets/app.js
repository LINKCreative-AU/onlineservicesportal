/* registration office portal — app. Vanilla JS, no dependencies.
   All data flows through /api with a Bearer session token. */

(() => {
  const $ = (s, el) => (el || document).querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt$ = (cents) => '$' + (cents / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const timeAgo = (iso) => {
    const s = (Date.now() - new Date(iso)) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }) + ' · ' + new Date(iso).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' });
  };

  const SITE_META = {
    all: { label: 'all businesses', color: '#0F0F10' },
    daspa: { label: 'DASPA', color: '#2F54EB' },
    abnassist: { label: 'ABN Assist', color: '#0D9488' },
    gstregister: { label: 'GST Register', color: '#D97706' },
    cgt: { label: 'CGT Clearance', color: '#DB2777' },
  };
  const PIPELINE = ['new', 'in_progress', 'lodged', 'cleared', 'refunded', 'dead'];
  const STATUS_LABEL = { new: 'new', in_progress: 'in progress', lodged: 'lodged', cleared: 'cleared', refunded: 'refunded', dead: 'dead', abandoned: 'abandoned' };
  const SENSITIVE = /tfn|passport_number|bank_account_number|bank_bsb|bank_swift/;

  const state = {
    token: localStorage.getItem('ro_token') || null,
    user: null, users: [],
    site: 'all', panel: 'leads',
    leads: [], filters: { status: '', q: '' },
    lastSeen: localStorage.getItem('ro_lastseen') || new Date().toISOString(),
    unread: 0, stats: null, statsDays: 30,
  };

  // ---------------------------------------------------------------- api
  async function api(path, body) {
    const opts = body
      ? { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.token }, body: JSON.stringify(body) }
      : { headers: { Authorization: 'Bearer ' + state.token } };
    const r = await fetch(path, opts);
    const data = await r.json().catch(() => ({}));
    if (r.status === 401 && state.user) {
      if (window.__portalErr) window.__portalErr(`401 from ${path.split('?')[0]} right after login (server said: "${data.error || '?'}") — screenshot this`);
      logout(); throw new Error('session expired');
    }
    if (!r.ok) throw new Error(data.error || 'request failed');
    return data;
  }

  const toast = (html, ms) => {
    const el = document.createElement('div');
    el.className = 'toast'; el.innerHTML = html;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), ms || 5000);
  };

  // ---------------------------------------------------------------- auth
  async function login(email, password) {
    const r = await fetch('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'login', email, password }) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'login failed');
    state.token = data.token; localStorage.setItem('ro_token', data.token);
    state.user = data;
    enterApp(data.mustChange);
  }
  function logout() {
    localStorage.removeItem('ro_token');
    state.token = null; state.user = null;
    $('#app').hidden = true; $('#login').hidden = false;
  }

  async function enterApp(mustChange) {
    try {
      sessionStorage.setItem('ro_entered', String(Date.now()));
      $('#login').hidden = true; $('#app').hidden = false;
      $('#user-chip').textContent = (state.user.name || state.user.email).toLowerCase() + ' · ' + state.user.role;
      api('/api/auth', { action: 'users' }).then((u) => { state.users = u; }).catch(() => {});
      renderTabs(); renderPanelNav(); show('leads');
      if (mustChange) changePasswordModal(true);
      if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
      setInterval(pollNew, 45000);
      setTimeout(() => sessionStorage.removeItem('ro_entered'), 4000);
      toast(`welcome, ${(state.user.name || '').toLowerCase()} — you're in`);
      setTimeout(() => {
        const appVisible = !$('#app').hidden && document.body.contains($('#site-tabs'));
        const tabsRendered = $('#site-tabs').children.length > 0;
        if (!appVisible || !tabsRendered) window.__portalErr && window.__portalErr(`app shell failed: visible=${appVisible} tabs=${tabsRendered} — screenshot this`);
      }, 800);
    } catch (e) { if (window.__portalErr) window.__portalErr('enterApp: ' + e.message); throw e; }
  }

  function changePasswordModal(forced) {
    openModal(`
      <h3>${forced ? 'set your own password' : 'change password'}</h3>
      <p class="muted" style="font-size:13px">${forced ? 'You’re on a temporary password — pick your own to continue.' : ''}</p>
      <label>current password<input type="password" id="cp-cur" autocomplete="current-password"></label>
      <label>new password (10+ characters)<input type="password" id="cp-new" autocomplete="new-password"></label>
      <p class="err" id="cp-err" hidden></p>
      <button class="btn primary" id="cp-go" style="width:100%">save password</button>
    `, !forced);
    $('#cp-go').onclick = async () => {
      try {
        await api('/api/auth', { action: 'change-password', current: $('#cp-cur').value, password: $('#cp-new').value });
        closeModal(); toast('password updated');
      } catch (e) { const el = $('#cp-err'); el.textContent = e.message; el.hidden = false; }
    };
  }

  // ---------------------------------------------------------------- shell
  function renderTabs() {
    $('#site-tabs').innerHTML = Object.entries(SITE_META).map(([id, m]) =>
      `<button data-site="${id}" class="${state.site === id ? 'on' : ''}">${id !== 'all' ? `<span class="site-dot" style="background:${m.color}"></span>` : ''}${esc(m.label)}</button>`).join('');
    $('#site-tabs').querySelectorAll('button').forEach((b) => b.onclick = () => { state.site = b.dataset.site; renderTabs(); show(state.panel); });
  }
  function renderPanelNav() {
    const admin = state.user.role === 'admin';
    const panels = [
      ['leads', 'leads'], ['team', 'team'],
      ...(admin ? [['revenue', 'revenue'], ['ads', 'ads & roi']] : []),
      ['seo', 'seo'], ['reports', 'usage reports <span class="soon">phase 2</span>'],
    ];
    $('#panel-nav').innerHTML = panels.map(([id, label]) => `<button data-p="${id}" class="${state.panel === id ? 'on' : ''}">${label}</button>`).join('');
    $('#panel-nav').querySelectorAll('button').forEach((b) => b.onclick = () => show(b.dataset.p));
  }
  function show(panel) {
    state.panel = panel; renderPanelNav();
    if (panel === 'leads') return renderLeads();
    if (panel === 'revenue') return renderRevenue();
    if (panel === 'team') return renderTeam();
    if (panel === 'seo') return renderSEO();
    if (panel === 'ads') return renderAds();
    $('#main').innerHTML = '<div class="card coming"><h2>usage reports</h2><p class="muted">The session-intelligence agent writes its daily, weekly and monthly conversion reports here (phase 2).</p></div>';
  }

  // ---------------------------------------------------------------- leads
  async function loadLeads() {
    const p = new URLSearchParams({ site: state.site });
    if (state.filters.status) p.set('status', state.filters.status);
    if (state.filters.q) p.set('q', state.filters.q);
    const data = await api('/api/leads?' + p);
    state.leads = data.leads;
    state.lastSeen = data.serverTime; localStorage.setItem('ro_lastseen', data.serverTime);
    state.unread = 0; updateBadge();
  }

  async function renderLeads() {
    $('#main').innerHTML = `
      <div class="filters">
        <input type="search" id="f-q" placeholder="search name, email, phone…" value="${esc(state.filters.q)}">
        <select id="f-status">
          <option value="">every status</option>
          ${['new', 'in_progress', 'lodged', 'cleared', 'refunded', 'dead', 'abandoned'].map((s) => `<option value="${s}" ${state.filters.status === s ? 'selected' : ''}>${STATUS_LABEL[s]}</option>`).join('')}
        </select>
        <span class="muted" id="lead-count" style="font-size:13px"></span>
        <span style="flex:1"></span>
        <button class="btn ghost sm-btn" id="refresh">refresh</button>
      </div>
      <div class="card" style="padding:6px 8px"><table class="grid" id="lead-table"><tbody><tr><td class="empty">loading…</td></tr></tbody></table></div>`;
    $('#f-q').oninput = debounce(() => { state.filters.q = $('#f-q').value; renderLeadRows(); }, 250);
    $('#f-status').onchange = () => { state.filters.status = $('#f-status').value; loadLeads().then(renderLeadRows); };
    $('#refresh').onclick = () => loadLeads().then(renderLeadRows);
    try { await loadLeads(); renderLeadRows(); } catch (e) { $('#lead-table tbody').innerHTML = `<tr><td class="empty">${esc(e.message)}</td></tr>`; }
  }

  function renderLeadRows() {
    const needle = state.filters.q.toLowerCase();
    const rows = state.leads.filter((l) => !needle || [l.name, l.email, l.phone, l.service].some((v) => v && String(v).toLowerCase().includes(needle)));
    $('#lead-count').textContent = rows.length + ' lead' + (rows.length === 1 ? '' : 's');
    $('#lead-table').innerHTML = `
      <thead><tr><th>lead</th><th>business</th><th>service</th><th>payment</th><th>status</th><th>assigned</th><th>came in</th></tr></thead>
      <tbody>${rows.length ? rows.map((l, i) => `
        <tr class="rowlink" data-i="${i}">
          <td><div class="lead-name">${esc(l.name || '—')}</div><div class="lead-sub">${esc(l.email || '')}${l.phone ? ' · ' + esc(l.phone) : ''}</div></td>
          <td><span class="site-pill"><i style="background:${SITE_META[l.site].color}"></i>${esc(l.siteLabel)}</span></td>
          <td style="font-size:13px">${esc(l.service || '')}</td>
          <td><span class="chip ${l.payment_status === 'paid' ? 'paid' : 'unpaid'}">${esc(l.payment_status || '—')}</span></td>
          <td><span class="chip ${l.status}">${STATUS_LABEL[l.status] || esc(l.status)}</span></td>
          <td class="assignee ${l.assignee ? '' : 'none'}">${esc(l.assignee_name || (l.assignee || 'unassigned'))}</td>
          <td class="lead-sub" title="${esc(l.created_at)}">${timeAgo(l.created_at)}</td>
        </tr>`).join('') : '<tr><td colspan="7" class="empty">no leads match</td></tr>'}
      </tbody>`;
    $('#lead-table').querySelectorAll('tr.rowlink').forEach((tr) => tr.onclick = () => openLead(rows[+tr.dataset.i]));
  }

  // ---------------------------------------------------------------- lead drawer
  async function openLead(lead) {
    const drawer = $('#drawer'); const veil = $('#drawer-veil');
    drawer.hidden = false; veil.hidden = false;
    veil.onclick = closeDrawer;
    drawer.innerHTML = '<p class="empty">loading…</p>';
    let d;
    try { d = await api(`/api/leads?site=${lead.site}&id=${encodeURIComponent(lead.id)}`); }
    catch (e) { drawer.innerHTML = `<p class="empty">${esc(e.message)}</p>`; return; }

    const status = (d.state && d.state.status) || lead.status || 'new';
    const fields = flatten(d.raw);
    drawer.innerHTML = `
      <button class="d-close" id="d-close">✕</button>
      <h2>${esc(lead.name || 'lead')}</h2>
      <div class="d-meta"><span class="site-pill"><i style="background:${SITE_META[lead.site].color}"></i>${esc(SITE_META[lead.site].label)}</span>
        · ${esc(lead.service || '')} · came in ${timeAgo(lead.created_at)}
        ${lead.payment_status ? ` · <span class="chip ${lead.payment_status === 'paid' ? 'paid' : 'unpaid'}">${esc(lead.payment_status)}</span>` : ''}</div>

      <div class="d-actions">
        <button class="btn blue sm-btn" id="d-take">i’ll take it</button>
        <select id="d-assign" class="btn ghost sm-btn" style="appearance:auto">
          <option value="">assign to…</option>
          ${state.users.map((u) => `<option value="${esc(u.email)}" data-name="${esc(u.name)}">${esc(u.name.toLowerCase())}</option>`).join('')}
        </select>
        <span class="assignee" style="align-self:center">${d.state && d.state.assignee_name ? 'with ' + esc(d.state.assignee_name.toLowerCase()) : 'unassigned'}</span>
      </div>

      <div class="pipeline" id="d-pipeline">
        ${PIPELINE.map((s) => `<button data-s="${s}" class="${s === status ? 'on' : ''}">${STATUS_LABEL[s]}</button>`).join('')}
      </div>

      <div class="section-title">full submission</div>
      <dl class="kv">${fields.map(([k, v]) => {
        const sensitive = SENSITIVE.test(k);
        return `<dt>${esc(k.replace(/_/g, ' '))}</dt><dd class="${sensitive ? 'mask' : ''}" ${sensitive ? `data-full="${esc(v)}"` : ''}>${sensitive ? '••••••' + `<button class="reveal">show</button>` : esc(v)}</dd>`;
      }).join('')}</dl>

      <div class="section-title">activity</div>
      <ul class="timeline" id="d-timeline">${timelineHtml(d.events)}</ul>
      <div class="notebox"><input id="d-note" placeholder="add a note for the team…"><button class="btn primary sm-btn" id="d-note-go">note</button></div>`;

    $('#d-close').onclick = closeDrawer;
    drawer.querySelectorAll('.reveal').forEach((b) => b.onclick = () => { const dd = b.closest('dd'); dd.textContent = dd.dataset.full; dd.classList.remove('mask'); });
    const act = async (body, msg) => {
      try { await api('/api/lead-action', { site: lead.site, id: lead.id, ...body }); toast(msg); openLead(lead); loadLeads().then(renderLeadRows); }
      catch (e) { toast(esc(e.message)); }
    };
    $('#d-take').onclick = () => act({ action: 'take' }, 'it’s yours');
    $('#d-assign').onchange = (e) => { const o = e.target.selectedOptions[0]; if (o.value) act({ action: 'assign', assignee: o.value, name: o.dataset.name }, 'assigned to ' + o.dataset.name.toLowerCase()); };
    $('#d-pipeline').querySelectorAll('button').forEach((b) => b.onclick = () => act({ action: 'status', status: b.dataset.s }, 'moved to ' + STATUS_LABEL[b.dataset.s]));
    $('#d-note-go').onclick = () => { const n = $('#d-note').value.trim(); if (n) act({ action: 'note', note: n }, 'noted'); };
  }
  const timelineHtml = (events) => (events && events.length
    ? events.map((e) => `<li>${esc(e.detail || e.event)}<div class="tl-time">${esc(e.actor_name || e.actor_email)} · ${timeAgo(e.created_at)}</div></li>`).join('')
    : '<li>no activity yet<div class="tl-time">actions and notes land here</div></li>');
  function closeDrawer() { $('#drawer').hidden = true; $('#drawer-veil').hidden = true; }

  function flatten(raw) {
    const out = [];
    const skip = /^(id|stripe_session_id|didit_session_id|pass_|nudge_|lodged_email)/;
    for (const [k, v] of Object.entries(raw || {})) {
      if (v == null || v === '' || skip.test(k)) continue;
      if (k === 'payload' && typeof v === 'object') {
        for (const [pk, pv] of Object.entries(v)) if (pv != null && pv !== '') out.push([pk, typeof pv === 'object' ? JSON.stringify(pv) : String(pv)]);
      } else out.push([k, typeof v === 'object' ? JSON.stringify(v) : String(v)]);
    }
    return out;
  }

  // ---------------------------------------------------------------- notifications
  async function pollNew() {
    if (!state.token) return;
    try {
      const data = await api('/api/leads?since=' + encodeURIComponent(state.lastSeen));
      if (data.count > 0) {
        state.unread += data.count; updateBadge();
        const first = data.latest[0];
        toast(`<b>new lead</b> — ${esc(first.name || 'someone')} · ${esc(first.siteLabel)}${data.count > 1 ? ` (+${data.count - 1} more)` : ''}`, 8000);
        if ('Notification' in window && Notification.permission === 'granted') {
          new Notification('new lead — ' + (first.siteLabel || ''), { body: `${first.name || ''} · ${first.service || ''}` });
        }
        state.lastSeen = new Date().toISOString(); localStorage.setItem('ro_lastseen', state.lastSeen);
        if (state.panel === 'leads') loadLeads().then(renderLeadRows).catch(() => {});
      }
    } catch { /* transient */ }
  }
  function updateBadge() {
    const b = $('#bell-badge');
    b.hidden = !state.unread; b.textContent = state.unread > 9 ? '9+' : state.unread;
  }

  // ---------------------------------------------------------------- revenue (admin)
  async function renderRevenue() {
    $('#main').innerHTML = '<p class="empty">loading…</p>';
    try { state.stats = await api('/api/stats?days=' + state.statsDays); }
    catch (e) { $('#main').innerHTML = `<div class="card empty">${esc(e.message)}</div>`; return; }
    const s = state.stats;
    if (!s.totals) { $('#main').innerHTML = '<div class="card empty">revenue is admin-only</div>'; return; }

    const siteIds = state.site === 'all' ? Object.keys(SITE_META).filter((k) => k !== 'all') : [state.site];
    const perSite = {};
    for (const day of Object.values(s.revenue || {})) for (const [k, v] of Object.entries(day)) perSite[k] = (perSite[k] || 0) + v;
    const rangeTotal = siteIds.reduce((t, k) => t + (perSite[k] || 0), 0);

    $('#main').innerHTML = `
      <div class="filters">
        <select id="r-days">${[7, 30, 90].map((d) => `<option value="${d}" ${state.statsDays === d ? 'selected' : ''}>last ${d} days</option>`).join('')}</select>
      </div>
      <div class="tiles">
        <div class="tile"><div class="t-label">today</div><div class="t-value">${fmt$(s.totals.today_cents)}</div><div class="t-sub">collected across all sites</div></div>
        <div class="tile"><div class="t-label">last ${s.days} days</div><div class="t-value">${fmt$(s.totals.range_cents)}</div><div class="t-sub">${s.totals.paid_count} paid orders</div></div>
        <div class="tile"><div class="t-label">average order</div><div class="t-value">${fmt$(s.totals.avg_cents)}</div><div class="t-sub">paid orders, all sites</div></div>
        ${siteIds.length > 1 ? siteIds.map((k) => `<div class="tile"><div class="t-label">${esc(SITE_META[k].label.toLowerCase())}</div><div class="t-value" style="font-size:22px">${fmt$(perSite[k] || 0)}</div><div class="t-sub">last ${s.days} days</div></div>`).join('') : ''}
      </div>
      <div class="card chart-card">
        <div class="section-title" style="margin-top:0">revenue per day${state.site !== 'all' ? ' — ' + esc(SITE_META[state.site].label.toLowerCase()) : ''}</div>
        ${siteIds.length > 1 ? `<div class="legend">${siteIds.map((k) => `<span><i style="background:${SITE_META[k].color}"></i>${esc(SITE_META[k].label.toLowerCase())}</span>`).join('')}</div>` : ''}
        <div id="rev-chart"></div>
      </div>
      <div class="section-title">by the numbers</div>
      <div class="card" style="padding:6px 8px"><table class="grid"><thead><tr><th>day</th>${siteIds.map((k) => `<th>${esc(SITE_META[k].label.toLowerCase())}</th>`).join('')}<th>total</th></tr></thead>
        <tbody>${revTableRows(s, siteIds)}</tbody></table></div>`;
    $('#r-days').onchange = (e) => { state.statsDays = +e.target.value; renderRevenue(); };
    drawBars($('#rev-chart'), s, siteIds);
  }

  function revTableRows(s, siteIds) {
    const days = lastNDays(s.days);
    const rows = days.map((d) => {
      const day = (s.revenue || {})[d] || {};
      const total = siteIds.reduce((t, k) => t + (day[k] || 0), 0);
      return { d, day, total };
    }).filter((r) => r.total > 0).reverse();
    if (!rows.length) return '<tr><td colspan="9" class="empty">no paid orders in this window yet</td></tr>';
    return rows.map((r) => `<tr><td>${fmtDay(r.d)}</td>${siteIds.map((k) => `<td>${r.day[k] ? fmt$(r.day[k]) : '<span class="muted">—</span>'}</td>`).join('')}<td><b>${fmt$(r.total)}</b></td></tr>`).join('');
  }

  const lastNDays = (n) => Array.from({ length: n }, (_, i) => new Date(Date.now() - (n - 1 - i) * 864e5).toISOString().slice(0, 10));
  const fmtDay = (d) => new Date(d + 'T00:00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });

  // Stacked daily bars: thin marks, 2px surface gaps between segments and bars,
  // rounded top on the topmost segment, recessive grid, hover tooltip per bar.
  function drawBars(mount, s, siteIds) {
    const days = lastNDays(s.days);
    const series = days.map((d) => siteIds.map((k) => ((s.revenue || {})[d] || {})[k] || 0));
    const max = Math.max(100, ...series.map((v) => v.reduce((a, b) => a + b, 0)));
    const W = 1000, H = 260, padL = 56, padB = 26, padT = 12;
    const iw = (W - padL - 10) / days.length;
    const bw = Math.max(4, Math.min(26, iw - 2));
    const y = (v) => padT + (H - padT - padB) * (1 - v / max);

    const ticks = niceTicks(max);
    let svg = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="revenue per day">`;
    for (const t of ticks) {
      svg += `<line x1="${padL}" x2="${W - 6}" y1="${y(t)}" y2="${y(t)}" stroke="#EFEFED" stroke-width="1"/>`
           + `<text x="${padL - 8}" y="${y(t) + 4}" text-anchor="end" font-size="11" fill="#8B8B93">$${t >= 100000 ? (t / 100000) + 'k' : Math.round(t / 100)}</text>`;
    }
    days.forEach((d, i) => {
      const x = padL + i * iw + (iw - bw) / 2;
      let acc = 0; const total = series[i].reduce((a, b) => a + b, 0);
      const topIdx = series[i].map((v, j) => (v > 0 ? j : -1)).filter((j) => j >= 0).pop();
      series[i].forEach((v, j) => {
        if (!v) return;
        const y1 = y(acc + v), h = Math.max(1.5, y(acc) - y(acc + v) - (acc ? 2 : 0));
        const r = j === topIdx ? 4 : 0;
        svg += `<path d="M${x},${y1 + h} L${x},${y1 + r} Q${x},${y1} ${x + r},${y1} L${x + bw - r},${y1} Q${x + bw},${y1} ${x + bw},${y1 + r} L${x + bw},${y1 + h} Z" fill="${SITE_META[siteIds[j]].color}"/>`;
        acc += v;
      });
      if (i === days.length - 1 && total) svg += `<text x="${x + bw / 2}" y="${y(total) - 6}" text-anchor="middle" font-size="11" font-weight="700" fill="#55555C">${fmt$(total)}</text>`;
      svg += `<rect class="hit" data-i="${i}" x="${padL + i * iw}" y="${padT}" width="${iw}" height="${H - padT - padB}" fill="transparent"/>`;
      if (days.length <= 14 || i % Math.ceil(days.length / 12) === 0) {
        svg += `<text x="${x + bw / 2}" y="${H - 8}" text-anchor="middle" font-size="10.5" fill="#8B8B93">${fmtDay(d)}</text>`;
      }
    });
    svg += '</svg>';
    mount.innerHTML = svg;

    let tip;
    mount.querySelectorAll('.hit').forEach((r) => {
      r.addEventListener('mousemove', (ev) => {
        const i = +r.dataset.i; const vals = series[i]; const total = vals.reduce((a, b) => a + b, 0);
        if (!tip) { tip = document.createElement('div'); tip.className = 'tooltip'; document.body.appendChild(tip); }
        tip.innerHTML = `<div class="tt-title">${fmtDay(days[i])}</div>` +
          siteIds.map((k, j) => vals[j] ? `<div class="tt-row"><span><i style="background:${SITE_META[k].color}"></i>${esc(SITE_META[k].label.toLowerCase())}</span><span>${fmt$(vals[j])}</span></div>` : '').join('') +
          (siteIds.length > 1 ? `<div class="tt-row" style="margin-top:3px"><span>total</span><b>${fmt$(total)}</b></div>` : '');
        tip.style.left = Math.min(ev.clientX + 14, innerWidth - 250) + 'px';
        tip.style.top = (ev.clientY + 14) + 'px';
      });
      r.addEventListener('mouseleave', () => { if (tip) { tip.remove(); tip = null; } });
    });
  }
  function niceTicks(maxCents) {
    const steps = [5000, 10000, 25000, 50000, 100000, 250000, 500000, 1000000, 2500000];
    const step = steps.find((s) => maxCents / s <= 5) || 5000000;
    const out = []; for (let v = step; v <= maxCents; v += step) out.push(v);
    return out.length ? out : [maxCents];
  }

  // ---------------------------------------------------------------- team: members + volumes
  async function renderTeam() {
    $('#main').innerHTML = '<p class="empty">loading…</p>';
    try {
      [state.stats, state.users] = await Promise.all([api('/api/stats?days=' + state.statsDays), api('/api/auth', { action: 'users' })]);
    } catch (e) { $('#main').innerHTML = `<div class="card empty">${esc(e.message)}</div>`; return; }
    const s = state.stats;
    const admin = state.user.role === 'admin';
    const people = Object.entries(s.volumes || {}).sort((a, b) => (b[1].cleared + b[1].lodged) - (a[1].cleared + a[1].lodged));
    const inflowTotal = Object.values(s.inflow || {}).reduce((t, d) => t + Object.values(d).reduce((a, b) => a + b, 0), 0);

    const memberRow = (u) => {
      const self = u.email === state.user.email;
      const status = u.pending
        ? '<span class="chip in_progress">invited — not set up yet</span>'
        : (u.lastLogin ? `<span class="chip cleared">active</span> <span class="lead-sub">last seen ${timeAgo(u.lastLogin)}</span>` : '<span class="chip new">never logged in</span>');
      const access = admin && !self
        ? `<select data-role-for="${esc(u.email)}" class="btn ghost sm-btn" style="appearance:auto">
             <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>admin</option>
             <option value="team" ${u.role === 'team' ? 'selected' : ''}>team</option></select>`
        : `<span class="chip ${u.role === 'admin' ? 'lodged' : 'new'}">${u.role}</span>${self ? ' <span class="lead-sub">(you)</span>' : ''}`;
      const actions = admin && !self
        ? `${u.pending ? `<button class="btn ghost sm-btn" data-resend="${esc(u.email)}">re-send invite</button> ` : ''}<button class="btn ghost sm-btn" data-remove="${esc(u.email)}" style="color:var(--serious)">remove</button>`
        : '';
      return `<tr><td><div class="lead-name">${esc((u.name || '').toLowerCase())}</div><div class="lead-sub">${esc(u.email)}</div></td>
        <td>${access}</td><td>${status}</td><td>${actions}</td></tr>`;
    };

    $('#main').innerHTML = `
      <div class="filters"><select id="t-days">${[7, 30, 90].map((d) => `<option value="${d}" ${state.statsDays === d ? 'selected' : ''}>last ${d} days</option>`).join('')}</select>
        <span style="flex:1"></span>
        ${admin ? '<button class="btn blue sm-btn" id="t-invite">invite someone</button>' : ''}</div>

      <div class="section-title" style="margin-top:4px">members</div>
      <div class="card" style="padding:6px 8px"><table class="grid">
        <thead><tr><th>person</th><th>access</th><th>status</th><th></th></tr></thead>
        <tbody>${state.users.map(memberRow).join('')}</tbody></table></div>

      <div class="section-title">activity</div>
      <div class="tiles">
        <div class="tile"><div class="t-label">leads in</div><div class="t-value">${inflowTotal}</div><div class="t-sub">all sites, last ${s.days} days</div></div>
        ${people.map(([email, v]) => `<div class="tile"><div class="t-label">${esc((v.name || email).toLowerCase())}</div><div class="t-value" style="font-size:22px">${v.cleared} cleared</div><div class="t-sub">${v.taken} taken · ${v.lodged} lodged</div></div>`).join('')}
      </div>
      <div class="section-title">who's doing what</div>
      <div class="card" style="padding:6px 8px"><table class="grid">
        <thead><tr><th>person</th><th>taken</th><th>lodged</th><th>cleared</th><th>notes</th><th>most active on</th></tr></thead>
        <tbody>${people.length ? people.map(([email, v]) => {
          const top = Object.entries(v.bySite).sort((a, b) => b[1] - a[1])[0];
          return `<tr><td class="lead-name">${esc((v.name || email).toLowerCase())}</td><td>${v.taken}</td><td>${v.lodged}</td><td><b>${v.cleared}</b></td><td>${v.notes}</td>
            <td>${top ? `<span class="site-pill"><i style="background:${SITE_META[top[0]].color}"></i>${esc(SITE_META[top[0]].label)}</span>` : '<span class="muted">—</span>'}</td></tr>`;
        }).join('') : '<tr><td colspan="6" class="empty">no pipeline activity yet — it shows up as soon as someone takes a lead</td></tr>'}
        </tbody></table></div>`;

    $('#main').querySelectorAll('[data-role-for]').forEach((sel) => sel.onchange = async () => {
      try { await api('/api/auth', { action: 'set-role', email: sel.dataset.roleFor, role: sel.value }); toast(`${sel.dataset.roleFor} is now ${sel.value}`); }
      catch (e) { toast(esc(e.message)); renderTeam(); }
    });
    $('#main').querySelectorAll('[data-resend]').forEach((b) => b.onclick = async () => {
      try { await api('/api/auth', { action: 'invite', email: b.dataset.resend }); toast('invite re-sent to ' + b.dataset.resend); }
      catch (e) { toast(esc(e.message)); }
    });
    $('#main').querySelectorAll('[data-remove]').forEach((b) => b.onclick = async () => {
      if (!confirm(`Remove ${b.dataset.remove}'s access to the portal?`)) return;
      try { await api('/api/auth', { action: 'remove-user', email: b.dataset.remove }); toast('removed ' + b.dataset.remove); renderTeam(); }
      catch (e) { toast(esc(e.message)); }
    });
    $('#t-days').onchange = (e) => { state.statsDays = +e.target.value; renderTeam(); };
    const inviteBtn = $('#t-invite');
    if (inviteBtn) inviteBtn.onclick = () => {
      openModal(`
        <h3>invite someone</h3>
        <p class="muted" style="font-size:13px">They get an email with a set-password link and land straight in the portal.</p>
        <label>name<input id="iv-name" placeholder="Chris"></label>
        <label>email<input id="iv-email" type="email" placeholder="chris@link.com.au"></label>
        <label>access<select id="iv-role" style="display:block;width:100%;margin-top:5px;padding:11px 14px;border:1.5px solid var(--line);border-radius:12px;background:var(--bg)">
          <option value="admin">admin — sees revenue, ads & roi</option>
          <option value="team">team — leads & seo only</option>
        </select></label>
        <p class="err" id="iv-err" hidden></p>
        <button class="btn primary" id="iv-go" style="width:100%">send invite</button>
      `);
      $('#iv-go').onclick = async () => {
        const err = $('#iv-err'); err.hidden = true;
        try {
          const r = await api('/api/auth', { action: 'add-user', email: $('#iv-email').value.trim(), name: $('#iv-name').value.trim(), role: $('#iv-role').value });
          if (r.invited) { closeModal(); toast(`invite emailed to ${r.created}`); }
          else {
            err.style.color = '';
            err.textContent = r.emailError
              ? `account created but the email failed (${r.emailError}) — temp password: ${r.tempPassword}`
              : `account created — temp password (share securely, shown once): ${r.tempPassword}`;
            err.hidden = false;
          }
          renderTeam();
        } catch (ex) { err.textContent = ex.message; err.hidden = false; }
      };
    };
  }

  // ---------------------------------------------------------------- seo (ahrefs)
  async function renderSEO() {
    $('#main').innerHTML = '<p class="empty">loading rankings…</p>';
    let data;
    try { data = await api('/api/seo' + (state.site !== 'all' && state.site !== 'cgt' ? '?site=' + state.site : '')); }
    catch (e) { $('#main').innerHTML = `<div class="card empty">${esc(e.message)}</div>`; return; }
    if (!data.configured) {
      $('#main').innerHTML = `<div class="card coming"><h2>seo rankings</h2><p class="muted">${esc(data.note)}</p></div>`;
      return;
    }
    $('#main').innerHTML = Object.entries(data.sites).map(([siteId, s]) => {
      if (s.error) return `<div class="card" style="margin-bottom:16px"><div class="section-title" style="margin-top:0">${esc(SITE_META[siteId].label.toLowerCase())}</div><p class="err">${esc(s.error)}</p></div>`;
      const targets = s.rows.filter((r) => r.target);
      const rest = s.rows.filter((r) => !r.target).slice(0, 20);
      const row = (r) => `<tr>
        <td class="lead-name" style="font-weight:${r.target ? 700 : 500}">${esc(r.keyword)}${r.target ? ' <span class="chip new">target</span>' : ''}</td>
        <td><b>#${r.position ?? '—'}</b></td>
        <td>${r.change == null || r.change === 0 ? '<span class="muted">—</span>' : r.change > 0 ? `<span style="color:var(--good);font-weight:700">▲ ${r.change}</span>` : `<span style="color:var(--serious);font-weight:700">▼ ${-r.change}</span>`}</td>
        <td>${r.volume ?? '—'}</td><td>${r.traffic ?? '—'}</td></tr>`;
      return `<div class="card" style="margin-bottom:16px;padding:14px 16px">
        <div class="section-title" style="margin-top:0"><span class="site-pill"><i style="background:${SITE_META[siteId].color}"></i>${esc(SITE_META[siteId].label.toLowerCase())}</span> · ${esc(s.domain)} <span class="muted" style="font-weight:500;font-size:12px">as of ${timeAgo(s.asOf)}</span></div>
        <table class="grid"><thead><tr><th>keyword</th><th>position</th><th>move</th><th>volume (au)</th><th>traffic</th></tr></thead>
        <tbody>${targets.map(row).join('')}${rest.map(row).join('') || ''}${!s.rows.length ? '<tr><td colspan="5" class="empty">no organic keywords found yet — normal pre-cutover</td></tr>' : ''}</tbody></table>
        ${s.missingTargets && s.missingTargets.length ? `<p class="muted" style="font-size:12.5px;margin:10px 4px 2px">not ranking yet: ${s.missingTargets.map(esc).join(' · ')}</p>` : ''}
      </div>`;
    }).join('');
  }

  // ---------------------------------------------------------------- ads & roi (admin)
  async function renderAds() {
    $('#main').innerHTML = '<p class="empty">loading ad spend…</p>';
    let ads;
    try { ads = await api('/api/ads?days=' + state.statsDays); }
    catch (e) { $('#main').innerHTML = `<div class="card empty">${esc(e.message)}</div>`; return; }
    if (!ads.configured) {
      $('#main').innerHTML = `<div class="card coming"><h2>google ads & roi</h2>
        <p class="muted">still needed:</p>
        <ul style="text-align:left;max-width:560px;margin:10px auto;color:var(--ink-2)">${ads.missing.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>
        ${ads.missing.some((m) => m.includes('connect google ads')) ? '<button class="btn blue" id="gads-connect">connect google ads</button>' : ''}</div>`;
      const b = $('#gads-connect');
      if (b) b.onclick = async () => { try { const r = await api('/api/google-oauth', { action: 'start' }); location.href = r.url; } catch (e) { toast(esc(e.message)); } };
      return;
    }
    // revenue for ROI comes from the stats endpoint
    let rev = {};
    try { const s = await api('/api/stats?days=' + state.statsDays); for (const day of Object.values(s.revenue || {})) for (const [k, v] of Object.entries(day)) rev[k] = (rev[k] || 0) + v; } catch {}
    const siteIds = Object.keys(SITE_META).filter((k) => k !== 'all');
    const totalSpend = Object.values(ads.spendBySite).reduce((a, b) => a + b, 0);
    const totalRev = siteIds.reduce((t, k) => t + (rev[k] || 0), 0);
    $('#main').innerHTML = `
      <div class="filters"><select id="a-days">${[7, 30, 90].map((d) => `<option value="${d}" ${state.statsDays === d ? 'selected' : ''}>last ${d} days</option>`).join('')}</select></div>
      <div class="tiles">
        <div class="tile"><div class="t-label">ad spend</div><div class="t-value">${fmt$(totalSpend)}</div><div class="t-sub">last ${ads.days} days, all accounts</div></div>
        <div class="tile"><div class="t-label">revenue</div><div class="t-value">${fmt$(totalRev)}</div><div class="t-sub">same window</div></div>
        <div class="tile"><div class="t-label">roi</div><div class="t-value">${totalSpend ? ((totalRev - totalSpend) / totalSpend * 100).toFixed(0) + '%' : '—'}</div><div class="t-sub">(revenue − spend) / spend</div></div>
      </div>
      <div class="section-title">per business</div>
      <div class="card" style="padding:6px 8px"><table class="grid">
        <thead><tr><th>business</th><th>spend</th><th>revenue</th><th>roi</th></tr></thead>
        <tbody>${siteIds.map((k) => {
          const sp = ads.spendBySite[k] || 0; const rv = rev[k] || 0;
          return `<tr><td><span class="site-pill"><i style="background:${SITE_META[k].color}"></i>${esc(SITE_META[k].label)}</span></td>
            <td>${sp ? fmt$(sp) : '<span class="muted">—</span>'}</td><td>${rv ? fmt$(rv) : '<span class="muted">—</span>'}</td>
            <td>${sp ? `<b>${((rv - sp) / sp * 100).toFixed(0)}%</b>` : '<span class="muted">—</span>'}</td></tr>`;
        }).join('')}${ads.spendBySite.other ? `<tr><td class="muted">unmatched campaigns</td><td>${fmt$(ads.spendBySite.other)}</td><td></td><td></td></tr>` : ''}</tbody></table></div>
      <div class="section-title">campaigns</div>
      <div class="card" style="padding:6px 8px"><table class="grid">
        <thead><tr><th>campaign</th><th>business</th><th>spend</th><th>clicks</th><th>impressions</th></tr></thead>
        <tbody>${ads.campaigns.length ? ads.campaigns.map((c) => `<tr><td class="lead-name">${esc(c.name)}</td>
          <td>${c.siteId !== 'other' ? `<span class="site-pill"><i style="background:${SITE_META[c.siteId].color}"></i>${esc(SITE_META[c.siteId].label)}</span>` : '<span class="muted">unmatched</span>'}</td>
          <td>${fmt$(c.spend_cents)}</td><td>${c.clicks}</td><td>${c.impressions}</td></tr>`).join('') : '<tr><td colspan="5" class="empty">no spend in this window</td></tr>'}</tbody></table></div>`;
    $('#a-days').onchange = (e) => { state.statsDays = +e.target.value; renderAds(); };
  }

  // ---------------------------------------------------------------- modal helpers
  function openModal(html, dismissable = true) {
    $('#modal').innerHTML = html;
    $('#modal-veil').hidden = false;
    $('#modal-veil').onclick = dismissable ? (e) => { if (e.target === $('#modal-veil')) closeModal(); } : null;
  }
  function closeModal() { $('#modal-veil').hidden = true; }
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  // ---------------------------------------------------------------- boot
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#login-err');
    err.textContent = 'logging in…'; err.hidden = false; err.style.color = '#55555C';
    try { await login($('#login-email').value.trim(), $('#login-pass').value); err.hidden = true; }
    catch (ex) { err.textContent = ex.message; err.style.color = ''; err.hidden = false; }
  });
  $('#logout').onclick = logout;
  $('#forgot').onclick = async (e) => {
    e.preventDefault();
    const email = prompt('email on your account:');
    if (!email) return;
    await fetch('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'reset-request', email: email.trim() }) }).catch(() => {});
    toast('if that email has an account, a set-password link is on its way');
  };
  const inviteTok = new URLSearchParams(location.search).get('invite');
  if (inviteTok) {
    $('#login').hidden = false;
    $('#login-form').hidden = true; $('#invite-form').hidden = false;
    $('#invite-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('#invite-err');
      err.textContent = 'saving…'; err.hidden = false; err.style.color = '#55555C';
      if ($('#invite-pass').value !== $('#invite-pass2').value) { err.textContent = 'passwords don’t match'; err.style.color = ''; return; }
      try {
        const r = await fetch('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'accept-invite', token: inviteTok, password: $('#invite-pass').value }) });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'failed');
        state.token = data.token; localStorage.setItem('ro_token', data.token);
        state.user = data;
        history.replaceState(null, '', '/');
        $('#login-form').hidden = false; $('#invite-form').hidden = true;
        err.hidden = true;
        enterApp(false);
      } catch (ex) { err.textContent = ex.message; err.style.color = ''; err.hidden = false; }
    });
  }
  $('#bell').onclick = () => { state.unread = 0; updateBadge(); if (state.panel !== 'leads') show('leads'); else loadLeads().then(renderLeadRows); };
  $('#user-chip').onclick = () => changePasswordModal(false);

  // reload detector: if the app was entered <4s ago and we're booting again,
  // the page reloaded right after login — surface that loudly.
  if (sessionStorage.getItem('ro_entered')) {
    const ago = Date.now() - Number(sessionStorage.getItem('ro_entered'));
    sessionStorage.removeItem('ro_entered');
    if (ago < 8000 && window.__portalErr) window.__portalErr('page RELOADED ' + Math.round(ago / 1000) + 's after entering the app — screenshot this');
  }
  if (state.token) {
    api('/api/auth', { action: 'me' }).then((me) => { state.user = me; enterApp(me.mustChange); })
      .catch((e) => { $('#login').hidden = false; if (window.__portalErr) window.__portalErr('session restore failed: ' + e.message); });
  } else $('#login').hidden = false;
})();
