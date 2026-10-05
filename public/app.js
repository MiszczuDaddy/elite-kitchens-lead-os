'use strict';
// Elite Kitchens Lead OS: inbox UI (Phase 2, milestone 1).
// Reads Firestore directly (staff-only rules); every write and every WhatsApp call goes through Cloud Functions.

const $ = (id) => document.getElementById(id);
const auth = firebase.auth();
const db = firebase.firestore();
const fns = firebase.app().functions('europe-west1');
const call = (name) => fns.httpsCallable(name);

const TZ = 'Europe/Dublin';
const INBOX_STATUSES = { inbox: 'New lead', booked: 'Booked', quoted: 'Quoted', won: 'Won', closed: 'Closed' };
const inboxStatus = (c) => Object.hasOwn(INBOX_STATUSES, c.inboxStatus) ? c.inboxStatus : 'inbox';
const statusRequests = new Map();
const statusErrors = new Map();

const S = {
  convs: [],            // conversation docs {id, ...data}
  selected: null,       // selected conversation id (phone digits)
  msgs: [],             // messages of the selected conversation
  query: '',
  statusFilter: 'inbox',
  pending: [],          // messages being sent (optimistic)
  snapSeq: 0,
  markingRead: new Set(),
  unsubList: null,
  unsubMsgs: null,
  unsubContact: null,
  contact: null,        // contacts/{phone} of the selected conversation
  dirty: false,         // unsaved edits in the details form
  listLoaded: false,
  attach: null,         // file chosen to send: { file, kind, mime, url }
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
  if (typeof c.unreadCount === 'number') return c.unreadCount > 0;    // maintained by the server once a conversation has new activity
  const inb = ms(c.lastInboundAt);
  if (!inb) return false;
  const read = ms(c.lastReadAt);
  return !read || inb > read;
};
const windowOpen = (c) => WindowState.isOpen(c, Date.now());      // the 24-hour rule is shared with the server (window-state.js)

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
const TYPE_ICON = { image: '📷 ', video: '🎥 ', audio: '🎤 ', document: '📄 ' };
function previewOf(c) {
  let t = String(c.lastMessage || '').replace(/^\[template:[^\]]*\]\s*/, '');
  if (PLACEHOLDERS[t]) t = PLACEHOLDERS[t];
  else if (TYPE_ICON[c.lastMessageType]) t = TYPE_ICON[c.lastMessageType] + t;
  return (c.lastMessageDirection === 'out' && t ? 'You: ' : '') + t;
}

const MEDIA_LABEL = { image: ['📷', 'Photo'], document: ['📄', 'Document'], video: ['🎥', 'Video'], audio: ['🎤', 'Voice message'], sticker: ['🙂', 'Sticker'] };

function banner(text) {
  const b = $('banner');
  b.textContent = text || '';
  b.hidden = !text;
}

const messageDrafts = new Map();
const contactDrafts = new Map();
function rememberDrafts() {
  if (!S.selected) return;
  if ($('text').value) messageDrafts.set(S.selected, $('text').value);
  else messageDrafts.delete(S.selected);
  if (S.dirty) contactDrafts.set(S.selected, Object.fromEntries(DETAIL_FIELDS.map(k => [k, $('d-'+k).value])));
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
  statusRequests.clear(); statusErrors.clear(); S.statusFilter = 'inbox';
  resetAssets(); closeLightbox(); urlCache.clear();
  messageDrafts.clear(); contactDrafts.clear(); $('text').value = '';
  clearAttachment();
  if (S.unsubList) { S.unsubList(); S.unsubList = null; }
  if (S.unsubMsgs) { S.unsubMsgs(); S.unsubMsgs = null; }
  if (S.unsubContact) { S.unsubContact(); S.unsubContact = null; }
  if (window.PIPE) PIPE.stop();
  if (window.APPT) APPT.stop();
  if (window.QUOTES) QUOTES.stop();
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
    renderDetails(false);          // keeps the stage dates line current when the stage changes
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
  const shown = S.convs.filter((c) => inboxStatus(c) === S.statusFilter && matchesQuery(c, q));
  list.replaceChildren(...shown.map(convItem));
  list.scrollTop = keep;

  const empty = $('list-empty');
  if (!S.listLoaded) { empty.hidden = true; }
  else if (!S.convs.length) { empty.hidden = false; empty.textContent = 'No conversations yet. New WhatsApp messages will appear here.'; }
  else if (!shown.length) { empty.hidden = false; empty.textContent = q ? 'No conversations match your search in ' + INBOX_STATUSES[S.statusFilter] + '.' : 'No conversations marked ' + INBOX_STATUSES[S.statusFilter] + '.'; }
  else empty.hidden = true;

  const n = S.convs.filter(isUnread).length;
  $('total-unread').hidden = !n; $('total-unread').textContent = n;
  $('rail-badge').hidden = !n; $('rail-badge').textContent = n > 9 ? '9+' : n;
  document.title = (n ? `(${n}) ` : '') + 'Inbox · Elite Kitchens';
  for (const button of $('status-filters').querySelectorAll('button')) {
    const status = button.dataset.status;
    const unread = S.convs.filter(c => inboxStatus(c) === status && isUnread(c)).length;
    button.setAttribute('aria-pressed', String(status === S.statusFilter));
    button.setAttribute('aria-label', INBOX_STATUSES[status] + (unread ? ', ' + unread + ' unread conversation' + (unread === 1 ? '' : 's') : ''));
    button.querySelector('.status-unread').hidden = !unread;
  }
}

function convItem(c) {
  const unread = isUnread(c);
  const item = el('div', 'conv' + (unread ? ' unread' : '') + (c.id === S.selected ? ' sel' : ''));
  item.setAttribute('role', 'listitem'); item.tabIndex = 0; item.dataset.phone = c.id;
  if (c.id === S.selected) item.setAttribute('aria-current', 'true');
  item.setAttribute('aria-label', displayName(c) + (unread ? ', unread messages' : '') + '. Open conversation');
  item.append(el('div', 'avatar', initials(c)));
  const body = el('div', 'conv-body');
  const top = el('div', 'conv-top');
  top.append(el('div', 'conv-name', displayName(c)), el('div', 'conv-time', listTime(ms(c.updatedAt))));
  body.append(top);
  const tag = [c.projectType, c.location].filter(Boolean).join(' · ');
  if (tag) body.append(el('div', 'conv-sub', tag));
  const prev = el('div', 'conv-prev');
  prev.append(el('span', 't', previewOf(c) || ' '));
  if (unread) {
    if (typeof c.unreadCount === 'number' && c.unreadCount > 0) { const b = el('span', 'badge', c.unreadCount > 99 ? '99+' : String(c.unreadCount)); b.title = c.unreadCount + ' unread'; prev.append(b); }
    else { const d = el('span', 'dot'); d.title = 'Unread'; prev.append(d); }
  }
  body.append(prev);
  item.append(body);
  const open = () => openConversation(c.id);
  item.onclick = open;
  item.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } };
  return item;
}

