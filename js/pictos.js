// Pictograms as inline SVG strings. Pure and importable in Node; the app inserts a string with
// svgNode() in the browser. No external files and no emoji: every picture is drawn here.
// Label text is always taken from the point's own data (`display`, `sign`, `busNumber`); this
// module never adds a fact such as a direction, distance or floor.

const INK = '#111827';
const SOFT = '#e2e8f0'; // decorative fill only, never behind text

export function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Rough glyph width in em: Hangul 1, digits 0.6, space 0.4, hyphen 0.4, other Latin 0.6. */
export function textWidthEm(s) {
  let w = 0;
  for (const ch of String(s)) {
    if (ch === ' ') w += 0.4;
    else if (ch === '-') w += 0.4;
    else if (/[0-9A-Za-z]/.test(ch)) w += 0.6;
    else w += 1;
  }
  return w;
}

/** Largest font size (SVG units) at which the widest line fits `maxWidth`, capped at `maxSize`. */
export function fitFont(lines, maxWidth, maxSize) {
  const widest = Math.max(...lines.map(textWidthEm), 0.1);
  return Math.min(maxSize, Math.floor(maxWidth / widest));
}

/** Splits at the space nearest the middle, or returns the label as one line. */
export function splitLabel(label) {
  const t = String(label).trim();
  const spaces = [];
  for (let i = 0; i < t.length; i++) if (t[i] === ' ') spaces.push(i);
  if (!spaces.length) return [t];
  const mid = t.length / 2;
  const at = spaces.reduce((best, i) => (Math.abs(i - mid) < Math.abs(best - mid) ? i : best), spaces[0]);
  return [t.slice(0, at).trim(), t.slice(at + 1).trim()];
}

/**
 * Chooses one or two lines and a font size for a label that must fit `width` x `height` units.
 * One line is used when it can be at least `minSingle` units tall; otherwise two lines.
 */
export function layoutLabel(label, { width, height, maxSingle, maxDouble, minSingle = 56 }) {
  const one = [String(label).trim()];
  const single = fitFont(one, width, maxSingle);
  if (single >= minSingle || splitLabel(label).length === 1) {
    return { lines: one, size: Math.min(single, Math.floor(height / 1.15)) };
  }
  const two = splitLabel(label);
  return { lines: two, size: Math.min(fitFont(two, width, maxDouble), Math.floor(height / (2 * 1.15))) };
}

function textBlock(layout, cx, yTop, height) {
  const { lines, size } = layout;
  const total = lines.length * size * 1.15;
  const start = yTop + (height - total) / 2 + size * 0.88;
  return lines.map((ln, i) =>
    `<text x="${cx}" y="${Math.round(start + i * size * 1.15)}" text-anchor="middle" font-weight="900" `
    + `font-size="${size}" fill="${INK}">${escapeXml(ln)}</text>`).join('');
}

function frame(inner, label) {
  return `<svg class="picto" viewBox="0 0 300 280" role="img" aria-label="${escapeXml(label)}" `
    + `xmlns="http://www.w3.org/2000/svg" focusable="false">${inner}</svg>`;
}

const stroke = (w = 6) => `stroke="${INK}" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round"`;

