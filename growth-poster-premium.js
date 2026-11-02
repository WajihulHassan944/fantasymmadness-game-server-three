'use strict';
// FANTASY MMADNESS premium poster renderer (genre design system).
//
// One design system, five genre looks (auto-selected from the verified contest's sport):
//   mma-ufc       cinematic octagon: arena spotlights, cage mesh, red floor glow, aggressive red/black, metallic type
//   boxing        championship: warm arena light, ring ropes, gold accents and frame, prestigious title-fight feel
//   bare-knuckle  gritty fight night: grunge texture, embers, rust/fire glow, heavy upright type
//   kickboxing    international striking: dynamic diagonal light beams, speed lines, electric blue + red
//   pro-wrestling theatrical spectacle: crossing stage spotlights, pyro bursts, confetti, purple/gold
// Two layouts per genre (flank / face-off), picked deterministically per fight, plus a seeded
// background so campaigns never look identical.
//
// Every poster: official FANTASY MMADNESS brand mark, PREDICT (red) THE FIGHT (white), the verified
// fighter names and event facts, a prominent red PLAY THIS FIGHT button, PLAY • PREDICT • COMPETE,
// and a real QR code for the fight's canonical link (decoded and checked by the studio).
//
// Fighter photos (approved originals only; see growth-fighter-artwork.js):
//   - transparent cut-outs are used as they are;
//   - photos on a plain studio background are cut out by removing ONLY the connected background
//     colour from the edges (fighter pixels are never changed);
//   - anything else is shown whole inside a frame.
// Photos are uniformly scaled, never stretched, cropped into the body, recoloured or retouched,
// and NOTHING is drawn over a fighter (text, badges and the QR code are laid out around them).
const crypto = require('crypto');
const path = require('path');

let sharpLib = null;
const sharp = () => (sharpLib ||= require('sharp'));
const F = (n) => path.join(__dirname, 'growth-assets', 'fonts', n);
const FONTS = { blackItalic: F('InterDisplay-BlackItalic.otf'), black: F('InterDisplay-Black.otf'), xbItalic: F('InterDisplay-ExtraBoldItalic.otf'), bold: F('Poppins-Bold.ttf'), reg: F('Poppins-Regular.ttf') };
const FAMILY = { blackItalic: 'Inter Display Black Italic', black: 'Inter Display Black', xbItalic: 'Inter Display ExtraBold Italic', bold: 'Poppins Bold', reg: 'Poppins' };
const BRAND = 'FANTASY MMADNESS';
const RED = '#e10600';
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const hashInt = (s) => parseInt(crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 8), 16);
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// ---- genre styles ----------------------------------------------------------------------------
const METAL = {
  silver: [['0', '#ffffff'], ['0.45', '#e9edf2'], ['0.55', '#9aa3ad'], ['0.75', '#d7dce2'], ['1', '#8d949c']],
  red: [['0', '#ff6a5c'], ['0.45', '#ff1d0d'], ['0.55', '#b00400'], ['1', '#e10600']],
  gold: [['0', '#fff6cf'], ['0.4', '#f3d27a'], ['0.55', '#b8860b'], ['0.8', '#f0cf6a'], ['1', '#9c7208']],
  steel: [['0', '#f4f1ec'], ['0.5', '#c9c2b8'], ['0.56', '#7d746a'], ['1', '#b3aa9e']],
};
const STYLES = {
  'mma-ufc': { label: 'MMA / UFC', headFont: 'blackItalic', nameFont: 'blackItalic', nameMetal: 'silver', accent: RED, accent2: '#ff3b2f', plate: '#1a0605', frame: RED, glow: '#ff1a0a' },
  boxing: { label: 'BOXING', headFont: 'black', nameFont: 'black', nameMetal: 'gold', accent: '#d4af37', accent2: '#f3d27a', plate: '#141008', frame: '#d4af37', glow: '#f2c14e', tracking: 3 },
  'bare-knuckle': { label: 'BARE-KNUCKLE', headFont: 'black', nameFont: 'black', nameMetal: 'steel', accent: '#ff5a1f', accent2: '#ffb347', plate: '#1a0c06', frame: '#b5471b', glow: '#ff6a2b', gritty: true },
  kickboxing: { label: 'KICKBOXING', headFont: 'xbItalic', nameFont: 'xbItalic', nameMetal: 'silver', accent: '#1e90ff', accent2: '#5fc3ff', plate: '#061024', frame: '#1e90ff', glow: '#3aa0ff' },
  'pro-wrestling': { label: 'PRO WRESTLING', headFont: 'black', nameFont: 'black', nameMetal: 'gold', accent: '#a020f0', accent2: '#ffcc33', plate: '#13061c', frame: '#ffcc33', glow: '#c04dff' },
};