$('search').addEventListener('input', (e) => { S.query = e.target.value; renderList(); });
$('status-filters').addEventListener('click', e => {
  const button = e.target.closest('button[data-status]');
  if (!button) return;
  S.statusFilter = button.dataset.status;
  $('list').scrollTop = 0;
  renderList();
});

$('conversation-status').addEventListener('change', async e => {
  const phone = S.selected, status = e.target.value;
  if (!phone || statusRequests.has(phone) || !Object.hasOwn(INBOX_STATUSES, status)) return;
  const request = { status };
  statusRequests.set(phone, request); statusErrors.delete(phone); renderConversationStatus();
  try {
    const res = await call('setConversationStatus')({ phone, status });
    if (statusRequests.get(phone) !== request) return; // signed out while saving
    if (res && res.data && res.data.corrected) toast('Corrected: the move to ' + CRM.LABELS[res.data.undone] + ' was undone and will not be counted.');
    const conversation = S.convs.find(c => c.id === phone);
    if (conversation) conversation.inboxStatus = status; // server-confirmed; no optimistic filter move
  } catch (err) {
    if (statusRequests.get(phone) !== request) return;
    statusErrors.set(phone, 'Could not confirm the status change. Please try again.');
  } finally {
    if (statusRequests.get(phone) === request) {
      statusRequests.delete(phone); renderList(); renderConversationStatus();
    }
  }
});

function renderConversationStatus() {
  const c = selectedConv(), pending = statusRequests.get(S.selected), error = statusErrors.get(S.selected);
  $('conversation-status').value = pending ? pending.status : inboxStatus(c || {});
  $('conversation-status').closest('.conversation-state').dataset.status = $('conversation-status').value;   // stage colour for the dot and tint
  $('conversation-status').disabled = !c || !!pending;
  const feedback = $('status-feedback');
  feedback.hidden = !pending && !error;
  feedback.classList.toggle('error', !!error);
  feedback.textContent = pending ? 'Updating status…' : error || '';
}

// ---------- routing ----------
function routeFromHash() {
  // Quotes (Phase 6): #quotes, #quotes/<id>, #quotes/settings. Leaving a quote with unsaved changes asks first.
  if (window.QUOTES && !QUOTES.mayLeave(location.hash)) return;
  if (window.QUOTES && QUOTES.handles(location.hash)) {
    if (S.selected) closeConversation(true);
    if (window.PIPE && PIPE.active) PIPE.hide();
    if (window.APPT && APPT.active) APPT.hide();
    QUOTES.show(location.hash); return;
  }
  if (window.QUOTES && QUOTES.active) QUOTES.hide();
  if (location.hash === '#appointments' && window.APPT) { if (S.selected) closeConversation(true); if (window.PIPE && PIPE.active) PIPE.hide(); APPT.show(); return; }
  if (window.APPT && APPT.active) APPT.hide();
  if (location.hash === '#pipeline' && window.APPT) APPT.origin = false;
  if (location.hash === '#pipeline' && window.PIPE) { if (S.selected) closeConversation(true); PIPE.show(); return; }
  if (window.PIPE && PIPE.active) PIPE.hide();
  const m = /^#c\/(\d+)$/.exec(location.hash);
  if (m) openConversation(m[1], true); else closeConversation(true);
}
window.addEventListener('hashchange', routeFromHash);

function setView() { $('app').dataset.view = window.QUOTES && QUOTES.active ? 'quotes' : window.APPT && APPT.active ? 'appointments' : window.PIPE && PIPE.active ? 'pipeline' : S.selected ? 'thread' : 'list'; }

function closeConversation(fromHash) {
  rememberDrafts();
  resetAssets(); closeLightbox();
  if (S.unsubMsgs) { S.unsubMsgs(); S.unsubMsgs = null; }
  clearAttachment();
  S.selected = null; S.msgs = []; S.pending = [];
  watchContact(null);
  $('thread').hidden = true; $('thread-empty').hidden = false;
  if (!fromHash && location.hash) history.replaceState(null, '', location.pathname + location.search);
  setView(); renderList();
}
$('back').onclick = () => {
  if (window.QUOTES && QUOTES.backTo) { const h = QUOTES.backTo; QUOTES.backTo = null; location.hash = h; return; }   // came from a quote: go back to it
  if (window.APPT && APPT.origin) { APPT.origin = false; location.hash = '#appointments'; return; }   // came from Appointments: go back to it
  if (window.PIPE && PIPE.origin) { PIPE.origin = false; location.hash = '#pipeline'; return; }   // came from the pipeline: go back to it
  closeConversation(false);
};

function openConversation(id, fromHash) {
  if (!id) return;
  if (S.selected === id) { setView(); return; }
  if (!fromHash && window.PIPE) PIPE.origin = false;      // opened from the Inbox list, not from the pipeline
  if (!fromHash && window.APPT) APPT.origin = false;
  if (!fromHash && window.QUOTES) QUOTES.backTo = null;
  rememberDrafts();
  if (S.unsubMsgs) { S.unsubMsgs(); S.unsubMsgs = null; }
  clearAttachment();
  S.selected = id; S.msgs = []; S.pending = []; banner('');
  $('text').value = messageDrafts.get(id) || ''; $('text').style.height = 'auto';
  if (!fromHash) history.replaceState(null, '', '#c/' + id);
  $('thread').hidden = false; $('thread-empty').hidden = true;
  $('msgs').replaceChildren();
  renderThreadHeader(); updateComposer(); setView(); renderList();
  resetAssets();
  setProfileTab("details");
  watchContact(id);
  S.firstRender = true;
  S.unsubMsgs = db.collection('conversations').doc(id).collection('messages').orderBy('createdAt').limitToLast(500).onSnapshot((snap) => {
    S.msgs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    S.snapSeq++;
    S.pending = S.pending.filter((p) => !p.done);
    renderMessages();
    renderAssets();
    updateComposer();               // a Reopen template's delivery status arrives as a message update
    maybeMarkRead();
  }, (e) => banner('Cannot load messages: ' + errText(e)));
  maybeMarkRead();
  $('text').focus({ preventScroll: true });
}

// ---------- thread ----------
function renderThreadHeader() {
  if (!S.selected) return;
  renderConversationStatus();
  const c = selectedConv() || { id: S.selected };
  $('t-avatar').textContent = initials(c);
  $('profile-avatar').textContent = initials(c);
  $('profile-name').textContent = displayName(c);
  $('t-name').textContent = displayName(c);
  $('t-phone').textContent = c.name ? formatPhone(c.id) + (c.location ? ' · ' + c.location : '') : '';
}

