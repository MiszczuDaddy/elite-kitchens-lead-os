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

// The Emails page (docs/EMAIL_LIST.md): every email in and out, newest first, from the server's list (emailLog: a short preview of each, written only by the server). Choose one to read the whole email beside the list
// (the full text of a received email, a reply and a follow-up is in the customer's own chat records; a quote email's wording is not kept). Live while the page is open; nothing is written from here.
window.EMAILS = (() => {
  const L = { active: false, unsub: null, items: [], filter: 'all', query: '', limit: 100, loaded: false, error: null, sel: null, seq: 0 };
  const MAX = 500, BASE = ['nav-inbox', 'nav-pipeline', 'nav-appointments', 'nav-quotes', 'nav-projects', 'nav-assistant'];
  const KIND = { customer: 'Received', reply: 'Sent · your reply', followup: 'Sent · follow-up', quotefollowup: 'Sent · quote follow-up', quote: 'Sent · quote' };
  const DAY_F = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Dublin' }), TIME_F = new Intl.DateTimeFormat('en-IE', { timeZone: 'Europe/Dublin', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }), DATE_F = new Intl.DateTimeFormat('en-IE', { timeZone: 'Europe/Dublin', day: 'numeric', month: 'short' });
  const FULL_F = new Intl.DateTimeFormat('en-IE', { timeZone: 'Europe/Dublin', weekday: 'short', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const handles = (hash) => hash === '#emails';
  function whenText(t, now = Date.now()) {
    if (t == null) return '';
    const d = DAY_F.format(new Date(t)), today = DAY_F.format(new Date(now)), yest = DAY_F.format(new Date(now - 86400000));
    return d === today ? TIME_F.format(new Date(t)) : d === yest ? 'Yesterday ' + TIME_F.format(new Date(t)) : DATE_F.format(new Date(t));
  }
  const norm = (x) => String(x == null ? '' : x).toLowerCase();
  const matches = (m, q) => !q || [m.name, m.subject, m.snippet, m.email, m.quoteRef, m.phone].some((v) => norm(v).includes(q));
  const byFilter = (m) => L.filter === 'all' || (L.filter === 'in' || L.filter === 'out' ? m.direction === L.filter : L.filter === 'followups' ? (m.kind === 'followup' || m.kind === 'quotefollowup') : m.confirmed === false);
  const shown = () => L.items.filter((m) => byFilter(m) && matches(m, norm(L.query).trim()));
  const kindText = (m) => (m.direction === 'in' ? '\u2199 ' : '\u2197 ') + (KIND[m.kind] || (m.direction === 'in' ? 'Received' : 'Sent'));
  function badges(m, host) {
    host.append(el('span', 'ea-kind ' + (m.direction === 'in' ? 'ea-in' : 'ea-out'), kindText(m)));
    if (m.confirmed === false) { const w = el('span', 'ea-warn', 'Not confirmed'); w.title = 'Google did not confirm this email was sent. Check the Sent folder of the mailbox.'; host.append(w); }
    if (m.quoteRef) host.append(el('span', 'ea-ref', m.quoteRef));
  }
  function renderList() {
    const ul = $('emp-list'), rows = shown(); ul.replaceChildren();
    const filtering = L.filter !== 'all' || norm(L.query).trim();
    $('emp-note').textContent = L.error ? 'The list could not be loaded just now. Open this page again in a moment.' : !L.loaded ? 'Loading…'
      : rows.length ? '' : filtering ? 'No emails match. Clear the search or choose All.' : 'No emails yet. Emails you send from Elite OS, and customers\' replies, will appear here.';
    for (const m of rows) {
      const li = el('li', 'ea-row'), b = el('button', 'ea-open'); b.type = 'button'; b.dataset.phone = m.phone; b.dataset.kind = m.kind; b.dataset.id = m.id;
      if (m.id === L.sel) b.setAttribute('aria-current', 'true');
      const top = el('div', 'ea-top'); top.append(el('span', 'ea-name', m.name || 'Customer'), el('span', 'ea-when', whenText(ms(m.at))));
      const sub = el('div', 'ea-sub'); badges(m, sub);
      b.append(top, sub, el('div', 'ea-subject', m.subject || '(no subject)'), el('div', 'ea-snip', m.snippet || ''));
      b.onclick = () => select(m.id);
      li.append(b); ul.append(li);
    }
    $('emp-more').hidden = !!L.error || L.items.length < L.limit || L.limit >= MAX;
    for (const c of document.querySelectorAll('#emails .ea-chip')) c.setAttribute('aria-pressed', c.dataset.f === L.filter ? 'true' : 'false');
  }
  // The email's own record in the customer's chat holds the whole text (not for a quote email: only its preview is kept).
  const docIdOf = (m) => (m.kind === 'quote' ? null : m.id.startsWith('g_') ? m.id : m.id.slice(String(m.phone).length + 1));
  async function select(id) {
    const m = L.items.find((x) => x.id === id); if (!m) return;
    L.sel = id; const mine = ++L.seq; renderList();
    $('emails').dataset.sub = 'read'; $('emp-empty').hidden = true; $('emp-detail').hidden = false;
    $('emp-d-name').textContent = m.name || 'Customer'; $('emp-d-kind').replaceChildren(); badges(m, $('emp-d-kind'));
    $('emp-d-subject').textContent = m.subject || '(no subject)'; $('emp-d-when').textContent = m.at ? FULL_F.format(new Date(ms(m.at))) : '';
    const inbound = m.direction === 'in';
    $('emp-d-from').textContent = inbound ? (m.email || '') : 'Elite Kitchens'; $('emp-d-to').textContent = inbound ? 'Elite Kitchens' : (m.email || '');
    $('emp-d-by').textContent = m.by || ''; $('emp-d-by').hidden = $('emp-d-by-t').hidden = inbound || !m.by;
    $('emp-d-warn').hidden = m.confirmed !== false; $('emp-d-note').hidden = true;
    $('emp-d-body').textContent = m.snippet || '';                                                           // the preview at once; the whole email replaces it when it arrives
    $('emp-chat').onclick = () => { location.hash = '#c/' + m.phone; };
    const docId = docIdOf(m);
    if (!docId) { $('emp-d-note').hidden = false; $('emp-d-note').textContent = 'The wording of a quote email and its PDF are not kept here: this is the start of it. Open the chat or the quote to see the quote itself.'; return; }
    try {
      const d = await db.collection('conversations').doc(m.phone).collection('emails').doc(docId).get();
      if (mine !== L.seq) return;
      if (d.exists && typeof d.data().body === 'string') {
        $('emp-d-body').textContent = d.data().body;
        const att = d.data().attachments || []; if (att.length) { $('emp-d-note').hidden = false; $('emp-d-note').textContent = 'Attachments (open the email in Gmail to see them): ' + att.map((a) => a.name).join(', '); }
      } else { $('emp-d-note').hidden = false; $('emp-d-note').textContent = 'The whole email is no longer in the chat, so this is the preview.'; }
    } catch (e) { if (mine === L.seq) { $('emp-d-note').hidden = false; $('emp-d-note').textContent = 'The whole email could not be loaded just now, so this is the preview.'; } }
  }
  function toList() { L.sel = null; L.seq++; $('emails').dataset.sub = 'list'; $('emp-detail').hidden = true; $('emp-empty').hidden = false; renderList(); }
  function setNav(on) {
    const n = $('nav-emails');
    n.classList.toggle('active', on);
    if (on) { n.setAttribute('aria-current', 'page'); for (const id of BASE) { const x = $(id); if (x) { x.classList.remove('active'); x.removeAttribute('aria-current'); } } }
    else { n.removeAttribute('aria-current'); $('nav-inbox').classList.add('active'); $('nav-inbox').setAttribute('aria-current', 'page'); }
  }
  function stop() { if (L.unsub) { L.unsub(); L.unsub = null; } }
  function start() {
    stop(); L.error = null;
    L.unsub = db.collection('emailLog').orderBy('at', 'desc').limit(L.limit).onSnapshot((snap) => { L.items = snap.docs.map((d) => ({ id: d.id, ...d.data() })); L.loaded = true; renderList(); }, () => { L.error = true; renderList(); });
  }
  function show() {
    L.active = true; setNav(true);
    L.filter = 'all'; L.query = ''; L.limit = 100; L.loaded = false; L.items = []; $('emp-search').value = ''; toList(); start(); setView();
  }
  function hide() { L.active = false; stop(); setNav(false); setView(); }
  function init() {
    if (!$('emails')) return;
    $('emp-back').onclick = () => { location.hash = ''; };
    $('emp-tolist').onclick = toList;
    $('emp-more').onclick = () => { L.limit = Math.min(MAX, L.limit + 100); start(); };
    $('emp-search').addEventListener('input', () => { L.query = $('emp-search').value; renderList(); });
    for (const c of document.querySelectorAll('#emails .ea-chip')) c.onclick = () => { L.filter = c.dataset.f; renderList(); };
  }
  init();
  return { get active() { return L.active; }, handles, show, hide, whenText, KIND };
})();
