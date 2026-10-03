// Phase 6 M1: a frozen copy of the ORIGINAL quoting app's PDF arithmetic and wording, used only as the reference in the
// calculator's parity tests. Copied from genPDF() / ratesOf() / drawerPrice() in index.html of the repository
// MiszczuDaddy/Elite-Kitchens-Quoting-app- at commit af45091 (2026-09-27). Deliberately left as it was, including its
// floating-point sums: do not "fix" anything here. Not deployed (functions/test is excluded from deploys).
//
// The original filled missing fields with fallback prices written into its code. Those are passed in here as `D`
// (made-up values in the tests), so no real price is written in this repository.

// genPDF's figures and wording for one quote in the original app's own data shape.
// ST: the original Settings (gs_price, gl_price, dr_cemux, dr_blum). D: { essPpd, premPpd, ppPpd, tppd, cemux, blum }.
// ratesOf(): a quote's frozen unit prices, falling back to Settings for quotes saved before they were frozen.
function legacyRates(q, ST, D) {
  return {
    gs: q?.rates?.gs ?? ST.gs_price,
    gl: q?.rates?.gl ?? ST.gl_price,
    cemux: q?.rates?.cemux ?? ST.dr_cemux ?? D.cemux,
    blum: q?.rates?.blum ?? ST.dr_blum ?? D.blum,
  };
}

function legacyPdf(q, ST, D) {
  const VAT = 13.5;
  const ratesOf = (x) => legacyRates(x, ST, D);
  const drawerPrice = (rates, key) => {
    if (key === 'cemux') return rates?.cemux ?? ST.dr_cemux ?? D.cemux;
    if (key === 'blum') return rates?.blum ?? ST.dr_blum ?? D.blum;
    return 0;
  };

  // ── Calculations ──
  const R = ratesOf(q);
  const wtT = q.wt?.wtOn ? (q.wt?.wtP || 0) : 0;
  const gsT = (q.glass?.sq || 0) * R.gs;
  const glT = (q.glass?.lq || 0) * R.gl;
  const glassT = gsT + glT;
  const extT = (q.extras || []).reduce((s, e) => s + e.qty * e.price, 0);
  const shared = extT + wtT + glassT;
  const DLABELS = { none: '', cemux: 'Cemux Soft-Close', blum: 'Blum Merivobox' };
  const dCount = q.drawers || 0;
  const ntb = q.topboxes || 0;

  // ── Per-package totals ──
  const essDrawerT = dCount * drawerPrice(R, q.ess?.drawer || 'none');
  const nDoors = q.doors || 0;
  const essK = nDoors * (q.ess?.ppd ?? D.essPpd) + ntb * (q.ess?.tppd ?? D.tppd) + essDrawerT;
  const ppExtTotal = (q.pp?.extras || []).reduce((s, e) => s + (e.free ? 0 : e.qty * e.price), 0);
  const premDrawerT = dCount * drawerPrice(R, q.prem?.drawer || 'none');
  const ppDrawerT = dCount * drawerPrice(R, q.pp?.drawer || 'none');
  function totalIncVAT(k, ppExt) { const ex = k + (ppExt || 0) + shared; return Math.round(ex * (1 + VAT / 100)); }

  // ── Active packages ──
  const essDesc = 'Vinyl wrap or melamine doors\nBlum soft-close hinges\nInstallation';
  const premDescFallback = 'Lacquered or solid wood doors\nBlum soft-close hinges\nProfessional installation';
  const ppDescFallback = 'Lacquered or solid wood doors\nBlum soft-close hinges\nPremium add-on systems\nProfessional installation';
  const activePkgs = [];
  if (q.ess?.on !== false) activePkgs.push({ name: 'Essential', k: essK, desc: essDesc, drawer: q.ess?.drawer || 'none', ppExt: 0, extras: [] });
  if (q.prem?.on) activePkgs.push({ name: 'Premium', k: nDoors * (q.prem?.ppd ?? D.premPpd) + ntb * (q.prem?.tppd ?? D.tppd) + premDrawerT, desc: q.prem?.desc || premDescFallback, drawer: q.prem?.drawer || 'none', ppExt: 0, extras: [] });
  if (q.pp?.on) activePkgs.push({ name: 'Premium Plus', k: nDoors * (q.pp?.ppd ?? D.ppPpd) + ntb * (q.pp?.tppd ?? D.tppd) + ppDrawerT, desc: q.pp?.desc || ppDescFallback, drawer: q.pp?.drawer || 'none', ppExt: ppExtTotal, extras: (q.pp?.extras || []).filter((e) => e.name) });
  if (!activePkgs.length) return null;   // the original refused: "Please select at least one package"

  const descLines = (d) => (d || '').split('\n').map((s) => s.trim()).filter(Boolean);

  // ── Specification facts ── (the original wrote '&amp;' in HTML; plain text here)
  const facts = [];
  facts.push({ label: 'Hinges & runners', value: 'Blum soft-close throughout' });
  facts.push({ label: 'Panels & gables', value: 'Finished to match your door colour' });
  facts.push({ label: 'Handles', value: 'From our standard range' });
  if (wtT > 0) facts.push({ label: 'Worktops', value: 'Supplied and fitted', note: 'Laminate worktops are not covered against water damage.' });

  // ── Package cards ── (the original escaped each line for HTML; unescaped here)
  const specs = activePkgs.map((p) => {
    const out = [];
    descLines(p.desc).slice(0, 4).forEach((l) => out.push(l));
    const drawerLbl = DLABELS[p.drawer] || '';
    if (drawerLbl && dCount > 0 && !out.some((l) => l.toLowerCase().includes(drawerLbl.toLowerCase()))) out.push(drawerLbl + ' drawer boxes');
    p.extras.filter((e) => e.free).forEach((e) => out.push(e.name));
    p.extras.filter((e) => !e.free && e.qty > 0).forEach((e) => out.push(e.name + (e.qty > 1 ? ' ×' + e.qty : '')));
    return out;
  });

  // ── What's included ──
  const inclKitchen = [];
  if (q.incl?.sink) inclKitchen.push('Sink');
  if (q.incl?.extractor) inclKitchen.push('Extractor');
  if (wtT > 0) inclKitchen.push('Worktops');
  const gsQty = q.glass?.sq || 0, glQty = q.glass?.lq || 0;
  if (gsQty > 0) inclKitchen.push(gsQty + ' small glazed door cabinet' + (gsQty > 1 ? 's' : ''));
  if (glQty > 0) inclKitchen.push(glQty + ' large glazed larder door' + (glQty > 1 ? 's' : ''));
  (q.extras || []).filter((e) => e.name).forEach((e) => inclKitchen.push(e.name + ((e.qty > 1) ? ' ×' + e.qty : '')));
  const inclWork = ['Kitchen cabinetry — supply and installation'];
  if (q.incl?.removal) inclWork.push('Removal of your existing kitchen');
  if (q.incl?.electrical) inclWork.push('Electrical work');
  if (q.incl?.plumbing) inclWork.push('Plumbing');
  const excl = ['Appliances'];
  if (!q.incl?.electrical) excl.push('Electrical work');
  if (!q.incl?.plumbing) excl.push('Plumbing');
  excl.push('Gas disconnection and reconnection — arranged by you with a registered RGI installer');
  excl.push('Tiling & flooring');
  excl.push('Painting and decorating — best done once the kitchen is fitted');
  excl.push('Skip and waste removal — arranged by you');

  return {
    options: activePkgs.map((p, i) => ({
      name: p.name,
      incVat: totalIncVAT(p.k, p.ppExt),
      exVatWhole: Math.round(p.k + (p.ppExt || 0) + shared),    // the "excluding VAT" figure the PDF prints
      exFloat: p.k + (p.ppExt || 0) + shared,                   // the unrounded sum, to recognise floating-point near-misses
      lines: specs[i],
    })),
    facts, inKitchen: inclKitchen, workIncluded: inclWork, notIncluded: excl, showExVat: q.showExVat || false,
  };
}

