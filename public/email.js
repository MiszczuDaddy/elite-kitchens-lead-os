'use strict';
// The email inbox on screen (docs/EMAIL_INBOX.md): a customer's emails (their replies to quotes and follow-ups, and our replies to them) are shown inside their chat, in time order with the WhatsApp messages, and the
// Email button answers them by email, in the same Gmail conversation. The emails live in conversations/{phone}/emails (read here, written only by the server). Loaded after app.js (it uses its S, $, el, call, ms, toast,
// errText, renderMessages and selectedConv).
window.EMAILBOX = (() => {
  const E = { id: null, items: [], unsub: null, busy: false };
  const showDialog = (d) => { if (typeof d.showModal === 'function') { if (!d.open) d.showModal(); } else d.setAttribute('open', ''); };
  const hideDialog = (d) => { if (typeof d.close === 'function') d.close(); else d.removeAttribute('open'); };
  const lastIn = () => E.items.slice().reverse().find((m) => m.direction === 'in') || null;
  const addressOf = () => { const l = lastIn(); return l ? l.fromEmail : String((S.contact && S.contact.email) || '').trim(); };      // the address they wrote from, else the one on their record
  const reSubject = (s) => { const t = String(s || '').replace(/[\r\n]+/g, ' ').trim(); return /^re:/i.test(t) ? t : 'Re: ' + (t || 'your enquiry'); };
  const nameOf = () => { const c = typeof selectedConv === 'function' ? selectedConv() : null; return (c && c.name) || (S.contact && S.contact.name) || 'the customer'; };

  // The Email button shows when there is somewhere to send to: an address on their record, or an email from them.
  function sync() {
    const b = $('email-btn'); if (!b) return;
    b.hidden = !(E.id && E.id === S.selected && (E.items.length || addressOf()));
    const label = lastIn() ? 'Reply by email' : 'Email ' + nameOf();
    b.setAttribute('aria-label', label); b.title = label; b.classList.toggle('em-hot', !!lastIn());          // an envelope in the chat header: it stands out once they have emailed
  }
  function stop() { if (E.unsub) { E.unsub(); E.unsub = null; } }
  function onSelect(id) {
    stop(); E.id = id || null; E.items = []; sync();
    if (!id) return;
    E.unsub = db.collection('conversations').doc(id).collection('emails').orderBy('createdAt').limitToLast(100).onSnapshot((snap) => {
      if (E.id !== id) return;
      E.items = snap.docs.map((d) => ({ id: d.id, type: 'email', ...d.data() }));
      for (let i = E.items.length - 1; i >= 0; i--) {                       // the newest email from them, if we have not answered it yet, gets a "Reply by email" button under it
        if (E.items[i].direction === 'in') { E.items[i].replyable = true; break; }
        if (E.items[i].direction === 'out') break;
      }
      sync(); if (S.selected === id) renderMessages();
    }, () => {});
  }
  // what the chat merges into its thread
  const items = (id) => (E.id && E.id === id ? E.items : []);

  function open() {
    if (!E.id || E.busy) return;
    const to = addressOf(); if (!to) { toast('There is no email address for ' + nameOf() + '. Add one in their Details first.'); return; }
    const l = lastIn();
    $('em-title').textContent = 'Email ' + nameOf(); $('em-to').textContent = 'To: ' + to;
    const box = $('em-last'); box.hidden = !l; box.replaceChildren();
    if (l) { box.append(el('div', 'em-last-h', 'Their last email · ' + (l.subject || '(no subject)')), el('div', 'em-last-b', String(l.body || '').slice(0, 600) + (String(l.body || '').length > 600 ? '…' : ''))); }
    $('em-subject').value = l ? reSubject(l.subject) : ''; $('em-body').value = ''; $('em-err').textContent = '';
    $('em-send').disabled = false; $('em-send').textContent = 'Send email'; $('em-check').disabled = false;
    showDialog($('em-dlg')); ($('em-subject').value ? $('em-body') : $('em-subject')).focus();
  }
  async function send() {
    if (E.busy) return; E.busy = true; $('em-send').disabled = true; $('em-send').textContent = 'Sending…'; $('em-err').textContent = '';
    const id = E.id, name = nameOf();
    try { await call('sendEmailReply')({ phone: id, subject: $('em-subject').value, body: $('em-body').value }); }
    catch (e) { E.busy = false; $('em-err').textContent = errText(e); $('em-send').disabled = false; $('em-send').textContent = 'Send email'; return; }
    E.busy = false; hideDialog($('em-dlg')); toast('Email sent to ' + name + '.');
  }
  // "Check for new email": the same check the server makes every five minutes, started now.
  async function check() {
    $('em-check').disabled = true; $('em-err').textContent = '';
    try {
      const r = (await call('checkEmail')({})).data || {};
      if (r.ok === false) $('em-err').textContent = r.error === 'forbidden' ? 'Google has not allowed Elite OS to read the mailbox yet (an admin step in Google Workspace is needed).' : 'Could not check the mailbox just now (' + (r.error || 'error') + '). Try again in a moment.';
      else $('em-err').textContent = r.stored ? `Found ${r.stored} new email${r.stored === 1 ? '' : 's'} from customers.` : 'No new emails from customers.';
    } catch (e) { $('em-err').textContent = errText(e); }
    $('em-check').disabled = false;
  }
  function init() {
    if (!$('em-dlg')) return;
    $('email-btn').onclick = open; $('em-send').onclick = send; $('em-check').onclick = check; $('em-cancel').onclick = () => { if (!E.busy) hideDialog($('em-dlg')); };
  }
  init();
  return { onSelect, items, sync, open };
})();

