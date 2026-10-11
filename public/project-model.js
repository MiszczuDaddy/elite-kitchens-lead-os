'use strict';
// Elite Kitchens Lead OS: the logic behind the Projects screen (Phase 7, docs/PROJECTS.md). Pure functions only (no DOM, no Firebase), so they can be
// unit-tested in Node: the five steps, what is still waiting to be ordered, the one-line status, the dashboard filters and counts, and the order of the list.
// The screens (projects.js) only draw what this returns.
//
// The five steps are INDEPENDENT. Nothing here assumes an order: "doors ordered" can be ticked before "carcasses ordered", before the design is approved, at any time.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.ProjectModel = factory();
})(this, function () {
  const STEPS = [
    { key: 'designApproved', label: 'Final 3D design approved' },
    { key: 'carcassesOrdered', label: 'Carcasses ordered' },
    { key: 'doorsOrdered', label: 'Doors ordered' },
    { key: 'readyForInstall', label: 'Ready for installation' },
    { key: 'installed', label: 'Installation completed' },
  ];
  const FILTERS = ['active', 'carcasses', 'doors', 'ready', 'completed'];
  const FILTER_LABEL = { active: 'Active', carcasses: 'Carcasses to order', doors: 'Doors to order', ready: 'Ready for installation', completed: 'Completed' };
  const done = (p, key) => !!(p && p.steps && p.steps[key] && p.steps[key].done);
  const isCompleted = (p) => !!p && p.status === 'completed';

  // What an active project is still waiting to have ORDERED (a completed project waits for nothing).
  function waitingFor(p) {
    if (!p || isCompleted(p)) return [];
    const out = [];
    if (!done(p, 'carcassesOrdered')) out.push('carcasses');
    if (!done(p, 'doorsOrdered')) out.push('doors');
    return out;
  }
  const progress = (p) => ({ done: STEPS.filter((s) => done(p, s.key)).length, total: STEPS.length });

  // One line for "where is this job". The most advanced fact wins; the ordering gaps are shown separately as badges.
  function statusOf(p) {
    if (isCompleted(p)) return { key: 'completed', label: 'Completed' };
    if (done(p, 'installed')) return { key: 'installed', label: 'Installed' };
    if (done(p, 'readyForInstall')) return { key: 'ready', label: 'Ready for installation' };
    if (!waitingFor(p).length) return { key: 'ordered', label: 'Everything ordered' };
    if (done(p, 'designApproved')) return { key: 'to-order', label: 'Design approved: order what is missing' };
    return { key: 'design', label: 'Waiting for design approval' };
  }

  // Dashboard filters. "Ready for installation" = ticked ready and not yet installed.
  function matches(p, filter) {
    if (filter === 'completed') return isCompleted(p);
    if (isCompleted(p)) return false;
    if (filter === 'carcasses') return !done(p, 'carcassesOrdered');
    if (filter === 'doors') return !done(p, 'doorsOrdered');
    if (filter === 'ready') return done(p, 'readyForInstall') && !done(p, 'installed');
    return true;                                                                  // active
  }
  function counts(list) {
    const c = { active: 0, carcasses: 0, doors: 0, ready: 0, completed: 0 };
    for (const p of list || []) for (const f of FILTERS) if (matches(p, f)) c[f]++;
    return c;
  }
  const ms = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : typeof t === 'number' ? t : 0);
  // Active jobs: the soonest installation first, jobs with no date last, then the newest. Completed: the most recently completed first.
  function sorted(list, filter) {
    const copy = [...(list || [])];
    if (filter === 'completed') return copy.sort((a, b) => ms(b.completedAt) - ms(a.completedAt));
    return copy.sort((a, b) => {
      const da = a.installDate || '9999-99-99', db = b.installDate || '9999-99-99';
      return da < db ? -1 : da > db ? 1 : ms(b.createdAt) - ms(a.createdAt);
    });
  }
  const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
  // Search by customer name, quote number or phone digits.
  function search(list, query, nameOf) {
    const q = norm(query).trim(); if (!q) return list;
    const digits = q.replace(/\D/g, '');
    return list.filter((p) => norm(nameOf ? nameOf(p) : p.customerName).includes(q) || norm(p.quoteRef).includes(q) || (digits.length >= 3 && String(p.phone || '').includes(digits)));
  }
  // "20 Nov 2026" for a YYYY-MM-DD installation date (no time zone maths: it is a calendar date).
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function dateLabel(d) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d || ''); if (!m) return '';
    return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
  }
  // The note shown when the linked quote was reopened after it was accepted.
  const quoteNote = (p) => (p && p.quoteStatus === 'reopened' ? 'The quote was reopened after it was accepted. Check that the job is still going ahead.' : '');

  return { STEPS, FILTERS, FILTER_LABEL, done, isCompleted, waitingFor, progress, statusOf, matches, counts, sorted, search, dateLabel, quoteNote };
});