function statusNode(m) {
  const s = m.status;
  if (m.state === 'sending') return el('span', 'tick', 'Sending…');
  if (s === 'failed') return el('span', 'tick', 'Failed');
  if (s === 'read') { const n = el('span', 'tick read', '✓✓'); n.title = 'Read'; return n; }
  if (s === 'delivered') { const n = el('span', 'tick', '✓✓'); n.title = 'Delivered'; return n; }
  if (s === 'sent') { const n = el('span', 'tick', '✓'); n.title = 'Sent'; return n; }
  return null;
}

// ---------- media (files live in private storage; the browser only ever gets short-lived signed links) ----------
const SIZE = (n) => { n = Number(n); if (!n) return ''; if (n < 1024) return n + ' B'; if (n < 1048576) return Math.round(n / 1024) + ' KB'; return (n / 1048576).toFixed(1) + ' MB'; };
const urlCache = new Map();        // "phone/msgId/dl" -> { url, exp }
const urlInflight = new Map();
let active = 0; const waiting = [];
function limited(fn) { return new Promise((res, rej) => { const run = () => { active++; fn().then(res, rej).finally(() => { active--; const n = waiting.shift(); if (n) n(); }); }; active < 4 ? run() : waiting.push(run); }); }

function cachedUrl(phone, id, dl) {
  const c = urlCache.get(`${phone}/${id}/${dl ? 1 : 0}`);
  return c && c.exp > Date.now() + 30000 ? c.url : null;
}
function loadUrl(phone, id, dl) {
  const hit = cachedUrl(phone, id, dl);
  if (hit) return Promise.resolve(hit);
  const key = `${phone}/${id}/${dl ? 1 : 0}`;
  if (!urlInflight.has(key)) {
    urlInflight.set(key, limited(() => call('mediaUrl')({ phone, id, download: !!dl })).then((r) => {
      urlCache.set(key, { url: r.data.url, exp: Date.now() + 9 * 60 * 1000 });
      return r.data.url;
    }).finally(() => urlInflight.delete(key)));
  }
  return urlInflight.get(key);
}

// Fetch a media link only when its element scrolls into view.
const io = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) { io.unobserve(e.target); const f = e.target._load; if (f) f(); }
}, { root: $('msgs'), rootMargin: '1000px' }) : null;
function whenVisible(host, fn) { host._load = fn; if (io) io.observe(host); else fn(); }

function fileIcon() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  for (const [k,v] of Object.entries({viewBox:'0 0 24 24',width:'24',height:'24',fill:'none',stroke:'currentColor','stroke-width':'1.5','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true'})) svg.setAttribute(k,v);
  const path = document.createElementNS(ns,'path'); path.setAttribute('d','M14 3H5v18h14V8l-5-5Zm0 0v5h5M8 12h8M8 16h6'); svg.append(path); return svg;
}

function chip(icon, text) { const c = el('div', 'media-status'); c.append(el('span', null, icon), el('span', null, text)); return c; }

function saveAs(url, name) { const a = document.createElement('a'); a.href = url; a.download = name || 'file'; a.rel = 'noopener'; document.body.append(a); a.click(); a.remove(); }
async function downloadMedia(phone, m) {
  try { saveAs(await loadUrl(phone, m.id, true), (m.media && m.media.filename) || 'file'); } catch (e) { banner('Could not download: ' + errText(e)); }
}

// Safety net: if the automatic download at arrival failed or never finished, fetch it in the background (once per page load,
// only when it scrolls into view) instead of waiting for a click. WhatsApp keeps media for about 30 days.
const autoTried = new Set();
function autoRetryWanted(m) {
  const md = m.media || {}, age = Date.now() - (ms(m.createdAt) || Date.now());
  if (!(md.waMediaId || md.id) || age > 29 * 86400000) return false;
  return (md.status === 'failed' && age > 20000) || (md.status === 'pending' && age > 90000) || !md.status;   // !status = a message stored before automatic downloads existed
}
function autoRetry(phone, id) {
  const k = phone + '/' + id;
  if (autoTried.has(k)) return;
  autoTried.add(k);
  limited(() => call('retryMedia')({ phone, id })).catch(() => {});
}

function mediaBlock(m, type) {
  const [icon, label] = MEDIA_LABEL[type];
  const box = el('div', 'media-box');
  const md = m.media || {};
  const phone = S.selected, id = m.id;
  if (m.attach) { box.append(chip(icon, `${m.attach.name} · ${m.progress != null ? 'Uploading ' + m.progress + '%' : 'Sending…'}`)); return box; }
  if (md.status === 'expired') { box.append(chip(icon, `${md.filename || label} · removed after the retention period`)); return box; }
  if (md.status !== 'stored' && autoRetryWanted(m)) whenVisible(box, () => autoRetry(phone, id));
  if (md.status === 'pending') { box.append(chip(icon, `${label} · downloading…`)); return box; }
  if (md.status !== 'stored' || !md.storagePath) {
    const c = chip(icon, `${md.filename || label} · ${md.status === 'failed' ? "couldn't be downloaded" : 'not downloaded yet'}`);
    const btn = el('button', 'linkbtn', 'Retry'); btn.type = 'button';
    btn.onclick = async () => {
      btn.disabled = true; btn.textContent = 'Retrying…';
      try { const r = await call('retryMedia')({ phone, id }); if (r.data.status !== 'stored') { btn.disabled = false; btn.textContent = 'Retry'; banner('Still could not download: ' + (r.data.error || 'unknown error')); } }
      catch (e) { btn.disabled = false; btn.textContent = 'Retry'; banner('Retry failed: ' + errText(e)); }
    };
    c.append(btn); box.append(c);
    if (md.error) box.append(el('div', 'media-err', md.error));
    return box;
  }
  if (type === 'image' || type === 'sticker') {
    const img = el('img', 'media-img' + (type === 'sticker' ? ' sticker' : '')); img.alt = label; img.loading = 'lazy';
    if (type === 'image') { img.onclick = () => openLightbox(phone, m); img.tabIndex = 0; img.setAttribute('role', 'button'); img.setAttribute('aria-label', 'Open photo'); img.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openLightbox(phone, m); } }; }
    const set = (u) => { img.src = u; };
    const hit = cachedUrl(phone, id, false);
    if (hit) set(hit); else whenVisible(img, () => loadUrl(phone, id, false).then(set).catch(() => { img.replaceWith(chip(icon, `${label} · couldn't load`)); }));
    box.append(img);
  } else if (type === 'video') {
    const v = el('video', 'media-video'); v.controls = true; v.preload = 'metadata'; v.playsInline = true;
    const hit = cachedUrl(phone, id, false);
    if (hit) v.src = hit; else whenVisible(v, () => loadUrl(phone, id, false).then((u) => { v.src = u; }).catch(() => v.replaceWith(chip(icon, `${label} · couldn't load`))));
    box.append(v);
  } else if (type === 'audio') {
    if (md.voice) box.append(el('div', 'voice-label', '🎤 Voice message'));
    const a = el('audio', 'media-audio'); a.controls = true; a.preload = 'none';
    const fallback = () => { const c = chip('🎤', "This browser can't play this audio"); const b = el('button', 'linkbtn', 'Download'); b.type = 'button'; b.onclick = () => downloadMedia(phone, m); c.append(b); a.replaceWith(c); };
    a.addEventListener('error', fallback);
    const hit = cachedUrl(phone, id, false);
    if (hit) a.src = hit; else whenVisible(a, () => loadUrl(phone, id, false).then((u) => { a.src = u; }).catch(fallback));
    box.append(a);
  } else {   // document
    const card = el('div', 'doc-card');
    const fileMark = el('div', 'doc-icon'); fileMark.append(fileIcon()); card.append(fileMark);
    const main = el('div', 'doc-main');
    main.append(el('div', 'doc-name', md.filename || label), el('div', 'doc-sub', [SIZE(md.size), (md.mimeType || '').split('/').pop().toUpperCase()].filter(Boolean).join(' · ')));
    const act = el('div', 'doc-actions');
    const open = el('a', null, 'Open'); open.target = '_blank'; open.rel = 'noopener'; open.href = '#';
    open.onclick = async (e) => {
      const hit = cachedUrl(phone, id, false);
      if (hit) { open.href = hit; return; }
      e.preventDefault();
      try { const u = await loadUrl(phone, id, false); window.open(u, '_blank', 'noopener'); } catch (err) { banner('Could not open: ' + errText(err)); }
    };
    const dl = el('button', 'linkbtn', 'Download'); dl.type = 'button'; dl.onclick = () => downloadMedia(phone, m);
    act.append(open, dl); main.append(act); card.append(main); box.append(card);
  }
  return box;
}

