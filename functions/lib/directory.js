'use strict';
// The Inbox "All" tab and the search across EVERY conversation (docs/INBOX_ALL_AND_SEARCH.md). The Inbox keeps a live list of the 300 newest chats; this gives the browser one compact list of every customer,
// fetched once when it is first needed, so the search runs in the browser and is instant. It READS only and returns only what the search needs, never message text, notes, addresses or budgets.
//   a row: [id (the phone number), name, town, project type, email, stage, last activity (ms)]     (about 100 bytes each: 20,000 customers is about 2 MB)
// Efficient: two reads per customer (the conversation and the contact, with only the fields listed), and the answer is kept for 2 minutes per server instance, so staff searching again do not read the database again.
// Staff only. If there are more than MAX customers the list is cut at the most recent MAX and says so ("truncated"), so the screen can tell you.
const { HttpsError } = require('firebase-functions/v2/https');

const MAX = 20000, CACHE_MS = 120000;
const STAGES = ['inbox', 'booked', 'quoted', 'won', 'closed'];
let cache = null;                                                                     // { at, max, out }
const ms = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : 0);
const text = (v, n) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');

async function build({ db }, data, { nowMs = Date.now(), max = MAX } = {}) {
  if (data != null && (typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length)) throw new HttpsError('invalid-argument', 'Nothing needs to be sent.');
  if (cache && cache.max === max && nowMs - cache.at < CACHE_MS) return { ...cache.out, cached: true };
  const [convs, contacts] = await Promise.all([
    db.collection('conversations').select('name', 'location', 'projectType', 'inboxStatus', 'updatedAt').limit(max + 1).get(),
    db.collection('contacts').select('name', 'email', 'location').limit(max + 1).get(),
  ]);
  const by = new Map(contacts.docs.map((d) => [d.id, d.data()]));
  let rows = convs.docs.map((d) => {
    const c = d.data(), k = by.get(d.id) || {};
    return [d.id, text(c.name || k.name, 100), text(c.location || k.location, 100), text(c.projectType, 60), text(k.email, 120).toLowerCase(), STAGES.includes(c.inboxStatus) ? c.inboxStatus : 'inbox', ms(c.updatedAt)];
  });
  const truncated = rows.length > max || contacts.size > max;
  rows.sort((a, b) => b[6] - a[6]);
  if (rows.length > max) rows = rows.slice(0, max);
  const out = { rows, truncated, total: rows.length, at: nowMs };
  cache = { at: nowMs, max, out };
  return { ...out, cached: false };
}
const resetCache = () => { cache = null; };

module.exports = { build, resetCache, MAX, CACHE_MS };
