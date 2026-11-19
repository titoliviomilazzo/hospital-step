// Floor schematic data: validation, lookup and layout. Pure, importable in Node (no DOM access).
// Positions are percentages of the official floor map, measured from the left and from the TOP
// (y grows downward). The layout keeps that convention: pixel y also grows downward.

import { escapeXml } from './pictos.js';

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';
const isPercent = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100;

/** Returns a list of error strings. An empty list means the floor data is valid. */
export function floorErrors(floor) {
  const errors = [];
  if (floor === null || typeof floor !== 'object' || Array.isArray(floor)) return ['floor must be an object'];
  for (const name of ['id', 'title', 'source', 'retrieved', 'note']) {
    if (!isNonEmptyString(floor[name])) errors.push(`floor.${name} is missing`);
  }
  if (!Array.isArray(floor.facilities) || floor.facilities.length === 0) {
    errors.push('floor.facilities must be a non-empty array');
  } else {
    const seen = new Set();
    floor.facilities.forEach((f, i) => {
      const tag = `facilities[${i}]`;
      if (f === null || typeof f !== 'object') {
        errors.push(`${tag} must be an object`);
        return;
      }
      if (!Number.isInteger(f.no) || f.no < 1) errors.push(`${tag}.no must be a positive integer`);
      else if (seen.has(f.no)) errors.push(`${tag}: duplicate no ${f.no}`);
      else seen.add(f.no);
      if (!isNonEmptyString(f.name)) errors.push(`${tag}.name is missing`);
      if (f.label !== undefined && !isNonEmptyString(f.label)) errors.push(`${tag}.label must be a non-empty string`);
      if (!isPercent(f.x) || !isPercent(f.y)) errors.push(`${tag}.x and .y must be numbers from 0 to 100`);
    });
  }
  if (!Array.isArray(floor.marks)) {
    errors.push('floor.marks must be an array');
  } else {
    const seen = new Set();
    floor.marks.forEach((m, i) => {
      const tag = `marks[${i}]`;
      if (m === null || typeof m !== 'object') {
        errors.push(`${tag} must be an object`);
        return;
      }
      if (!isNonEmptyString(m.id)) errors.push(`${tag}.id is missing`);
      else if (seen.has(m.id)) errors.push(`${tag}: duplicate id ${m.id}`);
      else seen.add(m.id);
      if (!isNonEmptyString(m.name)) errors.push(`${tag}.name is missing`);
      if (!isPercent(m.x) || !isPercent(m.y)) errors.push(`${tag}.x and .y must be numbers from 0 to 100`);
      // Marks are read off the map picture, never official coordinates, so they must say so.
      if (m.approx !== true) errors.push(`${tag}.approx must be true`);
    });
  }
  return errors;
}

/** Throws with the error list when the floor data is bad; returns the floor otherwise. */
export function validateFloor(floor) {
  const errors = floorErrors(floor);
  if (errors.length) throw new Error(`invalid floor: ${errors.join('; ')}`);
  return floor;
}

/** The facility with this official number, or null. */
export function facilityByNo(floor, no) {
  return (floor.facilities || []).find((f) => f.no === no) || null;
}

/** Short plain name for screens: the label when there is one, else the official name. */
export function facilityLabel(facility) {
  return facility.label || facility.name;
}

/**
 * Maps percentages to pixel positions in a box {width, height, pad = 0}. Returns
 * {width, height, facilities: [{no, x, y}], marks: [{id, x, y}]}; y grows downward.
 */
export function floorLayout(floor, box) {
  const { width, height, pad = 0 } = box;
  const innerW = width - 2 * pad;
  const innerH = height - 2 * pad;
  const at = (o) => ({ x: pad + (o.x / 100) * innerW, y: pad + (o.y / 100) * innerH });
  return {
    width,
    height,
    facilities: floor.facilities.map((f) => ({ no: f.no, ...at(f) })),
    marks: floor.marks.map((m) => ({ id: m.id, ...at(m) })),
  };
}