$('lb-close').onclick = closeLightbox;
$('lightbox').addEventListener('click', (e) => { if (e.target === $('lightbox')) closeLightbox(); });


// ---------- message bubbles ----------
const timeOf = (m) => { const t = m.createdAt && m.createdAt.toDate ? m.createdAt.toDate() : (m.at ? new Date(m.at) : null); return t ? hhmm(t) : ''; };

function buildBubble(m) {
  const out = m.direction === 'out';
  const b = el('div', 'm ' + (out ? 'out' : 'in') + (m.status === 'failed' ? ' failed' : ''));
  const type = m.type || 'text';
  const isMedia = !!MEDIA_LABEL[type];
  if (isMedia) {
    if (m.media || m.attach) b.append(mediaBlock(m, type));
    else { const [icon, label] = MEDIA_LABEL[type]; b.append(chip(icon, label)); }
  }
  const placeholder = /^\[[a-z]+\]$/.test(m.body || '');
  if (m.body && !(isMedia && placeholder)) b.append(el('div', 'body', m.body));
  const meta = el('div', 'meta');
  meta.append(el('span', null, timeOf(m)), el('span', 'tickwrap'));
  b.append(meta);
  if (m.error) b.append(el('div', 'err', m.error));
  patchTick(b, m);
  return b;
}
function patchTick(b, m) {
  const w = b.querySelector('.tickwrap'); if (!w) return;
  w.replaceChildren();
  if (m.direction === 'out') { const n = statusNode(m); if (n) w.append(n); }
  b.classList.toggle('failed', m.status === 'failed');
}

// Keep each message's element between renders (a playing voice note must not restart when a new message arrives).
const nodeCache = new Map();
let cacheFor = null;
const sigOf = (m) => { const d = m.media || null; return JSON.stringify([m.body, m.type, m.error, m.state, m.progress, d && [d.status, d.storagePath, d.error, d.filename]]); };

function renderMessages() {
  const box = $('msgs');
  if (cacheFor !== S.selected) { nodeCache.clear(); cacheFor = S.selected; }
  const atBottom = S.firstRender || box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const all = [...S.msgs, ...S.pending.map((p) => ({ direction: 'out', type: p.attach ? p.kind : 'text', body: p.body, at: p.at, state: 'sending', attach: p.attach, progress: p.progress }))];
  const nodes = [], seen = new Set();
  let lastDay = null;
  for (const m of all) {
    const key = m.id ? 'm:' + m.id : 'p:' + m.at;
    const sig = sigOf(m), tick = (m.status || '') + '|' + (m.state || '');
    let c = nodeCache.get(key);
    if (!c || c.sig !== sig) { c = { el: buildBubble(m), sig, tick }; nodeCache.set(key, c); }
    else if (c.tick !== tick) { patchTick(c.el, m); c.tick = tick; }
    seen.add(key);
    const d = m.createdAt && m.createdAt.toDate ? m.createdAt.toDate() : new Date(m.at || Date.now());
    const k = dayKey(d);
    if (k !== lastDay) { nodes.push(el('div', 'day', dayLabel(d))); lastDay = k; }
    nodes.push(c.el);
  }
  for (const k of [...nodeCache.keys()]) if (!seen.has(k)) nodeCache.delete(k);
  box.replaceChildren(...nodes);
  if (atBottom) box.scrollTop = box.scrollHeight;
  S.firstRender = false;
}

// The 24-hour window and Reopen conversation (Phase 6.1 M1). open: normal messages. awaiting: a Reopen template was sent and the
// customer has not replied, so messaging stays OFF. closed: Reopen (once per 24 hours). The state comes from window-state.js, the
// same rule the server enforces; the screen never implies the chat is open before the customer's reply.
function windowInfo(c) {
  const w = c && c.reopen && c.reopen.wamid ? S.msgs.find((m) => m.id === c.reopen.wamid) : null;    // its delivery status
  return WindowState.windowStatus(c, Date.now(), w || null);
}
const whenText = (t) => { const d = new Date(t); return dayKey(d) === dayKey(new Date()) ? hhmm(d) : dayLabel(d) + ' at ' + hhmm(d); };
const DELIVERY = { sending: 'sending…', sent: 'sent', delivered: 'delivered', read: 'read', unsure: 'not confirmed: check this chat before trying again' };
function windowNote(c, w) {
  const name = c.name || 'the customer', r = w.reopen;
  if (w.state === 'awaiting') return `Template sent ${whenText(r.at)} (${DELIVERY[r.kind]}). Waiting for ${name} to reply. You can't send normal messages until they do.`;
  let t = `${ms(c.lastInboundAt) ? `More than 24 hours since ${name} last messaged.` : `${name} hasn't messaged yet.`} WhatsApp only allows an approved template until they reply.`;
  if (r && r.kind === 'refused') t += ` The last attempt did not go through: ${r.error || 'WhatsApp refused it.'}`;
  else if (r && r.kind === 'undelivered') t += ` WhatsApp could not deliver the template sent ${whenText(r.at)}${r.error ? ` (${r.error})` : ''}.${w.canReopen ? '' : ` You can try again after ${whenText(w.nextReopenAt)}.`}`;
  else if (r) t += ` The template sent ${whenText(r.at)} got no reply.`;
  return t;
}
function updateComposer() {
  if (!S.selected) return;
  const c = selectedConv();
  const w = c ? windowInfo(c) : null;
  const open = !!w && w.state === 'open';
  $('composer').classList.toggle('disabled', !open);
  $('text').disabled = !open; $('send').disabled = !open; $('attach-btn').disabled = !open;
  $('window-note').hidden = open || !c;
  if (c && !open) {
    $('window-text').textContent = windowNote(c, w);
    $('tpl-btn').hidden = !(w.state === 'closed' && w.canReopen);
  }
  $('text').placeholder = open ? 'Type a message…' : w && w.state === 'awaiting' ? `Waiting for ${c.name || 'the customer'} to reply…` : 'Replies are disabled until the customer messages again';
}
setInterval(() => { if (S.selected) updateComposer(); }, 60000);          // a window closing, or a Reopen's day running out, while the chat is open

