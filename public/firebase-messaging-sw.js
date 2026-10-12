'use strict';
// Safety net (Phase 8). Firebase's function-calling code looks for a service worker at this exact address whenever notifications are allowed and messaging has not been set up yet in the page.
// It must exist, or that look-up fails (404) and a call fails with it. The real work is done by /sw.js: this file only loads it, so a push that arrives through this registration is handled the same way.
importScripts('/sw.js');
