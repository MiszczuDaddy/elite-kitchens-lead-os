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

  // The reply window works from a small description of who it is for, so it opens from a chat (below) and from the Emails page (reply(), further down): { id: their number, name, to: the address, last: their newest email { subject, body } or null }.
  function openWith(ctx) {
    if (E.busy) return;
    if (!ctx || !ctx.id) return;
    if (!ctx.to) { toast('There is no email address for ' + ctx.name + '. Add one in their Details first.'); return; }
    E.ctx = ctx; const l = ctx.last;
    $('em-title').textContent = 'Email ' + ctx.name; $('em-to').textContent = 'To: ' + ctx.to;
    const box = $('em-last'); box.hidden = !l; box.replaceChildren();
    if (l) { box.append(el('div', 'em-last-h', 'Their last email · ' + (l.subject || '(no subject)')), el('div', 'em-last-b', String(l.body || '').slice(0, 600) + (String(l.body || '').length > 600 ? '…' : ''))); }
    $('em-subject').value = l ? reSubject(l.subject) : ''; $('em-body').value = ''; $('em-err').textContent = '';
    $('em-send').disabled = false; $('em-send').textContent = 'Send email'; $('em-check').disabled = false;
    showDialog($('em-dlg')); ($('em-subject').value ? $('em-body') : $('em-subject')).focus();
  }
  function open() {
    if (!E.id || E.busy) return;
    const l = lastIn();
    openWith({ id: E.id, name: nameOf(), to: addressOf(), last: l ? { subject: l.subject, body: l.body } : null });
  }
  async function send() {
    if (E.busy || !E.ctx) return; E.busy = true; $('em-send').disabled = true; $('em-send').textContent = 'Sending…'; $('em-err').textContent = '';
    const id = E.ctx.id, name = E.ctx.name;
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
      else { const a = r.stored || 0, b = r.sentStored || 0; $('em-err').textContent = a || b ? 'Found ' + [a ? `${a} new email${a === 1 ? '' : 's'} from customers` : '', b ? `${b} you sent from Gmail` : ''].filter(Boolean).join(' and ') + '.' : 'No new emails to or from customers. (An email you sent in the last two minutes is picked up a little later.)'; }
    } catch (e) { $('em-err').textContent = errText(e); }
    $('em-check').disabled = false;
  }
  function init() {
    if (!$('em-dlg')) return;
    $('email-btn').onclick = open; $('em-send').onclick = send; $('em-check').onclick = check; $('em-cancel').onclick = () => { if (!E.busy) hideDialog($('em-dlg')); };
  }
  init();
  return { onSelect, items, sync, open, reply: openWith };
})();

