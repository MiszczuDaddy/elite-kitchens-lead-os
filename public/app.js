'use strict';
// Elite Kitchens Lead OS: inbox UI (Phase 2, milestone 1).
// Reads Firestore directly (staff-only rules); every write and every WhatsApp call goes through Cloud Functions.

const $ = (id) => document.getElementById(id);
const auth = firebase.auth();
const db = firebase.firestore();
const fns = firebase.app().functions('europe-west1');
const call = (name) => fns.httpsCallable(name);

const TZ = 'Europe/Dublin';
const WINDOW_MS = 24 * 3600 * 1000;

const S = {
  convs: [],            // conversation docs {id, ...data}
  selected: null,       // selected conversation id (phone digits)
  msgs: [],             // messages of the selected conversation
  query: '',
  pending: [],          // messages being sent (optimistic)
  snapSeq: 0,
  markingRead: new Set(),
  unsubList: null,
  unsubMsgs: null,
  unsubContact: null,
  contact: null,        // contacts/{phone} of the selected conversation
  dirty: false,         // unsaved edits in the details form
  listLoaded: false,
};

// ---------- helpers ----------
const ms = (ts) => (ts && typeof ts.toMillis === 'function' ? ts.toMillis() : null);
const errText = (e) => (e && e.message) || String(e);
const digits = (s) => String(s || '').replace(/\D/g, '');

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function formatPhone(d) {
  d = digits(d);
  if (d.startsWith('353') && d.length >= 11) return `+353 ${d.slice(3, 5)} ${d.slice(5, 8)} ${d.slice(8)}`;
  return d ? '+' + d : '';
}

// Irish national format (089 123 4567) -> 353891234567; anything else just keeps its digits.
function normalizePhoneInput(raw) {
  let d = digits(raw);
  if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0')) d = '353' + d.slice(1);
  return d;
}

const displayName = (c) => c.name || formatPhone(c.id);
function initials(c) {
  const n = (c.name || '').trim();
  if (n) {
    const p = n.split(/\s+/);
    return ((p[0][0] || '') + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
  }
  return digits(c.id).slice(-2);
}

const isUnread = (c) => {
  const inb = ms(c.lastInboundAt);
  if (!inb) return false;
  const read = ms(c.lastReadAt);
  return !read || inb > read;
};
const windowOpen = (c) => {
  const inb = ms(c && c.lastInboundAt);
  return !!inb && Date.now() - inb < WINDOW_MS;
};

const dayKey = (d) => d.toLocaleDateString('en-CA', { timeZone: TZ });
const hhmm = (d) => d.toLocaleTimeString('en-IE', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TZ });

function listTime(t) {
  if (!t) return '';
  const d = new Date(t), now = new Date();
  if (dayKey(d) === dayKey(now)) return hhmm(d);
  const y = new Date(now.getTime() - 86400000);
  if (dayKey(d) === dayKey(y)) return 'Yesterday';
  if (now - d < 6 * 86400000) return d.toLocaleDateString('en-IE', { weekday: 'short', timeZone: TZ });
  return d.toLocaleDateString('en-IE', { day: '2-digit', month: '2-digit', year: '2-digit', timeZone: TZ });
}

function dayLabel(d) {
  const now = new Date();
  if (dayKey(d) === dayKey(now)) return 'Today';
  if (dayKey(d) === dayKey(new Date(now.getTime() - 86400000))) return 'Yesterday';
  const sameYear = d.toLocaleDateString('en-IE', { year: 'numeric', timeZone: TZ }) === now.toLocaleDateString('en-IE', { year: 'numeric', timeZone: TZ });
  return d.toLocaleDateString('en-IE', { weekday: 'short', day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }), timeZone: TZ });
}

const PLACEHOLDERS = { '[image]': '📷 Photo', '[document]': '📄 Document', '[video]': '🎥 Video', '[audio]': '🎤 Voice message', '[sticker]': 'Sticker' };
function previewOf(c) {
  const t = String(c.lastMessage || '');
  if (PLACEHOLDERS[t]) return PLACEHOLDERS[t];
  return t.replace(/^\[template:[^\]]*\]\s*/, '');
}

