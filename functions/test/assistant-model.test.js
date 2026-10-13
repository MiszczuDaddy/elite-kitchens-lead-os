// Phase 9.1: the logic behind the Assistant screen (public/assistant-model.js): what is sent back as the conversation, the open customer as ids, the tiny markdown (turned into a
// structure, never HTML), the spending bar and what the screen says about the assistant's state. Pure functions; no database.
const { test } = require('node:test');
const assert = require('node:assert');
const M = require('../../public/assistant-model.js');
const AI = require('../lib/ai.js');

test('history: only text turns, newest that fit, starting with the person and ending with the assistant; errors and pending turns never go back', () => {
  const t = (role, text, extra = {}) => ({ role, text, ...extra });
  assert.deepEqual(M.historyOf([]), []);
  assert.deepEqual(M.historyOf(null), []);
  assert.deepEqual(M.historyOf([t('user', 'a'), t('assistant', 'b'), t('user', 'c')]), [t('user', 'a'), t('assistant', 'b')], 'the new question is not part of the history');
  assert.deepEqual(M.historyOf([t('user', 'a'), t('assistant', 'oops', { error: true }), t('user', 'b'), t('assistant', 'x', { pending: true })]), [], 'a question whose answer failed is dropped when it dangles');
  assert.deepEqual(M.historyOf([t('assistant', 'old'), t('user', 'a'), t('assistant', 'b')]), [t('user', 'a'), t('assistant', 'b')]);
  assert.deepEqual(M.historyOf([t('user', 'a'), t('user', 'b'), t('assistant', 'c')]), [t('user', 'b'), t('assistant', 'c')], 'two questions in a row: the later one wins');
  assert.deepEqual(M.historyOf([t('user', ' '), t('system', 'x'), { role: 'user' }, t('user', 'ok'), t('assistant', 'fine')]), [t('user', 'ok'), t('assistant', 'fine')]);
  const many = []; for (let i = 0; i < 20; i++) many.push(t('user', 'q' + i), t('assistant', 'a' + i));
  const h = M.historyOf(many);
  assert.ok(h.length <= M.MAX_TURNS && h[0].role === 'user' && h.at(-1).role === 'assistant' && h.at(-1).text === 'a19');
  const big = M.historyOf([t('user', 'x'.repeat(9000)), t('assistant', 'y'.repeat(9000)), t('user', 'z'), t('assistant', 'w')]);
  assert.ok(big.reduce((n, x) => n + x.text.length, 0) <= M.MAX_TOTAL_CHARS && big.every((x) => x.text.length <= M.MAX_TURN_CHARS));
});

test('what the screen sends is always acceptable to the server (same limits as functions/lib/ai.js)', () => {
  const turns = []; for (let i = 0; i < 40; i++) turns.push({ role: i % 2 ? 'assistant' : 'user', text: 'x'.repeat(1500) });
  const h = M.historyOf(turns);
  assert.deepEqual(AI.checkHistory(h), h);
  assert.deepEqual(AI.checkHistory(M.historyOf([{ role: 'user', text: 'q' }, { role: 'assistant', text: 'a' }])).length, 2);
  for (const c of [{ customerId: '353851111111' }, { customerId: '353851111111', quoteId: 'q_' + 'a'.repeat(24), projectId: 'p_' + 'b'.repeat(24) }, { projectId: 'm_' + '0'.repeat(24) }, {}])
    assert.deepEqual(AI.checkContext(M.contextOf(c)), c);
});

test('context: only valid ids survive, nothing else is ever sent', () => {
  assert.deepEqual(M.contextOf({ customerId: '353851111111', name: 'Boss', quoteId: 'EK-0104', projectId: 'p_nope' }), { customerId: '353851111111' });
  assert.deepEqual(M.contextOf({ customerId: 'abc' }), {});
  assert.deepEqual(M.contextOf(null), {});
  assert.deepEqual(M.contextOf({ quoteId: 'q_' + 'a'.repeat(24) }), { quoteId: 'q_' + 'a'.repeat(24) });
});

test('markdown: paragraphs, lists and bold only; HTML, links and images stay as plain text', () => {
  assert.deepEqual(M.blocks('Hello **world**\n\n- one\n- **two**\n* three\n1. four'), [
    { type: 'p', parts: [{ t: 'text', s: 'Hello ' }, { t: 'b', s: 'world' }] },
    { type: 'ul', items: [[{ t: 'text', s: 'one' }], [{ t: 'b', s: 'two' }], [{ t: 'text', s: 'three' }], [{ t: 'text', s: 'four' }]] }]);
  const bad = M.blocks('<img src=x onerror=alert(1)> [click](javascript:alert(1)) ![x](http://evil)\n- <script>x</script>');
  assert.equal(JSON.stringify(bad).includes('"t":"html"'), false);
  assert.deepEqual(bad[0].parts, [{ t: 'text', s: '<img src=x onerror=alert(1)> [click](javascript:alert(1)) ![x](http://evil)' }]);
  assert.deepEqual(bad[1].items[0], [{ t: 'text', s: '<script>x</script>' }]);
  assert.deepEqual(M.blocks(''), []); assert.deepEqual(M.blocks(null), []);
  assert.deepEqual(M.blocks('a **unclosed bold'), [{ type: 'p', parts: [{ t: 'text', s: 'a **unclosed bold' }] }]);
  assert.ok(M.blocks('x\r\ny\r\n').length === 2);
});