/** Fetches, parses and validates a floor file. Throws on failure. */
export async function loadFloor(url, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`floor request failed: ${res.status}`);
  return validateFloor(await res.json());
}

// ---------------------------------------------------------------- floor map drawing

/** Stands for the entrance mark wherever a facility number is expected. */
export const FLOOR_ENTRANCE = 'entrance';
export const FLOOR_CAPTION = '모식도예요. 실제 거리와 달라요. 출처: 분당서울대학교병원 누리집 층별안내';
export const FLOOR_SAME_PLACE = '같은 곳';
export const FLOOR_AT_ENTRANCE = '출입구 쪽';
const FLOOR_ENTRANCE_NAME = '출입구';

const INK = '#111827';
const SOFT = '#e2e8f0';
const BOX = { width: 320, height: 250, pad: 24 };
// Drawn radius of a facility circle: others, next, current (SVG units).
// Font arithmetic: the viewBox is 320 units wide and the figure is about 308 px wide on a 375 px
// phone, so 1 unit = 308 / 320 = 0.9625 px. The smallest number (other facilities) uses
// font-size 15 -> 15 * 0.9625 = 14.4 px (the minimum wanted is 14 px). Next uses 18 (17.3 px),
// current 24 (23.1 px). A two-digit number at 15 is about 18 units wide, inside the 24-unit circle.
export const FLOOR_FONT = { other: 15, next: 18, current: 24 };
const R_OTHER = 12;
const R_NEXT = 14;
const R_CURRENT = 20;
const R_DOOR = 14;

/**
 * Rescales every facility and the entrance mark so their bounding box spans the full 0..100 range
 * on both axes; the layout box then shows the cluster edge to edge (inside the box padding) instead
 * of in the middle of an empty frame. The other marks are not drawn, so they are ignored here.
 */
function fitToDrawn(floor) {
  const entrance = floor.marks.find((m) => m.id === 'entrance') || null;
  const pts = [...floor.facilities, ...(entrance ? [entrance] : [])];
  const span = (key) => {
    const vals = pts.map((p) => p[key]);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    return { min, size: max - min };
  };
  const sx = span('x');
  const sy = span('y');
  const norm = (v, s) => (s.size > 0 ? ((v - s.min) / s.size) * 100 : 50);
  const map = (o) => ({ ...o, x: norm(o.x, sx), y: norm(o.y, sy) });
  return { ...floor, facilities: floor.facilities.map(map), marks: floor.marks.map(map) };
}

/**
 * Which facility is "now" and which is "next" at route index `index`, as numbers or FLOOR_ENTRANCE.
 * Now is the point's own facility, or the entrance mark when it has none. Next is the next point's
 * facility when that point is indoor and has one; the entrance mark when the next point leaves the
 * building; otherwise null.
 */
export function floorFocus(route, index) {
  const p = route.points[index];
  const q = route.points[index + 1];
  const current = p && Number.isInteger(p.facility) ? p.facility : FLOOR_ENTRANCE;
  let next = null;
  if (q && q.stage === 'indoor' && Number.isInteger(q.facility)) next = q.facility;
  else if (q && p && p.stage === 'indoor' && q.stage === 'return') next = FLOOR_ENTRANCE;
  return { current, next };
}

/** "9번 노인의료센터", or "출입구 쪽" for the entrance mark; null when the number is unknown. */
function placeText(floor, ref, isNext = false) {
  if (ref === FLOOR_ENTRANCE) return isNext ? FLOOR_ENTRANCE_NAME : FLOOR_AT_ENTRANCE;
  const f = typeof ref === 'number' ? facilityByNo(floor, ref) : null;
  return f ? `${f.no}번 ${facilityLabel(f)}` : null;
}

/**
 * The two big lines under the picture: {now, next}. `next` is null when there is no next place.
 * The same place twice reads "다음: 같은 곳".
 */
