'use strict';
// "This lead never wrote to us": the one rule behind the Inbox's No reply tab (public/noreply-model.js, kept in step by a test), the follow-up emails (lib/followUp.js) and the assistant's counting
// (lib/aiTools.js find_leads). Pure: it only reads a conversation record.
const STAGES = ['inbox', 'booked', 'quoted', 'won', 'closed'];
const stageOf = (c) => (c && STAGES.includes(c.inboxStatus) ? c.inboxStatus : 'inbox');
function neverWrote(c) {
  if (!c || stageOf(c) !== 'inbox') return false;
  if (c.lastInboundAt || c.emailInboundAt || c.lastMessageDirection === 'in') return false;          // a reply by email counts as writing to us
  if (typeof c.unreadCount === 'number' && c.unreadCount > 0) return false;
  if (c.doNotContact && c.doNotContact.on === true) return false;
  return true;
}
module.exports = { neverWrote, stageOf, STAGES };
