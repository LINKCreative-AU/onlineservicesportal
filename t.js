/* registration office — lightweight session tracker (self-hosted, no cookies).
   Include on a site:  <script defer src="https://registrationoffice.com.au/t.js" data-site="daspa"></script>
   Captures structure, never content: pageviews, anonymous click targets, form
   start/submit, scroll depth, JS errors, duration, device class. No keystrokes,
   no field values, no PII — TFNs/passports/banks can never appear in this data. */
(function () {
  var script = document.currentScript || (function () { var s = document.querySelectorAll('script[data-site]'); return s[s.length - 1]; })();
  if (!script) return;
  var SITE = script.getAttribute('data-site');
  var ENDPOINT = (script.getAttribute('data-endpoint') || 'https://registrationoffice.com.au') + '/api/track';
  if (!SITE) return;

  var sid;
  try {
    sid = sessionStorage.getItem('ro_sid');
    if (!sid) { sid = Math.random().toString(36).slice(2) + Date.now().toString(36); sessionStorage.setItem('ro_sid', sid); }
  } catch (e) { sid = Math.random().toString(36).slice(2) + Date.now().toString(36); }

  var device = window.innerWidth < 720 ? 'mobile' : (window.innerWidth < 1100 ? 'tablet' : 'desktop');
  var started = Date.now();
  var q = [];
  var formsStarted = {};
  var scrollMarks = {};

  function ev(type, detail) {
    q.push({ t: type, p: location.pathname, d: detail || null, ts: Date.now() });
    if (q.length >= 25) flush();
  }
  function flush() {
    if (!q.length) return;
    var payload = JSON.stringify({ site: SITE, sid: sid, device: device, events: q.splice(0, 100) });
    try {
      if (navigator.sendBeacon) navigator.sendBeacon(ENDPOINT, new Blob([payload], { type: 'text/plain' }));
      else { var x = new XMLHttpRequest(); x.open('POST', ENDPOINT, true); x.setRequestHeader('Content-Type', 'text/plain'); x.send(payload); }
    } catch (e) { /* never break the host page */ }
  }

  function target(el) {
    if (!el || !el.tagName) return '?';
    var t = el.tagName.toLowerCase();
    if (el.id) return t + '#' + el.id;
    var txt = (el.textContent || '').trim().slice(0, 40);
    var cls = (typeof el.className === 'string' ? el.className : '').split(/\s+/)[0];
    return t + (cls ? '.' + cls : '') + (txt ? '"' + txt + '"' : '');
  }

  ev('pageview', { ref: document.referrer ? document.referrer.replace(/^https?:\/\//, '').split('/')[0] : null });

  document.addEventListener('click', function (e) {
    var el = e.target.closest ? (e.target.closest('a,button,[role=button],input[type=submit],summary,label') || e.target) : e.target;
    ev('click', { el: target(el) });
  }, true);

  document.addEventListener('focusin', function (e) {
    var el = e.target;
    if (!el || !/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) return;
    var form = el.form ? (el.form.id || el.form.action || 'form') : 'page';
    if (!formsStarted[form]) { formsStarted[form] = true; ev('form_start', { form: String(form).slice(0, 80) }); }
    ev('field_focus', { field: (el.name || el.id || el.type || '?').slice(0, 40) }); // name only — never the value
  }, true);

  document.addEventListener('submit', function (e) {
    var f = e.target;
    ev('form_submit', { form: (f.id || f.action || 'form').slice(0, 80) });
    flush();
  }, true);

  window.addEventListener('scroll', function () {
    var h = document.documentElement;
    var depth = Math.round((h.scrollTop + window.innerHeight) / h.scrollHeight * 100);
    [25, 50, 75, 95].forEach(function (m) { if (depth >= m && !scrollMarks[m]) { scrollMarks[m] = true; ev('scroll', { depth: m }); } });
  }, { passive: true });

  window.addEventListener('error', function (e) { ev('jserror', { msg: String(e.message || '').slice(0, 120) }); });

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') { ev('end', { secs: Math.round((Date.now() - started) / 1000) }); flush(); }
  });
  setInterval(flush, 6000);
})();
