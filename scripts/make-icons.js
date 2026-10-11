#!/usr/bin/env node
'use strict';
// Makes the app icons in public/icons/ from the REAL "E" and "K" letters of the logo (public/brand/elite-kitchens-logo.png), in the Elite OS brand
// colours: the bone page colour on the accent green (--bg and --accent in public/app.css). Run it again only if the logo or the colours change; the PNGs are committed.
//   NODE_PATH="$(npm root -g)" node scripts/make-icons.js        (needs Playwright; set CHROMIUM=<path> if it has no browser of its own)
// Outputs: icon-192.png and icon-512.png (rounded square, purpose "any"), icon-maskable-512.png (full square, the letters inside the middle 80% that Android may crop to),
// favicon-32.png and favicon-48.png.
const fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const ROOT = path.join(__dirname, '..'), OUT = path.join(ROOT, 'public', 'icons');
const GREEN = '#465c45', BONE = '#f7f7f4';

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const logo = fs.readFileSync(path.join(ROOT, 'public', 'brand', 'elite-kitchens-logo.png')).toString('base64');
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const page = await browser.newPage();
  const made = await page.evaluate(async ({ logo, GREEN, BONE }) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + logo; await img.decode();
    const src = document.createElement('canvas'); src.width = img.width; src.height = img.height; const sx = src.getContext('2d'); sx.drawImage(img, 0, 0);
    const d = sx.getImageData(0, 0, src.width, src.height).data;
    const ink = (X, Y) => { const i = (Y * src.width + X) * 4; return d[i + 3] > 128 && (d[i] + d[i + 1] + d[i + 2]) / 3 < 128; };
    // the wordmark's letters: columns that have ink inside the band of the big letters; "E" is the first letter, "K" the first one after the widest gap (the space between the words)
    const BAND = [625, 830], runs = []; let start = -1;
    for (let X = 0; X < src.width; X++) {
      let has = false; for (let Y = BAND[0]; Y < BAND[1] && !has; Y++) if (ink(X, Y)) has = true;
      if (has && start < 0) start = X; if (!has && start >= 0) { runs.push([start, X - 1]); start = -1; }
    }
    let gap = 0, k = -1; for (let i = 1; i < runs.length; i++) { const g = runs[i][0] - runs[i - 1][1]; if (g > gap) { gap = g; k = i; } }
    const rows = ([X0, X1]) => { let a = 1e9, z = -1; for (let Y = BAND[0]; Y < BAND[1]; Y++) for (let X = X0; X <= X1; X++) if (ink(X, Y)) { if (Y < a) a = Y; if (Y > z) z = Y; } return [a, z]; };
    const E = runs[0], K = runs[k], eR = rows(E), kR = rows(K), top = Math.min(eR[0], kR[0]), bottom = Math.max(eR[1], kR[1]);
    // the two letters, side by side, recoloured, on one transparent canvas
    const GAP = 44, w = (E[1] - E[0] + 1) + GAP + (K[1] - K[0] + 1), h = bottom - top + 1;
    const mark = document.createElement('canvas'); mark.width = w; mark.height = h; const mx = mark.getContext('2d');
    mx.drawImage(src, E[0], top, E[1] - E[0] + 1, h, 0, 0, E[1] - E[0] + 1, h);
    mx.drawImage(src, K[0], top, K[1] - K[0] + 1, h, E[1] - E[0] + 1 + GAP, 0, K[1] - K[0] + 1, h);
    mx.globalCompositeOperation = 'source-in'; mx.fillStyle = BONE; mx.fillRect(0, 0, w, h);
    const draw = (size, { rounded, markWidth }) => {                     // markWidth is the share of the icon's width the letters take
      const c = document.createElement('canvas'); c.width = c.height = size; const x = c.getContext('2d');
      x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
      x.fillStyle = GREEN;
      if (rounded) { x.beginPath(); x.roundRect(0, 0, size, size, size * 0.2); x.fill(); } else x.fillRect(0, 0, size, size);
      const mw = size * markWidth, mh = mw * h / w;
      // draw the letters at 512 first, then scale (a small icon is a high-quality reduction of the big one)
      x.drawImage(mark, (size - mw) / 2, (size - mh) / 2, mw, mh);
      return c;
    };
    const big = (opts) => draw(512, opts);
    const scaled = (opts, size) => { const b = big(opts), c = document.createElement('canvas'); c.width = c.height = size; const x = c.getContext('2d'); x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high'; x.drawImage(b, 0, 0, size, size); return c; };
    const any = { rounded: true, markWidth: 0.66 }, maskable = { rounded: false, markWidth: 0.56 };
    const url = (c) => c.toDataURL('image/png');
    return { letters: { E, K, top, bottom }, files: { 'icon-512.png': url(big(any)), 'icon-192.png': url(scaled(any, 192)), 'icon-maskable-512.png': url(big(maskable)), 'favicon-48.png': url(scaled(any, 48)), 'favicon-32.png': url(scaled(any, 32)) } };
  }, { logo, GREEN, BONE });
  for (const [name, dataUrl] of Object.entries(made.files)) fs.writeFileSync(path.join(OUT, name), Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log('letters (source pixels):', JSON.stringify(made.letters));
  console.log('written to public/icons/:', Object.keys(made.files).join(', '));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