function busIcon(x, y, w, h) {
  const win = (i) => `<rect x="${x + 10 + i * ((w - 20) / 3)}" y="${y + 10}" width="${(w - 20) / 3 - 6}" height="${h * 0.38}" fill="#fff" ${stroke(3)}/>`;
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="${SOFT}" ${stroke(5)}/>`
    + [0, 1, 2].map(win).join('')
    + `<circle cx="${x + w * 0.25}" cy="${y + h}" r="9" fill="${INK}"/>`
    + `<circle cx="${x + w * 0.75}" cy="${y + h}" r="9" fill="${INK}"/>`;
}

/**
 * Which picture and label a route point gets. `kind` is exit, bus, busstop, building, sign or
 * generic. The label is a piece of the point's own text, or null when nothing fits.
 */
export function pictoSpec(point) {
  const display = String(point.display || '');
  if (point.kind === 'bus' && point.busNumber) return { kind: 'bus', label: point.busNumber };
  if (point.kind === 'bus') {
    const m = /^(.+?정류장)/.exec(display);
    return { kind: 'busstop', label: m ? m[1] : null };
  }
  if (point.kind === 'walk') {
    const exit = /(\d+번\s*출구)/.exec(display);
    if (exit) return { kind: 'exit', label: exit[1] };
    const bld = /(\d+동)/.exec(display);
    if (bld) return { kind: 'building', label: bld[1] };
    return { kind: 'generic', label: null };
  }
  if (point.kind === 'indoor') {
    if (point.sign) return { kind: 'sign', label: point.sign };
    const m = /(간호사 스테이션)/.exec(display);
    return { kind: 'sign', label: m ? m[1] : null };
  }
  return { kind: 'generic', label: null };
}

/** The picture-box SVG string for a spec from pictoSpec(). */
export function pictoSvg(spec) {
  const { kind, label } = spec;
  const aria = label ? `${label} 그림` : '안내 그림';
  if (kind === 'bus') {
    const size = fitFont([label], 250, 150);
    return frame(
      busIcon(95, 14, 110, 60)
      + `<rect x="20" y="96" width="260" height="170" rx="26" fill="#fff" ${stroke(8)}/>`
      + `<text x="150" y="${96 + 85 + Math.round(size * 0.36)}" text-anchor="middle" font-weight="900" `
      + `font-size="${size}" fill="${INK}">${escapeXml(label)}</text>`, `버스 ${label}번`);
  }
  if (kind === 'sign') {
    const board = `<rect x="64" y="212" width="14" height="56" fill="${SOFT}" ${stroke(5)}/>`
      + `<rect x="222" y="212" width="14" height="56" fill="${SOFT}" ${stroke(5)}/>`
      + `<rect x="16" y="14" width="268" height="204" rx="22" fill="#fff" ${stroke(8)}/>`;
    const text = label
      ? textBlock(layoutLabel(label, { width: 236, height: 168, maxSingle: 84, maxDouble: 62 }), 150, 32, 168)
      : '';
    return frame(board + text, aria);
  }
  let icon;
  if (kind === 'exit') {
    icon = `<rect x="96" y="20" width="108" height="120" rx="10" fill="${SOFT}" ${stroke()}/>`
      + `<rect x="116" y="44" width="68" height="96" fill="#fff" ${stroke(4)}/>`
      + `<polygon points="150,54 174,86 160,86 160,126 140,126 140,86 126,86" fill="${INK}"/>`;
  } else if (kind === 'building') {
    const wins = [0, 1, 2].flatMap((c) => [0, 1].map((r) =>
      `<rect x="${108 + c * 32}" y="${38 + r * 32}" width="22" height="20" fill="#fff" ${stroke(3)}/>`)).join('');
    icon = `<rect x="94" y="22" width="112" height="118" fill="${SOFT}" ${stroke()}/>${wins}`
      + `<rect x="136" y="100" width="28" height="40" fill="#fff" ${stroke(4)}/>`;
  } else if (kind === 'busstop') {
    icon = `<rect x="144" y="46" width="12" height="94" fill="${SOFT}" ${stroke(4)}/>`
      + `<circle cx="150" cy="56" r="38" fill="#fff" ${stroke(6)}/>`
      + busIcon(128, 42, 44, 26).replace(/stroke-width="5"/, 'stroke-width="3"');
  } else {
    icon = `<path d="M150 140 C 100 90 104 36 150 28 C 196 36 200 90 150 140 Z" fill="${SOFT}" ${stroke()}/>`
      + `<circle cx="150" cy="70" r="16" fill="#fff" ${stroke(4)}/>`;
  }
  const text = label
    ? textBlock(layoutLabel(label, { width: 260, height: 112, maxSingle: 84, maxDouble: 52 }), 150, 152, 112)
    : '';
  return frame(icon + text, aria);
}

/** Big circle used on the arrival screen. */
export function doneSvg() {
  return `<svg class="picto picto-done" viewBox="0 0 200 200" role="img" aria-label="완료" `
    + `xmlns="http://www.w3.org/2000/svg" focusable="false">`
    + `<circle cx="100" cy="100" r="82" fill="#fff" stroke="${INK}" stroke-width="16"/></svg>`;
}

/** Small picture for the "what to bring" screen: `idcard` or `document`. */
export function itemSvg(kind, label) {
  const aria = escapeXml(label || (kind === 'idcard' ? '신분증' : '서류'));
  if (kind === 'idcard') {
    return `<svg class="picto-item" viewBox="0 0 120 90" role="img" aria-label="${aria}" xmlns="http://www.w3.org/2000/svg" focusable="false">`
      + `<rect x="6" y="10" width="108" height="70" rx="10" fill="#fff" ${stroke(5)}/>`
      + `<circle cx="38" cy="38" r="12" fill="${SOFT}" ${stroke(4)}/>`
      + `<path d="M18 68 C 20 54 56 54 58 68" fill="${SOFT}" ${stroke(4)}/>`
      + `<line x1="70" y1="32" x2="100" y2="32" ${stroke(5)}/><line x1="70" y1="48" x2="100" y2="48" ${stroke(5)}/>`
      + `<line x1="70" y1="64" x2="92" y2="64" ${stroke(5)}/></svg>`;
  }
  return `<svg class="picto-item" viewBox="0 0 120 90" role="img" aria-label="${aria}" xmlns="http://www.w3.org/2000/svg" focusable="false">`
    + `<path d="M30 6 H78 L96 24 V84 H30 Z" fill="#fff" ${stroke(5)}/>`
    + `<path d="M78 6 V24 H96" fill="${SOFT}" ${stroke(5)}/>`
    + `<line x1="42" y1="42" x2="84" y2="42" ${stroke(5)}/><line x1="42" y1="56" x2="84" y2="56" ${stroke(5)}/>`
    + `<line x1="42" y1="70" x2="70" y2="70" ${stroke(5)}/></svg>`;
}

/** Which item picture a checklist entry gets, from its own text. */
export function itemKind(text) {
  return String(text).includes('신분증') ? 'idcard' : 'document';
}

/** Browser only: turns one of the SVG strings above into an element. */
export function svgNode(svg) {
  const holder = document.createElement('div');
  holder.innerHTML = svg;
  return holder.firstElementChild;
}
