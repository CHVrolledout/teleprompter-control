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

// translateY for the text block so that content-y sits centred on the eye line.
export const textOffset = (s, vh, y) => (vh * s.markerPct) / 100 - linePx(s) / 2 - y;