test('the spending bar and the notice say the right thing in every state', () => {
  assert.deepEqual(M.budget({ monthSpentEur: 3.456, monthlyCapEur: 15 }), { pct: 23, level: 'ok', label: '€3.46 of €15 used this month' });
  assert.equal(M.budget({ monthSpentEur: 12, monthlyCapEur: 15 }).level, 'high');
  assert.equal(M.budget({ monthSpentEur: 15, monthlyCapEur: 15 }).level, 'full');
  assert.equal(M.budget({ monthSpentEur: 20, monthlyCapEur: 15 }).pct, 100);
  assert.equal(M.budget({ monthSpentEur: 0, monthlyCapEur: 0 }).level, 'full', 'a zero cap means no AI');
  assert.equal(M.budget({ monthSpentEur: 1, monthlyCapEur: 7.5 }).label, '€1.00 of €7.50 used this month');
  const ready = { keyConfigured: true, enabled: true, customerDataApproved: true, monthSpentEur: 1, monthlyCapEur: 15 };
  assert.deepEqual(M.notice(ready), { ask: true, text: '', level: 'info' });
  assert.equal(M.notice({ ...ready, customerDataApproved: false }).ask, true); assert.match(M.notice({ ...ready, customerDataApproved: false }).text, /Customer data is not switched on/);
  assert.equal(M.notice({ ...ready, enabled: false }).ask, false); assert.match(M.notice({ ...ready, enabled: false }).text, /switched off/);
  assert.equal(M.notice({ ...ready, keyConfigured: false }).ask, false); assert.match(M.notice({ ...ready, keyConfigured: false }).text, /not connected/);
  assert.equal(M.notice({ ...ready, monthSpentEur: 15 }).ask, false); assert.match(M.notice({ ...ready, monthSpentEur: 15 }).text, /budget is used up/);
  assert.equal(M.notice(null).ask, false);
});

test('errors are shown without technical prefixes; money formats as euro', () => {
  assert.equal(M.friendlyError(new Error('functions/failed-precondition: The AI assistant is switched off.')), 'The AI assistant is switched off.');
  assert.equal(M.friendlyError({ message: 'Nope' }), 'Nope');
  assert.equal(M.friendlyError(null), 'Something went wrong.');
  assert.ok(M.friendlyError('x'.repeat(1000)).length <= 300);
  assert.equal(M.eur(1234.5), '€1,234.50'); assert.equal(M.eur(15, 0), '€15'); assert.equal(M.eur(undefined), '');
  assert.equal(M.SUGGESTIONS.length, 4);
});

test('models on the screen: Haiku unless the person chose Sonnet; a saved choice that is not a real model is ignored; the screen says when the chosen model is not ready', () => {
  const ready = { keyConfigured: true, enabled: true, customerDataApproved: true, monthSpentEur: 1, monthlyCapEur: 15, defaultModel: 'haiku',
    models: [{ key: 'haiku', label: 'Haiku', ready: true }, { key: 'sonnet', label: 'Sonnet', ready: true }], ownerConfigured: true, canApproveData: true };
  assert.equal(M.chosenModel(ready, undefined), 'haiku'); assert.equal(M.chosenModel(ready, 'sonnet'), 'sonnet'); assert.equal(M.chosenModel(ready, 'claude-opus-5-5'), 'haiku'); assert.equal(M.chosenModel(null, null), 'haiku');
  assert.equal(M.chosenModel({ defaultModel: 'sonnet' }, null), 'sonnet'); assert.equal(M.chosenModel({ defaultModel: 'evil' }, null), 'haiku');
  assert.deepEqual(M.MODEL_KEYS, ['haiku', 'sonnet']);
  assert.equal(M.notice(ready, 'sonnet').ask, true);
  const unchecked = { ...ready, models: [{ key: 'haiku', label: 'Haiku', ready: false }, { key: 'sonnet', label: 'Sonnet', ready: true }] };
  assert.equal(M.notice(unchecked).ask, false); assert.match(M.notice(unchecked).text, /Haiku model has not been checked yet/);
  assert.equal(M.notice(unchecked, 'sonnet').ask, true, 'the other model still works');
  const failed = { ...ready, models: [{ key: 'haiku', label: 'Haiku', ready: false, reason: 'The model is retired, not active.' }, ready.models[1]] };
  assert.match(M.notice(failed).text, /failed its check: The model is retired/);
  assert.equal(M.notice({ ...ready, enabled: false }, 'sonnet').ask, false, 'the switch comes first');
  assert.equal(M.modelLine({ label: 'Haiku', ready: true }), 'Haiku: ready'); assert.equal(M.modelLine({ label: 'Sonnet' }), 'Sonnet: not checked yet'); assert.match(M.modelLine({ label: 'X', reason: 'No.' }), /failed\. No\./);
});

