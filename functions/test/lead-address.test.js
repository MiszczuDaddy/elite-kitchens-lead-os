'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const A = require('../lib/leadAddress');
const { mapLead, buildNote } = require('../lib/leadmap');

test('the browser and backend use the same extraction rules', () => {
  const source = fs.readFileSync(path.join(__dirname, '../lib/leadAddress.js'), 'utf8');
  assert.equal(fs.readFileSync(path.join(__dirname, '../../public/lead-address.js'), 'utf8'), source);
  const browser = {}; vm.runInNewContext(source, browser);
  assert.equal(browser.LeadAddress.resolve({ notes: 'Eircode: k67x123' }).value, 'K67 X123');
});
test('existing imported notes supply an Eircode without modifying the saved contact', () => {
  const contact = { notes: 'Meta lead · Kitchen enquiry · 11 Oct 2026\nLead ID: 123456789\nOther answers:\n• Eircode / postcode: k67x123', address: null };
  assert.deepEqual(A.resolve(contact), { value: 'K67 X123', source: 'notes', conflict: false });
  assert.equal(contact.address, null);
  assert.equal(A.resolve({ address: 'Staff saved address', notes: contact.notes }).value, 'Staff saved address');
});
test('recognises explicit customer addresses, full addresses with Eircodes, and Dublin 6W', () => {
  for (const [notes, expected] of [
    ['Your Eircode: D6W F4E2', 'D6W F4E2'],
    ['What_is_your_eircode?: k67 x123', 'K67 X123'],
    ['Home address: 12 Main Street, Swords\nEircode: K67 X123', '12 Main Street, Swords, K67 X123'],
    ['Address: 12 Main Street, Swords, K67 X123', '12 Main Street, Swords, K67 X123'],
    ['Address: Ballymore, County Dublin', 'Ballymore, County Dublin'],
    ['Address: 12 Main Street', '12 Main Street']
  ]) assert.equal(A.fromNotes(notes).value, expected, notes);
});
test('repeated identical submissions agree; distinct addresses or Eircodes do not', () => {
  assert.equal(A.fromNotes('Eircode: k67x123\n\nEircode: K67 X123').value, 'K67 X123');
  assert.equal(A.fromNotes('Eircode: K67 X123\n\nAddress: 12 Main St, K67 X123').value, '12 Main St, K67 X123');
  for (const notes of [
    'Eircode: K67 X123\n\nEircode: D02 X285',
    'Address: 12 Main St\n\nAddress: 42 High St',
    'Eircode: K67 X123\nRequirements: another property D02 X285',
    'Old address: 12 Main St\nEircode: K67 X123',
    'Address: 12 Main St\n\nEircode: K67 X123',
    'Address: 12 Main St\nAddress: 42 High St\nEircode: K67 X123'
  ]) assert.deepEqual(A.fromNotes(notes), { value: null, conflict: true }, notes);
});
test('never guesses from prose, emails, lead IDs, malformed codes, or potentially unsafe values', () => {
  for (const notes of [
    '', null, 'Lead ID: K67X123', 'Requirements: visit K67 X123', 'Email address: customer@example.com',
    'Eircode: unknown', 'Eircode: not K67 X123', 'Eircode: K67 X12', 'Eircode: K67 B123',
    'Eircode: K67 X123 or D02 X285', 'Eircode: D6V F4E2', 'Address: call me',
    'Address: <img src=x onerror=alert(1)>', 'Address: https://example.com/K67X123',
    'Address: ' + 'x'.repeat(301), 'Address: 12 ' + 'x'.repeat(295) + '\nEircode: K67 X123', 'Address: 12 Main St\n' + 'x'.repeat(10000)
  ]) assert.equal(A.fromNotes(notes).value, null, String(notes).slice(0, 80));
});
test('new lead form answers fill an address and still retain the original answer in notes', () => {
  const lead = mapLead({ leadId: 'ADDR00001', fields: { full_name: 'Test Customer', eircode: 'k67x123', home_address: '12 Main Street, Swords' } });
  assert.equal(lead.address, '12 Main Street, Swords, K67 X123');
  assert.match(buildNote(lead, '11 Oct 2026'), /Eircode \/ postcode: k67x123/);
  assert.match(buildNote(lead, '11 Oct 2026'), /Home address: 12 Main Street, Swords/);
  assert.equal(mapLead({ leadId: 'ADDR00002', fields: { eircode: 'K67 X123', old_eircode: 'D02 X285' } }).address, null);
  const old = mapLead({ leadId: 'ADDR00003', fields: { old_eircode: 'D02 X285' } });
  assert.match(buildNote(old, '11 Oct 2026'), /Old eircode: D02 X285/);
  assert.equal(A.fromNotes(buildNote(old, '11 Oct 2026')).value, null);
});
