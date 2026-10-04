'use strict';
// Elite Kitchens Lead OS: the customer quote document (Phase 6, docs/QUOTES.md). A faithful port of the original quoting app's
// PDF (genPDF in its index.html, commit af45091): the same editorial layout, wording and rules. It reads only a frozen quote
// version's price sheet, the customer details and the business details: never the builder's answers, so it has no door, top
// box or drawer counts or per-unit prices to print. Text is always inserted as text (never as HTML).
// The PDF is made in the browser with html2pdf.js (public/vendor/html2pdf, MIT) and the fonts are served by Elite OS itself
// (public/fonts, SIL Open Font Licence). Loaded after app.js.
window.QuoteDocument = (() => {
  const LIBRARY = '/vendor/html2pdf/html2pdf.bundle.min.js';
  const LOGO = '/brand/elite-kitchens-logo.png';
  const FACES = [['Faustina', 400], ['Faustina', 500], ['Faustina', 600], ['IBM Plex Sans', 400], ['IBM Plex Sans', 500], ['IBM Plex Sans', 600]];
  const fontFile = (family, w) => `/fonts/${family === 'Faustina' ? 'faustina' : 'ibm-plex-sans'}-latin-${w}-normal.woff2`;
  const A4_WIDTH = '210mm';
  // The original's stylesheet, unchanged apart from the self-hosted fonts and the PDF padding (13mm 14mm, as its download used).
  const CSS = FACES.map(([f, w]) => `@font-face{font-family:'${f}';font-style:normal;font-weight:${w};font-display:block;src:url('${fontFile(f, w)}') format('woff2')}`).join('\n') + `
  *{box-sizing:border-box;margin:0;padding:0}
  @page{size:A4;margin:0}
  :root{ --ink:#16130F; --soft:#5C554B; --faint:#8B8377; --deep:#22302A; --brass:#9C7233; --grn:#3F6B4A; --excl:#8A3B2E; --rule:#DFDBD2; --tint:#F6F3ED; }
  html{background:#fff}
  body{font-family:'IBM Plex Sans','Segoe UI',Arial,sans-serif;font-size:11.5px;line-height:1.55;color:var(--ink);background:#fff;padding:13mm 14mm;-webkit-font-smoothing:antialiased;width:${A4_WIDTH}}
  table{border-collapse:collapse}
  .serif{font-family:'Faustina',Georgia,'Times New Roman',serif}
  .wordmark{font-family:'Faustina',Georgia,serif;font-size:27px;font-weight:600;letter-spacing:-.01em;line-height:1.05}
  .wordmark-sub{font-size:9.5px;color:var(--faint);letter-spacing:.09em;text-transform:uppercase;margin-top:4px}
  .logo{max-height:60px;max-width:200px;object-fit:contain;display:block}
  .contact{text-align:right;font-size:10.5px;line-height:1.85;color:var(--soft)}
  .rule{height:1px;background:var(--rule);margin:13px 0}
  .rule-ink{height:2px;background:var(--ink);margin:0 0 9px}
  .eyebrow{font-size:9.5px;letter-spacing:.13em;text-transform:uppercase;color:var(--faint)}
  .sec-h{font-family:'Faustina',Georgia,serif;font-size:15px;font-weight:600;letter-spacing:-.01em;margin-bottom:9px}
  .sec{margin-top:17px;page-break-inside:avoid}
  .meta td{padding:0;vertical-align:top}
  .meta .lbl{font-size:9.5px;letter-spacing:.11em;text-transform:uppercase;color:var(--faint);margin-bottom:3px}
  .meta .val{font-size:12px;font-weight:500}
  .meta .ref{font-family:'Faustina',Georgia,serif;font-size:19px;font-weight:600}
  .greet{font-size:12px;margin-bottom:5px}
  .lede{font-size:12px;line-height:1.7;color:var(--soft);max-width:148mm}
  .fact-k{font-size:11px;color:var(--faint);padding:4px 14px 4px 0;white-space:nowrap;vertical-align:top;width:34%}
  .fact-v{font-size:11px;padding:4px 0;vertical-align:top}
  .fact-note{font-size:9.5px;color:var(--faint);margin-top:2px}
  .pkgs{width:100%;border-collapse:separate;border-spacing:9px 0;table-layout:fixed;margin:0 -9px}
  .pkg{vertical-align:top;background:var(--tint);border:1px solid var(--rule);padding:13px 14px 15px}
  .pkg-name{font-family:'Faustina',Georgia,serif;font-size:14.5px;font-weight:600;margin-bottom:8px}
  .pkg-li{font-size:10.5px;color:var(--soft);line-height:1.5;padding-left:9px;position:relative;margin-bottom:2px}
  .pkg-li:before{content:"–";position:absolute;left:0;color:var(--faint)}
  .pkg-rule{height:2px;background:var(--brass);width:26px;margin:11px 0 8px}
  .pkg-price{font-family:'Faustina',Georgia,serif;font-size:25px;font-weight:600;letter-spacing:-.015em;line-height:1}
  .pkg-vat{font-size:9.5px;color:var(--faint);margin-top:3px}
  .pkg-ex{font-size:9.5px;color:var(--faint);margin-top:1px}
  .tick{font-size:10.5px;line-height:1.5;padding-left:14px;position:relative;margin-bottom:3px;color:var(--ink)}
  .tick:before{content:"✓";position:absolute;left:0;color:var(--grn);font-weight:600}
  .cross{font-size:10.5px;line-height:1.5;padding-left:14px;position:relative;margin-bottom:3px;color:var(--soft)}
  .cross:before{content:"✕";position:absolute;left:0;color:var(--excl)}
  .terms{background:var(--deep);color:#fff;padding:13px 16px}
  .terms .eyebrow{color:rgba(255,255,255,.55)}
  .terms-row{font-size:11px;line-height:1.75;color:rgba(255,255,255,.9)}
  .terms-row b{color:#fff;font-weight:600}
  .terms-valid{margin-top:5px;color:rgba(255,255,255,.65)}
  .sign{font-size:11px;line-height:1.7}
  .sign .nm{font-family:'Faustina',Georgia,serif;font-size:14px;font-weight:600}
  .soft{color:var(--soft)}
  .render-pg{page-break-before:always;text-align:center;padding-top:6mm}
  .render-pg img{max-width:100%;max-height:225mm;object-fit:contain;display:block;margin:0 auto}
  .render-note{font-size:9.5px;color:var(--faint);margin-top:12px}
  .draft-band{margin:-13mm -14mm 10mm;padding:8px 14mm;background:#f7f0dc;color:#655420;font-size:11px;letter-spacing:.06em;text-transform:uppercase;font-weight:600}
  `;

  // ---------- small DOM helpers bound to the document being built ----------
  function maker(doc) {
    return function h(tag, cls, ...kids) {
      const n = doc.createElement(tag);
      if (cls) n.className = cls;
      for (const k of kids.flat()) if (k != null && k !== false) n.append(typeof k === 'string' ? doc.createTextNode(k) : k);
      return n;
    };
  }
  const longDate = (k) => { if (!k) return ''; const [y, m, d] = k.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-IE', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }); };
  const money = (n) => '€' + Math.round(n).toLocaleString('en-IE');
  const colWidth = (count) => Math.floor(100 / count) + '%';

  // data: { ref, issueDate, validUntil, customer:{name,address,email,phone}, business:{tradingName,signatureName,phone,email,web,
  //         address,vatNumber}, sheet (the frozen price sheet), renders:[image data URLs], draft:boolean }
  function build(doc, data) {
    const h = maker(doc), s = data.sheet, d = s.document, b = data.business || {}, c = data.customer || {};
    const style = doc.createElement('style'); style.textContent = CSS;
    doc.head.replaceChildren(style);
    const meta = doc.createElement('meta'); meta.setAttribute('charset', 'utf-8'); doc.head.prepend(meta);
    doc.title = `${b.tradingName || 'Elite Kitchens'} — Quotation ${data.ref}`;
    const body = doc.body; body.replaceChildren();
    if (data.draft) body.append(h('div', 'draft-band', 'Draft · not sent · prices and dates may still change'));

    // Header: logo, then the business's contact details.
    const logo = h('img', 'logo'); logo.src = LOGO; logo.alt = b.tradingName || 'Elite Kitchens';
    const contact = h('td', 'contact');
    [b.phone, b.email, b.web, b.address, b.vatNumber ? 'VAT ' + b.vatNumber : null].filter(Boolean).forEach((t, i) => { if (i) contact.append(h('br')); contact.append(t); });
    const head = h('table'); head.style.width = '100%';
    const left = h('td'); left.style.verticalAlign = 'top'; left.append(logo);
    head.append(h('tbody', null, h('tr', null, left, contact)));
    body.append(head, h('div', 'rule'));

    // Quotation number, date, valid until.
    const cell = (label, value, cls, w) => { const td = h('td', null, h('div', 'lbl', label), h('div', cls, value)); td.style.width = w; return td; };
    const metaT = h('table', 'meta'); metaT.style.width = '100%';
    metaT.append(h('tbody', null, h('tr', null, cell('Quotation', data.ref, 'ref', '34%'), cell('Date', longDate(data.issueDate), 'val', '33%'), cell('Valid until', longDate(data.validUntil), 'val', '33%'))));
    body.append(metaT, h('div', 'rule'));

    // Prepared for, greeting, introduction.
    const first = (c.name || '').trim().split(/\s+/)[0] || 'there';
    const who = h('div', 'serif', c.name || ''); Object.assign(who.style, { fontSize: '17px', fontWeight: '600', marginBottom: '2px' });
    const eyebrow = h('div', 'eyebrow', 'Prepared for'); eyebrow.style.marginBottom = '5px';
    body.append(eyebrow, who);
    const addr = h('div', 'soft', c.address || ''); Object.assign(addr.style, c.address ? { fontSize: '11px', marginBottom: '11px' } : { marginBottom: '9px' });
    body.append(addr, h('div', 'greet', `Dear ${first},`),
      h('div', 'lede', "Thank you for the opportunity to quote for your new kitchen. Below you'll find the specification and pricing for the work as we discussed it. A detailed design is prepared on confirmation of order and receipt of deposit."));

    // Your kitchen: the specification facts, and a short description.
    const facts = h('table'); facts.style.width = '100%';
    const fb = h('tbody'); facts.append(fb);
    for (const f of d.facts) fb.append(h('tr', null, h('td', 'fact-k', f.label), h('td', 'fact-v', f.value, f.note ? h('div', 'fact-note', f.note) : null)));
    const kt = h('table'); kt.style.width = '100%';
    const k1 = h('td', null, facts); Object.assign(k1.style, { width: '48%', verticalAlign: 'top' });
    const k2 = h('td'); k2.style.width = '4%';
    const k3 = h('td', 'soft', 'Every cabinet is made to fit your room rather than assembled from stock sizes, with panels and gables finished to match the doors you choose. Hinges and runners are Blum throughout, soft-close as standard.');
    Object.assign(k3.style, { width: '48%', verticalAlign: 'top', fontSize: '11px', lineHeight: '1.65' });
    kt.append(h('tbody', null, h('tr', null, k1, k2, k3)));
    body.append(h('div', 'sec', h('div', 'rule-ink'), h('div', 'sec-h', 'Your kitchen'), kt));

    // The options: one card each, padded to the same number of lines so the prices line up.
    const many = s.options.length > 1, maxLines = Math.max(0, ...s.options.map((o) => o.lines.length));
    const cards = s.options.map((o) => {
      const td = h('td', 'pkg'); td.style.width = colWidth(s.options.length);
      const spec = h('div', 'pkg-spec');
      for (let i = 0; i < maxLines; i++) {
        const li = h('div', 'pkg-li', i < o.lines.length ? o.lines[i] : ' ');
        if (i >= o.lines.length) li.style.visibility = 'hidden';
        spec.append(li);
      }
      td.append(h('div', 'pkg-name', o.name), spec, h('div', 'pkg-rule'), h('div', 'pkg-price', money(o.incVat)), h('div', 'pkg-vat', `including VAT at ${s.vatRate}%`));
      if (d.showExVat) td.append(h('div', 'pkg-ex', `${money(o.exVatWhole)} excluding VAT`));
      return td;
    });
    const pk = h('table', 'pkgs'); pk.append(h('tbody', null, h('tr', null, ...cards)));
    body.append(h('div', 'sec', h('div', 'rule-ink'), h('div', 'sec-h', many ? 'Your options' : 'Your quotation'), pk));

    // Included: items in the kitchen kept apart from the work carried out.
    const col = (title, items, w) => { const td = h('td', null, h('div', 'eyebrow', title), ...items.map((t) => h('div', 'tick', t))); Object.assign(td.style, { width: w, verticalAlign: 'top' }); td.firstChild.style.marginBottom = '7px'; return td; };
    const it = h('table'); it.style.width = '100%';
    const row = h('tr');
    if (d.inKitchen.length) { row.append(col('In your kitchen', d.inKitchen, '49%')); const gap = h('td'); gap.style.width = '2%'; row.append(gap); }
    row.append(col('Work included', d.workIncluded, d.inKitchen.length ? '49%' : '100%'));
    it.append(h('tbody', null, row));
    body.append(h('div', 'sec', h('div', 'rule-ink'), h('div', 'sec-h', many ? 'Every option includes' : 'Included'), it));

    // Not included, and the terms.
    const nt = h('table'); nt.style.width = '100%';
    const n1 = h('td', null, h('div', 'eyebrow', 'Not included'), ...d.notIncluded.map((t) => h('div', 'cross', t)));
    Object.assign(n1.style, { width: '47%', verticalAlign: 'top', paddingRight: '14px' }); n1.firstChild.style.marginBottom = '7px';
    const terms = h('div', 'terms', h('div', 'eyebrow', 'Terms'),
      h('div', 'terms-row', h('b', null, '30%'), ' deposit to secure your installation date'),
      h('div', 'terms-row', h('b', null, '70%'), ' on completion'),
      h('div', 'terms-row', h('b', null, '6-month'), ' snagging after completion'),
      h('div', 'terms-row terms-valid', `This quotation is valid until ${longDate(data.validUntil)}.`));
    terms.firstChild.style.marginBottom = '7px';
    const n2 = h('td', null, terms); Object.assign(n2.style, { width: '53%', verticalAlign: 'top' });
    nt.append(h('tbody', null, h('tr', null, n1, n2)));
    body.append(h('div', 'sec', nt));

    // Sign-off.
    const intro = h('div', 'soft', "I'd be glad to talk anything through — changes to the spec, or how a different door style would look in your room. Just give me a call.");
    intro.style.marginBottom = '9px';
    const regards = h('div', null, 'Kind regards,'); regards.style.marginBottom = '2px';
    body.append(h('div', 'sec sign', h('div', 'rule'), intro, regards, h('div', 'nm', b.signatureName || b.tradingName || ''),
      h('div', 'soft', [b.tradingName || 'Elite Kitchens', b.phone, b.email].filter(Boolean).join(' · '))));

    // Design renders, each on its own page.
    const renders = data.renders || [];
    renders.forEach((url, i) => {
      const img = h('img'); img.src = url; img.alt = 'Design render';
      const eb = h('div', 'eyebrow', `Design render${renders.length > 1 ? ` ${i + 1} of ${renders.length}` : ''} · ${data.ref}`); eb.style.marginBottom = '10px';
      body.append(h('div', 'render-pg', eb, img, h('div', 'render-note', 'Indicative render. Final design confirmed at detailed design stage.')));
    });
    return body;
  }

  // ---------- an iframe holding the document (its styles never touch Elite OS) ----------
  function frame(host, { hidden = false } = {}) {
    const f = document.createElement('iframe');
    f.title = 'Quote document';
    f.setAttribute('aria-hidden', hidden ? 'true' : 'false');
    Object.assign(f.style, hidden ? { position: 'fixed', left: '-10000px', top: '0', width: A4_WIDTH, height: '297mm', border: '0' } : { width: A4_WIDTH, maxWidth: '100%', border: '0', background: '#fff', display: 'block' });
    f.srcdoc = '<!doctype html><html><head></head><body></body></html>';
    (host || document.body).append(f);
    return new Promise((resolve) => f.addEventListener('load', () => resolve(f), { once: true }));
  }
  async function settle(doc) {
    await Promise.all(FACES.map(([f, w]) => doc.fonts.load(`${w} 16px '${f}'`).catch(() => null)));
    await doc.fonts.ready;
    await Promise.all([...doc.images].map((i) => (i.decode ? i.decode().catch(() => null) : null)));
  }
  // Render into a visible iframe (preview) and size it to its content.
  async function show(host, data) {
    const f = await frame(host);
    build(f.contentDocument, data);
    await settle(f.contentDocument);
    f.style.height = f.contentDocument.documentElement.scrollHeight + 'px';
    return f;
  }
  function loadLibrary(win) {
    if (win.html2pdf) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = win.document.createElement('script'); s.src = LIBRARY;
      s.onload = () => resolve(); s.onerror = () => reject(new Error('The PDF tool could not be loaded. Check the connection and try again.'));
      win.document.head.append(s);
    });
  }
  // The PDF as a Blob: A4, the same settings as the original app's "Download PDF".
  async function toPdf(data, { filename } = {}) {
    const f = await frame(null, { hidden: true });
    try {
      const win = f.contentWindow;
      build(f.contentDocument, data);
      await loadLibrary(win);
      await settle(f.contentDocument);
      const made = await win.html2pdf().set({
        margin: 0, filename: filename || `EliteKitchens-${data.ref}.pdf`,
        image: { type: 'jpeg', quality: 0.98 }, html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff' },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }, pagebreak: { mode: ['css', 'legacy'] },
      }).from(f.contentDocument.body).outputPdf('blob');
      // A Blob made inside the frame belongs to the frame: copy it into this page's own Blob, which uploads and downloads normally.
      return new Blob([await made.arrayBuffer()], { type: 'application/pdf' });
    } finally { f.remove(); }
  }
  // Design renders chosen in the Send dialog: made at most 2000 px on their longest side (JPEG), so the PDF stays a sensible size.
  function readRender(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file), img = new Image();
      img.onload = () => {
        const scale = Math.min(1, 2000 / Math.max(img.naturalWidth, img.naturalHeight));
        const cv = document.createElement('canvas'); cv.width = Math.max(1, Math.round(img.naturalWidth * scale)); cv.height = Math.max(1, Math.round(img.naturalHeight * scale));
        const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height); g.drawImage(img, 0, 0, cv.width, cv.height);
        URL.revokeObjectURL(url); resolve(cv.toDataURL('image/jpeg', 0.9));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`${file.name} could not be read as an image.`)); };
      img.src = url;
    });
  }
  return { build, show, toPdf, readRender, LIBRARY };
})();
