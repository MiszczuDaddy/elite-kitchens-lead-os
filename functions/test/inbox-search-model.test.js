// The Inbox "All" tab and the search across EVERY customer (public/inbox-search-model.js). Pure functions: no emulator, no browser. Every name and number is made up.
// What matters: it finds a customer by name, phone number (any way of typing it), email and town, however old or closed; every word typed must match; accents and capitals do not matter;
// the live chat wins over the directory row for the same customer; newest first; and 20,000 customers are searched in milliseconds.
const { test } = require('node:test');
const assert = require('node:assert');
const S = require('../../public/inbox-search-model.js');

const T = (t) => ({ toMillis: () => t });
const row = (id, name, town, project, email, stage, at) => [id, name, town, project, email, stage, at];
const DIR = S.fromRows([
  row('353851234567', 'Anna Murphy', 'Swords', 'Kitchen', 'anna.murphy@example.com', 'closed', 1000),
  row('353861112222', 'Seán Ó Briain', 'Malahide', 'Utility room', 'sean@briain.ie', 'won', 5000),
  row('353870000003', 'Brian Kelly', 'Swords', 'Kitchen', '', 'quoted', 3000),
  row('447911123456', 'Cara Doyle', 'Belfast', '', 'cara@doyle.co.uk', 'inbox', 2000),
  row('353879998888', '', 'Lucan', '', 'noname@example.com', 'inbox', 4000),
]);
const map = S.index(DIR);
const ids = (list) => list.map((c) => c.id);
const find = (q, live = []) => ids(S.search(live, DIR, map, q));

test('FIND BY NAME, TOWN, EMAIL AND PROJECT: any word, any case, accents ignored, closed and old customers included', () => {
  assert.deepEqual(find('anna'), ['353851234567']);
  assert.deepEqual(find('ANNA MURPHY'), ['353851234567']);
  assert.deepEqual(find('sean'), ['353861112222'], 'Seán is found by typing Sean');
  assert.deepEqual(find('Ó Briain'), ['353861112222']);
  assert.deepEqual(find('swords'), ['353870000003', '353851234567'], 'the town; newest first');
  assert.deepEqual(find('briain.ie'), ['353861112222'], 'part of an email');
  assert.deepEqual(find('cara@doyle'), ['447911123456']);
  assert.deepEqual(find('noname'), ['353879998888'], 'a customer with no name is found by email');
  assert.deepEqual(find('utility'), ['353861112222'], 'the project type');
  assert.deepEqual(find('murphy kitchen'), ['353851234567'], 'every word must match, in any order');
  assert.deepEqual(find('murphy utility'), [], 'a word that matches nobody together with another finds nothing');
  assert.deepEqual(find('zzz'), []);
  assert.equal(find('anna')[0], '353851234567'); assert.equal(DIR.find((c) => c.id === '353851234567').inboxStatus, 'closed');
});

test('FIND BY PHONE NUMBER however it is typed: with the 0, with +353, with spaces, brackets or dashes, or just the last digits', () => {
  for (const q of ['085 123 4567', '0851234567', '+353 85 123 4567', '353851234567', '(085) 123-4567', '85 123 4567', '1234567', '851234']) assert.deepEqual(find(q), ['353851234567'], q);
  assert.deepEqual(find('0044 7911 123456'), ['447911123456'], '00 stands for +');
  assert.deepEqual(find('07911 123456'), ['447911123456'], 'a UK number with the leading 0');
  assert.deepEqual(find('12'), [], 'two digits are too few to mean a phone number');
  assert.deepEqual(find('anna 085'), ['353851234567'], 'a name and the start of the number together');
  assert.deepEqual(find('brian 085'), [], 'the wrong combination finds nobody');
});

