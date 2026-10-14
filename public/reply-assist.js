'use strict';
// Elite Kitchens Lead OS: AI reply suggestions in a WhatsApp chat (Phase 9 R1, docs/AI.md). A "Suggest reply" button above the message box asks the aiSuggestReply function (one model call that
// reads this customer's whole chat and lead details) and shows a draft, what is known, what is missing and how ready the customer is for a consultation. NOTHING is sent: "Use this reply"
// only puts the words in the message box, where you edit them and press the normal Send. How each draft ended (used as it was, edited, not used) is reported, without any words.
// Everything shown is drawn as plain text. Loaded after app.js (shares its helpers). If anything here fails, the chat works as before.
window.REPLY = (() => {
  const M = window.ReplyModel;
  const R = { phone: null, enabled: false, auto: false, checkedAt: 0, busy: false, result: null, used: false, reported: false, error: '' };
  const ta = () => $('text');
  const report = (outcome) => { const r = R.result; if (!r || R.reported || !r.draftId) return; R.reported = true; call('aiDraftOutcome')({ draftId: r.draftId, outcome }).catch(() => {}); };
  // Reading the draft's fate when the chat is left or the panel is closed: a draft that was copied into the box but never sent, or never used, counts as not used.
  function finish() { if (R.result && !R.reported) report('discarded'); R.result = null; R.used = false; R.reported = false; R.error = ''; }

  async function checkEnabled() {
    if (Date.now() - R.checkedAt < 60000) return R.enabled;
    R.checkedAt = Date.now();
    try {
      const s = (await call('aiStatus')()).data, d = (s.models || []).find((m) => m.key === (s.replyModel || s.defaultModel));
      R.enabled = !!(s.enabled && s.keyConfigured && s.customerDataApproved && s.replyAssistant && d && d.ready);
      R.auto = !!(R.enabled && s.canApproveData);                      // Phase 9 R3: only the owner sees the Receptionist button (it works for a single chat even while the master switch is off)
    } catch (e) { R.enabled = false; R.auto = false; }
    return R.enabled;
  }
  function chips(label, items, cls) {
    const box = el('div', 'reply-row'); box.append(el('span', 'reply-label', label));
    for (const t of items) box.append(el('span', 'reply-chip' + (cls ? ' ' + cls : ''), t));
    return box;
  }
  function render() {
    const panel = $('reply-panel'), btn = $('reply-btn');
    btn.hidden = !R.enabled || !R.phone; btn.disabled = R.busy; btn.textContent = R.busy ? 'Reading the chat…' : 'Suggest reply';
    panel.replaceChildren();
    if (!R.phone || (!R.result && !R.error)) { panel.hidden = true; return; }
    panel.hidden = false;
    const head = el('div', 'reply-head'), close = el('button', 'icon-btn reply-x', '×'); close.type = 'button'; close.setAttribute('aria-label', 'Close the suggestion'); close.onclick = () => { finish(); render(); };
    if (R.error) { head.append(el('strong', '', 'Suggested reply'), close); panel.append(head, el('p', 'reply-err', R.error)); return; }
    const v = M.viewOf(R.result);
    head.append(el('strong', '', 'Suggested reply'), el('span', 'reply-state reply-' + v.readiness.tone, v.readiness.label));
    const meta = [v.modelLabel, v.cost].filter(Boolean).join(' · '); if (meta) head.append(el('span', 'reply-meta', meta));
    head.append(close); panel.append(head);
    if (v.handover) panel.append(el('p', 'reply-handover', 'Hand over to you' + (v.handoverReason ? ': ' + v.handoverReason : '') + '.' + (v.draft ? ' Send the reply below if you like, then take it from here.' : ' No reply is drafted.')));
    if (v.preference) { const b = el('div', 'reply-pref'); b.append(el('div', 'reply-label', 'Preferred days and times'), el('div', 'reply-pref-text', v.preference.text)); if (v.preference.customerWords) b.append(el('div', 'reply-meta', 'Their words: "' + v.preference.customerWords + '"')); panel.append(b); }
    if (!v.structured) panel.append(el('p', 'reply-warn', 'The assistant did not return its analysis. Check the draft carefully.'));
    if (v.draft) {
      panel.append(el('div', 'reply-draft', v.draft));
      const bar = el('div', 'reply-actions'), use = el('button', 'btn btn-primary btn-sm', 'Use this reply'); use.type = 'button'; use.onclick = useDraft; bar.append(use);
      { const t = el('button', 'btn btn-ghost btn-sm', 'Try ' + v.otherLabel); t.type = 'button'; t.disabled = R.busy; t.onclick = () => suggest(v.otherModel); bar.append(t); }
      panel.append(bar);
    } else if (!v.handover) panel.append(el('p', 'reply-warn', 'No reply was drafted.'));
    if (v.warnings.length) { const w = el('ul', 'reply-warns'); for (const x of v.warnings) w.append(el('li', '', 'Check: ' + x)); panel.append(w); }
    if (v.known.length) panel.append(chips('Known', v.known.map((k) => `${k.label}: ${k.value}`)));
    if (v.fromChat.length) panel.append(chips('From the chat (not saved yet)', v.fromChat.map((k) => `${k.label}: ${k.value}`), 'new'));
    if (v.missing.length) panel.append(chips('Still needed', v.missing, 'miss'));
  }
  function useDraft() {
    const r = R.result; if (!r || !r.draft) return;
    const t = ta(); t.value = r.draft; t.dispatchEvent(new Event('input', { bubbles: true })); t.focus(); R.used = true;
  }
  async function suggest(model) {
    if (R.busy || !R.phone) return;
    finish(); R.busy = true; render();
    const phone = R.phone;
    try {
      const r = (await call('aiSuggestReply')({ phone, ...(model ? { model } : {}) })).data;
      if (R.phone === phone) { R.result = r; R.used = false; R.reported = false; }
    } catch (e) { if (R.phone === phone) R.error = (e && e.message ? e.message : 'Could not suggest a reply.').replace(/^(functions\/)?[\w-]+:\s*/, '').slice(0, 250); }
    R.busy = false; render();
  }
  async function onSelect(phone) {
    if (R.phone !== phone) { finish(); R.phone = phone || null; R.error = ''; }
    render(); drawRecep();
    if (phone && (await checkEnabled()) !== undefined) { render(); drawRecep(); }
  }
  // Phase 9 R3: the per-chat Receptionist switch. On = it answers new messages in this chat by itself; "handed to you" = it passed the chat to you and stays out until you switch it on again.
  function drawRecep() {
    const b = $('recep-btn'); if (!b) return;
    const c = R.phone && S.convs.find((x) => x.id === R.phone), rc = (c && c.receptionist) || {}, live = rc.on === true && !rc.paused;
    b.hidden = !R.auto || !R.phone; b.disabled = R.recepBusy === true; b.classList.toggle('on', live);
    b.textContent = 'Receptionist: ' + (live ? (rc.auto ? 'on (automatic)' : 'on') : rc.on === true && rc.paused ? 'handed to you' : 'off');
    b.title = live ? 'It answers new messages in this chat by itself' + (rc.auto ? ' (switched on automatically because this is a new Meta lead)' : '') + '. Press to pause it.' : rc.on === true && rc.paused ? 'It passed this chat to you. Press to switch it on again.' : 'Let the receptionist answer new messages in this chat by itself. Press to switch it on.';
  }
  $('recep-btn').onclick = async () => {
    const c = S.convs.find((x) => x.id === R.phone), rc = (c && c.receptionist) || {}, want = !(rc.on === true && !rc.paused);
    if (!R.phone || R.recepBusy) return;
    R.recepBusy = true; drawRecep();
    try { await call('setReceptionist')({ phone: R.phone, on: want }); } catch (e) { R.error = (e && e.message ? e.message : 'Could not change the receptionist.').replace(/^(functions\/)?[\w-]+:\s*/, '').slice(0, 200); }
    R.recepBusy = false; drawRecep(); render();
  };
  function stop() { finish(); R.phone = null; R.enabled = false; R.auto = false; R.checkedAt = 0; render(); drawRecep(); }

  // The person pressed Send: if this message came from the draft, say whether it was used as it was or edited.
  $('composer').addEventListener('submit', () => { if (R.result && R.used && !R.reported) report(M.outcomeOf(R.result.draft, ta().value)); }, true);
  $('reply-btn').onclick = () => suggest();
  render();
  return Object.assign(R, { onSelect, stop, suggest, render, drawRecep });
})();