// composer: Enter sends, Shift+Enter = new line
const ta = $('text');
ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 160) + 'px'; });
ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('composer').requestSubmit(); } });

const finishPending = (p, phone) => {
  if (S.snapSeq > p.seq) S.pending = S.pending.filter((x) => x !== p); else p.done = true;   // drop it now if the real message already arrived
  if (S.selected === phone) renderMessages();
};

$('composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const phone = S.selected;
  if (!phone) return;
  const c = selectedConv();
  if (!c || !windowOpen(c)) return;
  const body = ta.value.trim();
  if (S.attach) return sendAttachment(phone, body);
  if (!body) return;
  banner('');
  const p = { body, at: Date.now(), seq: S.snapSeq, done: false };
  S.pending.push(p);
  ta.value = ''; ta.style.height = 'auto';
  renderMessages();
  try {
    await call('sendReply')({ phone, body });
    finishPending(p, phone);
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

// ---------- attachments (same limits WhatsApp enforces; the server re-checks everything) ----------
const MB = 1024 * 1024;
const SEND_RULES = {
  image: { mimes: ['image/jpeg', 'image/png'], max: 5 * MB, hint: 'Photos must be JPG or PNG and under 5 MB.' },
  video: { mimes: ['video/mp4', 'video/3gpp'], max: 16 * MB, hint: 'Videos must be MP4 and under 16 MB.' },
  audio: { mimes: ['audio/aac', 'audio/mp4', 'audio/mpeg', 'audio/amr', 'audio/ogg'], max: 16 * MB, hint: 'Audio must be under 16 MB.' },
  document: { mimes: ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'text/plain'],
    max: 100 * MB, hint: 'Documents must be under 100 MB.' },
};
const EXT_MIME = { pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', mp4: 'video/mp4', '3gp': 'video/3gpp', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', amr: 'audio/amr', ogg: 'audio/ogg', opus: 'audio/ogg' };

function classify(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const mime = (file.type || EXT_MIME[ext] || '').toLowerCase().split(';')[0];
  for (const [kind, r] of Object.entries(SEND_RULES)) {
    if (!r.mimes.includes(mime)) continue;
    if (file.size > r.max) throw new Error(`That file is too large. ${r.hint}`);
    return { kind, mime };
  }
  throw new Error("WhatsApp can't send that file type. Use JPG/PNG photos, MP4 video, audio, or PDF/Word/Excel/PowerPoint/text documents.");
}

function clearAttachment() {
  if (S.attach && S.attach.url) URL.revokeObjectURL(S.attach.url);
  S.attach = null; $('attach-bar').hidden = true; $('attach-thumb').replaceChildren(); $('file').value = '';
}
function chooseFile(file) {
  if (!file || !S.selected) return;
  const c = selectedConv();
  if (!c || !windowOpen(c)) { banner('Attachments can only be sent while the 24-hour window is open.'); return; }
  let k;
  try { k = classify(file); } catch (e) { banner(e.message); return; }
  banner(''); clearAttachment();
  S.attach = { file, kind: k.kind, mime: k.mime, url: k.kind === 'image' ? URL.createObjectURL(file) : null };
  const th = $('attach-thumb');
  if (S.attach.url) { const i = el('img'); i.alt = ''; i.src = S.attach.url; th.append(i); } else th.textContent = { video: '🎥', audio: '🎤', document: '📄' }[k.kind];
  $('attach-name').textContent = file.name;
  $('attach-sub').textContent = `${SIZE(file.size)} · add a caption below, then press Send`;
  $('attach-bar').hidden = false;
  ta.focus();
}
$('attach-btn').onclick = () => $('file').click();
$('file').addEventListener('change', (e) => { const f = e.target.files && e.target.files[0]; if (f) chooseFile(f); });
$('attach-x').onclick = clearAttachment;
ta.addEventListener('paste', (e) => { const f = e.clipboardData && e.clipboardData.files && e.clipboardData.files[0]; if (f) { e.preventDefault(); chooseFile(f); } });
const thread = $('thread');
['dragenter', 'dragover'].forEach((ev) => thread.addEventListener(ev, (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); thread.classList.add('dropping'); } }));
['dragleave', 'drop'].forEach((ev) => thread.addEventListener(ev, (e) => { if (ev === 'dragleave' && thread.contains(e.relatedTarget)) return; thread.classList.remove('dropping'); }));
thread.addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) chooseFile(f); });