// The same quote as answers for the Elite OS calculator, with the original's fallbacks applied the same way.
function legacyToAnswers(q, D) {
  const opt = (o, on, ppd, extra) => ({ on, perDoor: o?.ppd ?? ppd, perTopBox: o?.tppd ?? D.tppd, drawerBox: o?.drawer || 'none', ...extra });
  return {
    doors: q.doors || 0,
    topBoxes: q.topboxes || 0,
    drawers: q.drawers || 0,
    options: {
      ess: opt(q.ess, q.ess?.on !== false, D.essPpd),
      prem: opt(q.prem, !!q.prem?.on, D.premPpd, { description: q.prem?.desc || '' }),
      pp: opt(q.pp, !!q.pp?.on, D.ppPpd, { description: q.pp?.desc || '',
        extras: (q.pp?.extras || []).map((e) => (e.free ? { name: e.name, unit: e.unit || '', free: true } : { name: e.name, unit: e.unit || '', qty: e.qty, unitPrice: e.price, free: false })) }),
    },
    worktop: { on: !!q.wt?.wtOn, price: q.wt?.wtOn ? (q.wt?.wtP || 0) : 0 },
    glazing: { small: q.glass?.sq || 0, large: q.glass?.lq || 0 },
    extras: (q.extras || []).map((e) => ({ name: e.name, unit: e.unit || '', qty: e.qty, unitPrice: e.price })),
    includes: { sink: !!q.incl?.sink, extractor: !!q.incl?.extractor, removal: !!q.incl?.removal, electrical: !!q.incl?.electrical, plumbing: !!q.incl?.plumbing },
    showExVat: !!q.showExVat,
  };
}

// The price list the Elite OS calculator needs for that quote: the original's frozen rates (or its Settings fallback).
function legacyPriceList(rates, D) {
  return {
    options: { ess: { perDoor: D.essPpd, perTopBox: D.tppd }, prem: { perDoor: D.premPpd, perTopBox: D.tppd }, pp: { perDoor: D.ppPpd, perTopBox: D.tppd } },
    drawerBoxes: { cemux: rates.cemux, blum: rates.blum },
    glazing: { small: rates.gs, large: rates.gl },
    extras: [],
  };
}

module.exports = { legacyRates, legacyPdf, legacyToAnswers, legacyPriceList };
