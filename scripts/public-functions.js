#!/usr/bin/env node
'use strict';
// Prints, one per line, the Cloud Run service names (lower case) of the functions that browsers and other services may call: every
// onCall (they sign callers in themselves) and onRequest (the webhook and lead intake authenticate every request themselves).
// Scheduled functions (onSchedule, such as the calendar sweeper) are NEVER listed: only Cloud Scheduler may call those.
// The list comes from functions/index.js, so it cannot drift (audit finding 8: the old preview script opened every service).
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'functions', 'index.js'), 'utf8');
const names = [...src.matchAll(/^exports\.(\w+)\s*=\s*on(?:Call|Request)\b/gm)].map((m) => m[1].toLowerCase());
process.stdout.write([...new Set(names)].join('\n') + '\n');
