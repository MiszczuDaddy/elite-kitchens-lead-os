'use strict';
// Elite Kitchens Lead OS: the logic behind the Assistant screen (Phase 9, docs/AI.md). Pure functions only (no DOM, no Firebase), so they can be unit-tested in Node:
// what is sent back to the server as the conversation so far, the open customer/quote/project, the little markdown the assistant may use (turned into a plain
// structure, NEVER into HTML: the screen builds text nodes, so nothing the assistant or a customer wrote can run as a page), money, and the spending bar.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.AssistantModel = factory();
})(this, function () {
  const MAX_TURNS = 12, MAX_TURN_CHARS = 4000, MAX_TOTAL_CHARS = 12000;
  const CUSTOMER_ID = /^\d{9,15}$/, QUOTE_ID = /^q_[0-9a-f]{24}$/, PROJECT_ID = /^[pm]_[0-9a-f]{24}$/;

  // What the server gets as "the conversation so far": only text turns, the newest ones that fit, starting with the person and ending with the assistant.
  // Errors, notes and tool traces never go back to the model.
  function historyOf(turns) {
    const ok = (turns || []).filter((t) => t && (t.role === 'user' || t.role === 'assistant') && typeof t.text === 'string' && t.text.trim() && !t.error && !t.pending);
    const out = []; let total = 0;
    for (let i = ok.length - 1; i >= 0 && out.length < MAX_TURNS; i--) {
      const text = ok[i].text.length > MAX_TURN_CHARS ? ok[i].text.slice(0, MAX_TURN_CHARS) : ok[i].text;
      if (total + text.length > MAX_TOTAL_CHARS) break;
      total += text.length; out.unshift({ role: ok[i].role, text });
    }
    while (out.length && out[0].role !== 'user') out.shift();
    const clean = []; for (const t of out) { if (clean.length && clean[clean.length - 1].role === t.role) clean[clean.length - 1] = t; else clean.push(t); }
    while (clean.length && clean[clean.length - 1].role === 'user') clean.pop();
    return clean;
  }

  // The open customer / quote / project as ids only (the server looks the names up itself). Anything that is not a valid id is dropped.
  function contextOf(c) {
    const out = {};
    if (c && CUSTOMER_ID.test(String(c.customerId || ''))) out.customerId = String(c.customerId);
    if (c && QUOTE_ID.test(String(c.quoteId || ''))) out.quoteId = String(c.quoteId);
    if (c && PROJECT_ID.test(String(c.projectId || ''))) out.projectId = String(c.projectId);
    return out;
  }

  // **bold** and plain text inside one line.
  function inline(s) {
    const parts = []; const re = /\*\*([^*\n]+)\*\*/g; let last = 0, m;
    while ((m = re.exec(s))) { if (m.index > last) parts.push({ t: 'text', s: s.slice(last, m.index) }); parts.push({ t: 'b', s: m[1] }); last = m.index + m[0].length; }
    if (last < s.length) parts.push({ t: 'text', s: s.slice(last) });
    return parts.length ? parts : [{ t: 'text', s: '' }];
  }
  // Paragraphs, "- " / "* " / "1. " lists and **bold**. Nothing else is interpreted (no links, no images, no HTML): those characters stay as text.
  function blocks(text) {
    const out = []; let list = null;
    for (const raw of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
      const line = raw.trimEnd(), li = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
      if (li) { if (!list) { list = { type: 'ul', items: [] }; out.push(list); } list.items.push(inline(li[1])); continue; }
      list = null;
      if (!line.trim()) continue;
      out.push({ type: 'p', parts: inline(line.trim()) });
    }
    return out;
  }

  const eur = (n, digits) => (typeof n === 'number' && Number.isFinite(n) ? '€' + n.toLocaleString('en-IE', { minimumFractionDigits: digits == null ? 2 : digits, maximumFractionDigits: digits == null ? 2 : digits }) : '');
  // The spending bar: how much of the month's cap is used, and how worried to look.
  function budget(status) {
    const spent = Number(status && status.monthSpentEur) || 0, cap = Number(status && status.monthlyCapEur) || 0;
    const pct = cap > 0 ? Math.min(100, Math.round((spent / cap) * 100)) : 100;
    return { pct, level: cap <= 0 || pct >= 100 ? 'full' : pct >= 80 ? 'high' : 'ok', label: `${eur(spent)} of ${eur(cap, cap % 1 ? 2 : 0)} used this month` };
  }
  // What the page says about the assistant's state: why a question cannot be asked, and what is switched off.
  function notice(status, modelKey) {
    if (!status) return { ask: false, text: '', level: 'info' };
    if (!status.keyConfigured) return { ask: false, text: 'The assistant is not connected yet: the key has not been set up on the server.', level: 'warn' };
    if (!status.enabled) return { ask: false, text: 'The assistant is switched off. Open Settings to switch it on.', level: 'warn' };
    if (budget(status).level === 'full') return { ask: false, text: 'This month\'s AI budget is used up. It starts again next month, or the cap can be raised in Settings.', level: 'warn' };
    const chosen = modelOf(status, chosenModel(status, modelKey));
    if (chosen && !chosen.ready) return { ask: false, text: chosen.reason ? `The ${chosen.label} model failed its check: ${chosen.reason} Open Settings and press "Check models".` : `The ${chosen.label} model has not been checked yet. Open Settings and press "Check models".`, level: 'warn' };
    if (!status.customerDataApproved) return { ask: true, text: 'Customer data is not switched on yet, so the assistant can only answer general questions. The owner switches it on in Settings once the provider\'s data terms are checked.', level: 'info' };
    return { ask: true, text: '', level: 'info' };
  }
  // The model chosen on the screen: the saved choice if it is one of the server's models, else the server's default (Haiku).
  const MODEL_KEYS = ['haiku', 'sonnet'];
  const chosenModel = (status, saved) => (MODEL_KEYS.includes(saved) ? saved : (status && MODEL_KEYS.includes(status.defaultModel) ? status.defaultModel : 'haiku'));
  const modelOf = (status, key) => ((status && status.models) || []).find((m) => m.key === key) || null;
  // "Retry with Sonnet": only on the last answer, only when it did not come from Sonnet, and only when Sonnet is usable now.
  function canRetry(turns, index, status) {
    const t = (turns || [])[index], q = (turns || [])[index - 1], s = modelOf(status, 'sonnet');
    return !!(t && q && index === turns.length - 1 && t.role === 'assistant' && !t.error && !t.pending && t.model === 'haiku' && q.role === 'user' && typeof q.text === 'string' && q.text.trim() && s && s.ready && notice(status, 'sonnet').ask);
  }
  // The data box in Settings: only the owner account may change it (the server enforces this; the screen just explains).
  function dataGate(status) {
    if (!status) return { disabled: true, hint: '' };
    if (!status.ownerConfigured) return { disabled: true, hint: 'The owner account has not been set up on the server, so nobody can switch real customer data on yet.' };
    if (!status.canApproveData) return { disabled: true, hint: 'Only the owner account can change real customer data access.' };
    return { disabled: false, hint: '' };
  }
  const modelLine = (m) => (m.ready ? `${m.label}: ready` : m.reason ? `${m.label}: failed. ${m.reason}` : `${m.label}: not checked yet`);
  const friendlyError = (e) => String((e && e.message) || e || 'Something went wrong.').replace(/^(functions\/)?[\w-]+:\s*/, '').slice(0, 300);
  const SUGGESTIONS = ['Which quotes are waiting for an answer?', 'Who are the newest leads?', 'What is booked this week?', 'Which projects still need doors ordered?'];

  return { MODEL_KEYS, chosenModel, modelOf, canRetry, dataGate, modelLine, MAX_TURNS, MAX_TURN_CHARS, MAX_TOTAL_CHARS, historyOf, contextOf, blocks, inline, eur, budget, notice, friendlyError, SUGGESTIONS };
});
