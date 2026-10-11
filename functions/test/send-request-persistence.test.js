'use strict';
// Run the actual browser request lifecycle in fresh page contexts sharing sessionStorage. No Firebase.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../../public/app.js'), 'utf8');
const lifecycle = source.slice(source.indexOf('const newRid ='), source.indexOf('const UNCONFIRMED ='));
const phone = '353851111111', key = 'start|Test';
function fixture() {
  const saved = new Map(); let seq = 0, now = Date.now(), failWrites = false;
  const storage = { getItem: (k) => saved.get(k) || null, setItem(k, v) { if (failWrites) throw Error('quota'); saved.set(k, v); } };
  function page(send) {
    const crypto = { randomUUID: () => `request-test-${++seq}` };
    const nodes = { 'n-phone': { value: phone }, 'n-name': { value: 'Test' }, 'n-go': {}, 'n-err': {}, 'new-form': { addEventListener: (_, fn) => { nodes.submit = fn; } } };
    const context = vm.createContext({ sessionStorage: storage, window: { crypto }, crypto, Date: { now: () => now }, Math, Map, call: () => send,
      $: (id) => nodes[id], normalizePhoneInput: (v) => v, dlg: { close() {} }, openConversation() {}, errText: () => 'Failed', startDecision: () => { nodes.decision = true; } });
    vm.runInContext(lifecycle + ';this.api={dispatchMessage,needsDecision,unresolved,sendKey};', context);
    const formStart = source.indexOf("$('new-form').addEventListener");
    vm.runInContext(source.slice(formStart, source.indexOf('// ---------- add a customer', formStart)), context);
    context.api.submit = () => nodes.submit({ preventDefault() {} }); context.api.nodes = nodes;
    return context.api;
  }
  return { page, saved, advance: () => { now += 7 * 24 * 3600 * 1000; }, failWrites: () => { failWrites = true; } };
}
const send = (p, k = key, method = 'startConversation') => p.dispatchMessage(method, phone, k, { name: 'Test' });

test('the actual Start form persists before dispatch and offers a decision after reload of an unknown outcome', async () => {
  const f = fixture(); let calls = 0, answer;
  const p = f.page(({ requestId }) => {
    calls++; assert.ok(f.saved.get('ek-unresolved-sends').includes(requestId));
    return new Promise((_, reject) => { answer = reject; });
  });
  const pending = p.submit();
  answer({ code: 'functions/unavailable', details: { reason: 'not_confirmed' } }); await pending;
  f.advance(); const reloaded = f.page(() => { calls++; }); await reloaded.submit();
  assert.equal(calls, 1); assert.equal(reloaded.nodes.decision, true);
});

test('reload before the answer: the accepted send is retried with its persisted ID and reaches the provider once', async () => {
  for (const [method, k] of [['startConversation', key], ['sendReply', 'Hello'], ['sendMedia', 'site.pdf|123|Quote']]) {
    const f = fixture(), requests = [], accepted = new Set(); let release, providerCalls = 0;
    const provider = async ({ requestId }) => {
      requests.push(requestId);
      assert.ok(f.saved.get('ek-unresolved-sends').includes(requestId), 'identity must exist BEFORE dispatch');
      if (accepted.has(requestId)) return { data: { existing: true } };
      accepted.add(requestId); providerCalls++;
      return new Promise((r) => { release = r; });
    };
    const first = send(f.page(provider), k, method);
    const reloaded = f.page(provider);
    assert.equal(reloaded.needsDecision(phone, k), false, 'pending retries can safely ask the server with the SAME ID');
    await send(reloaded, k, method);
    release({ data: { ok: true } }); await first;
    assert.equal(providerCalls, 1); assert.equal(requests[0], requests[1]);
    assert.equal(reloaded.unresolved.get(reloaded.sendKey(phone, k)), null);
  }
});

test('transport failure then reload, even a week later, retains the pending request ID', async () => {
  const f = fixture(), ids = [];
  await assert.rejects(send(f.page(async ({ requestId }) => { ids.push(requestId); throw { code: 'functions/internal' }; })));
  f.advance();
  await send(f.page(async ({ requestId }) => { ids.push(requestId); return {}; }));
  assert.equal(ids[0], ids[1]);
});

