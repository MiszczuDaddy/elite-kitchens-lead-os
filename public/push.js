'use strict';
// Elite Kitchens Lead OS: push notifications (Phase 8, docs/PUSH.md). The "Notifications" dialog: switch notifications on or off for THIS device, send a test, and read the
// "Notification speed" table; plus opening the right chat when a notification is clicked. The words of a notification are written by the service worker (sw.js), never by the server.
// Loaded after app.js (shares its helpers). If anything here fails, Elite OS works as before.
window.PUSH = (() => {
  const M = window.PushModel;
  const KEY = 'ek-push-device';                                           // this browser's registration: { id, token, at }
  const DAY = 24 * 3600 * 1000;
  const P = { on: false, busy: false, unsubEvents: null, events: [], started: false };
  const supported = () => { try { return 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window && !!window.firebase && !!firebase.messaging && firebase.messaging.isSupported(); } catch (e) { return false; } };
  const platform = () => { const ua = navigator.userAgent || ''; return /Android/i.test(ua) ? 'android' : /Windows/i.test(ua) ? 'windows' : 'other'; };
  const stored = () => { try { const v = JSON.parse(localStorage.getItem(KEY) || 'null'); return v && v.id && v.token ? v : null; } catch (e) { return null; } };
  const keep = (v) => { try { if (v) localStorage.setItem(KEY, JSON.stringify(v)); else localStorage.removeItem(KEY); } catch (e) { /* private window: the choice just is not remembered */ } };
  const showDialog = (d) => { if (typeof d.showModal === 'function') { if (!d.open) d.showModal(); } else d.setAttribute('open', ''); };
  const closeDialog = (d) => { if (typeof d.close === 'function') { if (d.open) d.close(); } else d.removeAttribute('open'); };
  const friendly = (e) => {
    const t = String((e && (e.code || e.message)) || e);
    if (/appId|app-id|installations/i.test(t)) return 'Notifications are not set up on the server yet (the Firebase web app is missing). Tell the person who looks after Elite OS.';
    if (/permission-blocked|denied/i.test(t)) return 'Notifications are blocked for this site. Allow them in the browser settings (the padlock next to the address), then try again.';
    if (/unsupported|not supported/i.test(t)) return 'This browser cannot show notifications.';
    return 'Could not switch notifications on: ' + errText(e);
  };

  // Hosting's automatic Firebase config gained the web app's id only after the web app was registered (2026-10-12) and the next Hosting release; push needs it. It is public (it is in every
  // web page of the project), so it is used only as a fallback if the automatic config still lacks it.
  const WEB_APP_ID = '1:812360112616:web:2d739fad9219ebb92eec5d';
  async function token() {
    const options = firebase.app().options; if (options && !options.appId) options.appId = WEB_APP_ID;
    const reg = await navigator.serviceWorker.ready;                                // our own tiny service worker (sw.js) receives the pushes
    return firebase.messaging().getToken({ serviceWorkerRegistration: reg });
  }
  async function register(t) {
    const r = (await call('registerPushDevice')({ token: t, platform: platform() })).data;
    keep({ id: r.deviceId, token: t, at: Date.now() }); return r.deviceId;
  }
  async function enable() {
    if (P.busy) return; P.busy = true; setError(''); render();
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') throw new Error(perm === 'denied' ? 'permission-blocked' : 'The permission was not given.');
      await register(await token());
    } catch (e) { setError(friendly(e)); }
    P.busy = false; render();
  }
  async function disable() {
    if (P.busy) return; P.busy = true; setError(''); render();
    const s = stored();
    try { if (s) await call('unregisterPushDevice')({ deviceId: s.id }); } catch (e) { /* the server forgets a dead address by itself */ }
    try { await firebase.messaging().deleteToken(); } catch (e) { /* nothing to delete */ }
    keep(null); P.busy = false; render();
  }
  async function test() {
    const s = stored(); if (!s || P.busy) return; P.busy = true; setError(''); render();
    try { const r = await call('sendTestPush')({ deviceId: s.id }); $('notif-info').textContent = r.data.sent ? 'Test sent. Close this window or switch to another app to see it arrive; the table below fills in.' : 'The test could not be sent. Try again in a moment.'; }
    catch (e) { setError(errText(e)); }
    P.busy = false; render();
  }

  function setError(t) { $('notif-err').textContent = t || ''; if (t) $('notif-info').textContent = ''; }
  function render() {
    const perm = window.Notification ? Notification.permission : 'denied', s = stored(), on = perm === 'granted' && !!s;
    P.on = on;
    $('notif-state').textContent = on ? 'Notifications are ON for this device.' : perm === 'denied' ? 'Notifications are blocked for this site in the browser settings.' : 'Notifications are off for this device.';
    $('notif-state').dataset.on = String(on);
    const t = $('notif-toggle'); t.textContent = P.busy ? 'Please wait…' : on ? 'Turn off on this device' : 'Enable notifications'; t.disabled = P.busy || (!on && perm === 'denied');
    $('notif-test').disabled = !on || P.busy;
    for (const id of ['notif-open', 'notif-open-m']) { const b = $(id); if (b) { b.hidden = !supported(); b.classList.toggle('is-on', on); } }
  }

  // ---------- the speed table ----------
  function listenEvents() {
    if (P.unsubEvents) return;
    P.unsubEvents = db.collection('pushEvents').orderBy('createdAt', 'desc').limit(20).onSnapshot((snap) => { P.events = snap.docs.map((d) => ({ id: d.id, ...d.data() })); renderSpeed(); },
      (e) => { $('notif-summary').textContent = 'Cannot load the measurements: ' + errText(e); });
  }
  function unlistenEvents() { if (P.unsubEvents) { P.unsubEvents(); P.unsubEvents = null; } P.events = []; }
  const KIND = { message: 'WhatsApp', lead: 'Lead', test: 'Test' }, PLAT = { windows: 'Windows', android: 'Android', other: 'Other' };
  const clock = (ms) => (ms ? new Intl.DateTimeFormat('en-IE', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', day: 'numeric', month: 'short' }).format(new Date(ms)) : '');
  function renderSpeed() {
    const rows = M.rowsOfAll(P.events), sums = M.summarize(rows), box = $('notif-summary');
    box.replaceChildren(...Object.entries(sums).map(([plat, s]) => {
      const t = s.stats.total, a = s.stats.acceptedToDevice, p = el('p', 'notif-sum');
      p.textContent = `${PLAT[plat] || plat}: ${s.sent} sent, ${s.received} reported back. Time until the device had it (median / slowest 5%): ${M.fmt(t.median)} / ${M.fmt(t.p95)}. Firebase accepted → device: ${M.fmt(a.median)} / ${M.fmt(a.p95)}.`;
      return p;
    }));
    if (!rows.length) box.textContent = 'No notifications yet. Press "Send a test notification", or wait for a WhatsApp message or a lead.';
    const body = $('notif-rows'); body.replaceChildren();
    for (const r of rows) {
      const tr = el('tr'); if (r.clockSuspect) tr.title = `The device's clock differs from ours by ${M.fmt(Math.abs(r.deviceClockGap))}: do not trust any figure that uses the device's own clock.`;
      const cells = [clock(r.createdMs), KIND[r.kind] || r.kind, PLAT[r.platform] || r.platform, M.fmt(r.metaToBackend), M.fmt(r.backendToSend), r.ok ? M.fmt(r.sendToAccepted) : 'failed',
        r.received ? M.fmt(r.acceptedToDevice) : r.ok ? 'no report' : '–', r.received ? M.fmt(r.total) : '–', r.clicked ? 'yes' : ''];
      for (const c of cells) tr.append(el('td', '', c));
      body.append(tr);
    }
  }

  // ---------- opening the right chat ----------
  // A notification carries only an opaque id. The page looks it up (staff can read it) to find the chat.
  async function openFrom(n) {
    if (!n || !/^[mlt]_[0-9a-f]{24}$/.test(n)) return;
    try {
      const s = await db.doc('pushEvents/' + n).get();
      const phone = s.exists ? s.data().phone : null;
      if (phone) location.hash = '#c/' + phone;
    } catch (e) { /* not a staff member or offline: nothing to open */ }
  }
  function fromUrl() {
    try {
      const u = new URL(location.href), n = u.searchParams.get('n');
      if (!n) return;
      u.searchParams.delete('n'); history.replaceState(null, '', u.pathname + (u.search || '') + (u.hash || ''));
      openFrom(n);
    } catch (e) { /* not a valid address */ }
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', (e) => { if (e.data && e.data.type === 'ek-open') openFrom(e.data.n); });

  // ---------- life cycle ----------
  async function start() {
    P.started = true; render(); fromUrl();
    // A device that switched notifications on keeps its address fresh: it is checked every time Elite OS opens and re-sent to the server at most once a day.
    const s = stored();
    if (s && window.Notification && Notification.permission === 'granted' && supported()) {
      try { const t = await token(); if (t !== s.token || Date.now() - (s.at || 0) > DAY) await register(t); } catch (e) { /* try again next time */ }
      render();
    }
  }
  function stop() { P.started = false; unlistenEvents(); closeDialog($('notif-dlg')); }

  for (const id of ['notif-open', 'notif-open-m']) $(id).onclick = () => { setError(''); $('notif-info').textContent = ''; render(); showDialog($('notif-dlg')); listenEvents(); };
  $('notif-close').onclick = () => { closeDialog($('notif-dlg')); unlistenEvents(); };
  $('notif-dlg').addEventListener('close', unlistenEvents);
  $('notif-toggle').onclick = () => (P.on ? disable() : enable());
  $('notif-test').onclick = test;
  render();

  return Object.assign(P, { start, stop, supported, openFrom, render });
})();