const MEDIA_LABEL = { image: ['📷', 'Photo'], document: ['📄', 'Document'], video: ['🎥', 'Video'], audio: ['🎤', 'Voice message'], sticker: ['🙂', 'Sticker'] };

function banner(text) {
  const b = $('banner');
  b.textContent = text || '';
  b.hidden = !text;
}

const selectedConv = () => S.convs.find((c) => c.id === S.selected) || null;

// ---------- auth ----------
$('signin').onclick = () => {
  $('loginmsg').textContent = '';
  auth.signInWithPopup(new firebase.auth.GoogleAuthProvider()).catch((e) => { $('loginmsg').textContent = errText(e); });
};
const doSignOut = () => auth.signOut();
$('signout').onclick = doSignOut;
$('signout-m').onclick = doSignOut;
$('login-signout').onclick = doSignOut;

auth.onAuthStateChanged(async (user) => {
  stopListening();
  $('login-signout').hidden = true;
  if (!user) {
    $('login').hidden = false; $('app').hidden = true;
    return;
  }
  try {
    await call('claimAccess')();          // server checks the allowlist and sets the staff claim
    await user.getIdToken(true);          // pick up the new claim
  } catch (e) {
    $('loginmsg').textContent = `${user.email} is not authorised. ${errText(e)}`;
    $('login').hidden = false; $('app').hidden = true; $('login-signout').hidden = false;
    return;
  }
  $('login').hidden = true; $('app').hidden = false;
  watchList();
  routeFromHash();
});

function stopListening() {
  if (S.unsubList) { S.unsubList(); S.unsubList = null; }
  if (S.unsubMsgs) { S.unsubMsgs(); S.unsubMsgs = null; }
  if (S.unsubContact) { S.unsubContact(); S.unsubContact = null; }
  S.contact = null; S.dirty = false;
  S.convs = []; S.selected = null; S.msgs = []; S.pending = []; S.listLoaded = false;
}

// ---------- conversation list ----------
function watchList() {
  S.unsubList = db.collection('conversations').orderBy('updatedAt', 'desc').limit(300).onSnapshot((snap) => {
    S.convs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    S.listLoaded = true;
    renderList();
    renderThreadHeader();
    updateComposer();
    maybeMarkRead();
  }, (e) => { $('list-empty').hidden = false; $('list-empty').textContent = 'Cannot load conversations: ' + errText(e); });
}

function matchesQuery(c, q) {
  if (!q) return true;
  if (displayName(c).toLowerCase().includes(q)) return true;
  if (String(c.location || '').toLowerCase().includes(q)) return true;
  if (String(c.projectType || '').toLowerCase().includes(q)) return true;
  const d = digits(q);
  if (!d) return false;
  return c.id.includes(d) || (d.startsWith('0') && c.id.includes(d.slice(1)));
}

function renderList() {
  const q = S.query.trim().toLowerCase();
  const list = $('list');
  const keep = list.scrollTop;
  const shown = S.convs.filter((c) => matchesQuery(c, q));
  list.replaceChildren(...shown.map(convItem));
  list.scrollTop = keep;

  const empty = $('list-empty');
  if (!S.listLoaded) { empty.hidden = true; }
  else if (!S.convs.length) { empty.hidden = false; empty.textContent = 'No conversations yet. New WhatsApp messages will appear here.'; }
  else if (!shown.length) { empty.hidden = false; empty.textContent = 'No conversations match your search.'; }
  else empty.hidden = true;

  const n = S.convs.filter(isUnread).length;
  $('total-unread').hidden = !n; $('total-unread').textContent = n;
  $('rail-badge').hidden = !n; $('rail-badge').textContent = n > 9 ? '9+' : n;
  document.title = (n ? `(${n}) ` : '') + 'Inbox · Elite Kitchens';
}

