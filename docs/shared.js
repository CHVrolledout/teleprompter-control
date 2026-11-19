// Shared rendering + position math used by both the prompter and the controller preview.
//
// Position is exchanged as an "anchor" = paragraph index + fraction through that paragraph.
// That way the controller preview stays on the same words even if its fonts wrap
// slightly differently from the iPad.

export const SPEED_K = 0.2; // lines per second per speed unit

export const linePx = (s) => s.fontSize * s.lineHeight;
export const targetVelocity = (s) => (s.playing ? s.speed * SPEED_K * linePx(s) : 0);

export function renderScript(el, text) {
  const frag = document.createDocumentFragment();
  for (const line of String(text).split(/\r?\n/)) {
    const p = document.createElement('p');
    p.textContent = line.trim() ? line : ' ';
    frag.appendChild(p);
  }
  el.replaceChildren(frag);
}

export function applyTextStyle(el, s) {
  el.style.fontSize = s.fontSize + 'px';
  el.style.lineHeight = String(s.lineHeight);
  el.style.paddingLeft = el.style.paddingRight = s.margin + '%';
  el.style.textAlign = s.align || 'left';
}

// Measure paragraph boxes (layout units, unaffected by CSS transforms).
export function measure(el) {
  const rows = [];
  for (const p of el.children) rows.push({ top: p.offsetTop, h: p.offsetHeight });
  const last = rows[rows.length - 1];
  return { rows, total: last ? last.top + last.h : 0 };
}

export function yToAnchor(m, y) {
  const r = m.rows;
  if (!r.length || y <= 0) return 0;
  let lo = 0, hi = r.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (r[mid].top <= y) lo = mid; else hi = mid - 1;
  }
  return lo + Math.min(1, (y - r[lo].top) / (r[lo].h || 1));
}

export function anchorToY(m, a) {
  const r = m.rows;
  if (!r.length) return 0;
  a = Math.max(0, a || 0);
  const i = Math.min(r.length - 1, Math.floor(a));
  return r[i].top + Math.min(1, a - i) * r[i].h;
}

/* ---------- Colours: the text always stays readable on the background ---------- */
export const MIN_CONTRAST = 7; // WCAG AAA — comfortable reading from a distance

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toHex = (c) => '#' + c.map((x) => Math.round(x).toString(16).padStart(2, '0')).join('');
function luminance(hex) {
  const [r, g, b] = rgb(hex).map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
// Black or white, whichever reads better on this background.
export const bestTextOn = (bg) => (contrast(bg, '#000000') >= contrast(bg, '#ffffff') ? '#000000' : '#ffffff');

/**
 * Effective colours for the prompter.
 * fg 'auto' → black or white. A chosen fg that's too close to the background is
 * blended towards black/white just enough to reach MIN_CONTRAST (keeping its hue).
 */
export function colorsFor(s) {
  const bg = /^#[0-9a-f]{6}$/i.test(s.bg || '') ? s.bg : '#000000';
  const extreme = bestTextOn(bg);
  let fg = extreme, adjusted = false;
  if (s.fg && s.fg !== 'auto') {
    fg = s.fg;
    if (contrast(fg, bg) < MIN_CONTRAST) {
      const a = rgb(s.fg), b = rgb(extreme);
      for (let t = 0.05; t <= 1.0001; t += 0.05) {
        fg = toHex(a.map((x, i) => x + (b[i] - x) * Math.min(1, t)));
        if (contrast(fg, bg) >= MIN_CONTRAST) break;
      }
      adjusted = true;
    }
  }
  // Eye-line arrows: yellow if it shows up, otherwise the text colour.
  const marker = contrast('#ffcc00', bg) >= 3 ? '#ffcc00' : fg;
  return { bg, fg, marker, ratio: contrast(fg, bg), adjusted };
}

// translateY for the text block so that content-y sits centred on the eye line.
export const textOffset = (s, vh, y) => (vh * s.markerPct) / 100 - linePx(s) / 2 - y;