export function floorTexts(floor, currentNo, nextNo) {
  const cur = currentNo === null || currentNo === undefined ? FLOOR_ENTRANCE : currentNo;
  const nowPlace = placeText(floor, cur);
  const nextPlace = nextNo === null || nextNo === undefined ? null : placeText(floor, nextNo, true);
  return {
    now: nowPlace ? `지금: ${nowPlace}` : null,
    next: nextPlace ? `다음: ${nextNo === cur ? FLOOR_SAME_PLACE : nextPlace}` : null,
  };
}

/** Pushes overlapping circles apart (fixed ones stay) so every number stays readable. */
function spread(items, box) {
  for (let iter = 0; iter < 40; iter += 1) {
    let moved = false;
    for (let i = 0; i < items.length; i += 1) {
      for (let j = i + 1; j < items.length; j += 1) {
        const a = items[i];
        const b = items[j];
        if (a.fixed && b.fixed) continue;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d = Math.hypot(dx, dy);
        const gap = a.r + b.r + 2;
        if (d >= gap) continue;
        if (d === 0) { dx = 1; dy = 0; d = 1; }
        const push = gap - d;
        const ux = dx / d;
        const uy = dy / d;
        if (a.fixed) { b.x += ux * push; b.y += uy * push; }
        else if (b.fixed) { a.x -= ux * push; a.y -= uy * push; }
        else { a.x -= (ux * push) / 2; a.y -= (uy * push) / 2; b.x += (ux * push) / 2; b.y += (uy * push) / 2; }
        moved = true;
      }
    }
    for (const it of items) {
      if (it.fixed) continue;
      it.x = Math.min(box.width - it.r - 2, Math.max(it.r + 2, it.x));
      it.y = Math.min(box.height - it.r - 2, Math.max(it.r + 2, it.y));
    }
    if (!moved) break;
  }
}

function doorSvg(cx, cy, mode) {
  // mode: 'current' (filled, large), 'next' (thick outline) or 'other'
  const k = mode === 'current' ? 1.35 : 1;
  const w = 22 * k;
  const h = 26 * k;
  const fill = mode === 'current' ? INK : '#fff';
  const panel = mode === 'current' ? '#fff' : SOFT;
  const sw = mode === 'next' ? 5 : 3;
  const size = mode === 'other' ? 13 : 15;
  return `<g data-mark="entrance" data-role="${mode}">`
    + `<rect x="${(cx - w / 2).toFixed(1)}" y="${(cy - h / 2).toFixed(1)}" width="${w}" height="${h}" rx="3" fill="${fill}" stroke="${INK}" stroke-width="${sw}"/>`
    + `<rect x="${(cx - w / 2 + 5 * k).toFixed(1)}" y="${(cy - h / 2 + 5 * k).toFixed(1)}" width="${w - 10 * k}" height="${h - 5 * k}" fill="${panel}" stroke="${INK}" stroke-width="1.5"/>`
    + `<circle cx="${(cx + w / 2 - 8 * k).toFixed(1)}" cy="${(cy + 2 * k).toFixed(1)}" r="1.8" fill="${INK}"/>`
    + `<text x="${cx.toFixed(1)}" y="${(cy + h / 2 + size + 3).toFixed(1)}" text-anchor="middle" font-size="${size}" font-weight="800" fill="${INK}">출입구</text>`
    + '</g>';
}

/**
 * Schematic of the floor as one HTML string: an inline SVG (plain outline, a numbered circle per
 * facility, the current one large and filled, the next one with a strong outline, a dashed line
 * between them, the entrance as a small door) followed by the "지금"/"다음" lines and the caption.
 * `currentNo` and `nextNo` are facility numbers, FLOOR_ENTRANCE or null. Nothing here is the
 * hospital's own artwork, a compass or a distance: positions come from the percentages only.
 */
