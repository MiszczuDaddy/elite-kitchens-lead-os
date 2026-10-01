// Turn whatever Make/Meta sends for a lead into one normalised shape. Matching is by (loosely normalised) field name, so a NEW
// lead form with standard Meta fields or custom questions works with no code change; anything unrecognised is kept verbatim in Notes.
const CONTROL = /[\u0000-\u001f\u007f​-‏‪-‮⁠﻿]/g;
const clean = (v, max = 300) => String(v == null ? '' : v).replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

const RESERVED = new Set(['leadid', 'lead_id', 'leadgen_id', 'formid', 'form_id', 'formname', 'form_name', 'createdtime', 'created_time',
  'adid', 'ad_id', 'adname', 'ad_name', 'campaignname', 'campaign_name', 'campaignid', 'campaign_id', 'adsetid', 'adset_id', 'adsetname', 'adset_name',
  'platform', 'isorganic', 'is_organic', 'pageid', 'page_id', 'fields', 'field_data', 'id']);
const INTERNAL_EXTRAS = new Set(['is_organic', 'platform', 'created_time', 'id', 'form_id', 'ad_id', 'adset_id', 'campaign_id', 'page_id']);

const normKey = (k) => String(k).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const tokens = (k) => k.split('_').filter(Boolean);
const has = (k, ...parts) => parts.some((p) => k.includes(p));
const prettyLabel = (k) => clean(String(k).replace(/_+/g, ' '), 80).replace(/^./, (c) => c.toUpperCase());