test('THE LIVE CHAT WINS over the directory row for the same customer; a live chat is also found by the email the directory knows; newest first overall', () => {
  const live = [{ id: '353851234567', name: 'Anna Murphy', inboxStatus: 'quoted', updatedAt: T(9000), location: 'Swords' }, { id: '353850000009', name: 'Dan Walsh', inboxStatus: 'inbox', updatedAt: T(8000) }];
  const r = S.search(live, DIR, map, 'anna');
  assert.deepEqual(ids(r), ['353851234567']); assert.equal(r[0].fromDirectory, undefined, 'the live chat, not the directory row'); assert.equal(r[0].inboxStatus, 'quoted');
  assert.deepEqual(ids(S.search(live, DIR, map, 'anna.murphy@example')), ['353851234567'], 'found by email although the live chat has none');
  assert.deepEqual(ids(S.search(live, DIR, map, 'swords')), ['353851234567', '353870000003'], 'live first because it is newer');
  assert.deepEqual(ids(S.union(live, DIR, map)), ['353851234567', '353850000009', '353861112222', '353879998888', '353870000003', '447911123456'], 'the All tab: everyone once, newest first');
  assert.equal(S.union(live, DIR, map).filter((c) => c.id === '353851234567').length, 1);
});

test('THE ALL TAB lists every customer of every stage; with no live chats the directory alone is shown newest first; empty input finds everyone', () => {
  assert.deepEqual(ids(S.union([], DIR, map)), ['353861112222', '353879998888', '353870000003', '447911123456', '353851234567']);
  assert.deepEqual(ids(S.search([], DIR, map, '')), ids(S.union([], DIR, map)));
  assert.deepEqual(ids(S.search([], DIR, map, '   ')), ids(S.union([], DIR, map)));
  assert.deepEqual([...new Set(S.union([], DIR, map).map((c) => c.inboxStatus))].sort(), ['closed', 'inbox', 'quoted', 'won']);
  assert.deepEqual(ids(S.union([], [], null)), []);
});

test('BAD ROWS never break it: a row without an id is dropped, an unknown stage counts as a new lead, missing parts are blank', () => {
  const items = S.fromRows([null, [], [null, 'x'], ['353850000001'], ['353850000002', 'Eve', undefined, undefined, undefined, 'nonsense', 5], 'text']);
  assert.deepEqual(ids(items), ['353850000002', '353850000001'], 'newest first');
  assert.deepEqual([items[1].name, items[1].inboxStatus, items[0].inboxStatus], ['', 'inbox', 'inbox']);
  assert.deepEqual(S.fromRows(undefined), []);
});

test('20,000 CUSTOMERS are searched in a few milliseconds, and merged with the live list without re-sorting everything', () => {
  const towns = ['Swords', 'Malahide', 'Lucan', 'Naas', 'Cork', 'Galway'], rows = [];
  for (let i = 0; i < 20000; i++) rows.push([String(353850000000 + i), 'Customer ' + i + ' Smith', towns[i % 6], i % 2 ? 'Kitchen' : 'Wardrobe', i % 3 ? 'c' + i + '@example.com' : '', S.STAGES[i % 5], 1e9 - i]);
  const items = S.fromRows(rows), m = S.index(items), live = items.slice(0, 300).map((c) => ({ ...c, fromDirectory: undefined }));
  const timed = (f) => { const t = process.hrtime.bigint(); const r = f(); return [r, Number(process.hrtime.bigint() - t) / 1e6]; };
  const [a, ta] = timed(() => S.search(live, items, m, 'customer 19999')); assert.deepEqual(ids(a), ['353850019999']);
  const [b, tb] = timed(() => S.search(live, items, m, 'naas kitchen smith')); assert.ok(b.length > 1000);
  const [c, tc] = timed(() => S.search(live, items, m, '0850012345')); assert.deepEqual(ids(c), ['353850012345']);
  const [d, td] = timed(() => S.union(live, items, m)); assert.equal(d.length, 20000);
  for (const [name, t] of [['name', ta], ['three words', tb], ['phone', tc], ['all', td]]) assert.ok(t < 250, `${name}: ${t.toFixed(1)} ms`);
  for (let i = 1; i < d.length; i++) assert.ok(S.recency(d[i - 1], d[i]) <= 0, 'newest first');
});