// ---- backgrounds (pure SVG, rendered by libvips/librsvg) ---------------------------------------
function background(sport, W, H, seed) {
  const r = rng(seed); const S = STYLES[sport];
  const defs = []; const body = [];
  const haze = (op, freq = 0.008, id = 'hz') => { defs.push(`<filter id="${id}" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="${freq}" numOctaves="3" seed="${Math.floor(r() * 999)}"/><feColorMatrix type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 ${op} 0"/></filter>`); body.push(`<rect width="${W}" height="${H}" filter="url(#${id})"/>`); };
  const spot = (cx, cy, rx, ry, color, op) => { const id = `s${body.length}`; defs.push(`<radialGradient id="${id}"><stop offset="0" stop-color="${color}" stop-opacity="${op}"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient>`); body.push(`<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="url(#${id})"/>`); };
  const beam = (x1, x2, spread, color, op, yTop = 0, yBot = H) => { const id = `b${body.length}`; defs.push(`<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity="${op}"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient>`); body.push(`<polygon points="${x1 - 14},${yTop} ${x1 + 14},${yTop} ${x2 + spread},${yBot} ${x2 - spread},${yBot}" fill="url(#${id})" filter="url(#soft)"/>`); };
  defs.push('<filter id="soft" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="18"/></filter>');
  defs.push('<filter id="softer" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="40"/></filter>');
  const base = { 'mma-ufc': ['#0a0303', '#020203'], boxing: ['#0d0a05', '#030305'], 'bare-knuckle': ['#160b06', '#050302'], kickboxing: ['#04091a', '#020206'], 'pro-wrestling': ['#14051d', '#040208'] }[sport];
  defs.push(`<linearGradient id="base" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${base[1]}"/><stop offset="0.55" stop-color="${base[0]}"/><stop offset="1" stop-color="${base[1]}"/></linearGradient>`);
  body.push(`<rect width="${W}" height="${H}" fill="url(#base)"/>`);
  if (sport === 'mma-ufc') {
    for (let i = 0; i < 6; i++) { const x = W * (0.08 + i * 0.168) + (r() - 0.5) * 30; spot(x, 26, 60, 26, '#ffffff', 0.95); spot(x, 26, 140, 70, '#ff2a1a', 0.35); }
    beam(W * 0.25, W * 0.16, 280, '#ffffff', 0.17, 20, H * 0.85); beam(W * 0.75, W * 0.84, 280, '#ffffff', 0.17, 20, H * 0.85); beam(W * 0.5, W * 0.5, 200, '#ff3b2f', 0.12, 0, H * 0.7);
    for (const sx of [0, W]) spot(sx, H * 0.45, W * 0.35, H * 0.4, '#b30000', 0.45);
    // cage mesh (chain-link) across the middle, fading out
    defs.push('<pattern id="mesh" width="44" height="44" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><path d="M0 0H44M0 0V44" stroke="#b9bec6" stroke-width="2.2" fill="none"/></pattern>');
    defs.push(`<linearGradient id="meshfade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.3" stop-color="#fff" stop-opacity="0.22"/><stop offset="0.7" stop-color="#fff" stop-opacity="0.16"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient><mask id="mm"><rect width="${W}" height="${H}" fill="url(#meshfade)"/></mask>`);
    body.push(`<rect y="${H * 0.12}" width="${W}" height="${H * 0.62}" fill="url(#mesh)" mask="url(#mm)"/>`);
    body.push(`<polyline points="0,${H * 0.2} ${W * 0.18},${H * 0.15} ${W * 0.82},${H * 0.15} ${W},${H * 0.2}" stroke="#30343a" stroke-width="10" fill="none" opacity="0.9"/>`);
    spot(W / 2, H * 0.98, W * 0.75, H * 0.22, RED, 0.75); spot(W / 2, H * 0.55, W * 0.5, H * 0.35, '#5a0000', 0.35);
    haze(0.18, 0.006);
  } else if (sport === 'boxing') {
    spot(W / 2, H * 0.08, W * 0.75, H * 0.36, '#f6d98a', 0.5); beam(W / 2, W / 2, W * 0.45, '#fff3cc', 0.2, 0, H * 0.9); beam(W * 0.15, W * 0.3, 160, '#f3d27a', 0.12, 0, H * 0.8); beam(W * 0.85, W * 0.7, 160, '#f3d27a', 0.12, 0, H * 0.8);
    for (let i = 0; i < 3; i++) { const y = H * (0.6 + i * 0.045); body.push(`<path d="M-20 ${y + 30} Q ${W / 2} ${y - 14} ${W + 20} ${y + 30}" stroke="#d4af37" stroke-opacity="${0.55 - i * 0.12}" stroke-width="${8 - i * 2}" fill="none"/><path d="M-20 ${y + 30} Q ${W / 2} ${y - 14} ${W + 20} ${y + 30}" stroke="#fff6cf" stroke-opacity="${0.35 - i * 0.08}" stroke-width="2" fill="none"/>`); }
    for (let i = 0; i < 90; i++) body.push(`<circle cx="${r() * W}" cy="${r() * H * 0.7}" r="${0.8 + r() * 2.4}" fill="#f3d27a" opacity="${0.15 + r() * 0.5}"/>`);
    spot(W / 2, H, W * 0.8, H * 0.18, '#7a5a10', 0.45);
    body.push(`<rect x="16" y="16" width="${W - 32}" height="${H - 32}" rx="6" fill="none" stroke="#d4af37" stroke-opacity="0.75" stroke-width="3"/><rect x="26" y="26" width="${W - 52}" height="${H - 52}" rx="4" fill="none" stroke="#d4af37" stroke-opacity="0.3" stroke-width="1.5"/>`);
    haze(0.12, 0.005);
  } else if (sport === 'bare-knuckle') {
    spot(W / 2, H * 1.02, W * 0.95, H * 0.42, '#ff4a12', 0.85); spot(W / 2, H * 0.6, W * 0.4, H * 0.25, '#ff7a2b', 0.18); spot(W * 0.15, H * 0.35, W * 0.4, H * 0.3, '#5c1a06', 0.6); spot(W * 0.85, H * 0.3, W * 0.4, H * 0.3, '#5c1a06', 0.6);
    for (let i = 0; i < 140; i++) { const x = r() * W; const y = H * (0.35 + r() * 0.65); body.push(`<circle cx="${x}" cy="${y}" r="${0.8 + r() * 2.6}" fill="${r() > 0.5 ? '#ffb347' : '#ff5a1f'}" opacity="${0.25 + r() * 0.7}"/>`); }
    for (let i = 0; i < 26; i++) { const x = r() * W; const y = r() * H; body.push(`<line x1="${x}" y1="${y}" x2="${x + (r() - 0.5) * 220}" y2="${y + (r() - 0.5) * 40}" stroke="#d9cfc4" stroke-opacity="${0.04 + r() * 0.08}" stroke-width="${1 + r() * 2}"/>`); }
    defs.push(`<filter id="grit" x="0" y="0" width="100%" height="100%"><feTurbulence type="turbulence" baseFrequency="0.85" numOctaves="2" seed="${Math.floor(r() * 999)}"/><feColorMatrix type="matrix" values="0 0 0 0 0.9  0 0 0 0 0.8  0 0 0 0 0.7  0 0 0 0.55 -0.12"/></filter>`);
    body.push(`<rect width="${W}" height="${H}" filter="url(#grit)" opacity="0.55"/>`);
    haze(0.16, 0.01);
  } else if (sport === 'kickboxing') {
    const lines = [['#1e90ff', 0.28], ['#e10600', 0.22], ['#5fc3ff', 0.18]];
    for (let i = 0; i < 9; i++) { const [c, o0] = lines[i % 3]; const o = o0 * 1.5; const y = H * (0.1 + r() * 0.8); const w = 30 + r() * 90; body.push(`<polygon points="${-100},${y + 260} ${W + 100},${y - 260} ${W + 100},${y - 260 + w} ${-100},${y + 260 + w}" fill="${c}" opacity="${o}" filter="url(#soft)"/>`); }
    for (let i = 0; i < 60; i++) { const y = r() * H; const x = r() * W; const l = 60 + r() * 220; body.push(`<line x1="${x}" y1="${y}" x2="${x + l}" y2="${y - l * 0.47}" stroke="#ffffff" stroke-opacity="${0.05 + r() * 0.12}" stroke-width="${1 + r() * 2}"/>`); }
    spot(W * 0.2, H * 0.15, W * 0.5, H * 0.3, '#1e90ff', 0.35); spot(W * 0.8, H * 0.9, W * 0.6, H * 0.25, RED, 0.4);
    haze(0.12, 0.007);
  } else {
    for (const [x, c] of [[0.12, '#c04dff'], [0.88, '#ff3db8'], [0.35, '#ffcc33'], [0.65, '#c04dff']]) beam(W * x, W * (1 - x), 240, c, 0.34, 0, H * 0.95);
    for (let i = 0; i < 9; i++) spot(W * (0.06 + i * 0.11), 20, 34, 18, '#fff2c4', 0.95);
    for (const cx of [0.08, 0.92]) for (let k = 0; k < 18; k++) { const a = (k / 18) * Math.PI * 2; const L = 120 + r() * 160; body.push(`<line x1="${W * cx}" y1="${H * 0.97}" x2="${W * cx + Math.cos(a) * L}" y2="${H * 0.97 + Math.sin(a) * L}" stroke="#ffcc33" stroke-opacity="${0.25 + r() * 0.35}" stroke-width="${2 + r() * 3}"/>`); }
    for (let i = 0; i < 110; i++) body.push(`<rect x="${r() * W}" y="${r() * H}" width="${4 + r() * 8}" height="${2 + r() * 4}" fill="${['#ffcc33', '#ff3db8', '#c04dff', '#ffffff'][i % 4]}" opacity="${0.25 + r() * 0.6}" transform="rotate(${r() * 180})"/>`);
    spot(W / 2, H * 0.98, W * 0.8, H * 0.2, '#a020f0', 0.6);
    haze(0.14, 0.007);
  }
  // vignette
  defs.push('<radialGradient id="vig" cx="0.5" cy="0.45" r="0.75"><stop offset="0.55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.85"/></radialGradient>');
  body.push(`<rect width="${W}" height="${H}" fill="url(#vig)"/>`);
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs>${defs.join('')}</defs>${body.join('')}</svg>`);
}

// ---- display typography: metallic fill + outline + drop shadow (font files bundled) ---------------
async function textMask(text, { font, size, width, spacing = 0, align = 'centre' }) {
  const buf = await sharp()({ text: { text: `<span foreground="#ffffff" letter_spacing="${Math.round(spacing * 1024)}">${esc(text)}</span>`, font: `${FAMILY[font]} ${size}`, fontfile: FONTS[font], width, align, rgba: true, dpi: 72, wrap: 'word' } }).png().toBuffer();
  const m = await sharp()(buf).metadata(); return { buffer: buf, width: m.width, height: m.height };
}
async function fitMask(text, { width, max, min, lines = 1, step = 4, ...o }) {
  for (let size = max; size >= min; size -= step) {
    const t = await textMask(text, { width, size, ...o });
    if (t.width <= width && t.height <= Math.ceil(size * 1.32 * lines)) return { ...t, size };
  }
  return { ...(await textMask(text, { width, size: min, ...o })), size: min };
}
const gradientSvg = (w, h, stops, dir = 'v') => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="${dir === 'v' ? 0 : 1}" y2="${dir === 'v' ? 1 : 0}">${stops.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join('')}</linearGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/></svg>`);
// Alpha-only effects computed on a raw single-channel buffer (no colour-space ambiguity).
async function alphaOf(png, padPx = 0) {
  const { data, info } = await sharp()(png).extend({ top: padPx, bottom: padPx, left: padPx, right: padPx, background: { r: 0, g: 0, b: 0, alpha: 0 } }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const a = Buffer.alloc(info.width * info.height); for (let i = 0; i < a.length; i++) a[i] = data[i * info.channels + 3];
  return { a, width: info.width, height: info.height };
}
async function blurAlpha({ a, width, height }, sigma) {
  if (!sigma) return a;
  const { data, info } = await sharp()(a, { raw: { width, height, channels: 1 } }).blur(sigma).raw().toBuffer({ resolveWithObject: true });
  if (info.channels === 1) return data;
  const o = Buffer.alloc(width * height); for (let i = 0; i < o.length; i++) o[i] = data[i * info.channels]; return o;
}
async function colourLayer(alpha, width, height, color, opacity = 1, threshold = 0) {
  const out = Buffer.alloc(width * height * 4); const c = color.replace('#', ''); const rgb = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16));
  for (let i = 0; i < width * height; i++) { let v = alpha[i]; if (threshold) v = v > threshold ? 255 : 0; out[i * 4] = rgb[0]; out[i * 4 + 1] = rgb[1]; out[i * 4 + 2] = rgb[2]; out[i * 4 + 3] = Math.round(v * opacity); }
  return sharp()(out, { raw: { width, height, channels: 4 } }).png().toBuffer();
}
async function alphaLayer(mask, pad, { blur = 0, threshold = 0, color = '#000', opacity = 1 }) {
  const src = await alphaOf(mask.buffer, pad);
  return colourLayer(await blurAlpha(src, blur), src.width, src.height, color, opacity, threshold);
}
// Returns a composited PNG of styled text (with padding) and its glyph box inside it.
async function styledText(mask, { metal = 'silver', outline = '#000000', outlineW = 4, shadow = 0.75, glow = null, pad = 26 }) {
  const W = mask.width + pad * 2 + 8; const H = mask.height + pad * 2 + 8;
  const fill = await sharp()(gradientSvg(mask.width, mask.height, METAL[metal] || METAL.silver)).composite([{ input: mask.buffer, blend: 'dest-in' }]).png().toBuffer();
  const layers = [];
  if (glow) layers.push({ input: await alphaLayer(mask, pad, { blur: 16, color: glow, opacity: 0.85 }), top: 0, left: 0 });
  if (shadow) layers.push({ input: await alphaLayer(mask, pad, { blur: 7, color: '#000000', opacity: shadow }), top: 6, left: 4 });
  if (outlineW) layers.push({ input: await alphaLayer(mask, pad, { blur: outlineW / 2, threshold: 8, color: outline }), top: 0, left: 0 });
  layers.push({ input: fill, top: pad, left: pad });
  const buffer = await sharp()({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(layers.map((l) => ({ ...l, top: Math.max(0, Math.min(l.top, H - 1)), left: Math.max(0, Math.min(l.left, W - 1)) }))).png().toBuffer();
  return { buffer, width: W, height: H, pad, glyph: { width: mask.width, height: mask.height } };
}
const svgBuf = (w, h, inner) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${inner}</svg>`);

// ---- fighter photos: cut-out detection (background only) or framed ----------------------------------
async function prepareFighter(f) {
  const img = sharp()(f.buffer).rotate().ensureAlpha();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info; const at = (x, y) => (y * w + x) * 4;
  const border = []; for (let x = 0; x < w; x++) border.push(at(x, 0)); for (let y = 0; y < h; y++) border.push(at(0, y), at(w - 1, y));
  for (let x = 0; x < w; x++) border.push(at(x, h - 1));
  const sides = border.slice(0, w + 2 * h); // top + left + right
  const transparentBorder = border.filter((i) => data[i + 3] < 16).length / border.length;
  let method = 'framed'; let removed = 0;
  if (transparentBorder > 0.3) method = 'cutout_transparent';
  else {
    // plain studio background? (median border colour covers >= 97% of the border)
    const med = [0, 1, 2].map((c) => sides.map((i) => data[i + c]).sort((a, b) => a - b)[sides.length >> 1]);
    const close = (i, t) => Math.abs(data[i] - med[0]) + Math.abs(data[i + 1] - med[1]) + Math.abs(data[i + 2] - med[2]) <= t;
    const uniform = sides.filter((i) => close(i, 30)).length / sides.length;
    if (uniform >= 0.97) {
      const seen = new Uint8Array(w * h); const stack = [];
      for (const i of border) { const p = i / 4; if (!seen[p] && close(i, 42)) { seen[p] = 1; stack.push(p); } } // flood only from edge pixels of the background colour
      while (stack.length) { const p = stack.pop(); const x = p % w; const y = (p / w) | 0;
        for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) if (q >= 0 && !seen[q] && close(q * 4, 42)) { seen[q] = 1; stack.push(q); } }
      let n = 0; for (let p = 0; p < w * h; p++) if (seen[p]) n++;
      removed = n / (w * h);
      if (removed > 0.08 && removed < 0.8) { for (let p = 0; p < w * h; p++) if (seen[p]) data[p * 4 + 3] = 0; method = 'cutout_background_removed'; }
    }
  }
  if (method === 'framed') return { ...f, method, removed: 0, png: await sharp()(f.buffer).rotate().png().toBuffer(), width: f.width, height: f.height, trimmed: null };
  // trim only fully transparent margins (never into the fighter)
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (data[at(x, y) + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const tw = x1 - x0 + 1; const th = y1 - y0 + 1;
  const png = await sharp()(data, { raw: { width: w, height: h, channels: 4 } }).extract({ left: x0, top: y0, width: tw, height: th }).png().toBuffer();
  return { ...f, method, removed, png, width: tw, height: th, trimmed: { left: x0, top: y0, width: tw, height: th, originalWidth: w, originalHeight: h } };
}

// ---- quality checks --------------------------------------------------------------------------------
function luminance(r, g, b) { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); }
async function regionStats(raw, info, box) {
  let s = 0, n = 0; const x0 = Math.max(0, box.left), y0 = Math.max(0, box.top), x1 = Math.min(info.width, box.left + box.width), y1 = Math.min(info.height, box.top + box.height);
  for (let y = y0; y < y1; y += 3) for (let x = x0; x < x1; x += 3) { const i = (y * info.width + x) * info.channels; s += luminance(raw[i], raw[i + 1], raw[i + 2]); n++; }
  return n ? s / n : 0;
}
const contrast = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
const overlap = (a, b) => a.left < b.left + b.width && a.left + a.width > b.left && a.top < b.top + b.height && a.top + a.height > b.top;

// ---- the poster ------------------------------------------------------------------------------------
async function renderPremium({ contest, format = 'portrait', artwork = { mode: 'text' }, logo = null, qrUrl, facts, qrImage }) {
  const story = format === 'story'; const W = 1080; const H = story ? 1920 : 1350;
  const sport = STYLES[contest.sport] ? contest.sport : 'mma-ufc'; const S = STYLES[sport];
  const seed = hashInt(`${contest.id}|${contest.fingerprint || ''}`);
  const variant = artwork.mode === 'text' ? 'typographic' : (seed % 2 === 0 ? 'flank' : 'faceoff');
  const layout = { format, width: W, height: H, mode: artwork.mode, style: sport, variant, images: [], text: [], qc: { problems: [] } };
  const L = []; // overlay layers drawn after the base (text, badges, QR) — never over a fighter
  const pad = 40; const inner = W - pad * 2;
  const put = (img, top, left, kind) => { L.push({ input: img.buffer, top: Math.round(top), left: Math.round(left) }); const box = { kind, left: Math.round(left + (img.pad || 0)), top: Math.round(top + (img.pad || 0)), width: img.glyph ? img.glyph.width : img.width, height: img.glyph ? img.glyph.height : img.height }; layout.text.push(box); return box; };
  const centerX = (w) => (W - w) / 2;
  let y = story ? 34 : 22;

  // 1. brand mark
  if (logo) {
    const lg = await sharp()(logo).resize({ width: story ? 400 : 300, height: story ? 160 : 108, fit: 'inside' }).png().toBuffer(); const lm = await sharp()(lg).metadata();
    const glowL = await sharp()({ create: { width: lm.width + 80, height: lm.height + 80, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([{ input: svgBuf(lm.width + 80, lm.height + 80, `<defs><radialGradient id="g"><stop offset="0" stop-color="${S.glow}" stop-opacity="0.55"/><stop offset="1" stop-color="${S.glow}" stop-opacity="0"/></radialGradient></defs><ellipse cx="${(lm.width + 80) / 2}" cy="${(lm.height + 80) / 2}" rx="${(lm.width + 80) / 2}" ry="${(lm.height + 80) / 2}" fill="url(#g)"/>`) }]).png().toBuffer();
    L.push({ input: glowL, top: Math.max(0, y - 40), left: Math.round(centerX(lm.width + 80)) });
    put({ buffer: lg, width: lm.width, height: lm.height }, y, centerX(lm.width), 'logo'); y += lm.height + (story ? 22 : 10); layout.logo = true;
  } else {
    const wm = await styledText(await fitMask(BRAND, { font: 'blackItalic', width: inner - 120, max: story ? 92 : 76, min: 40 }), { metal: 'silver', outlineW: 4, glow: S.glow });
    put(wm, y - wm.pad, centerX(wm.width), 'brand'); y += wm.glyph.height + (story ? 30 : 12); layout.logo = false;
  }
  // 2. PREDICT (red) / THE FIGHT (white)
  const headSize = story ? 132 : 112;
  const predict = await styledText(await fitMask('PREDICT', { font: S.headFont, width: inner, max: headSize, min: 70, spacing: S.tracking || 0 }), { metal: 'red', outline: '#2a0000', outlineW: 6, glow: '#ff1a0a', shadow: 0.9 });
  const theFight = await styledText(await fitMask('THE FIGHT', { font: S.headFont, width: inner, max: headSize, min: 70, spacing: S.tracking || 0 }), { metal: 'silver', outline: '#0b0b0b', outlineW: 6, shadow: 0.9 });
  const headInline = !story;
  if (headInline) {
    // single line on feed posters with photos: "PREDICT THE FIGHT"
    const p2 = await styledText(await fitMask('PREDICT', { font: S.headFont, width: inner * 0.46, max: 112, min: 60, spacing: S.tracking || 0 }), { metal: 'red', outline: '#2a0000', outlineW: 5, glow: '#ff1a0a', shadow: 0.9 });
    const t2 = await styledText(await fitMask('THE FIGHT', { font: S.headFont, width: inner * 0.54, max: p2.glyph.height > 0 ? 112 : 112, min: 60, spacing: S.tracking || 0 }), { metal: 'silver', outline: '#0b0b0b', outlineW: 5, shadow: 0.9 });
    const total = p2.glyph.width + 22 + t2.glyph.width; const x0 = centerX(total);
    const h2 = Math.max(p2.glyph.height, t2.glyph.height);
    put(p2, y - p2.pad + (h2 - p2.glyph.height), x0 - p2.pad, 'headline-predict'); put(t2, y - t2.pad + (h2 - t2.glyph.height), x0 + p2.glyph.width + 22 - t2.pad, 'headline-thefight');
    y += h2 + 8;
  } else {
    put(predict, y - predict.pad, centerX(predict.width), 'headline-predict'); y += predict.glyph.height + 10;
    put(theFight, y - theFight.pad, centerX(theFight.width), 'headline-thefight'); y += theFight.glyph.height + 6;
  }
  // slash accent under the headline
  L.push({ input: svgBuf(inner, 16, `<defs><linearGradient id="a" x1="0" x2="1"><stop offset="0" stop-color="${RED}" stop-opacity="0"/><stop offset="0.5" stop-color="${RED}"/><stop offset="1" stop-color="${RED}" stop-opacity="0"/></linearGradient></defs><polygon points="${inner * 0.18},10 ${inner * 0.82},2 ${inner * 0.82},6 ${inner * 0.18},14" fill="url(#a)"/>`), top: Math.round(y), left: pad }); y += 18;

  // bottom stack measured first (event badge, date, CTA + QR, tagline)
  const eventText = facts.event || S.label;
  const badgeT = await styledText(await fitMask(eventText.toUpperCase(), { font: S.nameFont, width: inner * 0.6, max: story ? 56 : 44, min: 26, spacing: 1 }), { metal: 'silver', outlineW: 3, shadow: 0.7, pad: 14 });
  const sportT = await textMask(S.label, { font: 'black', size: story ? 26 : 22, width: 400, spacing: 3 });
  const dateLine = [facts.date.replace(/, \d{4}$/, ''), facts.time].filter(Boolean).join('  •  ');
  const dateT = await styledText(await fitMask(dateLine, { font: 'black', width: inner, max: story ? 46 : 38, min: 22 }), { metal: 'silver', outlineW: 3, shadow: 0.8, pad: 12 });
  const whereLine = [facts.where, facts.detail].filter(Boolean).join('  •  ');
  const whereT = whereLine ? await fitMask(whereLine, { font: 'bold', width: inner, max: story ? 30 : 24, min: 16 }) : null;
  const qrPlate = (story ? 330 : 280); const qrInner = qrPlate - 20; // >= 4 px per module so phones can scan it
  const ctaH = story ? 118 : 96;
  const tagT = await fitMask('PLAY  •  PREDICT  •  COMPETE', { font: 'blackItalic', width: inner - 80, max: story ? 44 : 34, min: 22, spacing: 5 });
  const namesBlockH = variant === 'flank' ? (story ? 104 : 84) : 0;
  const bottomH = namesBlockH + 18 + badgeT.glyph.height + 28 + dateT.glyph.height + (whereT ? whereT.height + 8 : 0) + 22 + Math.max(qrPlate, ctaH) + 20 + tagT.height + (story ? 46 : 26);

  // 3. fighters band
  const bandTop = Math.round(y); const bandH = Math.max(story ? 520 : 400, H - bottomH - bandTop);
  layout.band = { top: bandTop, height: bandH };
  const base = await sharp()(background(sport, W, H, seed)).png().toBuffer();
  const baseLayers = [];
  if (artwork.mode !== 'text') baseLayers.push({ input: svgBuf(W, 140, `<defs><radialGradient id="fl"><stop offset="0" stop-color="${S.glow}" stop-opacity="0.55"/><stop offset="0.6" stop-color="${S.glow}" stop-opacity="0.12"/><stop offset="1" stop-color="${S.glow}" stop-opacity="0"/></radialGradient></defs><ellipse cx="${W / 2}" cy="70" rx="${W * 0.52}" ry="58" fill="url(#fl)"/><ellipse cx="${W / 2}" cy="70" rx="${W * 0.44}" ry="34" fill="none" stroke="${S.accent}" stroke-opacity="0.55" stroke-width="3"/>`), top: Math.min(H - 140, bandTop + bandH - 80), left: 0 });
  if (artwork.mode === 'fighter_photos') {
    const [A, B] = await Promise.all(artwork.fighters.map(prepareFighter));
    const vsSize = story ? 170 : 136;
    // boxes: flank = two halves with VS in the gap; faceoff = narrower boxes at the edges, names + VS in the centre column
    const centreW = variant === 'faceoff' ? Math.round(W * (story ? 0.36 : 0.38)) : vsSize + 20;
    const boxW = Math.floor((W - 2 * 16 - centreW) / 2);
    const boxes = [{ left: 16, top: bandTop, width: boxW, height: bandH }, { left: W - 16 - boxW, top: bandTop, width: boxW, height: bandH }];
    for (const [i, f] of [[0, A], [1, B]]) {
      const box = boxes[i];
      if (f.method === 'framed') {
        const fr = { left: box.left + 8, top: box.top + 8, width: box.width - 16, height: box.height - 16 };
        const scaled = await sharp()(f.png).resize({ width: fr.width - 24, height: fr.height - 24, fit: 'inside', kernel: 'lanczos3' }).toColourspace('srgb').png().toBuffer(); const sm = await sharp()(scaled).metadata();
        const px = fr.left + Math.round((fr.width - sm.width) / 2); const py = fr.top + Math.round((fr.height - sm.height) / 2);
        baseLayers.push({ input: svgBuf(sm.width + 60, sm.height + 60, `<defs><filter id="b"><feGaussianBlur stdDeviation="14"/></filter></defs><rect x="22" y="22" width="${sm.width + 16}" height="${sm.height + 16}" rx="14" fill="${S.glow}" opacity="0.55" filter="url(#b)"/><rect x="22" y="22" width="${sm.width + 16}" height="${sm.height + 16}" rx="12" fill="${S.plate}" stroke="${S.frame}" stroke-width="4"/>`), top: py - 30, left: px - 30 });
        baseLayers.push({ input: scaled, top: py, left: px });
        layout.images.push({ side: f.side, name: f.name, method: 'framed', top: py, left: px, width: sm.width, height: sm.height, sourceWidth: f.width, sourceHeight: f.height, sha256: f.sha256 });
      } else {
        const scaled = await sharp()(f.png).resize({ width: box.width, height: box.height, fit: 'inside', kernel: 'lanczos3' }).png().toBuffer(); const sm = await sharp()(scaled).metadata();
        const px = box.left + Math.round((box.width - sm.width) / 2); const py = box.top + box.height - sm.height; // standing on the floor of the band
        // rim light + floor shadow BEHIND the fighter (the photo itself is untouched)
        const ga = await alphaOf(scaled, 40);
        baseLayers.push({ input: await colourLayer(await blurAlpha(ga, 22), ga.width, ga.height, S.glow, 0.9), top: py - 40, left: px - 40 });
        baseLayers.push({ input: svgBuf(sm.width + 120, 70, `<defs><radialGradient id="f"><stop offset="0" stop-color="#000" stop-opacity="0.85"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient></defs><ellipse cx="${(sm.width + 120) / 2}" cy="35" rx="${(sm.width + 120) / 2}" ry="30" fill="url(#f)"/>`), top: Math.min(H - 70, py + sm.height - 36), left: px - 60 });
        baseLayers.push({ input: scaled, top: py, left: px });
        layout.images.push({ side: f.side, name: f.name, method: f.method, top: py, left: px, width: sm.width, height: sm.height, sourceWidth: f.width, sourceHeight: f.height, removedBackground: f.removed, trimmed: f.trimmed, sha256: f.sha256 });
      }
    }
    // VS emblem (in the gap / centre column, never over a fighter)
    const vsTop = variant === 'faceoff' ? bandTop + Math.round(bandH * 0.42) : bandTop + Math.round(bandH * 0.45) - vsSize / 2;
    layout.vs = { top: Math.round(vsTop), left: Math.round(W / 2 - vsSize / 2), size: vsSize };
    if (variant === 'faceoff') {
      // centre column: fighter A name, VS, fighter B name
      const colW = centreW - 20;
      const nA = await styledText(await fitMask(facts.fighterA.toUpperCase(), { font: S.nameFont, width: colW, max: story ? 62 : 50, min: 20, lines: 2, spacing: S.tracking ? 1 : 0 }), { metal: S.nameMetal, outlineW: 4, shadow: 0.85, pad: 14 });
      const nB = await styledText(await fitMask(facts.fighterB.toUpperCase(), { font: S.nameFont, width: colW, max: story ? 62 : 50, min: 20, lines: 2, spacing: S.tracking ? 1 : 0 }), { metal: S.nameMetal, outlineW: 4, shadow: 0.85, pad: 14 });
      const vsMask = await textMask('VS', { font: 'blackItalic', size: Math.round(vsSize * 0.62), width: vsSize * 2 });
      const vsT = await styledText(vsMask, { metal: 'red', outline: '#200000', outlineW: 5, glow: '#ff1a0a', pad: 18 });
      const colH = nA.glyph.height + vsT.glyph.height + nB.glyph.height + 36;
      let cy = bandTop + Math.round((bandH - colH) * 0.5);
      put(nA, cy - nA.pad, centerX(nA.width), 'name-a'); cy += nA.glyph.height + 18;
      layout.vs = { top: Math.round(cy), left: Math.round(W / 2 - vsT.glyph.width / 2), size: Math.max(vsT.glyph.width, vsT.glyph.height) };
      put(vsT, cy - vsT.pad, centerX(vsT.width), 'vs'); cy += vsT.glyph.height + 18;
      put(nB, cy - nB.pad, centerX(nB.width), 'name-b');
    } else {
      L.push({ input: svgBuf(vsSize, vsSize, `<defs><radialGradient id="r" cx="0.4" cy="0.35"><stop offset="0" stop-color="#ff5a4d"/><stop offset="0.6" stop-color="${RED}"/><stop offset="1" stop-color="#6a0000"/></radialGradient></defs><circle cx="${vsSize / 2}" cy="${vsSize / 2}" r="${vsSize / 2 - 4}" fill="url(#r)" stroke="#ffffff" stroke-width="5"/>`), top: layout.vs.top, left: layout.vs.left });
      const vsMask = await textMask('VS', { font: 'blackItalic', size: Math.round(vsSize * 0.46), width: vsSize });
      const vsT = await styledText(vsMask, { metal: 'silver', outlineW: 3, shadow: 0.6, pad: 10 });
      put(vsT, layout.vs.top + (vsSize - vsT.glyph.height) / 2 - vsT.pad, W / 2 - vsT.glyph.width / 2 - vsT.pad, 'vs');
    }
  } else if (artwork.mode === 'contest_artwork') {
    const fr = { left: pad, top: bandTop, width: inner, height: bandH };
    const scaled = await sharp()(artwork.contestArt.buffer).rotate().resize({ width: fr.width - 24, height: fr.height - 24, fit: 'inside', kernel: 'lanczos3' }).toColourspace('srgb').png().toBuffer(); const sm = await sharp()(scaled).metadata();
    const px = fr.left + Math.round((fr.width - sm.width) / 2); const py = fr.top + Math.round((fr.height - sm.height) / 2);
    baseLayers.push({ input: svgBuf(sm.width + 60, sm.height + 60, `<defs><filter id="b"><feGaussianBlur stdDeviation="16"/></filter></defs><rect x="22" y="22" width="${sm.width + 16}" height="${sm.height + 16}" rx="14" fill="${S.glow}" opacity="0.6" filter="url(#b)"/><rect x="22" y="22" width="${sm.width + 16}" height="${sm.height + 16}" rx="12" fill="${S.plate}" stroke="${S.frame}" stroke-width="4"/>`), top: py - 30, left: px - 30 });
    baseLayers.push({ input: scaled, top: py, left: px });
    layout.images.push({ side: 'matchup', method: 'framed', top: py, left: px, width: sm.width, height: sm.height, sourceWidth: artwork.contestArt.width, sourceHeight: artwork.contestArt.height, sha256: artwork.contestArt.sha256 });
  } else {
    // premium text-only: huge metallic names with an emblem VS, no fighter imagery
    const nmax = story ? 150 : 118;
    const nA = await styledText(await fitMask(facts.fighterA.toUpperCase(), { font: S.nameFont, width: inner - 40, max: nmax, min: 46, lines: 2, spacing: S.tracking ? 2 : 0 }), { metal: S.nameMetal, outlineW: 6, shadow: 0.9, glow: S.glow });
    const nB = await styledText(await fitMask(facts.fighterB.toUpperCase(), { font: S.nameFont, width: inner - 40, max: nmax, min: 46, lines: 2, spacing: S.tracking ? 2 : 0 }), { metal: S.nameMetal, outlineW: 6, shadow: 0.9, glow: S.glow });
    const vsSize = story ? 180 : 140;
    const totalH = nA.glyph.height + vsSize + nB.glyph.height + 40;
    let cy = bandTop + Math.max(0, Math.round((bandH - totalH) / 2));
    put(nA, cy - nA.pad, centerX(nA.width), 'name-a'); cy += nA.glyph.height + 20;
    L.push({ input: svgBuf(W, vsSize, `<defs><linearGradient id="l" x1="0" x2="1"><stop offset="0" stop-color="${S.accent}" stop-opacity="0"/><stop offset="0.5" stop-color="${S.accent}"/><stop offset="1" stop-color="${S.accent}" stop-opacity="0"/></linearGradient><radialGradient id="r" cx="0.4" cy="0.35"><stop offset="0" stop-color="#ff5a4d"/><stop offset="0.6" stop-color="${RED}"/><stop offset="1" stop-color="#6a0000"/></radialGradient></defs><rect x="0" y="${vsSize / 2 - 3}" width="${W}" height="6" fill="url(#l)"/><circle cx="${W / 2}" cy="${vsSize / 2}" r="${vsSize / 2 - 4}" fill="url(#r)" stroke="#ffffff" stroke-width="5"/>`), top: cy, left: 0 });
    layout.vs = { top: cy, left: Math.round(W / 2 - vsSize / 2), size: vsSize };
    const vsT = await styledText(await textMask('VS', { font: 'blackItalic', size: Math.round(vsSize * 0.46), width: vsSize }), { metal: 'silver', outlineW: 3, shadow: 0.6, pad: 10 });
    put(vsT, cy + (vsSize - vsT.glyph.height) / 2 - vsT.pad, W / 2 - vsT.glyph.width / 2 - vsT.pad, 'vs'); cy += vsSize + 20;
    put(nB, cy - nB.pad, centerX(nB.width), 'name-b');
  }
  // 4. bottom stack
  y = bandTop + bandH + 14;
  if (variant === 'flank') {
    // name plates under each fighter
    for (const [i, nm] of [[0, facts.fighterA], [1, facts.fighterB]]) {
      const box = layout.images[i]; const cw = Math.round(W / 2 - 34);
      const t = await styledText(await fitMask(nm.toUpperCase(), { font: S.nameFont, width: cw - 30, max: story ? 64 : 50, min: 20, lines: 1, spacing: S.tracking ? 1 : 0 }), { metal: S.nameMetal, outlineW: 4, shadow: 0.85, pad: 12 });
      const left = i === 0 ? 24 : W / 2 + 10;
      L.push({ input: svgBuf(cw, namesBlockH - 10, `<defs><linearGradient id="p" x1="0" x2="1"><stop offset="0" stop-color="${S.plate}" stop-opacity="${i === 0 ? 0.2 : 0.95}"/><stop offset="1" stop-color="${S.plate}" stop-opacity="${i === 0 ? 0.95 : 0.2}"/></linearGradient></defs><polygon points="18,0 ${cw},0 ${cw - 18},${namesBlockH - 10} 0,${namesBlockH - 10}" fill="url(#p)" stroke="${S.accent}" stroke-opacity="0.8" stroke-width="2"/>`), top: Math.round(y), left: Math.round(left) });
      put(t, y + (namesBlockH - 10 - t.glyph.height) / 2 - t.pad, left + (cw - t.glyph.width) / 2 - t.pad, i === 0 ? 'name-a' : 'name-b');
      void box;
    }
    y += namesBlockH;
  }
  y += 10;
  // event badge: [SPORT | EVENT]
  const sportW = sportT.width + 36; const evW = badgeT.glyph.width + 48; const bh = Math.max(badgeT.glyph.height + 20, sportT.height + 20);
  const bx = centerX(sportW + evW);
  L.push({ input: svgBuf(sportW + evW + 20, bh, `<defs><linearGradient id="m" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f4f6f8"/><stop offset="1" stop-color="#9aa3ad"/></linearGradient></defs><polygon points="14,0 ${sportW + 6},0 ${sportW - 8},${bh} 0,${bh}" fill="url(#m)"/><polygon points="${sportW + 12},0 ${sportW + evW + 20},0 ${sportW + evW + 6},${bh} ${sportW - 2},${bh}" fill="${RED}"/>`), top: Math.round(y), left: Math.round(bx) });
  L.push({ input: await sharp()(sportT.buffer).composite([{ input: gradientSvg(sportT.width, sportT.height, [['0', '#111'], ['1', '#111']]), blend: 'in' }]).png().toBuffer(), top: Math.round(y + (bh - sportT.height) / 2), left: Math.round(bx + 16) });
  layout.text.push({ kind: 'sport', left: Math.round(bx + 16), top: Math.round(y + (bh - sportT.height) / 2), width: sportT.width, height: sportT.height });
  put(badgeT, y + (bh - badgeT.glyph.height) / 2 - badgeT.pad, bx + sportW + 24 - badgeT.pad, 'event');
  y += bh + 16;
  put(dateT, y - dateT.pad, centerX(dateT.width), 'date'); y += dateT.glyph.height + 8;
  if (whereT) { L.push({ input: whereT.buffer, top: Math.round(y), left: Math.round(centerX(whereT.width)) }); layout.text.push({ kind: 'where', left: Math.round(centerX(whereT.width)), top: Math.round(y), width: whereT.width, height: whereT.height }); y += whereT.height + 8; }
  y += 14;
  // CTA + QR row
  const rowH = Math.max(qrPlate, ctaH); const qrLeft = W - pad - qrPlate; const ctaW = qrLeft - pad - 24;
  const ctaTop = y + (rowH - ctaH) / 2;
  L.push({ input: svgBuf(ctaW + 20, ctaH + 24, `<defs><linearGradient id="c" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff3b2f"/><stop offset="0.5" stop-color="${RED}"/><stop offset="1" stop-color="#8f0000"/></linearGradient><filter id="s"><feGaussianBlur stdDeviation="8"/></filter></defs><polygon points="${30},${16} ${ctaW + 10},${16} ${ctaW - 10},${ctaH + 12} ${10},${ctaH + 12}" fill="${RED}" opacity="0.65" filter="url(#s)"/><polygon points="26,6 ${ctaW + 6},6 ${ctaW - 14},${ctaH + 2} 6,${ctaH + 2}" fill="url(#c)" stroke="#ffffff" stroke-opacity="0.85" stroke-width="3"/><polygon points="30,10 ${ctaW + 1},10 ${ctaW - 4},${10 + ctaH * 0.34} 25,${10 + ctaH * 0.34}" fill="#ffffff" opacity="0.14"/>`), top: Math.round(ctaTop - 6), left: pad - 6 });
  const ctaT = await styledText(await fitMask('PLAY THIS FIGHT', { font: 'blackItalic', width: ctaW - 70, max: story ? 76 : 62, min: 28 }), { metal: 'silver', outline: '#5a0000', outlineW: 4, shadow: 0.7, pad: 12 });
  put(ctaT, ctaTop + (ctaH - ctaT.glyph.height) / 2 - ctaT.pad - 2, pad + (ctaW - ctaT.glyph.width) / 2 - ctaT.pad, 'cta');
  const urlT = await fitMask(facts.shownUrl, { font: 'reg', width: ctaW, max: story ? 24 : 19, min: 13 });
  const urlTop = ctaTop + ctaH + 10;
  if (urlTop + urlT.height < y + rowH + 16) { L.push({ input: await sharp()(urlT.buffer).composite([{ input: gradientSvg(urlT.width, urlT.height, [['0', '#f5c518'], ['1', '#f5c518']]), blend: 'in' }]).png().toBuffer(), top: Math.round(urlTop), left: Math.round(pad + (ctaW - urlT.width) / 2) }); layout.text.push({ kind: 'url', left: Math.round(pad + (ctaW - urlT.width) / 2), top: Math.round(urlTop), width: urlT.width, height: urlT.height }); }
  const qrTop = y + (rowH - qrPlate) / 2;
  L.push({ input: svgBuf(qrPlate, qrPlate, `<rect x="2" y="2" width="${qrPlate - 4}" height="${qrPlate - 4}" rx="18" fill="#ffffff" stroke="${RED}" stroke-width="5"/>`), top: Math.round(qrTop), left: qrLeft });
  const qr = await qrImage(qrUrl, qrInner);
  const qrX = qrLeft + Math.round((qrPlate - qr.px) / 2); const qrY = Math.round(qrTop + (qrPlate - qr.px) / 2);
  L.push({ input: qr.buffer, top: qrY, left: qrX });
  layout.qr = { top: qrY, left: qrX, px: qr.px, scale: qr.scale, quiet: qr.quiet, modules: qr.modules, url: qrUrl };
  y += rowH + 18;
  // tagline
  const tagC = await sharp()(tagT.buffer).composite([{ input: gradientSvg(tagT.width, tagT.height, [['0', '#ffffff'], ['1', '#d9dde2']]), blend: 'in' }]).png().toBuffer();
  L.push({ input: tagC, top: Math.round(y), left: Math.round(centerX(tagT.width)) }); layout.text.push({ kind: 'tagline', left: Math.round(centerX(tagT.width)), top: Math.round(y), width: tagT.width, height: tagT.height });
  L.push({ input: svgBuf(W, 10, `<rect width="${W}" height="10" fill="${RED}"/>`), top: H - 10, left: 0 });
  L.push({ input: svgBuf(W, 8, `<rect width="${W}" height="8" fill="${RED}"/>`), top: 0, left: 0 });

  // ---- compose: background + fighters (base), then everything else ----
  const baseImg = await sharp()(base).composite(baseLayers).png().toBuffer();
  const baseRaw = await sharp()(baseImg).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  // QC 1: nothing is drawn over a fighter; QR fully on the poster
  for (const im of layout.images) for (const t of layout.text) if (t.kind !== 'logo' && overlap(im, t)) layout.qc.problems.push(`text_over_image:${t.kind}`);
  for (const im of layout.images) if (overlap(im, { left: layout.qr.left, top: layout.qr.top, width: layout.qr.px, height: layout.qr.px })) layout.qc.problems.push('qr_over_image');
  if (layout.qr.top + layout.qr.px > H - 10 || y > H) layout.qc.problems.push('layout_overflow');
  if (qr.px > qrPlate - 8) layout.qc.problems.push('qr_larger_than_its_plate');
  if (qr.scale < 4) layout.qc.problems.push('qr_modules_too_small');
  for (const t of layout.text) if (overlap(t, { left: qrLeft, top: Math.round(qrTop), width: qrPlate, height: qrPlate })) layout.qc.problems.push(`text_over_qr:${t.kind}`);
  for (const t of layout.text) if (t.top + t.height > H - 8 || t.top < 0) layout.qc.problems.push(`text_off_poster:${t.kind}`);
  // QC 2: image proportions (uniform scale only)
  for (const im of layout.images) if (Math.abs(im.width / im.height - im.sourceWidth / im.sourceHeight) > 0.01) layout.qc.problems.push(`image_proportions:${im.name || im.side}`);
  // QC 3: legibility — small information text needs contrast against what is behind it
  for (const t of layout.text.filter((x) => ['where', 'url', 'tagline', 'sport'].includes(x.kind))) {
    const bg = await regionStats(baseRaw.data, baseRaw.info, t);
    const fg = t.kind === 'url' ? luminance(245, 197, 24) : t.kind === 'sport' ? luminance(17, 17, 17) : 1;
    const c = t.kind === 'sport' ? contrast(fg, luminance(200, 205, 212)) : contrast(fg, bg);
    t.contrast = Math.round(c * 10) / 10;
    if (c < 4.5) layout.qc.problems.push(`low_contrast:${t.kind}:${t.contrast}`);
  }
  const out = await sharp()(baseImg).composite(L.map((l) => ({ ...l, top: Math.max(0, l.top), left: Math.max(0, l.left) }))).removeAlpha().jpeg({ quality: 92, chromaSubsampling: '4:4:4' }).toBuffer();
  layout.qc.passed = layout.qc.problems.length === 0;
  return { buffer: out, layout };
}

module.exports = { renderPremium, prepareFighter, background, STYLES, METAL };
