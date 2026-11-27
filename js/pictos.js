// Pictograms as inline SVG strings. Pure and importable in Node; the app inserts a string with
// svgNode() in the browser. The flat pictures are drawn here; the 3D ones are <image> tags pointing at img/icons/. No emoji.
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
    return { kind: 'sign', label: find(/(간호사 스테이션)/) || find(/^(\S+)에서 접수/) };
  }
  return { kind: 'generic', label: null };
}

// Indoor pictures: 3D icons (400x400 transparent WebP in img/icons/) placed in the top 144 units of
// the 300x280 picture frame; the label goes below, like the exit and building pictures. The image
// shows no text of its own. The kind-to-file table is explicit on purpose.
const INDOOR_FILE = {
  consult: 'place-consult',
  pay: 'place-pay',
  blood: 'place-blood',
  xray: 'place-xray',
  prescription: 'place-prescription',
  medicine: 'place-medicine',
  wait: 'place-wait',
};

export const INDOOR_KINDS = Object.keys(INDOOR_FILE);

// Square, centred horizontally (80..220), 4..144 vertically: clear of the label block that starts at y=152.
const indoorImage = (name) => `<image href="img/icons/${name}.webp" x="80" y="4" width="140" height="140" `
  + 'preserveAspectRatio="xMidYMid meet"/>';

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
  if (INDOOR_FILE[kind]) {
    icon = indoorImage(INDOOR_FILE[kind]);
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

/** Big picture used on the arrival screen (3D "done" mark inside the 200x200 frame). */
export function doneSvg() {
  return svgFrame(iconImage('mark-done'), '완료', 'picto picto-done');
}

/** Small picture for the "what to bring" screen: `idcard` or `document`. */
export function itemSvg(kind, label) {
  const aria = escapeXml(label || (kind === 'idcard' ? '신분증' : '서류'));
  const file = kind === 'idcard' ? 'mark-idcard' : 'mark-document';
  return `<svg class="picto-item" viewBox="0 0 120 90" role="img" aria-label="${aria}" xmlns="http://www.w3.org/2000/svg" focusable="false">`
    + `<image href="img/icons/${file}.webp" x="0" y="0" width="120" height="90" preserveAspectRatio="xMidYMid meet"/></svg>`;
}

/** Which item picture a checklist entry gets, from its own text. */
export function itemKind(text) {
  return String(text).includes('신분증') ? 'idcard' : 'document';
}

// ---------------------------------------------------------------- hero illustrations
// 3D pictures for the question screens and the mobility buttons: 400x400 transparent WebP files in
// img/icons/, shown inside the same 200x200 SVG frame the old flat drawings used (so every caller
// and CSS size rule is unchanged). Each has its own Korean aria-label and shows no text, so it adds
// no facts. Paths are relative to index.html (the app is served under a sub-path).

const HERO_LABELS = {
  walker: '보행기를 쓰는 사람 그림',
  wheelchair: '휠체어를 탄 사람 그림',
  walking: '걸어 다니는 사람 그림',
  hospital: '병원 건물 그림',
  'first-visit': '처음 방문하는 사람 그림',
  reception: '접수 창구에서 직원이 돕는 그림',
  dept: '진료과 안내를 도와주는 의사 그림',
};

export const HERO_KINDS = Object.keys(HERO_LABELS);

function svgFrame(inner, label, cls) {
  return `<svg class="${cls}" viewBox="0 0 200 200" role="img" aria-label="${escapeXml(label)}" `
    + `xmlns="http://www.w3.org/2000/svg" focusable="false">${inner}</svg>`;
}

const iconImage = (name, extra = '') => `<image href="img/icons/${name}.webp" x="0" y="0" width="200" `
  + `height="200" preserveAspectRatio="xMidYMid meet"${extra}/>`;

// The first-visit picture is cropped flat at its bottom edge: fade the lowest ~18% to transparent.
// The id is fixed on purpose: the picture is on screen at most once, and duplicates would be identical.
const FADE_BOTTOM = '<defs><linearGradient id="fv-fade-grad" x1="0" y1="0" x2="0" y2="1">'
  + '<stop offset="0.82" stop-color="#fff"/><stop offset="1" stop-color="#000"/></linearGradient>'
  + '<mask id="fv-fade-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="200" height="200">'
  + '<rect x="0" y="0" width="200" height="200" fill="url(#fv-fade-grad)"/></mask></defs>';

/** Inline SVG string of one illustration. `kind` is one of HERO_KINDS; `cls` is the CSS class. */
export function heroSvg(kind, cls = 'hero-svg') {
  if (!HERO_LABELS[kind]) throw new Error(`unknown hero kind: ${kind}`);
  const name = `hero-${kind}`;
  const inner = kind === 'first-visit' ? FADE_BOTTOM + iconImage(name, ' mask="url(#fv-fade-mask)"') : iconImage(name);
  return svgFrame(inner, HERO_LABELS[kind], cls);
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
  dept: ['dept'],
  visit: ['first-visit'],
  mobility: ['walker', 'wheelchair'],
  reception: ['reception'],
};

// Small marks used as icons (not illustrations): 400x400 WebP in img/icons/, same 200x200 frame.
const MARK_LABELS = { mic: '마이크 그림' };

export const MARK_KINDS = Object.keys(MARK_LABELS);

/** Inline SVG string of a mark icon. `kind` is one of MARK_KINDS; `cls` is the CSS class. */
export function markSvg(kind, cls = 'btn-icon') {
  if (!MARK_LABELS[kind]) throw new Error(`unknown mark kind: ${kind}`);
  return svgFrame(iconImage(`mark-${kind}`), MARK_LABELS[kind], cls);
}

/** Small icon at the left of each mobility answer button, by answer value. */
export const MOBILITY_ICON = { walker: 'walker', wheelchair: 'wheelchair', none: 'walking' };

// ---------------------------------------------------------------- visit-notes pictures
// Same 200x200 frame as the hero illustrations. They carry no text of their own and the
// screens always print a text title next to them (a picture alone is never the message).

const NOTE_LABELS = {
  note: '공책과 연필 그림',
  next: '달력 그림',
  med: '알약과 약봉지 그림',
  test: '시험관 그림',
  todo: '체크 표시가 있는 종이 그림',
  caution: '세모 느낌표 그림',
};

export const NOTE_KINDS = Object.keys(NOTE_LABELS);

/** Inline SVG string of a visit-notes picture. `kind` is one of NOTE_KINDS; `cls` is the CSS class. */
export function noteSvg(kind, cls = 'note-svg') {
  if (!NOTE_LABELS[kind]) throw new Error(`unknown note picture: ${kind}`);
  return svgFrame(iconImage(`note-${kind}`), NOTE_LABELS[kind], cls);
}

/** Browser only: turns one of the SVG strings above into an element. */
export function svgNode(svg) {
  const holder = document.createElement('div');
  holder.innerHTML = svg;
  return holder.firstElementChild;
}