test('"Retry with Sonnet" is offered only on the last answer, only if it was not Sonnet, never on errors or while waiting, and only if Sonnet is usable', () => {
  const status = { keyConfigured: true, enabled: true, customerDataApproved: true, monthSpentEur: 1, monthlyCapEur: 15, models: [{ key: 'haiku', label: 'Haiku', ready: true }, { key: 'sonnet', label: 'Sonnet', ready: true }] };
  const turns = [{ role: 'user', text: 'a' }, { role: 'assistant', text: 'b', model: 'haiku' }, { role: 'user', text: 'c' }, { role: 'assistant', text: 'd', model: 'haiku' }];
  assert.equal(M.canRetry(turns, 3, status), true); assert.equal(M.canRetry(turns, 1, status), false, 'only the last answer');
  assert.equal(M.canRetry([...turns.slice(0, 3), { role: 'assistant', text: 'd', model: 'sonnet' }], 3, status), false);
  assert.equal(M.canRetry([...turns.slice(0, 3), { role: 'assistant', text: 'x', error: true }], 3, status), false);
  assert.equal(M.canRetry([...turns.slice(0, 3), { role: 'assistant', text: '', pending: true }], 3, status), false);
  assert.equal(M.canRetry([{ role: 'assistant', text: 'orphan' }], 0, status), false); assert.equal(M.canRetry(turns, 9, status), false);
  assert.equal(M.canRetry([...turns.slice(0, 3), { role: 'assistant', text: 'summary', model: null }], 3, status), false, 'an instant summary (no AI used) has nothing to retry');
  assert.equal(M.canRetry(turns, 3, { ...status, models: [status.models[0], { key: 'sonnet', label: 'Sonnet', ready: false }] }), false);
  assert.equal(M.canRetry(turns, 3, { ...status, enabled: false }), false); assert.equal(M.canRetry(turns, 3, { ...status, monthSpentEur: 15 }), false); assert.equal(M.canRetry(turns, 3, null), false);
});

test('the customer-data box: usable only by the owner account; explained for everyone else', () => {
  assert.deepEqual(M.dataGate({ ownerConfigured: true, canApproveData: true }), { disabled: false, hint: '' });
  assert.equal(M.dataGate({ ownerConfigured: true, canApproveData: false }).disabled, true); assert.match(M.dataGate({ ownerConfigured: true, canApproveData: false }).hint, /Only the owner account/);
  assert.equal(M.dataGate({ ownerConfigured: false, canApproveData: false }).disabled, true); assert.match(M.dataGate({ ownerConfigured: false }).hint, /has not been set up/);
  assert.equal(M.dataGate(null).disabled, true); assert.equal(M.dataGate({}).disabled, true, 'unknown means closed');
});

test('proposal cards: the state shown comes from the stored proposal; a pending one past its time shows as expired; only a pending one can be decided', () => {
  const doc = (status, extra = {}) => ({ id: 'ap_' + 'a'.repeat(24), title: 'Add a note to Anna', status, preview: { rows: [{ label: 'Notes', type: 'append', existing: 'x', added: 'y' }], footer: 'Saved to Notes.' }, expiresAt: { toMillis: () => 1000000 }, ...extra });
  const p = M.proposalView(doc('pending'), 1000000 - 5 * 60000);
  assert.deepEqual([p.status, p.canDecide, p.minutes, p.label, p.rows.length, p.footer], ['pending', true, 5, 'Waiting for your approval', 1, 'Saved to Notes.']);
  const late = M.proposalView(doc('pending'), 1000001); assert.deepEqual([late.status, late.canDecide, late.minutes], ['expired', false, null]);
  for (const s of ['applied', 'partial', 'stale', 'expired', 'rejected', 'failed', 'applying']) { const v = M.proposalView(doc(s), 1); assert.equal(v.canDecide, false, s); assert.equal(v.label, M.STATE_LABEL[s]); }
  assert.equal(M.proposalView(doc('applied', { result: { message: 'The note was added.', results: [{ label: 'Notes', ok: true }] } }), 1).message, 'The note was added.');
  assert.equal(M.proposalView(null, 1), null); assert.deepEqual(M.proposalView({ id: 'x', status: 'pending' }, 1).rows, []);
  assert.equal(M.proposalView(doc('pending', { expiresAt: 2000000 }), 1000000).minutes, 17);
});

test('AI actions box in Settings: owner only; explained for everyone else; needs customer data', () => {
  assert.deepEqual(M.actionsGate({ ownerConfigured: true, canApproveData: true, customerDataApproved: true }), { disabled: false, hint: '' });
  assert.match(M.actionsGate({ ownerConfigured: true, canApproveData: true, customerDataApproved: false }).hint, /customer data/); assert.equal(M.actionsGate({ ownerConfigured: true, canApproveData: true, customerDataApproved: false }).disabled, false);
  assert.deepEqual([M.actionsGate({ ownerConfigured: true, canApproveData: false }).disabled, M.actionsGate({ ownerConfigured: false }).disabled, M.actionsGate(null).disabled], [true, true, true]);
  assert.match(M.actionsGate({ ownerConfigured: true, canApproveData: false }).hint, /Only the owner account/);
});