// "john" / "JOHN" -> "John"; mixed case ("McDonald", "Seán") is left exactly as typed.
function tidyCase(s) {
  if (!s || !/\p{L}/u.test(s)) return s;
  if (s !== s.toLowerCase() && s !== s.toUpperCase()) return s;
  return s.toLowerCase().replace(/(^|[\s'’.\-])(\p{L})/gu, (_m, p, c) => p + c.toUpperCase());
}

// First name for the WhatsApp template: sanitised, never a URL/number/email, "there" when nothing usable.
function firstNameFor(first, full) {
  const fullClean = clean(full, 100);
  if (/@|https?:|www\./i.test(clean(first, 100) + ' ' + fullClean)) return 'there';     // a name field that contains a link/email: don't greet it
  const raw = clean(first || fullClean.split(' ')[0] || '', 60);
  if (!raw || /\d/.test(raw)) return 'there';
  const name = raw.replace(/[^\p{L}\p{M}'’.\-]/gu, '').replace(/^[.'’\-]+|[.'’\-]+$/g, '').slice(0, 30);
  if ((name.match(/\p{L}/gu) || []).length < 2) return 'there';
  return tidyCase(name);
}

function deriveProjectType(text) {
  const t = String(text || '').toLowerCase();
  const k = /kitchen/.test(t), w = /wardrobe|bedroom|fitted/.test(t);
  if (k && w) return 'Kitchen & wardrobes';
  if (k) return 'Kitchen';
  if (w) return 'Wardrobes';
  return null;
}

// Accepts: {fields: {...}} | {fields: [{name, values}]} | {field_data: [...]} | flat top-level answers. Returns [{key, label, value}].
function entriesOf(body) {
  const out = [];
  const add = (name, val) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) return;
    const value = clean(Array.isArray(val) ? val.filter((x) => x != null && typeof x !== 'object').join(', ') : val, 600);
    const key = normKey(name);
    if (key && value) out.push({ key, label: clean(name, 80), value });
  };
  for (const src of [body.fields, body.field_data]) {
    if (Array.isArray(src)) src.forEach((f) => f && add(f.name || f.key || f.label, f.values != null ? f.values : f.value));
    else if (src && typeof src === 'object') Object.entries(src).forEach(([k, v]) => add(k, v));
  }
  for (const [k, v] of Object.entries(body)) if (!RESERVED.has(normKey(k)) && !RESERVED.has(String(k).toLowerCase())) add(k, v);
  return out;
}

function mapLead(body) {
  const leadId = clean(body.leadId || body.lead_id || body.leadgen_id || body.id, 80);
  if (!/^[A-Za-z0-9_-]{5,64}$/.test(leadId)) return { error: 'leadId (the Meta lead id) is required: 5-64 letters, digits, - or _' };
  const lead = {
    leadId, formId: clean(body.formId || body.form_id, 40) || null, formName: clean(body.formName || body.form_name, 150) || null,
    adName: clean(body.adName || body.ad_name, 150) || null, createdTime: clean(body.createdTime || body.created_time, 40) || null,
    platform: clean(body.platform, 20) || null,
    first: null, last: null, full: null, emails: [], phones: [], locations: {}, budget: null, requirements: [], projectTypes: [], extras: [],
  };
  for (const e of entriesOf(body)) {
    const { key, value } = e, t = tokens(key);
    if (has(key, 'email', 'e_mail')) { if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) lead.emails.push(value.slice(0, 200)); else lead.extras.push(e); continue; }
    if (t.some((x) => ['phone', 'mobile', 'whatsapp', 'telephone', 'tel', 'cell'].includes(x))) { lead.phones.push(value); continue; }
    if (t.includes('first') && t.includes('name') || ['firstname', 'forename', 'given_name'].includes(key)) { lead.first = lead.first || value; continue; }
    if (t.includes('last') && t.includes('name') || ['lastname', 'surname', 'family_name'].includes(key)) { lead.last = lead.last || value; continue; }
    if (['full_name', 'fullname', 'name', 'your_name', 'customer_name', 'contact_name'].includes(key)) { lead.full = lead.full || value; continue; }
    if (has(key, 'budget')) { lead.budget = lead.budget ? `${lead.budget}; ${value}` : value; continue; }
    if (t.some((x) => ['zip', 'post', 'postcode', 'postal', 'eircode'].includes(x))) { lead.extras.push({ ...e, label: 'Eircode / postcode' }); continue; }
    const loc = ['city', 'town', 'village', 'suburb', 'location', 'located', 'area', 'county'].find((x) => t.includes(x));
    if (loc && !has(key, 'budget')) { lead.locations[loc] = lead.locations[loc] || value; continue; }
    if (has(key, 'requirement', 'message', 'comment', 'tell_us', 'describe', 'about_your', 'additional', 'anything_else', 'question', 'details')) { lead.requirements.push(value); continue; }
    if (has(key, 'project_type', 'type_of_project', 'kind_of_project', 'service', 'interested_in', 'looking_for', 'what_type', 'what_kind', 'room_type')) { lead.projectTypes.push(value); continue; }
    if (t.includes('name') && !t.some((x) => ['company', 'business', 'form', 'ad', 'campaign', 'street', 'page'].includes(x))) { lead.full = lead.full || value; continue; }
    if (!INTERNAL_EXTRAS.has(key)) lead.extras.push(e);
  }
  const full = clean(lead.full || [lead.first, lead.last].filter(Boolean).join(' '), 100);
  lead.fullName = tidyCase(full) || null;
  lead.firstName = firstNameFor(lead.first, full);
  lead.email = lead.emails[0] || null;
  lead.location = ['city', 'town', 'village', 'suburb', 'location', 'located', 'area', 'county'].map((k) => lead.locations[k]).find(Boolean) || null;
  if (lead.location) lead.location = lead.location.slice(0, 100);
  lead.budget = lead.budget ? lead.budget.slice(0, 60) : null;
  const explicit = lead.projectTypes.join(' ');
  lead.projectType = (deriveProjectType(explicit) || (explicit && explicit.length <= 60 ? explicit : null) || deriveProjectType(lead.formName)) || null;
  return lead;
}

// The staff-readable summary appended to the customer's Notes. Everything the customer typed that has no dedicated field ends up here.
function buildNote(lead, when) {
  const lines = [`Meta lead · ${lead.formName || (lead.formId ? 'form ' + lead.formId : 'lead form')} · ${when}`, `Lead ID: ${lead.leadId}`];
  if (lead.requirements.length) lines.push('Requirements: ' + lead.requirements.join(' | ').slice(0, 800));
  if (lead.projectTypes.length && !lead.projectType) lines.push('Project: ' + lead.projectTypes.join(', '));
  if (lead.extras.length) { lines.push('Other answers:'); lead.extras.slice(0, 12).forEach((e) => lines.push(`• ${prettyLabel(e.label)}: ${e.value.slice(0, 300)}`)); }
  return lines.join('\n').slice(0, 1800);
}

module.exports = { mapLead, buildNote, firstNameFor, tidyCase, clean, deriveProjectType };
