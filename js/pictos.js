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
 * generic, or one of the indoor kinds consult, pay, blood, xray, prescription, medicine, wait. The label is a piece of the point's own text, or null when nothing fits.
 */
export function pictoSpec(point) {
  const display = String(point.display || '');
  if (point.kind === 'bus' && point.busNumber) return { kind: 'bus', label: point.busNumber };
  if (point.kind === 'bus') {
    // The stop to get off at is the one right before "에서" ("A 정류장 다음, B 정류장(설명)에서 내리세요").
    const m = /(\S+ 정류장)(?:\([^)]*\))?에서/.exec(display) || /^(.+?정류장)/.exec(display);
    return { kind: 'busstop', label: m ? m[1] : null };
  }
  if (point.kind === 'walk') {
    const exit = /(\d+번\s*출구)/.exec(display);
    if (exit) return { kind: 'exit', label: exit[1] };
    const bld = /(\d+동)/.exec(display);
    if (bld) return { kind: 'building', label: bld[1] };
    const station = /([가-힣]+역)에/.exec(display);
    if (station) return { kind: 'building', label: station[1] };
    return { kind: 'generic', label: null };
  }
  if (point.kind === 'indoor') {
    if (point.sign) return { kind: 'sign', label: point.sign };
    // Chosen by the point's own data, never by its id: waiting, then the words of its sentence,
    // then its facility number. The label is always a piece of the sentence itself.
    const find = (re) => { const m = re.exec(display); return m ? m[1] : null; };
    if (point.wait === true) return { kind: 'wait', label: find(/(진료실)/) };
    const rx = find(/(처방전)/);
    if (rx) return { kind: 'prescription', label: rx };
    const blood = find(/(채혈실)/);
    if (blood) return { kind: 'blood', label: blood };
    const xray = find(/(영상의학과)/);
    if (xray) return { kind: 'xray', label: xray };
    const med = find(/(약국)/);
    if (med) return { kind: 'medicine', label: med };
    const pay = find(/(원무 수납)/);
    if (pay) return { kind: 'pay', label: pay };
    const consult = find(/(진료실)/);
    if (consult) return { kind: 'consult', label: consult };
    // Reception and other desks keep the sign picture, with a place name from the sentence.
    return { kind: 'sign', label: find(/(간호사 스테이션)/) };
  }
  return { kind: 'generic', label: null };
}

// Indoor pictures: simple flat icons in the 300x280 picture frame, drawn in the top 150 units
// (the label goes below, like the exit and building pictures). They show no text of their own.
const WHITE_LINE = (w) => `stroke="#fff" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"`;
const INDOOR_ICON = {
  // stethoscope: two ear tips, a tube and the round chest piece
  consult: () => `<path d="M104 28 V68 Q104 104 150 104 Q196 104 196 68 V28" fill="none" ${stroke(8)}/>`
    + `<circle cx="104" cy="26" r="7" fill="${INK}"/><circle cx="196" cy="26" r="7" fill="${INK}"/>`
    + `<line x1="150" y1="104" x2="150" y2="116" ${stroke(8)}/>`
    + `<circle cx="150" cy="128" r="14" fill="${SOFT}" ${stroke(6)}/>`,
  // counter with a card lying on it
  pay: () => `<rect x="104" y="22" width="92" height="62" rx="9" fill="#fff" ${stroke(6)}/>`
    + `<line x1="104" y1="42" x2="196" y2="42" ${stroke(6)}/>`
    + `<line x1="116" y1="64" x2="150" y2="64" ${stroke(5)}/>`
    + `<rect x="60" y="88" width="180" height="52" rx="8" fill="${SOFT}" ${stroke(7)}/>`,
  // arm with a test tube
  blood: () => `<rect x="34" y="66" width="140" height="40" rx="20" fill="${SOFT}" ${stroke(7)}/>`
    + `<line x1="174" y1="86" x2="202" y2="86" ${stroke(6)}/>`
    + `<path d="M202 22 H238 V110 a18 18 0 0 1 -36 0 Z" fill="#fff" ${stroke(6)}/>`
    + `<path d="M202 88 H238 V110 a18 18 0 0 1 -36 0 Z" fill="${INK}"/>`,
  // chest picture: dark film with a spine and ribs
  xray: () => `<rect x="82" y="16" width="136" height="126" rx="10" fill="${INK}"/>`
    + `<line x1="150" y1="28" x2="150" y2="130" ${WHITE_LINE(6)}/>`
    + [44, 66, 88].map((y) => `<path d="M150 ${y} Q116 ${y + 2} 104 ${y + 24}" fill="none" ${WHITE_LINE(5)}/>`
      + `<path d="M150 ${y} Q184 ${y + 2} 196 ${y + 24}" fill="none" ${WHITE_LINE(5)}/>`).join(''),
  // paper with folded corner and lines
  prescription: () => `<path d="M104 18 H178 L200 40 V142 H104 Z" fill="#fff" ${stroke(6)}/>`
    + `<path d="M178 18 V40 H200" fill="${SOFT}" ${stroke(6)}/>`
    + [66, 88, 110].map((y) => `<line x1="118" y1="${y}" x2="186" y2="${y}" ${stroke(5)}/>`).join(''),
  // medicine bag with a cross
  medicine: () => `<rect x="96" y="40" width="108" height="100" rx="8" fill="${SOFT}" ${stroke(7)}/>`
    + `<rect x="96" y="22" width="108" height="22" rx="6" fill="#fff" ${stroke(6)}/>`
    + `<rect x="126" y="66" width="48" height="48" rx="6" fill="#fff" ${stroke(5)}/>`
    + `<line x1="150" y1="74" x2="150" y2="106" ${stroke(7)}/><line x1="134" y1="90" x2="166" y2="90" ${stroke(7)}/>`,
  // chair seen from the side
  wait: () => `<line x1="108" y1="24" x2="108" y2="100" ${stroke(10)}/>`
    + `<rect x="104" y="84" width="96" height="18" rx="5" fill="${SOFT}" ${stroke(6)}/>`
    + `<line x1="112" y1="102" x2="112" y2="142" ${stroke(8)}/><line x1="192" y1="102" x2="192" y2="142" ${stroke(8)}/>`,
};

