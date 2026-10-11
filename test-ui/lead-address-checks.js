'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
module.exports = async function ({ page, db, phone, ok, shots }) {
  const ref = db.doc('contacts/' + phone);
  const notes = 'Meta lead · Kitchen form · 11 Oct 2026\nLead ID: 777777777\nOther answers:\n• Eircode / postcode: k67x123';
  await ref.update({ notes });
  await page.waitForFunction(() => document.querySelector('.agenda-entry[open] .agenda-lead-address')?.textContent.includes('K67 X123'));
  assert.equal(await page.locator('.agenda-entry[open] .agenda-lead-source').innerText(), 'From customer notes');
  assert.equal((await ref.get()).data().address, undefined, 'opening the calendar must not write to the customer');
  await page.screenshot({ path: path.join(shots, 'calendar-address-from-notes.png') });
  ok('existing lead Eircode appears automatically from imported notes, labelled with its source, without any database write');

  await ref.update({ notes: notes + '\n\nEircode: D02 X285' });
  await page.waitForFunction(() => document.querySelector('.agenda-entry[open] .agenda-lead-address')?.textContent === 'Check address in customer notes');
  await ref.update({ address: '42 Saved Street, Swords' });
  await page.waitForFunction(() => document.querySelector('.agenda-entry[open] .agenda-lead-address')?.textContent === '42 Saved Street, Swords');
  assert.equal(await page.locator('.agenda-entry[open] .agenda-lead-source').count(), 0);
  ok('conflicting Eircodes are not guessed; a saved address always wins');

  await ref.update({ address: null, notes });
  await page.click('.agenda-entry[open] button:has-text("Open customer")');
  await page.waitForFunction(() => document.getElementById('d-address').value === 'K67 X123');
  assert.match(await page.locator('#d-address-help').textContent(), /Found in customer notes/);
  assert.equal(await page.locator('#d-save').isEnabled(), true);
  // Merely displaying the inferred value must not freeze a subsequent staff update as an unsaved draft.
  await ref.update({ address: '7 Updated Avenue, Swords' });
  await page.waitForFunction(() => document.getElementById('d-address').value === '7 Updated Avenue, Swords');
  await ref.update({ address: null });
  await page.waitForFunction(() => document.getElementById('d-address').value === 'K67 X123');
  await page.click('#d-save');
  await page.waitForFunction(() => document.getElementById('d-msg').textContent === 'Saved');
  assert.equal((await ref.get()).data().address, 'K67 X123');
  assert.equal((await ref.get()).data().notes, notes);
  ok('customer address is prefilled, stays live until edited, and can be saved without copying or losing notes');

  // Restore the fixture and original calendar selection for the remaining appointment checks.
  await ref.update({ address: null, notes: '' });
  await page.evaluate(() => { location.hash = '#appointments'; });
  await page.waitForFunction(() => document.querySelector('.agenda-entry[open] .agenda-lead-address')?.textContent === 'Not provided');
};