function convItem(c) {
  const unread = isUnread(c);
  const item = el('div', 'conv' + (unread ? ' unread' : '') + (c.id === S.selected ? ' sel' : ''));
  item.setAttribute('role', 'listitem'); item.tabIndex = 0; item.dataset.phone = c.id;
  item.append(el('div', 'avatar', initials(c)));
  const body = el('div', 'conv-body');
  const top = el('div', 'conv-top');
  top.append(el('div', 'conv-name', displayName(c)), el('div', 'conv-time', listTime(ms(c.updatedAt))));
  body.append(top);
  const tag = [c.projectType, c.location].filter(Boolean).join(' · ');
  if (c.name || tag) body.append(el('div', 'conv-sub', tag || formatPhone(c.id)));
  const prev = el('div', 'conv-prev');
  prev.append(el('span', 't', previewOf(c) || ' '));
  if (unread) { const d = el('span', 'dot'); d.title = 'Unread'; prev.append(d); }
  body.append(prev);
  item.append(body);
  const open = () => openConversation(c.id);
  item.onclick = open;
  item.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } };
  return item;
}

$('search').addEventListener('input', (e) => { S.query = e.target.value; renderList(); });

// ---------- routing ----------
function routeFromHash() {
  const m = /^#c\/(\d+)$/.exec(location.hash);
  if (m) openConversation(m[1], true); else closeConversation(true);
}
window.addEventListener('hashchange', routeFromHash);

function setView() { $('app').dataset.view = S.selected ? 'thread' : 'list'; }

function closeConversation(fromHash) {
  if (S.unsubMsgs) { S.unsubMsgs(); S.unsubMsgs = null; }
  S.selected = null; S.msgs = []; S.pending = [];
  watchContact(null);
  $('thread').hidden = true; $('thread-empty').hidden = false;
  if (!fromHash && location.hash) history.replaceState(null, '', location.pathname + location.search);
  setView(); renderList();
}
$('back').onclick = () => closeConversation(false);

function openConversation(id, fromHash) {
  if (!id) return;
  if (S.selected === id) { setView(); return; }
  if (S.unsubMsgs) { S.unsubMsgs(); S.unsubMsgs = null; }
  S.selected = id; S.msgs = []; S.pending = []; banner('');
  if (!fromHash) history.replaceState(null, '', '#c/' + id);
  $('thread').hidden = false; $('thread-empty').hidden = true;
  $('msgs').replaceChildren();
  renderThreadHeader(); updateComposer(); setView(); renderList();
  watchContact(id);
  S.firstRender = true;
  S.unsubMsgs = db.collection('conversations').doc(id).collection('messages').orderBy('createdAt').limitToLast(500).onSnapshot((snap) => {
    S.msgs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    S.snapSeq++;
    S.pending = S.pending.filter((p) => !p.done);
    renderMessages();
    maybeMarkRead();
  }, (e) => banner('Cannot load messages: ' + errText(e)));
  maybeMarkRead();
  $('text').focus({ preventScroll: true });
}

// ---------- thread ----------
function renderThreadHeader() {
  if (!S.selected) return;
  const c = selectedConv() || { id: S.selected };
  $('t-avatar').textContent = initials(c);
  $('t-name').textContent = displayName(c);
  $('t-phone').textContent = c.name ? formatPhone(c.id) + (c.location ? ' · ' + c.location : '') : '';
}

function statusNode(m) {
  const s = m.status;
  if (m.state === 'sending') return el('span', 'tick', 'Sending…');
  if (s === 'failed') { const n = el('span', 'tick', 'Failed'); return n; }
  if (s === 'read') { const n = el('span', 'tick read', '✓✓'); n.title = 'Read'; return n; }
  if (s === 'delivered') { const n = el('span', 'tick', '✓✓'); n.title = 'Delivered'; return n; }
  if (s === 'sent') { const n = el('span', 'tick', '✓'); n.title = 'Sent'; return n; }
  return null;
}

function bubble(m) {
  const out = m.direction === 'out';
  const failed = m.status === 'failed';
  const b = el('div', 'm ' + (out ? 'out' : 'in') + (failed ? ' failed' : ''));
  const type = m.type || 'text';
  const isMedia = !!MEDIA_LABEL[type];
  const isPlaceholder = /^\[[a-z]+\]$/.test(m.body || '');
  if (isMedia) {
    const [icon, label] = MEDIA_LABEL[type];
    const chip = el('div', 'media-chip');
    chip.append(el('span', null, icon), el('span', null, (m.media && m.media.filename) || label));
    b.append(chip);
  }
  if (m.body && !(isMedia && isPlaceholder)) b.append(el('div', 'body', m.body));
  const meta = el('div', 'meta');
  const t = m.createdAt && m.createdAt.toDate ? m.createdAt.toDate() : (m.at ? new Date(m.at) : null);
  if (t) meta.append(el('span', null, hhmm(t)));
  if (out) { const s = statusNode(m); if (s) meta.append(s); }
  b.append(meta);
  if (m.error) b.append(el('div', 'err', m.error));
  return b;
}

