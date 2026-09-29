// Integration test: real Postgres (DATABASE_URL), mocked Meta Graph API.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

process.env.ADMIN_PASSWORD = 'pw';
process.env.WHATSAPP_PHONE_NUMBER_ID = '111';
process.env.WHATSAPP_ACCESS_TOKEN = 'tok';
process.env.WHATSAPP_APP_SECRET = 'secret';
process.env.WHATSAPP_VERIFY_TOKEN = 'vt';

const realFetch = global.fetch;
const graphCalls = [];
let graphFail = false;
global.fetch = async (url, opts) => {
  if (!String(url).startsWith('https://graph.facebook.com/')) return realFetch(url, opts);
  graphCalls.push({ url: String(url), body: JSON.parse(opts.body), auth: opts.headers.Authorization });
  if (graphFail) return { ok: false, status: 400, json: async () => ({ error: { code: 131047, message: 'Re-engagement message' } }) };
  return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.OUT' + graphCalls.length }] }) };
};

const db = require('../src/db');
const { app } = require('../src/server');
let server, base;
const H = { authorization: 'Basic ' + Buffer.from('admin:pw').toString('base64'), 'content-type': 'application/json' };
const sign = (raw) => 'sha256=' + crypto.createHmac('sha256', 'secret').update(raw).digest('hex');
const hook = (payload, sig) => {
  const raw = JSON.stringify(payload);
  return realFetch(base + '/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig || sign(raw) }, body: raw });
};
const inbound = (wamid, text, from = '353851234567') => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
  metadata: { phone_number_id: '111' }, contacts: [{ wa_id: from, profile: { name: 'Tom' } }],
  messages: [{ id: wamid, from, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }] } }] }] });
const api = (p, o = {}) => realFetch(base + p, { ...o, headers: H });

before(async () => {
  await db.pool.query('DROP TABLE IF EXISTS messages, conversations, contacts CASCADE');
  await db.migrate();
  server = app.listen(0); base = 'http://127.0.0.1:' + server.address().port;
});
after(async () => { server.close(); await db.pool.end(); });

test('healthz reaches the database', async () => {
  const r = await realFetch(base + '/healthz'); assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, db: true });
});

test('UI and API require the admin password; webhook stays public', async () => {
  assert.equal((await realFetch(base + '/')).status, 401);
  assert.equal((await realFetch(base + '/api/conversations')).status, 401);
  assert.equal((await api('/')).status, 200);
  assert.match(await (await api('/')).text(), /WhatsApp Test/);
});

test('webhook verification handshake', async () => {
  const ok = await realFetch(base + '/webhook?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=12345');
  assert.equal(ok.status, 200); assert.equal(await ok.text(), '12345');
  assert.equal((await realFetch(base + '/webhook?hub.mode=subscribe&hub.verify_token=bad&hub.challenge=1')).status, 403);
});

test('webhook rejects a bad signature and stores nothing', async () => {
  assert.equal((await hook(inbound('wamid.BAD', 'x'), 'sha256=deadbeef')).status, 401);
  assert.equal((await db.pool.query('SELECT count(*) FROM messages')).rows[0].count, '0');
});

test('inbound text is stored once even if Meta retries', async () => {
  for (let i = 0; i < 3; i++) assert.equal((await hook(inbound('wamid.IN1', 'Hello, I am interested in a kitchen.'))).status, 200);
  const { rows } = await db.pool.query("SELECT * FROM messages WHERE whatsapp_message_id = 'wamid.IN1'");
  assert.equal(rows.length, 1); assert.equal(rows[0].direction, 'in');
  const convs = await (await api('/api/conversations')).json();
  assert.equal(convs.length, 1); assert.equal(convs[0].phone, '353851234567'); assert.equal(convs[0].name, 'Tom');
});

test('events for a different phone number id are ignored', async () => {
  const p = inbound('wamid.OTHER', 'nope'); p.entry[0].changes[0].value.metadata.phone_number_id = '999';
  assert.equal((await hook(p)).status, 200);
  assert.equal((await db.pool.query("SELECT count(*) FROM messages WHERE whatsapp_message_id='wamid.OTHER'")).rows[0].count, '0');
});

test('reply within 24h goes to Meta as text and is stored', async () => {
  const convId = (await (await api('/api/conversations')).json())[0].id;
  const r = await api(`/api/conversations/${convId}/send`, { method: 'POST', body: JSON.stringify({ body: 'Thanks Tom!' }) });
  assert.equal(r.status, 200);
  const call = graphCalls.at(-1);
  assert.match(call.url, /\/111\/messages$/); assert.equal(call.auth, 'Bearer tok');
  assert.equal(call.body.to, '353851234567'); assert.equal(call.body.type, 'text'); assert.equal(call.body.text.body, 'Thanks Tom!');
  const msgs = await (await api(`/api/conversations/${convId}/messages`)).json();
  assert.deepEqual(msgs.map((m) => m.direction), ['in', 'out']);
});

test('status webhooks update the message and never move backwards', async () => {
  const st = (status) => ({ entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: '111' }, statuses: [{ id: graphCalls.at(-1) && 'wamid.OUT' + graphCalls.length, status }] } }] }] });
  await hook(st('delivered')); await hook(st('read')); await hook(st('delivered'));
  const { rows } = await db.pool.query("SELECT status FROM messages WHERE direction='out'");
  assert.equal(rows[0].status, 'read');
});

test('start conversation sends the approved template with the first name', async () => {
  const r = await api('/api/start', { method: 'POST', body: JSON.stringify({ phone: '+353 87 111 2222', name: 'Aoife' }) });
  assert.equal(r.status, 200);
  const b = graphCalls.at(-1).body;
  assert.equal(b.to, '353871112222'); assert.equal(b.type, 'template');
  assert.equal(b.template.name, 'elite_kitchens_new_lead'); assert.equal(b.template.language.code, 'en');
  assert.equal(b.template.components[0].parameters[0].text, 'Aoife');
});

test('free text is refused outside the 24h window (no Meta call)', async () => {
  const convs = await (await api('/api/conversations')).json();
  const aoife = convs.find((c) => c.phone === '353871112222');
  const before = graphCalls.length;
  const r = await api(`/api/conversations/${aoife.id}/send`, { method: 'POST', body: JSON.stringify({ body: 'hi' }) });
  assert.equal(r.status, 409); assert.equal(graphCalls.length, before);
});

test('Meta send failure is surfaced and recorded, not swallowed', async () => {
  const convId = (await (await api('/api/conversations')).json()).find((c) => c.phone === '353851234567').id;
  graphFail = true;
  const r = await api(`/api/conversations/${convId}/send`, { method: 'POST', body: JSON.stringify({ body: 'will fail' }) });
  graphFail = false;
  assert.equal(r.status, 502); assert.match((await r.json()).error, /131047/);
  const msgs = await (await api(`/api/conversations/${convId}/messages`)).json();
  assert.equal(msgs.at(-1).status, 'failed'); assert.match(msgs.at(-1).error, /Re-engagement/);
});

test('non-text inbound (image) is stored with a placeholder and media metadata', async () => {
  const p = inbound('wamid.IMG', ''); const m = p.entry[0].changes[0].value.messages[0];
  m.type = 'image'; delete m.text; m.image = { id: 'MEDIA1', mime_type: 'image/jpeg' };
  await hook(p);
  const { rows } = await db.pool.query("SELECT message_type, body, media FROM messages WHERE whatsapp_message_id='wamid.IMG'");
  assert.equal(rows[0].message_type, 'image'); assert.equal(rows[0].body, '[image]'); assert.equal(rows[0].media.id, 'MEDIA1');
});
