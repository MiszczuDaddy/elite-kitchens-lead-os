'use strict';
// Focused extension of appointments.e2e.js; receives its demo emulators and fake Google Calendar.
const assert = require('assert');
const path = require('path');
module.exports = async ({ page, db, cal, showDay, dublin, D7, created, ok, SHOTS }) => {
  await page.setViewportSize({ width: 1360, height: 900 });
  await showDay(page, D7);
  const source = () => page.locator(`.cal-ev[data-id="${created.id}"]`);
  await source().waitFor();
  const dates = await page.locator('.cal-cell').evaluateAll(ns => ns.map(n => n.dataset.day));
  const today = dublin(Date.now());
  const target = dates.filter(k => k.slice(0, 7) === D7.slice(0, 7) && k >= today && k !== D7).at(-1);
  assert.ok(target);
  const cell = k => page.locator(`.cal-cell[data-day="${k}"]`);
  const record = async () => (await db.doc('appointments/' + created.id).get()).data();
  const original = await record();
  const clock = ms => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Dublin', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
  const googleId = original.sync.google.eventId, eventCount = cal.events.size;

  await source().dragTo(cell(target));
  await page.waitForSelector('#appt-dlg[open]');
  assert.equal(await page.inputValue('#a-date'), target);
  assert.equal(await page.inputValue('#a-time'), clock(original.start.toMillis()));
  assert.equal(await page.inputValue('#a-duration'), String(original.durationMin));
  assert.match(await page.textContent('#appt-who'), /Cathal Closed/);
  assert.equal(await page.textContent('#a-go'), 'Confirm move');
  assert.equal((await record()).version, original.version, 'drop alone must not write');
  await page.screenshot({ path: path.join(SHOTS, 'calendar-drag-confirm.png') });
  await page.click('#a-cancel');
  assert.equal((await record()).version, original.version, 'cancelling must not write');
  ok('dragging prefills the new day and preserves time/duration; dropping or cancelling alone does not move the appointment');

  await source().dragTo(cell(target));
  await page.click('#a-go');
  await page.waitForFunction(() => !document.getElementById('appt-dlg').open);
  const moved = await record();
  assert.equal(dublin(moved.start.toMillis()), target);
  assert.equal(clock(moved.start.toMillis()), clock(original.start.toMillis()), 'keep Dublin wall time across clock changes');
  assert.equal(moved.end.toMillis() - moved.start.toMillis(), original.end.toMillis() - original.start.toMillis());
  for (const key of ['phone', 'notes', 'location', 'type']) assert.equal(moved[key], original[key]);
  assert.equal(moved.version, original.version + 1);
  assert.equal(moved.rescheduleCount, original.rescheduleCount + 1);
  assert.equal(cal.events.size, eventCount); assert.equal(moved.sync.google.eventId, googleId);
  assert.equal(Date.parse(cal.events.get(googleId).start.dateTime), moved.start.toMillis());
  ok('confirming a drag updates the same appointment and Google event once, retaining customer, details, Irish clock time and duration');

  await source().dragTo(cell(target)); // same day
  assert.equal(await page.locator('#appt-dlg[open]').count(), 0);
  const past = dates.find(k => k < today);
  if (past) { await source().dragTo(cell(past)); assert.equal(await page.locator('#appt-dlg[open]').count(), 0); }
  assert.equal((await record()).version, moved.version);
  await db.doc('appointments/drag-cancelled-fixture').set({ ...original, status: 'cancelled' });
  await page.check('#appts-show-cancelled');
  const cancelled = page.locator('.cal-ev[data-id="drag-cancelled-fixture"]');
  await cancelled.waitFor();
  assert.equal(await cancelled.getAttribute('draggable'), null);
  await page.uncheck('#appts-show-cancelled');
  await db.doc('appointments/drag-cancelled-fixture').delete();
  const foreign = await page.evaluateHandle(() => { const d = new DataTransfer(); d.setData('text/plain', 'a_foreign'); return d; });
  await cell(D7).dispatchEvent('drop', { dataTransfer: foreign });
  assert.equal(await page.locator('#appt-dlg[open]').count(), 0); await foreign.dispose();
  ok('same-day and past-day drops do not write; cancelled appointments and external drag data cannot be moved');

  // Hold the native drag open while a Firestore update arrives: no stale appointment can be moved.
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  await source().dispatchEvent('dragstart', { dataTransfer: transfer });
  await db.doc('appointments/' + created.id).update({ version: moved.version + 1, notes: 'Updated during drag' });
  await page.waitForFunction(({ id, version }) => APPT.calList.find(a => a.id === id)?.version === version, { id: created.id, version: moved.version + 1 });
  await cell(D7).dispatchEvent('drop', { dataTransfer: transfer });
  assert.match(await page.textContent('#appts-toast'), /changed while you were dragging/);
  assert.equal(await page.locator('#appt-dlg[open]').count(), 0);
  assert.equal((await record()).notes, 'Updated during drag'); await transfer.dispose();

  await source().dragTo(cell(D7));
  await page.waitForSelector('#appt-dlg[open]');
  await db.doc('appointments/' + created.id).update({ version: moved.version + 2, notes: 'Updated before confirmation' });
  await page.click('#a-go');
  await page.waitForFunction(() => document.getElementById('a-err').textContent.includes('changed by someone else'));
  assert.equal((await record()).notes, 'Updated before confirmation');
  assert.equal(dublin((await record()).start.toMillis()), target);
  await page.click('#a-cancel');
  ok('staff changes during the drag or before confirmation are preserved by the existing version guard');

  // Agenda entries are also draggable; on phones the Reschedule action remains the route.
  await cell(target).locator('.cal-select').click();
  const agenda = page.locator(`.agenda-entry[data-id="${created.id}"] summary`);
  await agenda.dragTo(cell(D7));
  await page.waitForSelector('#appt-dlg[open]'); await page.click('#a-cancel');
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileTransfer = await page.evaluateHandle(() => new DataTransfer());
  await agenda.dispatchEvent('dragstart', { dataTransfer: mobileTransfer });
  assert.equal(await page.evaluate(() => APPT.drag), null); await mobileTransfer.dispose();
  await agenda.click();
  assert.equal(await page.locator('#appt-detail-dlg').getByRole('button', { name: 'Reschedule', exact: true }).isVisible(), true);
  await page.click('#appt-detail-close');
  await page.setViewportSize({ width: 1360, height: 860 });
  ok('dragging also works from the day agenda; mobile retains its tap-to-reschedule flow');
};