function renderMessages() {
  const box = $('msgs');
  const atBottom = S.firstRender || box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const nodes = [];
  let lastDay = null;
  const all = [...S.msgs, ...S.pending.map((p) => ({ direction: 'out', type: 'text', body: p.body, at: p.at, state: 'sending' }))];
  for (const m of all) {
    const d = m.createdAt && m.createdAt.toDate ? m.createdAt.toDate() : new Date(m.at || Date.now());
    const k = dayKey(d);
    if (k !== lastDay) { nodes.push(el('div', 'day', dayLabel(d))); lastDay = k; }
    nodes.push(bubble(m));
  }
  box.replaceChildren(...nodes);
  if (atBottom) box.scrollTop = box.scrollHeight;
  S.firstRender = false;
}

function updateComposer() {
  if (!S.selected) return;
  const c = selectedConv();
  const open = c ? windowOpen(c) : false;
  $('composer').classList.toggle('disabled', !open);
  $('text').disabled = !open; $('send').disabled = !open;
  $('window-note').hidden = open || !c;
  $('text').placeholder = open ? 'Type a message…' : 'Replies are disabled until the customer messages again';
}

// composer: Enter sends, Shift+Enter = new line
const ta = $('text');
ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 160) + 'px'; });
ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('composer').requestSubmit(); } });

$('composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = ta.value.trim();
  const phone = S.selected;
  if (!body || !phone) return;
  const c = selectedConv();
  if (!c || !windowOpen(c)) return;
  banner('');
  const p = { body, at: Date.now(), seq: S.snapSeq, done: false };
  S.pending.push(p);
  ta.value = ''; ta.style.height = 'auto';
  renderMessages();
  try {
    await call('sendReply')({ phone, body });
    if (S.snapSeq > p.seq) { S.pending = S.pending.filter((x) => x !== p); } else { p.done = true; }
    if (S.selected === phone) renderMessages();
  } catch (err) {
    S.pending = S.pending.filter((x) => x !== p);
    // Meta rejections are recorded as a failed message by the server; other errors leave nothing behind, so keep the text.
    if (S.selected === phone) {
      if (err && err.code !== 'functions/unavailable') ta.value = body;
      banner('Message not sent: ' + errText(err));
      renderMessages();
    }
  }
});

// ---------- unread ----------
function maybeMarkRead() {
  const c = selectedConv();
  if (!c || !isUnread(c)) return;
  if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
  if (S.markingRead.has(c.id)) return;
  S.markingRead.add(c.id);
  call('markRead')({ phone: c.id })
    .catch(() => {})
    .finally(() => setTimeout(() => S.markingRead.delete(c.id), 1500));
}
window.addEventListener('focus', maybeMarkRead);
document.addEventListener('visibilitychange', maybeMarkRead);

// ---------- new conversation / template ----------
const dlg = $('new-dlg');
function openNewDialog(phone, name) {
  $('n-phone').value = phone ? '+' + digits(phone) : '';
  $('n-name').value = name || '';
  $('n-err').textContent = '';
  $('n-go').disabled = false;
  if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
  (phone && name ? $('n-go') : (phone ? $('n-name') : $('n-phone'))).focus();
}
$('new-btn').onclick = () => openNewDialog();
$('tpl-btn').onclick = () => { const c = selectedConv(); openNewDialog(c ? c.id : '', c && c.name ? c.name : ''); };
$('n-cancel').onclick = () => dlg.close();
$('new-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const phone = normalizePhoneInput($('n-phone').value);
  const name = $('n-name').value.trim();
  $('n-err').textContent = '';
  $('n-go').disabled = true;
  try {
    const r = await call('startConversation')({ phone, name });
    dlg.close();
    openConversation(r.data.phone);
  } catch (err) {
    $('n-err').textContent = errText(err);
    $('n-go').disabled = false;
  }
});