async function sendAttachment(phone, caption) {
  const att = S.attach, user = auth.currentUser;
  if (!att || !user) return;
  banner('');
  const p = { body: caption, at: Date.now(), seq: S.snapSeq, done: false, attach: { name: att.file.name }, kind: att.kind, progress: 0 };
  S.pending.push(p);
  const keep = { file: att.file, kind: att.kind, mime: att.mime };
  clearAttachment(); ta.value = ''; ta.style.height = 'auto';
  renderMessages();
  const path = `uploads/${user.uid}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${att.file.name.replace(/[^\w.\-]/g, '_')}`;
  try {
    const task = firebase.storage().ref(path).put(att.file, { contentType: att.mime });
    task.on('state_changed', (s) => { p.progress = Math.round(100 * s.bytesTransferred / Math.max(1, s.totalBytes)); if (S.selected === phone) renderMessages(); });
    await task;
    p.progress = null; if (S.selected === phone) renderMessages();        // uploaded; now handing it to WhatsApp
    await call('sendMedia')({ phone, uploadPath: path, caption, filename: att.file.name });
    finishPending(p, phone);
  } catch (err) {
    S.pending = S.pending.filter((x) => x !== p);
    if (S.selected === phone) {                                              // put everything back so nothing is lost
      if (!(err && err.code === 'functions/unavailable')) { S.attach = { ...keep, url: keep.kind === 'image' ? URL.createObjectURL(keep.file) : null }; $('attach-bar').hidden = false;
        $('attach-thumb').replaceChildren(); if (S.attach.url) { const i = el('img'); i.alt = ''; i.src = S.attach.url; $('attach-thumb').append(i); } else $('attach-thumb').textContent = { video: '🎥', audio: '🎤', document: '📄' }[keep.kind];
        $('attach-name').textContent = keep.file.name; $('attach-sub').textContent = SIZE(keep.file.size); ta.value = caption; }
      banner('File not sent: ' + errText(err));
      renderMessages();
    }
  }
}

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
// ---------- Reopen conversation (Phase 6.1 M1): a confirmation that shows exactly what will be sent ----------
const rdlg = $('reopen-dlg');
let reopenDlg = null;                                           // { phone, requestId, working } while the dialog is open
const reopenRequestId = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12));
function openReopen() {
  const c = selectedConv(); if (!c) return;
  const w = windowInfo(c);
  if (w.state !== 'closed' || !w.canReopen) { updateComposer(); return; }
  reopenDlg = { phone: c.id, requestId: reopenRequestId(), working: false };      // one request id per dialog: a double click sends once
  const who = c.name || formatPhone(c.id);
  $('reopen-who').textContent = `This sends WhatsApp's approved template to ${who}:`;
  $('reopen-text').textContent = WindowState.reopenText(WindowState.firstName(c.name));
  $('reopen-note').textContent = `Sending it does not reopen normal messaging. You can message ${c.name || 'them'} normally only after they reply.`;
  $('reopen-err').textContent = ''; $('reopen-go').disabled = false; $('reopen-cancel').disabled = false; $('reopen-cancel').textContent = 'Cancel';
  if (typeof rdlg.showModal === 'function') rdlg.showModal(); else rdlg.setAttribute('open', '');
  $('reopen-go').focus();
}
$('tpl-btn').onclick = openReopen;
$('reopen-cancel').onclick = () => { if (!reopenDlg || !reopenDlg.working) rdlg.close(); };
rdlg.addEventListener('cancel', (e) => { if (reopenDlg && reopenDlg.working) e.preventDefault(); });
rdlg.addEventListener('close', () => { reopenDlg = null; });
$('reopen-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const d = reopenDlg; if (!d || d.working) return;
  d.working = true; $('reopen-go').disabled = true; $('reopen-cancel').disabled = true; $('reopen-err').textContent = '';
  try {
    await call('reopenConversation')({ phone: d.phone, requestId: d.requestId });
    rdlg.close();                                               // the chat now shows "waiting for the customer to reply"
  } catch (err) {
    $('reopen-err').textContent = errText(err);                 // no retry from here: the chat shows what happened and offers Reopen again only when it is allowed
    $('reopen-cancel').textContent = 'Close';
  } finally { d.working = false; $('reopen-cancel').disabled = false; }
});
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

// ---------- add a customer without messaging (Phase 6) ----------
// Phone, email and walk-in enquiries: the customer is added as a New lead and nothing is sent to them. If the number is already
// a customer they are opened instead. onDone(phone, existing) lets Quotes carry on, e.g. by creating their quote.
const custDlg = $('cust-dlg');
let custDone = null;
function openAddCustomer(prefill = {}, onDone = null) {
  custDone = onDone;
  $('c-phone').value = prefill.phone || ''; $('c-name').value = prefill.name || '';
  for (const k of ['email', 'address', 'location', 'source']) $('c-' + k).value = '';
  $('c-err').textContent = ''; $('c-go').disabled = false;
  if (typeof custDlg.showModal === 'function') custDlg.showModal(); else custDlg.setAttribute('open', '');
  (prefill.phone ? (prefill.name ? $('c-email') : $('c-name')) : $('c-phone')).focus();
}
$('n-nomsg').onclick = () => { const phone = $('n-phone').value, name = $('n-name').value; dlg.close(); openAddCustomer({ phone, name }); };
$('c-cancel').onclick = () => { custDlg.close(); custDone = null; };
$('cust-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = { phone: $('c-phone').value, name: $('c-name').value };
  for (const k of ['email', 'address', 'location', 'source']) if ($('c-' + k).value.trim()) data[k] = $('c-' + k).value;
  $('c-err').textContent = ''; $('c-go').disabled = true;
  try {
    const r = (await call('createCustomer')(data)).data;
    custDlg.close();
    const done = custDone; custDone = null;
    if (done) { done(r.phone, r.existing); return; }
    if (r.existing) toast('That number is already a customer: opening them. Nothing was changed.');
    openConversation(r.phone);
  } catch (err) { $('c-err').textContent = errText(err); $('c-go').disabled = false; }
});

// ---------- customer details panel ----------
const DETAIL_FIELDS = ['name', 'email', 'location', 'address', 'projectType', 'budget', 'quoteValue', 'source', 'notes'];
const detailsEl = () => $('details');
function detailsPref() { try { return localStorage.getItem('ek.details'); } catch (e) { return null; } }
function setDetailsPref(v) { try { localStorage.setItem('ek.details', v); } catch (e) { /* private mode */ } }
function detailsOpen() { return !detailsEl().hidden; }

function setDetailsOpen(open, remember) {
  detailsEl().hidden = !open || !S.selected;
  $('app').classList.toggle('has-details', open && !!S.selected);
  $('details-btn').setAttribute('aria-expanded', String(open && !!S.selected));
  $('profile-trigger').setAttribute('aria-expanded', String(open && !!S.selected));
  syncProfileOverlay();
  if (open && window.innerWidth < 1280) $('details-close').focus();
  if (!open && S.selected) $('profile-trigger').focus({preventScroll:true});
  if (remember) setDetailsPref(open ? 'open' : 'closed');
  if (open) { renderDetails(false); renderAssets(); }
}
$('details-btn').onclick = () => setDetailsOpen(!detailsOpen(), true);
$('profile-trigger').onclick = () => setDetailsOpen(true, true);
$('details-close').onclick = () => setDetailsOpen(false, true);