// The Emails page (docs/EMAIL_LIST.md): ONE ROW PER CUSTOMER (21 Nov 2026), newest conversation first, built from the server's list of emails (emailLog: a short preview of each, written only by the server). Choose a customer
// and the whole conversation opens in one window, oldest email at the top and the newest at the bottom, sent and received together (the full text of a received email, a reply and a follow-up is in the customer's own
// chat records; a quote email's wording is not kept). Live while the page is open; nothing is written from here.
window.EMAILS = (() => {
  const L = { active: false, unsub: null, items: [], filter: 'all', query: '', limit: 300, loaded: false, error: null, sel: null };
  const T = { phone: null, unsub: null, items: [], bodies: {}, loading: false, failed: false, stick: true, seq: 0 };
  const MAX = 1500, BASE = ['nav-inbox', 'nav-pipeline', 'nav-appointments', 'nav-quotes', 'nav-projects', 'nav-assistant'];
  const KIND = { customer: 'Received', reply: 'Sent · your reply', followup: 'Sent · follow-up', quotefollowup: 'Sent · quote follow-up', quote: 'Sent · quote', gmail: 'Sent · from Gmail', assistant: 'Sent · written by the Assistant' };
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
  const kindText = (m) => (m.direction === 'in' ? '↙ ' : '↗ ') + (KIND[m.kind] || (m.direction === 'in' ? 'Received' : 'Sent'));
  const plural = (n) => n + ' email' + (n === 1 ? '' : 's');
  function badges(m, host, warn) {
    host.append(el('span', 'ea-kind ' + (m.direction === 'in' ? 'ea-in' : 'ea-out'), kindText(m)));
    if (m.confirmed === false || warn) { const w = el('span', 'ea-warn', 'Not confirmed'); w.title = 'Google did not confirm this email was sent. Check the Sent folder of the mailbox.'; host.append(w); }
    if (m.quoteRef) host.append(el('span', 'ea-ref', m.quoteRef));
  }
  // One entry per customer: their emails that match the filter and the search (the list is newest first, so the first one seen is the newest), and how many.
  function groups() {
    const q = norm(L.query).trim(), by = new Map();
    for (const m of L.items) {
      if (!byFilter(m) || !matches(m, q)) continue;
      let g = by.get(m.phone); if (!g) { g = { phone: m.phone, name: m.name || '', newest: m, count: 0, unconfirmed: 0 }; by.set(m.phone, g); }
      g.count++; if (m.confirmed === false) g.unconfirmed++; if (!g.name && m.name) g.name = m.name;
    }
    return [...by.values()];
  }
  function renderList() {
    const ul = $('emp-list'), rows = groups(); ul.replaceChildren();
    const filtering = L.filter !== 'all' || norm(L.query).trim();
    $('emp-note').textContent = L.error ? 'The list could not be loaded just now. Open this page again in a moment.' : !L.loaded ? 'Loading…'
      : rows.length ? '' : filtering ? 'No emails match. Clear the search or choose All.' : 'No emails yet. Emails you send from Elite OS, and customers\' replies, will appear here.';
    for (const g of rows) {
      const m = g.newest, li = el('li', 'ea-row'), b = el('button', 'ea-open'); b.type = 'button'; b.dataset.phone = g.phone; b.dataset.kind = m.kind; b.dataset.id = m.id;
      if (g.phone === L.sel) b.setAttribute('aria-current', 'true');
      const top = el('div', 'ea-top'); top.append(el('span', 'ea-name', g.name || 'Customer'), el('span', 'ea-when', whenText(ms(m.at))));
      const sub = el('div', 'ea-sub'); badges(m, sub, g.unconfirmed > 0); sub.append(el('span', 'ea-count', plural(g.count)));          // a customer with any email Google did not confirm is flagged, even when it is not the newest
      b.append(top, sub, el('div', 'ea-subject', m.subject || '(no subject)'), el('div', 'ea-snip', m.snippet || ''));
      b.onclick = () => select(g.phone);
      li.append(b); ul.append(li);
    }
    $('emp-more').hidden = !!L.error || L.items.length < L.limit || L.limit >= MAX;
    for (const c of document.querySelectorAll('#emails .ea-chip')) c.setAttribute('aria-pressed', c.dataset.f === L.filter ? 'true' : 'false');
  }
  // The email's own record in the customer's chat holds the whole text (not for a quote email: only its preview is kept).
  const docIdOf = (m) => (m.kind === 'quote' ? null : m.id.startsWith('g_') ? m.id : m.id.slice(String(m.phone).length + 1));
  function stopThread() { if (T.unsub) { T.unsub(); T.unsub = null; } T.phone = null; T.seq++; }
  const nearBottom = (box) => box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  // The whole conversation with one customer: every email, oldest first, newest at the bottom (like the chat). The text of each comes from the customer's chat records when it has arrived (the preview until then).
  function renderThread(forceBottom) {
    const box = $('emp-read'), host = $('emp-thread'), mine = T.items;
    host.replaceChildren();
    for (const m of mine) {
      const card = el('article', 'emp-msg ' + (m.direction === 'in' ? 'emp-in' : 'emp-out')); card.dataset.kind = m.kind; card.dataset.id = m.id;
      const head = el('div', 'ea-sub emp-msg-head'); badges(m, head); head.append(el('span', 'emp-msg-when', m.at ? FULL_F.format(new Date(ms(m.at))) : '')); card.append(head);
      card.append(el('h3', 'emp-msg-subject', m.subject || '(no subject)'));
      const who = m.direction === 'in' ? (m.email ? 'From ' + m.email : '') : ['To ' + (m.email || ''), m.by ? 'sent by ' + m.by : ''].filter(Boolean).join(' · '); if (who) card.append(el('div', 'emp-msg-meta', who));
      if (m.confirmed === false) card.append(el('div', 'emp-d-warn', 'Google did not confirm this email was sent. Check the Sent folder of the mailbox; Elite OS never sends it again by itself.'));
      const docId = docIdOf(m), got = docId && T.bodies[docId];
      card.append(el('div', 'emp-d-body', got && typeof got.body === 'string' ? got.body : (m.snippet || '')));
      const note = !docId ? 'The wording of a quote email and its PDF are not kept here: this is the start of it. Open the chat or the quote to see the quote itself.'
        : got && got.attachments && got.attachments.length ? 'Attachments (open the email in Gmail to see them): ' + got.attachments.map((a) => a.name).join(', ')
        : docId in T.bodies && !got ? 'The whole email is no longer in the chat, so this is the preview.' : T.failed ? 'The whole email could not be loaded just now, so this is the preview.' : '';
      if (note) card.append(el('p', 'hint emp-msg-note', note));
      host.append(card);
    }
    $('emp-reply').textContent = mine.some((x) => x.direction === 'in') ? 'Reply by email' : 'Write an email';          // they wrote to us: a reply; otherwise a new email to them
    if (forceBottom || T.stick) box.scrollTop = box.scrollHeight;
  }
  // The full text of every email in this customer's chat, fetched once for the conversation (and again when a new email arrives).
  async function loadBodies(phone, mine) {
    if (T.loading) return;
    const missing = T.items.some((m) => { const d = docIdOf(m); return d && !(d in T.bodies); }); if (!missing) return;
    T.loading = true;
    try {
      const snap = await db.collection('conversations').doc(phone).collection('emails').limit(300).get();
      if (mine !== T.seq) return;
      const have = {}; for (const d of snap.docs) have[d.id] = { body: d.data().body, attachments: d.data().attachments || [] };
      for (const m of T.items) { const d = docIdOf(m); if (d) T.bodies[d] = have[d] || null; }
      T.failed = false;
    } catch (e) { if (mine === T.seq) T.failed = true; }
    if (mine === T.seq) { T.loading = false; renderThread(false); } else T.loading = false;
  }
  // "Reply by email": the same reply window as in the chat, for this customer. The server picks where it goes (the address they last wrote from, else the one on their record), keeps it in their conversation and lists it here.
  async function replyTo() {
    const phone = T.phone, btn = $('emp-reply'); if (!phone || !window.EMAILBOX || btn.disabled) return;
    btn.disabled = true;
    try {
      const ins = T.items.filter((x) => x.direction === 'in'), last = ins[ins.length - 1] || null;
      let to = (last && last.email) || ''; if (!to) { const any = T.items.slice().reverse().find((x) => x.email); to = any ? any.email : ''; }
      if (!to) { try { const c = await db.collection('contacts').doc(phone).get(); to = c.exists ? String(c.data().email || '').trim() : ''; } catch (e) { /* no address known */ } }
      const named = T.items.find((x) => x.name), got = last && docIdOf(last) ? T.bodies[docIdOf(last)] : null;
      EMAILBOX.reply({ id: phone, name: (named && named.name) || 'the customer', to, last: last ? { subject: last.subject, body: got && typeof got.body === 'string' ? got.body : last.snippet } : null });
    } finally { btn.disabled = false; }
  }
  function openThread(phone) {
    stopThread(); T.phone = phone; T.items = []; T.bodies = {}; T.loading = false; T.failed = false; T.stick = true; const mine = ++T.seq;
    const first = L.items.find((x) => x.phone === phone);
    $('emp-d-name').textContent = (first && first.name) || 'Customer'; $('emp-d-sub').textContent = ''; $('emp-chat').onclick = () => { location.hash = '#c/' + phone; };
    T.items = L.items.filter((x) => x.phone === phone).sort((a, b) => ms(a.at) - ms(b.at)); renderThread(true);                       // what the list already has, at once
    T.unsub = db.collection('emailLog').where('phone', '==', phone).limit(300).onSnapshot((snap) => {
      if (mine !== T.seq) return;
      T.items = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => ms(a.at) - ms(b.at));
      const named = T.items.find((x) => x.name), addr = T.items.slice().reverse().find((x) => x.email);
      $('emp-d-name').textContent = (named && named.name) || 'Customer'; $('emp-d-sub').textContent = [plural(T.items.length), addr ? addr.email : ''].filter(Boolean).join(' · ');
      renderThread(false); loadBodies(phone, mine);
    }, () => { if (mine === T.seq) { T.failed = true; renderThread(false); } });
  }
  function select(phone) {
    L.sel = phone; renderList();
    $('emails').dataset.sub = 'read'; $('emp-empty').hidden = true; $('emp-detail').hidden = false;
    openThread(phone);
  }
  function toList() { L.sel = null; stopThread(); $('emails').dataset.sub = 'list'; $('emp-detail').hidden = true; $('emp-empty').hidden = false; renderList(); }
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
    L.filter = 'all'; L.query = ''; L.limit = 300; L.loaded = false; L.items = []; $('emp-search').value = ''; toList(); start(); setView();
  }
  function hide() { L.active = false; stop(); stopThread(); setNav(false); setView(); }
  function init() {
    if (!$('emails')) return;
    $('emp-back').onclick = () => { location.hash = ''; };
    $('emp-tolist').onclick = toList; $('emp-reply').onclick = replyTo;
    $('emp-more').onclick = () => { L.limit = Math.min(MAX, L.limit + 300); start(); };
    $('emp-search').addEventListener('input', () => { L.query = $('emp-search').value; renderList(); });
    $('emp-read').addEventListener('scroll', () => { T.stick = nearBottom($('emp-read')); });                  // scrolled up to read an older email: a new email does not pull the page down
    for (const c of document.querySelectorAll('#emails .ea-chip')) c.onclick = () => { L.filter = c.dataset.f; renderList(); };
  }
  init();
  return { get active() { return L.active; }, handles, show, hide, whenText, KIND };
})();