// ---------- customer details panel ----------
const DETAIL_FIELDS = ['name', 'email', 'location', 'projectType', 'budget', 'source', 'notes'];
const detailsEl = () => $('details');
function detailsPref() { try { return localStorage.getItem('ek.details'); } catch (e) { return null; } }
function setDetailsPref(v) { try { localStorage.setItem('ek.details', v); } catch (e) { /* private mode */ } }
function detailsOpen() { return !detailsEl().hidden; }

function setDetailsOpen(open, remember) {
  detailsEl().hidden = !open || !S.selected;
  $('app').classList.toggle('has-details', open && !!S.selected);
  $('details-btn').setAttribute('aria-expanded', String(open && !!S.selected));
  if (remember) setDetailsPref(open ? 'open' : 'closed');
  if (open) renderDetails(true);
}
$('details-btn').onclick = () => setDetailsOpen(!detailsOpen(), true);
$('details-close').onclick = () => setDetailsOpen(false, true);

function watchContact(id) {
  if (S.unsubContact) { S.unsubContact(); S.unsubContact = null; }
  S.contact = null; S.dirty = false;
  if (!id) { setDetailsOpen(false, false); return; }
  // Wide screens: default open (remembered choice wins). Narrow screens: closed until asked for.
  const pref = detailsPref();
  setDetailsOpen(pref ? pref === 'open' && window.innerWidth >= 900 : window.innerWidth >= 1280, false);
  S.unsubContact = db.collection('contacts').doc(id).onSnapshot((d) => {
    S.contact = d.exists ? d.data() : {};
    renderDetails(false);
  }, () => {});
}

function renderDetails(force) {
  if (!S.selected || !detailsOpen()) return;
  if (S.dirty && !force) return;              // never overwrite what someone is typing
  const c = S.contact || {}, conv = selectedConv() || {};
  $('d-phone').textContent = formatPhone(S.selected);
  for (const k of DETAIL_FIELDS) {
    const v = k === 'name' ? (c.name != null ? c.name : conv.name) : c[k];
    $('d-' + k).value = v || '';
  }
  // a stored value that is not in the dropdown (e.g. from a future lead import) must still show
  for (const k of ['projectType', 'source']) {
    const sel = $('d-' + k), v = sel.value;
    if (!v && c[k]) { const o = document.createElement('option'); o.textContent = c[k]; sel.append(o); sel.value = c[k]; }
  }
  const made = c.createdAt && c.createdAt.toDate ? c.createdAt.toDate().toLocaleDateString('en-IE', { day: 'numeric', month: 'short', year: 'numeric', timeZone: TZ }) : null;
  const upd = c.updatedAt && c.updatedAt.toDate ? c.updatedAt.toDate().toLocaleDateString('en-IE', { day: 'numeric', month: 'short', year: 'numeric', timeZone: TZ }) : null;
  $('d-meta').textContent = [made && 'Added ' + made, upd && 'Updated ' + upd].filter(Boolean).join(' · ');
  S.dirty = false; $('d-save').disabled = true; setDetailMsg('');
}

function setDetailMsg(text, kind) { const m = $('d-msg'); m.textContent = text || ''; m.className = 'd-msg' + (kind ? ' ' + kind : ''); }

$('details-form').addEventListener('input', () => { S.dirty = true; $('d-save').disabled = false; setDetailMsg(''); });
$('details-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const phone = S.selected;
  if (!phone || !S.dirty) return;
  const fields = {};
  for (const k of DETAIL_FIELDS) fields[k] = $('d-' + k).value;
  $('d-save').disabled = true; setDetailMsg('Saving…');
  try {
    await call('updateContact')({ phone, fields });
    if (S.selected === phone) { S.dirty = false; setDetailMsg('Saved', 'ok'); setTimeout(() => { if ($('d-msg').textContent === 'Saved') setDetailMsg(''); }, 2500); }
  } catch (err) {
    $('d-save').disabled = false; setDetailMsg(errText(err), 'err');
  }
});