function watchContact(id) {
  if (S.unsubContact) { S.unsubContact(); S.unsubContact = null; }
  if (window.APPT) APPT.watchCustomer(id);           // the customer's appointments, shown above the details form
  if (window.QUOTES) QUOTES.watchCustomer(id);       // and their quotes (Phase 6)
  S.contact = null; S.dirty = false;
  setDetailMsg('');
  $('profile-body').scrollTop = 0;
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
    const v = k === 'name' ? (c.name != null ? c.name : conv.name) : k === 'quoteValue' ? CRM.money(c.quoteValue) : c[k];
    $('d-' + k).value = v || '';
  }
  // a stored value that is not in the dropdown (e.g. from a future lead import) must still show
  for (const k of ['projectType', 'source']) {
    const sel = $('d-' + k), v = sel.value;
    if (!v && c[k]) { const o = document.createElement('option'); o.textContent = c[k]; sel.append(o); sel.value = c[k]; }
  }
  const made = c.createdAt && c.createdAt.toDate ? c.createdAt.toDate().toLocaleDateString('en-IE', { day: 'numeric', month: 'short', year: 'numeric', timeZone: TZ }) : null;
  const upd = c.updatedAt && c.updatedAt.toDate ? c.updatedAt.toDate().toLocaleDateString('en-IE', { day: 'numeric', month: 'short', year: 'numeric', timeZone: TZ }) : null;
  const sd = conv.stageDates || {}, day = (t) => t && t.toDate ? t.toDate().toLocaleDateString('en-IE', { day: 'numeric', month: 'short', timeZone: TZ }) : null;
  const stages = ['booked', 'quoted', 'won', 'closed'].filter((k) => day(sd[k])).map((k) => CRM.LABELS[k] + ' ' + day(sd[k]));
  $('d-meta').textContent = [made && 'Added ' + made, ...stages, upd && 'Updated ' + upd].filter(Boolean).join(' · ');
  const draft = contactDrafts.get(S.selected);
  if (draft) {
    for (const k of DETAIL_FIELDS) $('d-'+k).value = draft[k];
    S.dirty = true; $('d-save').disabled = false; setDetailMsg('Unsaved changes');
  } else {
    S.dirty = false; $('d-save').disabled = true;
    // A late snapshot must not erase the confirmation from a completed save.
    if ($('d-msg').textContent !== 'Saved') setDetailMsg('');
  }
}

function setDetailMsg(text, kind) { const m = $('d-msg'); m.textContent = text || ''; m.className = 'd-msg' + (kind ? ' ' + kind : ''); }

$('details-form').addEventListener('input', () => { S.dirty = true; $('d-save').disabled = false; setDetailMsg('Unsaved changes'); $('d-email').removeAttribute('aria-invalid'); $('d-quoteValue').removeAttribute('aria-invalid'); });
$('details-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const phone = S.selected;
  if (!phone || !S.dirty) return;
  const fields = {};
  for (const k of DETAIL_FIELDS) if (k !== 'quoteValue') fields[k] = $('d-' + k).value;
  const qv = CRM.parseMoney($('d-quoteValue').value), had = (S.contact && S.contact.quoteValue) || null;
  if (Number.isNaN(qv) || (qv !== null && (qv < 1 || qv > 1000000))) {
    $('d-quoteValue').setAttribute('aria-invalid', 'true'); setDetailMsg('Quote value should be a number of euros, e.g. 14500 or €14,500.', 'err'); return;
  }
  if (qv !== had) fields.quoteValue = qv;          // only sent when it changed, so ordinary saves never touch it
  $('d-save').disabled = true; setDetailMsg('Saving…');
  try {
    await call('updateContact')({ phone, fields });
    contactDrafts.delete(phone);
    if (S.selected === phone) { S.dirty = false; setDetailMsg('Saved', 'ok'); setTimeout(() => { if ($('d-msg').textContent === 'Saved') setDetailMsg(''); }, 2500); }
  } catch (err) {
    if (S.selected !== phone) return;
    $('d-save').disabled = false; setDetailMsg(errText(err), 'err');
    $('d-email').setAttribute('aria-invalid', /email/i.test(errText(err)) ? 'true' : 'false');
  }
});

// ---------- data controls: permanently delete a customer ----------
const delDlg = $('del-dlg');
function toast(text) { const t = $('toast'); t.textContent = text; t.hidden = false; clearTimeout(toast.h); toast.h = setTimeout(() => { t.hidden = true; }, 8000); }
$('del-btn').onclick = () => {
  if (!S.selected) return;
  const c = selectedConv() || { id: S.selected };
  $('del-text').textContent = `This permanently deletes ${displayName(c)} (${formatPhone(S.selected)}): their details, ${S.msgs.length} message(s), and every photo, video, voice note and document they sent or received. This cannot be undone.`;
  $('del-digits').textContent = S.selected.slice(-4);
  $('del-confirm').value = ''; $('del-err').textContent = ''; $('del-go').disabled = false;
  if (typeof delDlg.showModal === 'function') delDlg.showModal(); else delDlg.setAttribute('open', '');
  $('del-confirm').focus();
};
$('del-cancel').onclick = () => delDlg.close();
$('del-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const phone = S.selected;
  if (!phone) return;
  $('del-err').textContent = ''; $('del-go').disabled = true;
  try {
    const r = await call('deleteCustomer')({ phone, confirm: $('del-confirm').value });
    delDlg.close();
    statusRequests.delete(phone); statusErrors.delete(phone);
    messageDrafts.delete(phone); contactDrafts.delete(phone); S.dirty = false; $('text').value = '';
    closeConversation(false);
    toast(`Customer deleted (${r.data.messages} message(s), ${r.data.files} file(s)).`);
  } catch (err) { $('del-err').textContent = errText(err); $('del-go').disabled = false; }
});

