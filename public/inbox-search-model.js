'use strict';
// Elite Kitchens Lead OS: the rules behind the Inbox "All" tab and the search across EVERY customer (docs/INBOX_ALL_AND_SEARCH.md). Pure functions only (no DOM, no Firebase), so they are unit-tested in Node.
// The Inbox keeps its live list of the 300 newest chats. The directory (functions/lib/directory.js) is one compact row per customer: [id, name, town, project type, email, stage, last activity ms].
// Search runs here, in the browser, over both: the live chat wins where a customer is in both (it is newer), the directory adds everyone else. 20,000 customers search in a few milliseconds.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.InboxSearch = factory();
})(this, function () {
  const STAGES = ['inbox', 'booked', 'quoted', 'won', 'closed'];
  const ms = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : typeof t === 'number' ? t : 0);
  // lower case, no accents, single spaces: "Seán  Ó Briain" -> "sean o briain"
  const norm = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  const digits = (s) => String(s == null ? '' : s).replace(/\D/g, '');

  // A directory row as an object the Inbox list can draw (like a conversation, with only what the directory knows).
  function fromRow(r) {
    const [id, name, location, projectType, email, stage, updated] = r;
    return { id: String(id), name: name || '', location: location || '', projectType: projectType || '', email: email || '', inboxStatus: STAGES.includes(stage) ? stage : 'inbox',
      updatedAt: { toMillis: () => updated || 0 }, fromDirectory: true, _s: norm([name, location, projectType, email].join(' ')) };
  }
  // The server sends them newest first; sorted again here (once) so a list that is not in order can never break the merge.
  const fromRows = (rows) => (Array.isArray(rows) ? rows : []).filter((r) => Array.isArray(r) && r[0] != null).map(fromRow).sort((a, b) => ms(b.updatedAt) - ms(a.updatedAt));
  const index = (items) => new Map(items.map((c) => [c.id, c]));

  // Does the phone number (digits only) match what was typed? "085 123", "+353 85 123", "85123" all find 353851234567; a leading 0 stands for 353.
  function phoneMatch(id, d) {
    if (d.length < 3) return false;
    if (id.includes(d)) return true;
    if (d.startsWith('0') && id.includes(d.slice(1))) return true;
    return d.startsWith('00') && id.includes(d.slice(2));
  }
  // A matcher for what was typed, or null for "everything". Every word must match: a word of digits matches the phone number, any other word matches the name, town, project type or email.
  // Typing a whole phone number with spaces, a plus or brackets works too.
  function matcher(query) {
    const q = norm(query);
    if (!q) return null;
    const onlyPhone = /^[+\d\s()-]+$/.test(q);
    const tokens = q.split(' ').filter(Boolean);
    return (item, id, hay) => {
      const phoneId = id || item.id, text = hay != null ? hay : item._s;
      if (onlyPhone) { const d = digits(q); if (d.length >= 3 && phoneMatch(phoneId, d)) return true; }
      return tokens.every((t) => (/^\+?\d[\d-]*$/.test(t) && digits(t).length >= 3 && phoneMatch(phoneId, digits(t))) || text.includes(t));
    };
  }
  const hayOf = (c, dirItem) => norm([c.name, c.location, c.projectType, dirItem && dirItem.email].join(' '));
  const recency = (a, b) => ms(b.updatedAt) - ms(a.updatedAt);

  // Two lists, newest first, merged into one newest first (no sorting of 20,000 rows each time); a customer in both appears once, as the live chat.
  function union(live, dirItems, dirMap) {
    const liveIds = new Set(live.map((c) => c.id)), out = [], rest = dirItems.filter((c) => !liveIds.has(c.id));
    let i = 0, j = 0;
    const L = [...live].sort(recency);
    while (i < L.length || j < rest.length) out.push(j >= rest.length || (i < L.length && ms(L[i].updatedAt) >= ms(rest[j].updatedAt)) ? L[i++] : rest[j++]);
    return out;
  }
  // The search: the live chats (matched on their own fields plus the email the directory knows) and the directory rows, newest first.
  function search(live, dirItems, dirMap, query) {
    const m = matcher(query);
    if (!m) return union(live, dirItems, dirMap);
    const hits = [], liveIds = new Set();
    for (const c of live) { liveIds.add(c.id); if (m(c, c.id, hayOf(c, dirMap && dirMap.get(c.id)))) hits.push(c); }
    const dirHits = [];
    for (const c of dirItems) if (!liveIds.has(c.id) && m(c)) dirHits.push(c);
    return union(hits, dirHits, null);
  }
  return { norm, digits, fromRow, fromRows, index, matcher, phoneMatch, union, search, hayOf, recency, STAGES };
});