test('unknown outcomes and pre-fix stored outcomes do not expire; only a decision frees a new request', async () => {
  const f = fixture(); let first;
  await assert.rejects(send(f.page(async ({ requestId }) => { first = requestId; throw { code: 'functions/unavailable', details: { reason: 'not_confirmed' } }; })));
  f.advance(); const p = f.page(async ({ requestId }) => { assert.notEqual(requestId, first); return {}; });
  assert.ok(p.needsDecision(phone, key));
  assert.equal(p.unresolved.get(p.sendKey(phone, key)).requestId, first);
  assert.equal(p.unresolved.clear(p.sendKey(phone, key)), true); await send(p);
  f.saved.set('ek-unresolved-sends', JSON.stringify({ [phone + '|' + key]: { requestId: 'legacy-request', at: 1 } }));
  assert.ok(f.page(() => {}).needsDecision(phone, key));
});

test('unavailable legacy answer and in-progress answer retain their own identities', async () => {
  for (const error of [{ code: 'functions/unavailable' }, { code: 'functions/failed-precondition', details: { reason: 'in_progress' } }]) {
    const f = fixture(); let id;
    await assert.rejects(send(f.page(async ({ requestId }) => { id = requestId; throw error; })));
    const p = f.page(() => {}); assert.equal(p.unresolved.get(p.sendKey(phone, key)).requestId, id);
    assert.equal(!!p.needsDecision(phone, key), error.code === 'functions/unavailable');
  }
});

test('an auth or validation failure on a retry cannot erase a previously dispatched request', async () => {
  for (const code of ['unauthenticated', 'permission-denied', 'invalid-argument', 'not-found']) {
    const f = fixture(); let id;
    await assert.rejects(send(f.page(async ({ requestId }) => { id = requestId; throw { code: 'functions/internal' }; })));
    await assert.rejects(send(f.page(async ({ requestId }) => { assert.equal(requestId, id); throw { code: 'functions/' + code }; })));
    assert.equal(f.page(() => {}).unresolved.get(phone + '|' + key).requestId, id);
  }
});

test('definite refusal clears its hold; concurrent messages and late responses cannot clear another request', async () => {
  const f = fixture(), p = f.page(async () => { throw { code: 'functions/unavailable', details: { reason: 'refused' } }; });
  await assert.rejects(send(p)); assert.equal(p.unresolved.get(p.sendKey(phone, key)), null);
  let release; const q = f.page(() => new Promise((r) => { release = r; }));
  const pending = send(q); const k = q.sendKey(phone, key);
  q.unresolved.clear(k); q.unresolved.set(k, 'newer-request', 'pending');
  release({}); await pending; assert.equal(q.unresolved.get(k).requestId, 'newer-request');
  const r = f.page(async () => { throw { code: 'functions/unavailable' }; });
  await assert.rejects(send(r, 'different message'));
  assert.notEqual(r.unresolved.get(r.sendKey(phone, 'different message')).requestId, 'newer-request');
});

test('storage failure or malformed stored state prevents dispatch, and failed clearing retains protection', async () => {
  const f = fixture(); let calls = 0; const p = f.page(async () => { calls++; });
  f.failWrites(); await assert.rejects(send(p), /Cannot save/); assert.equal(calls, 0);
  const g = fixture(); g.saved.set('ek-unresolved-sends', '{bad');
  await assert.rejects(send(g.page(async () => { calls++; })), /Cannot save/); assert.equal(calls, 0);
  g.saved.set('ek-unresolved-sends', JSON.stringify({ [phone + '|' + key]: { state: 'pending' } }));
  await assert.rejects(send(g.page(async () => { calls++; })), /Cannot save/); assert.equal(calls, 0);
  const h = fixture(), q = h.page(async () => { h.failWrites(); return {}; });
  await send(q); assert.ok(q.unresolved.get(q.sendKey(phone, key)), 'failed clearing must keep the original ID');
});