export const INDOOR_KINDS = Object.keys(INDOOR_ICON);

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
  if (INDOOR_ICON[kind]) {
    icon = INDOOR_ICON[kind]();
  } else if (kind === 'exit') {
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

// ---------------------------------------------------------------- hero illustrations
// Flat pictograms for the question screens and the mobility buttons. Each is a square 200x200
// drawing with its own Korean aria-label; strokes use INK, fills use SOFT or white (same tokens as
// the pictures above). They show no text, so they add no facts.

const HERO_LABELS = {
  walker: '보행기를 쓰는 사람 그림',
  wheelchair: '휠체어를 탄 사람 그림',
  walking: '걸어 다니는 사람 그림',
  hospital: '병원 건물 그림',
  'first-visit': '처음 방문하는 사람 그림',
  reception: '접수 창구에서 직원이 돕는 그림',
};

export const HERO_KINDS = Object.keys(HERO_LABELS);

function heroFrame(inner, kind, cls) {
  return `<svg class="${cls}" viewBox="0 0 200 200" role="img" aria-label="${escapeXml(HERO_LABELS[kind])}" `
    + `xmlns="http://www.w3.org/2000/svg" focusable="false">${inner}</svg>`;
}

const head = (cx, cy, r = 16) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#fff" ${stroke(6)}/>`;
const line = (x1, y1, x2, y2, w = 8) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" ${stroke(w)}/>`;
const poly = (pts, w = 8) => `<polyline points="${pts}" fill="none" ${stroke(w)}/>`;
const ground = `<line x1="14" y1="192" x2="186" y2="192" ${stroke(5)}/>`;

function drawWalker() {
  return ground
    // person, leaning slightly toward the walker
    + head(80, 40)
    + line(82, 60, 76, 112, 12)
    + poly('76,112 84,150 80,186', 10) + poly('76,112 64,150 56,186', 10)
    + line(80, 186, 96, 186, 8) + line(56, 186, 42, 186, 8)
    + poly('82,72 112,92 132,98', 9)
    // walker frame with two wheels
    + line(128, 98, 168, 98, 9) + line(130, 98, 130, 176, 8) + line(166, 98, 166, 176, 8)
    + line(130, 140, 166, 140, 6)
    + `<circle cx="130" cy="182" r="9" fill="${SOFT}" ${stroke(5)}/>`
    + `<circle cx="166" cy="182" r="9" fill="${SOFT}" ${stroke(5)}/>`;
}

function drawWheelchair() {
  return ground
    + head(92, 36)
    + line(92, 54, 88, 108, 12)
    + poly('88,108 134,110 146,152', 10) + line(146,152, 164,152, 8)
    + poly('92,70 116,92 126,94', 8)
    // chair: backrest with push handle, seat, footrest rod
    + poly('58,56 66,56 66,114', 7) + line(66, 114, 142, 114, 7) + line(142, 114, 154, 150, 6)
    // big wheel and small front wheel
    + `<circle cx="92" cy="146" r="40" fill="none" ${stroke(8)}/>`
    + `<circle cx="92" cy="146" r="6" fill="${INK}"/>`
    + `<circle cx="166" cy="180" r="11" fill="${SOFT}" ${stroke(5)}/>`;
}

function drawWalking() {
  return ground
    + head(100, 34)
    + line(100, 54, 100, 112, 12)
    + poly('100,112 120,150 118,186', 10) + line(118, 186, 134, 186, 8)
    + poly('100,112 84,150 64,180', 10) + line(64, 180, 50, 178, 8)
    + poly('100,68 78,92 70,112', 9) + poly('100,68 124,90 132,108', 9);
}

function drawHospital() {
  const win = (x, y) => `<rect x="${x}" y="${y}" width="20" height="20" fill="#fff" ${stroke(4)}/>`;
  return ground
    + `<rect x="36" y="56" width="128" height="136" fill="${SOFT}" ${stroke(7)}/>`
    + [60, 92, 124].flatMap((x) => [74, 112].map((y) => win(x + 0, y))).join('')
    + `<rect x="84" y="150" width="32" height="42" fill="#fff" ${stroke(5)}/>`
    // plus sign on the roof
    + `<rect x="78" y="14" width="44" height="40" rx="6" fill="#fff" ${stroke(6)}/>`
    + line(100, 20, 100, 48, 9) + line(86, 34, 114, 34, 9);
}

function drawFirstVisit() {
  return ground
    + head(78, 70, 20)
    + `<path d="M40 192 C 40 128 116 128 116 192 Z" fill="${SOFT}" ${stroke(7)}/>`
    // question bubble
    + `<path d="M104 28 H176 Q188 28 188 40 V84 Q188 96 176 96 H138 L120 116 L124 96 H104 Q92 96 92 84 V40 Q92 28 104 28 Z" fill="#fff" ${stroke(6)}/>`
    + `<text x="140" y="82" text-anchor="middle" font-weight="900" font-size="56" fill="${INK}">?</text>`;
}

function drawReception() {
  return ground
    // window frame and the staff member behind the counter
    + `<rect x="24" y="22" width="152" height="118" rx="12" fill="#fff" ${stroke(7)}/>`
    + head(100, 62, 18)
    + `<path d="M62 140 C 62 96 138 96 138 140 Z" fill="${SOFT}" ${stroke(6)}/>`
    // counter and a paper handed across
    + `<rect x="14" y="140" width="172" height="52" rx="6" fill="${SOFT}" ${stroke(7)}/>`
    + `<rect x="120" y="124" width="40" height="26" fill="#fff" ${stroke(5)}/>`
    + line(128, 134, 152, 134, 4) + line(128, 142, 146, 142, 4);
}

const HERO_DRAW = {
  walker: drawWalker, wheelchair: drawWheelchair, walking: drawWalking,
  hospital: drawHospital, 'first-visit': drawFirstVisit, reception: drawReception,
};

/** Inline SVG string of one illustration. `kind` is one of HERO_KINDS; `cls` is the CSS class. */
export function heroSvg(kind, cls = 'hero-svg') {
  const draw = HERO_DRAW[kind];
  if (!draw) throw new Error(`unknown hero kind: ${kind}`);
  return heroFrame(draw(), kind, cls);
}

export const walkerSvg = (cls) => heroSvg('walker', cls);
export const wheelchairSvg = (cls) => heroSvg('wheelchair', cls);
export const walkingSvg = (cls) => heroSvg('walking', cls);
export const hospitalSvg = (cls) => heroSvg('hospital', cls);
export const firstVisitSvg = (cls) => heroSvg('first-visit', cls);
export const receptionSvg = (cls) => heroSvg('reception', cls);

/** Hero illustrations shown above the choices of each question step, in display order. */
export const HERO_BY_STEP = {
  hospital: ['hospital'],
  visit: ['first-visit'],
  mobility: ['walker', 'wheelchair'],
  reception: ['reception'],
};

/** Small icon at the left of each mobility answer button, by answer value. */
export const MOBILITY_ICON = { walker: 'walker', wheelchair: 'wheelchair', none: 'walking' };

/** Browser only: turns one of the SVG strings above into an element. */
export function svgNode(svg) {
  const holder = document.createElement('div');
  holder.innerHTML = svg;
  return holder.firstElementChild;
}