export function renderFloorMap(floor, currentNo, nextNo) {
  const cur = currentNo === null || currentNo === undefined ? FLOOR_ENTRANCE : currentNo;
  const nxt = nextNo === null || nextNo === undefined ? null : nextNo;
  const texts = floorTexts(floor, cur, nxt);
  const lay = floorLayout(fitToDrawn(floor), BOX);
  const doorPos = lay.marks.find((m) => m.id === 'entrance') || null;
  const role = (ref) => (ref === cur ? 'current' : (ref === nxt ? 'next' : 'other'));

  const items = lay.facilities.map((f) => {
    const rl = role(f.no);
    return { no: f.no, x: f.x, y: f.y, role: rl,
      r: rl === 'current' ? R_CURRENT : (rl === 'next' ? R_NEXT : R_OTHER), fixed: rl !== 'other' };
  });
  // Invisible fixed circles that cover the "출입구" label under the door, so no number is pushed onto it.
  const ghosts = [];
  if (doorPos) {
    const doorRole = role(FLOOR_ENTRANCE);
    items.push({ no: FLOOR_ENTRANCE, x: doorPos.x, y: doorPos.y, role: doorRole, r: R_DOOR, fixed: true });
    const k = doorRole === 'current' ? 1.35 : 1;
    const size = doorRole === 'other' ? 13 : 15;
    const labelY = doorPos.y + 13 * k + size * 0.6 + 3; // vertical centre of the label text
    for (const dx of [-14, 0, 14]) ghosts.push({ no: null, x: doorPos.x + dx, y: labelY, r: 8, fixed: true });
  }
  spread([...items, ...ghosts], BOX);

  const at = (ref) => items.find((it) => it.no === ref) || null;
  const from = at(cur);
  const to = nxt !== null && nxt !== cur ? at(nxt) : null;
  const parts = [];
  parts.push(`<rect x="2" y="2" width="${BOX.width - 4}" height="${BOX.height - 4}" rx="16" fill="#fff" stroke="${INK}" stroke-width="3"/>`);
  if (from && to) {
    parts.push(`<line data-link="1" x1="${from.x.toFixed(1)}" y1="${from.y.toFixed(1)}" x2="${to.x.toFixed(1)}" y2="${to.y.toFixed(1)}" `
      + `stroke="${INK}" stroke-width="3" stroke-dasharray="7 6" stroke-linecap="round"/>`);
  }
  // Others first, then next, then current, so the highlighted circles are never covered.
  const order = { other: 0, next: 1, current: 2 };
  for (const it of [...items].sort((a, b) => order[a.role] - order[b.role])) {
    if (it.no === FLOOR_ENTRANCE) {
      parts.push(doorSvg(it.x, it.y, it.role));
      continue;
    }
    const isCur = it.role === 'current';
    const isNext = it.role === 'next';
    const fs = FLOOR_FONT[it.role];
    parts.push(`<g data-no="${it.no}" data-role="${it.role}">`
      + `<circle cx="${it.x.toFixed(1)}" cy="${it.y.toFixed(1)}" r="${it.r}" fill="${isCur ? INK : (isNext ? '#fff' : SOFT)}" `
      + `stroke="${INK}" stroke-width="${isNext ? 5 : (isCur ? 3 : 1.5)}"/>`
      + `<text x="${it.x.toFixed(1)}" y="${it.y.toFixed(1)}" dy="0.35em" text-anchor="middle" font-size="${fs}" `
      + `font-weight="900" fill="${isCur ? '#fff' : INK}">${it.no}</text></g>`);
  }
  const aria = `${floor.title} 모식도. ${texts.now || ''}${texts.next ? ` ${texts.next}` : ''}`.trim();
  const svg = `<svg class="floor-svg" viewBox="0 0 ${BOX.width} ${BOX.height}" role="img" aria-label="${escapeXml(aria)}" `
    + `xmlns="http://www.w3.org/2000/svg" focusable="false">${parts.join('')}</svg>`;
  return `<figure class="floor-map" id="floor-map">${svg}`
    + (texts.now ? `<p class="floor-now" id="floor-now">${escapeXml(texts.now)}</p>` : '')
    + (texts.next ? `<p class="floor-next" id="floor-next">${escapeXml(texts.next)}</p>` : '')
    + `<figcaption class="floor-caption" id="floor-caption">${escapeXml(FLOOR_CAPTION)}</figcaption></figure>`;
}
