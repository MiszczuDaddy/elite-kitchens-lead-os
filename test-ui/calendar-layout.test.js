'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const L = require('../public/calendar-layout');
const event = (id, start, end) => ({ id, start: Date.parse(start), end: Date.parse(end) });
test('compact window covers 08:00–20:00, including on Dublin clock-change days', () => {
  for (const key of ['2026-11-02','2026-10-25','2027-03-28']) {
    const w = L.windowFor([key], [L.layout([], key)]);
    assert.equal(w.minutes, 720);
    assert.equal(L.slots(key).find(s => s.minute === w.starts[0]).time, '08:00');
    assert.equal(L.slots(key).find(s => s.minute === w.starts[0]+w.minutes).time, '20:00');
    const full = L.windowFor([key], [L.layout([], key)], true);
    assert.equal(full.starts[0], 0); assert.equal(full.minutes, L.layout([], key).minutes);
  }
});
test('compact windows expand to include early, late and cross-midnight appointments', () => {
  const keys = L.days('2026-11-02', 'week');
  const appointments = [event('early','2026-11-02T06:30Z','2026-11-02T07:30Z'),event('late','2026-11-03T19:30Z','2026-11-03T21:15Z')];
  const w = L.windowFor(keys, keys.map(k => L.layout(appointments, k)));
  assert.deepEqual(w.starts, keys.map(() => 360)); assert.equal(w.minutes, 960);
  const night = L.layout([event('night','2026-11-01T23:30Z','2026-11-02T00:30Z')], keys[0]);
  assert.equal(L.windowFor([keys[0]],[night]).starts[0],0);
});
test('week boundaries cross months, years and leap days without changing Dublin dates', () => {
  assert.deepEqual(L.days('2026-01-01', 'week'), ['2025-12-29','2025-12-30','2025-12-31','2026-01-01','2026-01-02','2026-01-03','2026-01-04']);
  assert.equal(L.addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(L.addDays('2028-02-29', 1), '2028-03-01');
});
test('Dublin timelines contain 23/25 hours on clock-change days, never offer nonexistent or ambiguous early slots', () => {
  assert.equal(L.layout([], '2027-03-28').minutes, 1380);
  assert.equal(L.layout([], '2026-10-25').minutes, 1500);
  assert.equal(L.slots('2027-03-28').some(s => s.time === '01:30'), false);
  const repeated = L.slots('2026-10-25').filter(s => s.time === '01:30');
  assert.deepEqual(repeated.map(s => s.bookable), [false, true]);
  assert.equal(repeated[1].at - repeated[0].at, 3600000);
});
test('blocks retain actual duration across spring and autumn clock changes', () => {
  const spring = L.layout([event('s', '2027-03-28T00:30Z', '2027-03-28T02:30Z')], '2027-03-28');
  const fall = L.layout([event('f', '2026-10-25T00:30Z', '2026-10-25T02:30Z')], '2026-10-25');
  assert.equal(spring.events[0].duration, 120); assert.equal(fall.events[0].duration, 120);
});
test('overlaps get separate columns; touching intervals and disconnected groups reclaim width', () => {
  const rows = [['a',9,11],['b',10,12],['c',11,13],['d',14,15]].map(([id,s,e]) => event(id,`2026-11-02T${String(s).padStart(2,'0')}:00Z`,`2026-11-02T${e}:00Z`));
  const result = L.layout(rows, '2026-11-02').events;
  assert.deepEqual(result.map(e => [e.appointment.id,e.column,e.columns]), [['a',0,2],['b',1,2],['c',0,2],['d',0,1]]);
  for (const a of result) for (const b of result) if (a !== b && a.start < b.end && a.end > b.start) assert.notEqual(a.column,b.column);
});
test('cross-midnight events are clipped into both days; exact midnight endings do not spill', () => {
  const rows = [event('night','2026-11-02T23:30Z','2026-11-03T01:00Z'),event('end','2026-11-02T23:00Z','2026-11-03T00:00Z')];
  const first = L.layout(rows,'2026-11-02').events.find(e=>e.appointment.id==='night');
  assert.equal(first.duration,30); assert.equal(first.continuesAfter,true);
  const next=L.layout(rows,'2026-11-03').events;
  assert.equal(next.length,1); assert.equal(next[0].top,0); assert.equal(next[0].duration,60); assert.equal(next[0].continuesBefore,true);
});