// Customer asset views use the existing message collection and mediaUrl contract.
let profileTab = 'details', olderMessages = [], historyDone = false, historyLoading = false;
const assetNodes = new Map();
function resetAssets() {
  profileTab = 'details'; olderMessages = []; historyDone = false; historyLoading = false;
  assetNodes.clear(); assetObserver.disconnect();
  $('gallery').replaceChildren(); $('documents').replaceChildren();
}
function assetMessages() {
  const map = new Map(olderMessages.map(m => [m.id, m]));
  S.msgs.forEach(m => map.set(m.id, m));
  return [...map.values()].sort((a,b) => (ms(a.createdAt)||0) - (ms(b.createdAt)||0));
}
function setProfileTab(tab) {
  profileTab = tab;
  $('profile-footer').hidden = tab !== 'details';
  $('profile-body').scrollTop = 0;
  ['details','media','documents'].forEach(k => {
    $('tab-'+k).setAttribute('aria-selected', String(k === tab));
    $('tab-'+k).tabIndex = k === tab ? 0 : -1;
    $('panel-'+k).hidden = k !== tab;
  });
  renderAssets();
}
['details','media','documents'].forEach((k,i,keys) => {
  $('tab-'+k).onclick = () => setProfileTab(k);
  $('tab-'+k).onkeydown = e => {
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(e.key)) return;
    e.preventDefault();
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? 2 : (i + (e.key === 'ArrowRight' ? 1 : 2)) % 3;
    setProfileTab(keys[next]); $('tab-'+keys[next]).focus();
  };
});
const assetObserver = new IntersectionObserver(entries => {
  entries.forEach(e => { if (e.isIntersecting) { assetObserver.unobserve(e.target); e.target._loadAsset(); } });
}, {root: $('details'), rootMargin: '150px'});
function assetDate(m) { return ms(m.createdAt) ? new Date(ms(m.createdAt)).toLocaleDateString('en-IE',{day:'numeric',month:'short',year:'numeric',timeZone:TZ}) : ''; }
function renderAssets() {
  if (!S.selected || !detailsOpen() || profileTab === 'details') return;
  const phone = S.selected, media = profileTab === 'media';
  const box = $(media ? 'gallery' : 'documents');
  const msgs = assetMessages().filter(m => media ? ['image','video'].includes(m.type) : m.type === 'document').reverse();
  const nodes = msgs.map(m => {
    const key = phone+'/'+m.id+'/'+sigOf(m); if (assetNodes.has(key)) return assetNodes.get(key);
    let item;
    if (media && m.media && m.media.status === 'stored' && m.media.storagePath) {
      item = el('button','gallery-item'); item.type = 'button'; item.setAttribute('aria-label', 'Open '+m.type+' from '+assetDate(m));
      const thumb = el(m.type === 'video' ? 'video' : 'img');
      if (m.type === 'video') { thumb.muted = true; thumb.preload = 'metadata'; thumb.playsInline = true; } else thumb.alt = m.body && !/^\[/.test(m.body) ? m.body : 'Customer photo';
      item.append(thumb,el('span',null,(m.type === 'video' ? 'Video · ' : '')+(ms(m.createdAt) ? new Date(ms(m.createdAt)).toLocaleDateString('en-IE',{day:'numeric',month:'short',timeZone:TZ}) : '')));
      item._loadAsset = () => loadUrl(phone,m.id,false).then(u => thumb.src = u).catch(() => { item.textContent = "Couldn't load · click to retry"; });
      item.onclick = () => openLightbox(phone,m);
      assetObserver.observe(item);
    } else {
      item = el('div','asset-document'+(media ? ' asset-unavailable' : '')); item.append(mediaBlock(m,m.type),el('div','asset-date',(m.direction === 'out' ? 'Sent · ' : 'Received · ')+assetDate(m)));
    }
    assetNodes.set(key,item); return item;
  });
  const grouped = []; let previousMonth = '';
  nodes.forEach((node,i) => {
    const month = ms(msgs[i].createdAt) ? new Date(ms(msgs[i].createdAt)).toLocaleDateString('en-IE',{month:'long',year:'numeric',timeZone:TZ}) : 'Date unavailable';
    if (media && month !== previousMonth) { grouped.push(el('h3','asset-month',month)); previousMonth = month; }
    grouped.push(node);
  });
  box.replaceChildren(...(grouped.length ? grouped : [el('p','asset-empty',media ? 'No photos or videos in the loaded messages.' : 'No documents in the loaded messages.')]));
  ['older-media','older-documents'].forEach(id => { $(id).hidden = historyDone || S.msgs.length < 500; $(id).disabled = historyLoading; $(id).textContent = historyLoading ? 'Loading…' : 'Load earlier messages'; });
}
async function loadEarlierAssets() {
  if (historyLoading || !S.selected) return;
  const phone = S.selected, all = assetMessages(), first = all[0]; if (!first || !first.createdAt) return;
  historyLoading = true; renderAssets();
  try {
    const snap = await db.collection('conversations').doc(phone).collection('messages').orderBy('createdAt').endBefore(first.createdAt).limitToLast(500).get();
    if (S.selected !== phone) return;
    olderMessages.push(...snap.docs.map(d => ({id:d.id,...d.data()}))); historyDone = snap.size < 500;
  } catch(e) { toast('Could not load earlier messages: '+errText(e)); }
  finally { historyLoading = false; renderAssets(); }
}
$('older-media').onclick = loadEarlierAssets; $('older-documents').onclick = loadEarlierAssets;
let viewer = null, viewerFocus = null, viewerSeq = 0;
async function openLightbox(phone,m) {
  if ($('lightbox').hidden) viewerFocus = document.activeElement;
  const seq = ++viewerSeq;
  $('details').inert = true; $('app').inert = true;
  const items = assetMessages().filter(x => ['image','video'].includes(x.type) && x.media && x.media.status === 'stored');
  viewer = {phone,m,items};
  $('lightbox').hidden = false; $('lightbox').focus();
  $('lb-img').hidden = true; $('lb-video').hidden = true; $('lb-video').pause();
  $('lb-caption').textContent = 'Loading…';
  const index = items.findIndex(x => x.id === m.id);
  $('lb-prev').disabled = index <= 0; $('lb-next').disabled = index < 0 || index >= items.length-1;
  $('lb-dl').onclick = () => downloadMedia(phone,m);
  try {
    const u = await loadUrl(phone,m.id,false); if (seq !== viewerSeq) return;
    const target = $(m.type === 'video' ? 'lb-video' : 'lb-img'); target.src = u; target.hidden = false;
    $('lb-caption').textContent = [assetDate(m),m.direction === 'out' ? 'Sent' : 'Received', (index+1)+' of '+items.length].join(' · ');
  } catch(e) { if (seq === viewerSeq) $('lb-caption').textContent = 'Could not open media: '+errText(e); }
}
function closeLightbox() {
  viewerSeq++; viewer = null; $('lightbox').hidden = true;
  $('details').inert = false; $('app').inert = false;
  $('lb-video').pause(); $('lb-video').removeAttribute('src'); $('lb-img').removeAttribute('src');
  if (viewerFocus && viewerFocus.isConnected) viewerFocus.focus();
}
function moveViewer(delta) { if (!viewer) return; const i = viewer.items.findIndex(m => m.id === viewer.m.id), m = viewer.items[i+delta]; if(m) openLightbox(viewer.phone,m); }
$('lb-prev').onclick = () => moveViewer(-1); $('lb-next').onclick = () => moveViewer(1);
document.addEventListener('keydown',e => {
  if (!$('lightbox').hidden) {
    if (e.key === 'Escape') { closeLightbox(); return; }
    if(e.key === 'ArrowLeft') moveViewer(-1); if(e.key === 'ArrowRight') moveViewer(1);
    if(e.key === 'Tab') { const controls = [...$('lightbox').querySelectorAll('button:not(:disabled),video:not([hidden])')]; const i = controls.indexOf(document.activeElement); e.preventDefault(); controls[(i+(e.shiftKey ? controls.length-1 : 1))%controls.length].focus(); }
  } else if(e.key === 'Escape' && detailsOpen()) setDetailsOpen(false,true);
});


function syncProfileOverlay() {
  const overlay = detailsOpen() && window.innerWidth < 1280;
  for (const pane of document.querySelectorAll('.rail, .list-pane, .thread-pane')) pane.inert = overlay;
  if (overlay) { detailsEl().setAttribute('role','dialog'); detailsEl().setAttribute('aria-modal','true'); }
  else { detailsEl().removeAttribute('role'); detailsEl().removeAttribute('aria-modal'); }
}
window.addEventListener('resize', syncProfileOverlay);
$('details').addEventListener('keydown', e => {
  if (e.key !== 'Tab' || window.innerWidth >= 1280 || !detailsOpen()) return;
  const focusable = [...detailsEl().querySelectorAll('button:not(:disabled),input,select,textarea,[tabindex="0"],a[href]')].filter(n => n.getClientRects().length && !n.closest('[hidden]'));
  const first = focusable[0], last = focusable[focusable.length-1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});
