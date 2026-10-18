'use strict';
// Elite Kitchens Lead OS: "Needs attention" (Phase 10, docs/PHASE10_SAFETY_NET.md). A bar at the top of the Inbox appears only when something needs a person; it opens a list of
// PROBLEMS (from the health check), hand-over ALERTS that did not reach a phone, and Meta LEADS that could not be added, with a button for each. The same dialog shows when Elite OS last
// checked itself and when the backups were last tested, and holds the "no leads for N hours" setting. It can always be opened from Notifications > System health and backups.
// Loaded after app.js (shares its helpers). Reads only; every button goes through a staff-only function (attentionAction). If anything here fails, Elite OS works as before.
window.ATTN = (() => {
  const M = window.AttentionModel;
  const A = { started: false, issues: [], leads: [], convs: [], heartbeats: null, backup: null, settings: null, unsubs: [], busy: false, ticker: null };
  const dlg = $('attn-dlg');
  const show = () => { if (typeof dlg.showModal === 'function') { if (!dlg.open) dlg.showModal(); } else dlg.setAttribute('open', ''); };
  const hide = () => { if (typeof dlg.close === 'function') { if (dlg.open) dlg.close(); } else dlg.removeAttribute('open'); };
  const fail = (e) => { $('attn-err').textContent = errText(e).replace(/^(functions\/)?[\w-]+:\s*/, ''); };
  const state = () => M.build({ issues: A.issues, leads: A.leads, convs: A.convs, heartbeats: A.heartbeats }, Date.now());

  function start() {
    if (A.started) return; A.started = true;
    const listen = (q, fn) => A.unsubs.push(q.onSnapshot((s) => { fn(s); render(); }, () => {}));
    listen(db.collection('healthIssues').where('status', '==', 'open'), (s) => { A.issues = s.docs.map((d) => ({ id: d.id, ...d.data() })); });
    listen(db.collection('leadIssues').where('status', '==', 'open'), (s) => { A.leads = s.docs.map((d) => ({ id: d.id, ...d.data() })); });
    listen(db.collection('conversations').orderBy('receptionist.notifyFailed.at', 'desc').limit(50), (s) => { A.convs = s.docs.map((d) => ({ id: d.id, ...d.data() })); });
    listen(db.doc('health/heartbeats'), (d) => { A.heartbeats = d.exists ? d.data() : null; });
    listen(db.doc('health/backup'), (d) => { A.backup = d.exists ? d.data() : null; });
    listen(db.doc('healthSettings/current'), (d) => { A.settings = d.exists ? d.data() : null; });
    A.ticker = setInterval(render, 60000);                      // "checked 3 minutes ago", and a health check that stops, without any new data
  }
  function stop() { for (const u of A.unsubs) u(); A.unsubs = []; clearInterval(A.ticker); Object.assign(A, { started: false, issues: [], leads: [], convs: [], heartbeats: null, backup: null, settings: null }); render(); hide(); }

  const button = (text, cls, fn) => { const b = el('button', 'btn btn-sm ' + cls, text); b.type = 'button'; b.onclick = fn; return b; };
  async function act(data, done) {
    if (A.busy) return; A.busy = true; $('attn-err').textContent = ''; render();
    try { await call('attentionAction')(data); if (done) done(); } catch (e) { fail(e); }
    A.busy = false; render();
  }
  function item(title, lines, buttons) {
    const box = el('div', 'attn-item'); box.append(el('div', 'attn-item-title', title));
    for (const l of lines.filter(Boolean)) box.append(el('div', 'attn-item-line', l));
    if (buttons.length) { const row = el('div', 'attn-item-actions'); for (const b of buttons) { b.disabled = A.busy; row.append(b); } box.append(row); }
    return box;
  }

  function render(force) {
    const now = Date.now(), st = state();
    const bar = $('attn-bar'); bar.hidden = !A.started || st.count === 0;
    $('attn-count').textContent = String(st.count); $('attn-text').textContent = M.barText(st.count).replace(/^\d+ /, '');
    if (!dlg.open && force !== true) return;
    $('attn-summary').textContent = st.count ? M.barText(st.count) + '.' : 'All clear: nothing needs your attention.';
    $('attn-problems').hidden = !st.problems.length;
    $('attn-problems-list').replaceChildren(...st.problems.map((p) => item(p.title, [p.help, `Since ${M.ago(p.since, now)}${p.count > 1 ? ` · seen ${p.count} times` : ''}${p.detail ? ' · ' + p.detail : ''}${p.alert === 'failed' ? ' · the alert could not be delivered' : ''}`],
      p.local ? [] : [button('Mark as fixed', 'btn-ghost', () => act({ action: 'fixed', kind: p.kind }))])));
    $('attn-alerts').hidden = !st.alerts.length;
    $('attn-alerts-list').replaceChildren(...st.alerts.map((a) => item(a.name || formatPhone(a.phone), ['The receptionist passed this chat to you ' + M.ago(a.at, now) + ', but the alert did not reach your phone.' + (a.emailed ? ' An email was sent instead.' : ''), a.why ? 'Why: ' + a.why : ''],
      [button('Open chat', 'btn-primary', () => { hide(); location.hash = '#c/' + a.phone; }), button('Seen', 'btn-ghost', () => act({ action: 'seen', phone: a.phone }))])));
    $('attn-leads').hidden = !st.leads.length;
    $('attn-leads-list').replaceChildren(...st.leads.map((l) => item(l.name || 'A lead with no name', [l.reason,
      ['Number as typed: ' + (l.phoneTyped || 'none'), l.email ? 'Email: ' + l.email : 'No email', l.location ? 'Area: ' + l.location : ''].filter(Boolean).join(' · '),
      [l.formName ? 'Form: ' + l.formName : '', 'Received ' + M.ago(l.at, now), l.attempts > 1 ? `sent ${l.attempts} times` : ''].filter(Boolean).join(' · ')],
    [button('Add as customer', 'btn-primary', () => addLead(l)), button('Dismiss', 'btn-ghost', () => { if (window.confirm('Dismiss this lead? Their name, email and number are deleted from Elite OS.')) act({ action: 'lead', leadId: l.leadId, outcome: 'dismissed' }); })])));
    $('attn-checks').textContent = M.checksText(A.heartbeats, now);
    $('attn-backup').textContent = M.backupText(A.backup, now);
    const hours = $('attn-hours'); if (document.activeElement !== hours) hours.value = String(A.settings && Number.isInteger(A.settings.leadSilenceHours) ? A.settings.leadSilenceHours : 168);
    $('attn-save').disabled = A.busy;
  }

  // "Add as customer": the usual Add customer form, already filled in (the number as typed, to be corrected). When it is saved the lead is closed and its details here are deleted.
  function addLead(l) {
    hide();
    openAddCustomer({ phone: l.phoneTyped || '', name: l.name || '', email: l.email || '', location: l.location || '', source: 'Meta Ads' }, async (phone) => {
      try { await call('attentionAction')({ action: 'lead', leadId: l.leadId, outcome: 'added' }); } catch (e) { toast('The customer was added, but the lead is still listed in Needs attention: ' + errText(e)); }
      openConversation(phone);
    });
  }

  function open() { $('attn-err').textContent = ''; $('attn-set-msg').textContent = ''; render(true); show(); render(); }      // filled in BEFORE it opens (opening focuses the first field)
  $('attn-open').onclick = open;
  $('attn-close').onclick = hide;
  $('notif-health').onclick = () => { if (window.PUSH) { const d = $('notif-dlg'); if (d.open && typeof d.close === 'function') d.close(); } open(); };
  $('attn-settings').addEventListener('submit', (e) => {
    e.preventDefault();
    const h = M.hoursOf($('attn-hours').value);
    if (h == null) { $('attn-set-msg').textContent = 'Enter a whole number of hours from 0 (off) to 720.'; return; }
    act({ action: 'settings', leadSilenceHours: h }, () => { $('attn-set-msg').textContent = h ? `Saved: you are warned after ${h} hours without a lead.` : 'Saved: the warning is off.'; });
  });
  // For the Today tab (Phase 11), which shows the same rejected leads with the same two buttons, and says how many system problems there are.
  const dismissLead = (l) => { if (window.confirm('Dismiss this lead? Their name, email and number are deleted from Elite OS.')) return call('attentionAction')({ action: 'lead', leadId: l.leadId, outcome: 'dismissed' }); return null; };
  const problemCount = () => state().problems.length;
  return Object.assign(A, { start, stop, open, render, addLead, dismissLead, problemCount });
})();
