'use strict';
// Installable app (Phase 6.2): registers the tiny service worker (sw.js) and shows "Install Elite OS" ONLY where the browser says the app can be installed
// (Chrome and Edge on Windows, Chrome on Android) and it is not installed yet. Nothing here touches the rest of the app: if this file fails, Elite OS works as before.
(function () {
  if ('serviceWorker' in navigator) window.addEventListener('load', function () { navigator.serviceWorker.register('/sw.js').catch(function () { /* the app works without it */ }); });
  function installed() { try { return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true; } catch (e) { return false; } }
  var offered = null;                                                                  // the browser's install offer; it can be used once
  function show(on) { var list = document.querySelectorAll('[data-install-app]'); for (var i = 0; i < list.length; i++) list[i].hidden = !on; }
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); if (installed()) return; offered = e; show(true); });
  window.addEventListener('appinstalled', function () { offered = null; show(false); });
  document.addEventListener('click', function (e) {
    var button = e.target && e.target.closest ? e.target.closest('[data-install-app]') : null;
    if (!button || !offered) return;
    var offer = offered; offered = null; show(false);
    try { offer.prompt(); Promise.resolve(offer.userChoice).catch(function () { /* the browser's own menu still installs */ }); } catch (err) { /* same */ }
  });
})();
