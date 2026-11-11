'use strict';
// The Inbox "No reply" tab (docs/INBOX_NO_REPLY.md): the leads who never wrote back. Pure functions, no DOM and no Firebase, so they run in Node tests.
// A lead "never replied" when they are still a New lead, no message of theirs has ever been recorded, and nobody has asked for them to be left alone.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.NoReply = factory();
})(this, function () {
  const DAY = 86400000, STAGES = ['inbox', 'booked', 'quoted', 'won', 'closed'];
  const ms = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : typeof t === 'number' && isFinite(t) ? t : 0);
  const stageOf = (c) => (c && STAGES.includes(c.inboxStatus) ? c.inboxStatus : 'inbox');
  const born = (c) => ms(c && c.createdAt) || ms(c && c.updatedAt);

  // Only a New lead counts: once a lead is Booked, Quoted, Won or Closed, they have been in touch (or you have decided about them). A customer who asked not to be contacted did write.
  function neverWrote(c) {
    if (!c || stageOf(c) !== 'inbox') return false;
    if (c.lastInboundAt || c.emailInboundAt || c.lastMessageDirection === 'in') return false;          // a reply by email counts as writing to us
    if (typeof c.unreadCount === 'number' && c.unreadCount > 0) return false;
    if (c.doNotContact && c.doNotContact.on === true) return false;
    return true;
  }

  // `live` = the Inbox's live list, `extra` = older chats read on request; where both have a chat the live one wins. `checked` = Map of id -> true when a message of theirs was found in the chat itself.
  // Oldest lead first (the one waiting longest); a lead with no date goes last.
  function rows(live, extra, checked) {
    const byId = new Map();
    for (const c of extra || []) if (c && c.id) byId.set(c.id, c);
    for (const c of live || []) if (c && c.id) byId.set(c.id, c);
    return [...byId.values()].filter((c) => neverWrote(c) && !(checked && checked.get(c.id) === true))
      .sort((a, b) => ((born(a) || Infinity) - (born(b) || Infinity)) || String(a.id).localeCompare(String(b.id)));
  }

  const ageDays = (c, now) => { const b = born(c); return b ? Math.max(0, Math.floor((now - b) / DAY)) : null; };
  const ageText = (d) => (d == null ? '' : d === 0 ? 'today' : d === 1 ? '1 day' : d + ' days');
  const callHref = (id) => (/^\d{9,15}$/.test(String(id)) ? 'tel:+' + id : null);

  return { neverWrote, rows, ageDays, ageText, callHref };
});
