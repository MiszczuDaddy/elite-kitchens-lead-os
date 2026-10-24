// The welcome message a new Meta lead gets (owner's request, 24 Oct 2026): two approved WhatsApp templates, and the owner picks which one goes out with one switch in
// Assistant > Settings (aiSettings/current.welcome; owner only). Nothing else changes: the lead intake still sends at most one welcome, and the receptionist treats either
// template as "our welcome" (not as a person taking the chat over).
//   standard  the original welcome (the WHATSAPP_TEMPLATE_NAME setting, elite_kitchens_new_lead). Always the fallback.
//   personal  the owner's new wording (template welcoming_message_v_2_, created 24 Oct 2026, same language setting). If WhatsApp REFUSES it (a definite 4xx: not approved yet,
//             paused, deleted, wrong language), the standard welcome is sent instead in the same run, so a lead never goes without a welcome. A refusal means it was
//             definitely not sent, so this can never make a double. An answer we cannot confirm (5xx, timeout) is never followed by a second message.
// Elite OS keeps its own copy of the words in the chat (what staff see and what the receptionist reads), so each copy below must match the template approved at Meta.
const PERSONAL_TEMPLATE = 'welcoming_message_v_2_';
const KEYS = ['standard', 'personal'];
const TEXT = {
  standard: (first) => `Hi ${first}, thanks for your enquiry with Elite Kitchens...`,
  personal: (first) => `Hi ${first}, it's Tomasz from Elite Kitchens. Just saw your enquiry about a new kitchen. Have you got any plans or measurements you could send over?`,
};
// For the screen: the words of each choice, with "{{1}}" where the first name goes.
const PREVIEW = { standard: TEXT.standard('{{1}}'), personal: TEXT.personal('{{1}}') };

const keyOf = (v) => (v === 'personal' ? 'personal' : 'standard');
const nameOf = (key, standardName) => (key === 'personal' ? PERSONAL_TEMPLATE : standardName);
// The chat copy of a welcome: "[template: <name>] <words>" (the prefix is how the receptionist and the screen recognise a template).
const bodyOf = (key, standardName, first) => `[template: ${nameOf(key, standardName)}] ${TEXT[key](first)}`;
// Is this stored message one of our welcome templates (either wording)?
const isWelcomeBody = (body, standardName) => typeof body === 'string' && [standardName, PERSONAL_TEMPLATE].some((n) => !!n && body.startsWith('[template: ' + n + ']'));
const isPersonalBody = (body) => typeof body === 'string' && body.startsWith('[template: ' + PERSONAL_TEMPLATE + ']');

// Which welcome the owner chose. Any problem reading the setting means the standard welcome (never no welcome).
async function chosen(db) {
  try { const s = await db.doc('aiSettings/current').get(); return keyOf(s.exists ? s.data().welcome : null); }
  catch (e) { return 'standard'; }
}

module.exports = { PERSONAL_TEMPLATE, KEYS, PREVIEW, keyOf, nameOf, bodyOf, isWelcomeBody, isPersonalBody, chosen };