// The Emails window (docs/EMAIL_LIST.md): every email in and out, newest first, from the server's list (emailLog: a short preview of each, written only by the server). Tapping a row opens that customer's chat, where the
// whole email is. Live while the window is open; nothing is written from here.
window.EMAILLIST = (() => {
  const L = { unsub: null, items: [], filter: 'all', limit: 100, loaded: false, error: null };
  const MAX = 500;
  const KIND = { customer: 'Received', reply: 'Sent · your reply', followup: 'Sent · follow-up', quotefollowup: 'Sent · quote follow-up', quote: 'Sent · quote' };
  const showDialog = (d) => { if (typeof d.showModal === 'function') { if (!d.open) d.showModal(); } else d.setAttribute('open', ''); };
  const hideDialog = (d) => { if (typeof d.close === 'function') d.close(); else d.removeAttribute('open'); };
  const DAY_F = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Dublin' }), TIME_F = new Intl.DateTimeFormat('en-IE', { timeZone: 'Europe/Dublin', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }), DATE_F = new Intl.DateTimeFormat('en-IE', { timeZone: 'Europe/Dublin', day: 'numeric', month: 'short' });
  function whenText(t, now = Date.now()) {
    if (t == null) return '';
    const d = DAY_F.format(new Date(t)), today = DAY_F.format(new Date(now)), yest = DAY_F.format(new Date(now - 86400000));
    return d === today ? TIME_F.format(new Date(t)) : d === yest ? 'Yesterday ' + TIME_F.format(new Date(t)) : DATE_F.format(new Date(t));
  }
  const shown = () => L.items.filter((m) => L.filter === 'all' || m.direction === L.filter);
  function render() {
    const ul = $('ea-list'), rows = shown(); ul.replaceChildren();
    $('ea-note').textContent = L.error ? 'The list could not be loaded just now. Close this and open it again.' : !L.loaded ? 'Loading…' : rows.length ? '' : (L.filter === 'all' ? 'No emails yet. Emails you send from Elite OS, and customers\' replies, will appear here.' : L.filter === 'in' ? 'No emails received from customers yet.' : 'No emails sent yet.');
    for (const m of rows) {
      const li = el('li', 'ea-row'), b = el('button', 'ea-open'); b.type = 'button'; b.dataset.phone = m.phone; b.dataset.kind = m.kind;
      const top = el('div', 'ea-top'); top.append(el('span', 'ea-name', m.name || 'Customer'), el('span', 'ea-when', whenText(ms(m.at))));
      const sub = el('div', 'ea-sub'), kind = el('span', 'ea-kind ' + (m.direction === 'in' ? 'ea-in' : 'ea-out'), (m.direction === 'in' ? '\u2199 ' : '\u2197 ') + (KIND[m.kind] || (m.direction === 'in' ? 'Received' : 'Sent')));
      sub.append(kind); if (m.confirmed === false) { const w = el('span', 'ea-warn', 'Not confirmed'); w.title = 'Google did not confirm this email was sent. Check the Sent folder of the mailbox.'; sub.append(w); }
      if (m.quoteRef) sub.append(el('span', 'ea-ref', m.quoteRef));
      b.append(top, sub, el('div', 'ea-subject', m.subject || '(no subject)'), el('div', 'ea-snip', m.snippet || ''));
      b.onclick = () => { close(); if (typeof openConversation === 'function') openConversation(m.phone); };
      li.append(b); ul.append(li);
    }
    $('ea-more').hidden = L.error || L.items.length < L.limit || L.limit >= MAX;
    for (const c of document.querySelectorAll('#ea-dlg .ea-chip')) c.setAttribute('aria-pressed', c.dataset.f === L.filter ? 'true' : 'false');
  }
  function stop() { if (L.unsub) { L.unsub(); L.unsub = null; } }
  function start() {
    stop(); L.error = null;
    L.unsub = db.collection('emailLog').orderBy('at', 'desc').limit(L.limit).onSnapshot((snap) => { L.items = snap.docs.map((d) => ({ id: d.id, ...d.data() })); L.loaded = true; render(); }, () => { L.error = true; render(); });
  }
  function open() { L.filter = 'all'; L.limit = 100; L.loaded = false; L.items = []; render(); showDialog($('ea-dlg')); start(); }
  function close() { stop(); hideDialog($('ea-dlg')); }
  function init() {
    if (!$('ea-dlg')) return;
    for (const id of ['emails-rail', 'to-emails']) if ($(id)) $(id).onclick = open;                  // the left rail on a computer, the section buttons on a phone
    $('ea-close').onclick = close; $('ea-dlg').addEventListener('close', stop);
    $('ea-more').onclick = () => { L.limit = Math.min(MAX, L.limit + 100); start(); };
    for (const c of document.querySelectorAll('#ea-dlg .ea-chip')) c.onclick = () => { L.filter = c.dataset.f; render(); };
  }
  init();
  return { open, close, whenText, KIND };
})();
