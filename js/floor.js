// Floor schematic data: validation, lookup and layout. Pure, importable in Node (no DOM access).
// Positions are percentages of the official floor map, measured from the left and from the TOP
// (y grows downward). The layout keeps that convention: pixel y also grows downward.

import { escapeXml, textWidthEm } from './pictos.js';
import { arrowAngle } from './compass.js';

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
  // Optional size of the official picture in pixels (the percent frame is relative to it).
  if (floor.picture !== undefined) {
    const p = floor.picture;
    const posNum = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
    if (p === null || typeof p !== 'object' || Array.isArray(p)) errors.push('floor.picture must be an object');
    else if (!posNum(p.width) || !posNum(p.height)) errors.push('floor.picture.width and .height must be positive numbers');
  }
  // Optional compass bearing of "up" on the floor data (north-up picture, measured approximately).
  if (floor.north !== undefined) {
    const n = floor.north;
    if (n === null || typeof n !== 'object' || Array.isArray(n)) errors.push('floor.north must be an object');
    else {
      if (typeof n.upBearingDeg !== 'number' || !Number.isFinite(n.upBearingDeg) || n.upBearingDeg < 0 || n.upBearingDeg >= 360) {
        errors.push('floor.north.upBearingDeg must be a number from 0 up to 360');
      }
      if (n.approx !== true) errors.push('floor.north.approx must be true');
      if (!isNonEmptyString(n.source)) errors.push('floor.north.source is missing');
      if (!isNonEmptyString(n.status)) errors.push('floor.north.status is missing');
    }
  }
  // Optional drawn shapes (building outline, lobby): approximate polygons in the same percent frame.
  for (const key of ['outline', 'lobby']) {
    if (floor[key] === undefined) continue;
    const s = floor[key];
    if (s === null || typeof s !== 'object' || Array.isArray(s)) {
      errors.push(`floor.${key} must be an object with points`);
      continue;
    }
    if (!Array.isArray(s.points) || s.points.length < 3) errors.push(`floor.${key}.points must have at least 3 points`);
    else {
      s.points.forEach((p, i) => {
        if (!Array.isArray(p) || p.length !== 2 || !isPercent(p[0]) || !isPercent(p[1])) {
          errors.push(`floor.${key}.points[${i}] must be [x, y] from 0 to 100`);
        }
      });
    }
    // Read off the map picture, never official coordinates, so they must say so.
    if (s.approx !== true) errors.push(`floor.${key}.approx must be true`);
    if (!isNonEmptyString(s.note)) errors.push(`floor.${key}.note is missing`);
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

/** The mark with this id (entrance, info, escalator, elevator ...), or null. */
export function markById(floor, id) {
  return (floor.marks || []).find((m) => m.id === id) || null;
}

/**
 * The place an indoor point refers to: its facility number, else its `mark` id, else null. A mark is
 * used by points that lead to a spot without a facility number (the elevator to the 2nd floor, the
 * information desk).
 */
export function placeOf(point) {
  if (!point) return null;
  if (Number.isInteger(point.facility)) return point.facility;
  return typeof point.mark === 'string' && point.mark.trim() !== '' ? point.mark : null;
}

/** The floor's data for a place: a facility (number) or a mark (id); null when it is not on this floor. */
function placeData(floor, ref) {
  if (typeof ref === 'number') return facilityByNo(floor, ref);
  return typeof ref === 'string' ? markById(floor, ref) : null;
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
const FLOOR_INFO = 'info';
const TAG_NOW = '지금 여기';
const TAG_NEXT = '다음';
const TAG_BOTH = '지금 여기 · 다음';

const INK = '#111827';
const STAGE = '#fde047'; // the indoor stage colour (same as the page accent on indoor screens)
const SOFT = '#e2e8f0';
const FAINT = '#94a3b8';
const BUILDING = '#cbd5e1';
const LOBBY = '#f8fafc';

// Drawing box in SVG units. The title bar is the top TITLE_H units. Below it lies a band (y 38..66) that
// holds the top note and the north marker; the plan is fitted into the free area PLAN under that band
// (about 331 px tall figure on a 375 px phone).
export const FLOOR_BOX = { width: 320, height: 346 };
const TITLE_H = 32;
const MAP = { x0: 12, y0: 38, w: 296, h: 296 };
const BAND_BOTTOM = 66; // bottom of the note / north marker band
/** Free drawing area for the plan (SVG units): everything inside the frame below the note band. */
export const FLOOR_PLAN_AREA = { x0: 12, y0: BAND_BOTTOM + 2, w: 296, h: 334 - (BAND_BOTTOM + 2) };
const PLAN_MARGIN = 13; // the plan's dots (radius up to 12 plus stroke) stay clear of the area edge
// North marker: a disc with the needle inside, the letter beside it (never rotated, never on the disc).
const NORTH_R = 13;
const NORTH_C = { x: 294, y: 52 };
export const FLOOR_NORTH_UP_NOTE = '북쪽이 위예요';
export const FLOOR_FACING_NOTE = '▲ 바라보는 쪽';
export const FLOOR_BEARING_NOTE = '건물 안에서는 방향이 조금 틀릴 수 있어요.';
// Label font sizes in SVG units: other places, next place, current place; the small tag line.
// Arithmetic: the viewBox is 320 units wide and the figure is about 308 px wide on a 375 px phone
// (375 - 2*16 page padding - 2*12 card padding - 2*2 card border = 315; 308 is used as a safe floor), so
// 1 unit = 308 / 320 = 0.9625 px. 15 units -> 14.4 px, 16 -> 15.4 px, 17 -> 16.4 px. Every text in the
// figure (labels, tag line, "로비", title 17) is 15 units or more, so 14.4 px or more.
export const FLOOR_FONT = { other: 15, next: 16, current: 17, tag: 15, title: 17, lobby: 15 };
const PAD_X = 8; // horizontal padding inside a label
const LABEL_GAP = 3; // minimum space kept between two labels

/** Hangul 1 em, digits 0.6, spaces 0.4, other characters 0.6 (same estimate as the pictograms). */
const textUnits = (text, fs) => textWidthEm(text) * fs;

/** Corners of a polygon from a floor `outline`/`lobby` object, or null when absent. */
function polygonOf(shape) {
  return shape && Array.isArray(shape.points) ? shape.points : null;
}

/** Bounding box of the building: the outline when present, else every facility and the entrance. */
function floorBounds(floor) {
  const poly = polygonOf(floor.outline);
  const pts = poly
    || [...floor.facilities, ...floor.marks.filter((m) => m.id === FLOOR_ENTRANCE)].map((p) => [p.x, p.y]);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

const norm360 = (deg) => ((deg % 360) + 360) % 360;

/**
 * Geometry of the turned plan. Pure.
 *
 * 1. Percent -> true-shape units: x% * (picture width / 100), y% * (picture height / 100). The picture
 *    has the same scale on both axes, so this keeps the real proportions (no stretching). A floor file
 *    without `picture` is treated as a square percent frame.
 * 2. Rotation about the centre of the building's bounding box so that the user's heading points to the
 *    top of the figure. The data "up" lies at compass bearing `north.upBearingDeg` (0 when absent), so a
 *    point at compass bearing B from the centre ends up at screen angle (B - heading) clockwise from up.
 *    `headingDeg` null/undefined means heading 0 (north up).
 * 3. One uniform scale (same on both axes) that fits the bounding box of the rotated plan into the free
 *    area FLOOR_PLAN_AREA (inset by PLAN_MARGIN), and the box is centred there. The scale is therefore
 *    chosen per heading: the map is redrawn only when the 15 degree step changes, and the plan is as
 *    large as that heading allows. Aspect ratio is kept (same scale on both axes).
 *
 * Returns {at(xPct, yPct) -> {x, y} in SVG units (y downward), scale, pivot (where the rotation centre
 * ends up), northAngle, headingUsed, outline, lobby, facilities, marks}; the last four are the drawn
 * coordinates (for tests and drawing).
 */
export function floorGeometry(floor, headingDeg = null) {
  const pic = floor.picture || { width: 100, height: 100 };
  const kx = pic.width / 100;
  const ky = pic.height / 100;
  const up = floor.north && Number.isFinite(floor.north.upBearingDeg) ? floor.north.upBearingDeg : 0;
  const headingUsed = Number.isFinite(headingDeg) ? norm360(headingDeg) : 0;
  const b = floorBounds(floor);
  const cx = ((b.minX + b.maxX) / 2) * kx;
  const cy = ((b.minY + b.maxY) / 2) * ky;
  const ring = [...(polygonOf(floor.outline) || []), ...floor.facilities.map((f) => [f.x, f.y]), ...floor.marks.map((m) => [m.x, m.y])];
  const theta = (up - headingUsed) * (Math.PI / 180); // clockwise on screen (y downward)
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  // Bounding box of every plan point after the turn, at scale 1 (picture units).
  const rot = ring.map(([x, y]) => {
    const vx = x * kx - cx;
    const vy = y * ky - cy;
    return [vx * cos - vy * sin, vx * sin + vy * cos];
  });
  const rx0 = Math.min(...rot.map((p) => p[0]));
  const rx1 = Math.max(...rot.map((p) => p[0]));
  const ry0 = Math.min(...rot.map((p) => p[1]));
  const ry1 = Math.max(...rot.map((p) => p[1]));
  const availW = FLOOR_PLAN_AREA.w - 2 * PLAN_MARGIN;
  const availH = FLOOR_PLAN_AREA.h - 2 * PLAN_MARGIN;
  const scale = Math.min(availW / Math.max(1e-6, rx1 - rx0), availH / Math.max(1e-6, ry1 - ry0));
  // Centre the turned box in the free area.
  const mx = FLOOR_PLAN_AREA.x0 + FLOOR_PLAN_AREA.w / 2 - (scale * (rx0 + rx1)) / 2;
  const my = FLOOR_PLAN_AREA.y0 + FLOOR_PLAN_AREA.h / 2 - (scale * (ry0 + ry1)) / 2;
  const at = (xPct, yPct) => {
    const vx = xPct * kx - cx;
    const vy = yPct * ky - cy;
    return { x: mx + scale * (vx * cos - vy * sin), y: my + scale * (vx * sin + vy * cos) };
  };
  const poly = (shape) => (polygonOf(shape) || []).map(([x, y]) => { const q = at(x, y); return [q.x, q.y]; });
  return {
    at,
    scale,
    pivot: { x: mx, y: my },
    headingUsed,
    northAngle: norm360(-headingUsed), // compass north, clockwise from the top of the figure
    outline: poly(floor.outline),
    lobby: poly(floor.lobby),
    facilities: floor.facilities.map((f) => ({ no: f.no, ...at(f.x, f.y) })),
    marks: floor.marks.map((m) => ({ id: m.id, ...at(m.x, m.y) })),
  };
}

/**
 * Which place is "now" and which is "next" at route index `index`: a facility number, a mark id or
 * FLOOR_ENTRANCE. Now is the point's own facility or mark, or the entrance mark when it has none. Next is
 * the next point's facility or mark when that point is indoor and has one; the entrance mark when the next
 * point leaves the building; otherwise null.
 */
export function floorFocus(route, index) {
  const p = route.points[index];
  const q = route.points[index + 1];
  const current = placeOf(p) ?? FLOOR_ENTRANCE;
  let next = null;
  if (q && q.stage === 'indoor' && placeOf(q) !== null) next = placeOf(q);
  else if (q && p && p.stage === 'indoor' && q.stage === 'return') next = FLOOR_ENTRANCE;
  return { current, next };
}

/** Fixed line under an indoor arrow (never spoken). */
export const INDOOR_ARROW_NOTE = '대략 이 방향이에요. 표지판도 함께 보세요.';

const onThisFloor = (p, floor) => Boolean(p && p.stage === 'indoor' && p.floor === floor.id);

/**
 * Compass bearing (degrees clockwise from north, [0, 360)) of the straight line on the floor picture
 * from where the user stands to where the point at `index` is, or null when no honest arrow exists.
 * Destination: the place (facility or mark, see placeOf) of an indoor point of this floor; or, for the
 * first point after an indoor point (the way out), the entrance mark. Origin: the place of the previous
 * point, or the entrance mark when the previous point has no place or is not an indoor point of this
 * floor. Null when a facility or mark is missing from the floor data, or origin and destination are the
 * same place.
 * Pure. Picture units (x% * width / 100, y% * height / 100) keep the true proportions; y grows downward.
 */
export function indoorBearing(route, floor, index) {
  const p = route && route.points ? route.points[index] : null;
  if (!p || !floor) return null;
  const prev = route.points[index - 1] || null;
  const entrance = (floor.marks || []).find((m) => m.id === FLOOR_ENTRANCE) || null;
  const prevPlace = onThisFloor(prev, floor) ? placeOf(prev) : null;
  let origin;
  let dest;
  if (onThisFloor(p, floor)) {
    if (placeOf(p) === null) return null;
    dest = placeData(floor, placeOf(p));
    origin = prevPlace !== null ? placeData(floor, prevPlace) : entrance;
  } else if (p.stage === 'return' && prevPlace !== null) {
    dest = entrance;
    origin = placeData(floor, prevPlace);
  } else {
    return null;
  }
  if (!dest || !origin) return null;
  const pic = floor.picture || { width: 100, height: 100 };
  const dx = ((dest.x - origin.x) * pic.width) / 100;
  const dy = ((dest.y - origin.y) * pic.height) / 100;
  if (dx === 0 && dy === 0) return null;
  const up = floor.north && Number.isFinite(floor.north.upBearingDeg) ? floor.north.upBearingDeg : 0;
  return norm360((Math.atan2(dx, -dy) * 180) / Math.PI + up);
}

/**
 * Indoor arrow for the point at `index`: {bearing, angle} or null (see indoorBearing). `angle` is the
 * drawn rotation (clockwise from the top of the screen) for the heading the user faces, or null when
 * `headingDeg` is not a finite number (no compass reading yet).
 */
export function indoorArrow(route, floor, index, headingDeg) {
  const bearing = indoorBearing(route, floor, index);
  if (bearing === null) return null;
  return { bearing, angle: Number.isFinite(headingDeg) ? arrowAngle(bearing, headingDeg) : null };
}

/** Facility numbers any point of the route refers to, in route order, without repeats. */
export function routeFacilityNumbers(route) {
  const out = [];
  for (const p of (route && route.points) || []) {
    if (Number.isInteger(p.facility) && !out.includes(p.facility)) out.push(p.facility);
  }
  return out;
}

/** Mark ids (elevator, info ...) that route points refer to instead of a facility number, without repeats. */
export function routeMarkIds(route) {
  const out = [];
  for (const p of (route && route.points) || []) {
    const id = placeOf(p);
    if (typeof id === 'string' && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * "원무 수납 (층별 안내 7번)", the entrance wording, or a mark's own name ("엘리베이터"); null when the
 * number or mark is unknown.
 */
function placeText(floor, ref, isNext = false) {
  if (ref === FLOOR_ENTRANCE) return isNext ? FLOOR_ENTRANCE_NAME : FLOOR_AT_ENTRANCE;
  if (typeof ref === 'string') {
    const m = markById(floor, ref);
    return m ? m.name : null;
  }
  const f = typeof ref === 'number' ? facilityByNo(floor, ref) : null;
  return f ? `${facilityLabel(f)} (층별 안내 ${f.no}번)` : null;
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

function inPolygon(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > pt.y) !== (yj > pt.y) && pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Where to write "로비": the lobby point (in SVG units) farthest from every given dot, such that the
 * word's box (width `w`, height `h`, plus a small margin) is not `blocked` (a rect predicate: labels,
 * arrow). Null when no such point exists, in which case the word is left out.
 */
function lobbyTextSpot(polyUnits, dots, w, h, blocked) {
  const xs = polyUnits.map((p) => p[0]);
  const ys = polyUnits.map((p) => p[1]);
  let best = null;
  for (let x = Math.min(...xs); x <= Math.max(...xs); x += 4) {
    for (let y = Math.min(...ys); y <= Math.max(...ys); y += 4) {
      if (!inPolygon({ x, y }, polyUnits)) continue;
      // keep the word clear of the lobby edge too
      const edge = [[-14, 0], [14, 0], [0, -10], [0, 10]].every(([dx, dy]) => inPolygon({ x: x + dx, y: y + dy }, polyUnits));
      if (!edge) continue;
      if (blocked({ x: x - w / 2 - 3, y: y - h / 2 - 3, w: w + 6, h: h + 6 })) continue;
      const score = Math.min(...dots.map((d) => Math.hypot(d.x - x, d.y - y)), 999);
      if (!best || score > best.score) best = { x, y, score };
    }
  }
  return best;
}

const overlaps = (a, b, gap) => a.x < b.x + b.w + gap && b.x < a.x + a.w + gap
  && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;

/** Moves a box (in place) inside the drawing box, below the title bar. */
function clampBox(b, size) {
  b.x = Math.min(size.width - 2 - b.w, Math.max(2, b.x));
  b.y = Math.min(size.height - 2 - b.h, Math.max(TITLE_H + 2, b.y));
  return b;
}

/** Separating-axis test: does the convex polygon [[x, y], ...] touch the rect grown by `m` on every side? */
function polyHitsRect(poly, r, m = 0) {
  const x0 = r.x - m;
  const x1 = r.x + r.w + m;
  const y0 = r.y - m;
  const y1 = r.y + r.h + m;
  const px = poly.map((p) => p[0]);
  const py = poly.map((p) => p[1]);
  if (Math.max(...px) < x0 || Math.min(...px) > x1 || Math.max(...py) < y0 || Math.min(...py) > y1) return false;
  const corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  for (let i = 0; i < poly.length; i += 1) {
    const [ax, ay] = poly[i];
    const [bx, by] = poly[(i + 1) % poly.length];
    const nx = by - ay;
    const ny = ax - bx;
    const ps = poly.map(([x, y]) => x * nx + y * ny);
    const cs = corners.map(([x, y]) => x * nx + y * ny);
    if (Math.max(...ps) < Math.min(...cs) || Math.min(...ps) > Math.max(...cs)) return false;
  }
  return true;
}

/** Shortest distance from a point to a rect (0 inside). */
const rectDist = (p, r) => Math.hypot(Math.max(r.x - p.x, 0, p.x - (r.x + r.w)), Math.max(r.y - p.y, 0, p.y - (r.y + r.h)));

/**
 * The dashed arrow between two dots: shaft polygon (stroke 5 -> half width 2.5), head triangle, and the
 * points the drawing uses. The tip stops at the edge of the next place's dot, never at its label.
 */
function arrowShapes(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const start = { x: a.x + ux * 15, y: a.y + uy * 15 };
  const tip = { x: b.x - ux * 12, y: b.y - uy * 12 };
  const base = { x: tip.x - ux * 16, y: tip.y - uy * 16 };
  const hw = 2.5;
  return {
    ux,
    uy,
    start,
    tip,
    base,
    shaft: [[start.x - uy * hw, start.y + ux * hw], [base.x - uy * hw, base.y + ux * hw],
      [base.x + uy * hw, base.y - ux * hw], [start.x + uy * hw, start.y - ux * hw]],
    head: [[tip.x, tip.y], [base.x - uy * 9, base.y + ux * 9], [base.x + uy * 9, base.y - ux * 9]],
  };
}

const OPPOSITE_SIDE = { up: 'down', down: 'up', left: 'right', right: 'left' };
/** Sides of a dot for a label, best first, when the label should lie in direction (dx, dy). */
function sideOrder(dx, dy) {
  const vert = dy > 0 ? 'down' : 'up';
  const horiz = dx > 0 ? 'right' : 'left';
  const [first, second] = Math.abs(dy) >= Math.abs(dx) ? [vert, horiz] : [horiz, vert];
  return [first, second, OPPOSITE_SIDE[second], OPPOSITE_SIDE[first]];
}

/**
 * Pushes overlapping label boxes {x, y, w, h, fixed?} apart (fixed ones stay) along the axis with the
 * smaller overlap, then keeps every movable box inside the drawing box.
 */
function separate(boxes, size) {
  const clamp = (b) => clampBox(b, size);
  boxes.forEach((b) => { if (!b.fixed) clamp(b); });
  for (let iter = 0; iter < 120; iter += 1) {
    let moved = false;
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i];
        const b = boxes[j];
        if (a.fixed && b.fixed) continue;
        if (!overlaps(a, b, LABEL_GAP)) continue;
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) + LABEL_GAP;
        const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) + LABEL_GAP;
        const vertical = oy <= ox;
        const dir = vertical ? Math.sign((b.y + b.h / 2) - (a.y + a.h / 2)) || 1 : Math.sign((b.x + b.w / 2) - (a.x + a.w / 2)) || 1;
        const amount = vertical ? oy : ox;
        const k = vertical ? 'y' : 'x';
        if (a.fixed) b[k] += dir * amount;
        else if (b.fixed) a[k] -= dir * amount;
        else { a[k] -= (dir * amount) / 2; b[k] += (dir * amount) / 2; }
        if (!a.fixed) clamp(a);
        if (!b.fixed) clamp(b);
        moved = true;
      }
    }
    if (!moved) break;
  }
}

const f1 = (v) => Number(v).toFixed(1);
const polyAttr = (pts) => pts.map((p) => `${f1(p[0])},${f1(p[1])}`).join(' ');

/** A simple person pictogram (head and shoulders, white) centred on (x, y). */
function personSvg(x, y) {
  return `<circle cx="${f1(x)}" cy="${f1(y - 4)}" r="3.4" fill="#fff"/>`
    + `<path d="M${f1(x - 6.5)},${f1(y + 8)} a6.5,6.5 0 0 1 13,0 z" fill="#fff"/>`;
}

/**
 * Floor plan as one HTML string: a figure with an inline SVG (title bar, building and lobby shapes
 * from the floor data, small faint dots for every facility, a named label for each place that matters
 * today, a "you are here" person marker on the current place, a thick dashed arrow to the next one),
 * followed by the "지금"/"다음" lines and the caption.
 *
 * The places that matter are derived from the route: every facility any route point refers to, plus
 * the current and next ones, the entrance and the information desk. `currentNo` and `nextNo` are
 * facility numbers, FLOOR_ENTRANCE or null. Nothing here is the hospital's own artwork or a distance:
 * positions come from the percentages only (see floorGeometry).
 *
 * `options.headingDeg` is the direction the user faces (compass degrees); the plan is turned so that it
 * points to the top. null/undefined means north up. Only the plan turns: every text and label stays
 * upright (no transform is used anywhere). A small north marker shows where north lies.
 */
export function renderFloorMap(floor, currentNo, nextNo, route = null, options = {}) {
  const cur = currentNo === null || currentNo === undefined ? FLOOR_ENTRANCE : currentNo;
  const nxt = nextNo === null || nextNo === undefined ? null : nextNo;
  const texts = floorTexts(floor, cur, nxt);
  const headingDeg = options && Number.isFinite(options.headingDeg) ? options.headingDeg : null;
  const geo = floorGeometry(floor, headingDeg);
  const to = (x, y) => geo.at(x, y);
  const size = FLOOR_BOX;

  // Fixed things drawn on the plan that labels must keep clear of: the note at the top edge and the
  // north marker in the top right corner.
  const noteText = headingDeg === null ? FLOOR_NORTH_UP_NOTE : FLOOR_FACING_NOTE;
  const noteW = Math.ceil(textUnits(noteText, FLOOR_FONT.tag)) + 16;
  const noteBox = { x: size.width / 2 - noteW / 2, y: MAP.y0 + 2, w: noteW, h: 22, fixed: true };
  // The marker sits in the top right corner of the band above the plan area, so it never covers the plan.
  // The letter lies beside the disc (to its left), upright, clear of the disc and of the note.
  const northC = NORTH_C;
  const LETTER_W = FLOOR_FONT.tag; // one Hangul character, 1 em
  const letterC = { x: northC.x - NORTH_R - 4 - LETTER_W / 2, y: northC.y };
  const northBox = {
    x: letterC.x - LETTER_W / 2, y: northC.y - NORTH_R, w: northC.x + NORTH_R - (letterC.x - LETTER_W / 2), h: 2 * NORTH_R, fixed: true,
  };
  const fixedObstacles = [noteBox, northBox];

  // Places that get a text label.
  const refs = [];
  const add = (ref) => { if (ref !== null && !refs.includes(ref)) refs.push(ref); };
  routeFacilityNumbers(route).forEach(add);
  routeMarkIds(route).forEach(add);
  add(cur);
  add(nxt);
  add(FLOOR_ENTRANCE);
  add(FLOOR_INFO);

  const markOf = (id) => floor.marks.find((m) => m.id === id) || null;
  const places = [];
  for (const ref of refs) {
    let name;
    let src;
    if (typeof ref === 'string') {
      src = markOf(ref); // entrance, info, elevator, escalator: named by the mark itself
      name = src ? src.name : null;
    } else {
      src = typeof ref === 'number' ? facilityByNo(floor, ref) : null;
      name = src ? facilityLabel(src) : null;
    }
    if (!src || !name) continue;
    const role = ref === cur ? 'current' : (ref === nxt ? 'next' : 'other');
    const tag = role === 'other' ? null : (cur === nxt ? TAG_BOTH : (role === 'current' ? TAG_NOW : TAG_NEXT));
    places.push({ ref, name, role, tag, dot: to(src.x, src.y), fs: FLOOR_FONT[role] });
  }

  // The arrow (current -> next) is computed first so the labels can keep clear of it.
  const from = places.find((p) => p.role === 'current');
  const dest = nxt !== null && nxt !== cur ? places.find((p) => p.role === 'next') : null;
  const arrow = from && dest ? arrowShapes(from.dot, dest.dot) : null;
  const hitsArrow = (b, m) => !!arrow && (polyHitsRect(arrow.shaft, b, m) || polyHitsRect(arrow.head, b, m));

  // Label box sizes, and a box for a given side of its dot.
  const sizes = places.map((pl) => {
    const nameW = textUnits(pl.name, pl.fs);
    const tagW = pl.tag ? textUnits(pl.tag, FLOOR_FONT.tag) : 0;
    return { w: Math.ceil(Math.max(nameW, tagW) + 2 * PAD_X), h: pl.tag ? pl.fs + FLOOR_FONT.tag + 14 : pl.fs + 10 };
  });
  const OFFSET = { current: 20, next: 15, other: 11 }; // dot centre to label edge
  // Drawn dot radius incl. half the stroke: current 12 + 1.25 (person disc), next 9 + 2, other 6 + 1.5.
  const DOT_R = { current: 13.5, next: 11, other: 7.5 };
  // A label box must not touch ANY named dot (the person marker, the next dot, every other named dot,
  // its own included: the leader line joins a label to its dot). Faint unnamed dots may be covered.
  const dotHit = (b) => places.some((p) => rectDist(p.dot, b) <= DOT_R[p.role] + 1);
  const insideFigure = (b) => b.x >= 2 && b.x + b.w <= size.width - 2 && b.y >= TITLE_H + 2 && b.y + b.h <= size.height - 2;
  /** Nearest free box (by distance of its centre from the dot) around place i that satisfies ok(b), or null. */
  const findSpot = (i, ok) => {
    const { w, h } = sizes[i];
    const { dot } = places[i];
    let best = null;
    for (let dy = -160; dy <= 160; dy += 3) {
      for (let dx = -170; dx <= 170; dx += 3) {
        const b = { x: dot.x + dx - w / 2, y: dot.y + dy - h / 2, w, h };
        if (!insideFigure(b) || !ok(b)) continue;
        const d = Math.hypot(dx, dy);
        if (!best || d < best.d) best = { d, b };
      }
    }
    return best ? best.b : null;
  };
  const boxAt = (i, side) => {
    const { w, h } = sizes[i];
    const { dot, role } = places[i];
    const o = OFFSET[role];
    let x = dot.x - w / 2;
    let y = dot.y - o - h;
    if (side === 'down') y = dot.y + o;
    else if (side === 'left') { x = dot.x - o - w; y = dot.y - h / 2; }
    else if (side === 'right') { x = dot.x + o; y = dot.y - h / 2; }
    return { x, y, w, h };
  };

  // Focus labels (current, next) sit on the side of their dot away from the other focus place, so the
  // arrow never crosses them. Candidate sides are tried best first; a candidate must stay inside the
  // picture, clear of the arrow, of both focus dots and of the other focus label.
  const ci = places.findIndex((p) => p.role === 'current');
  const ni = places.findIndex((p) => p.role === 'next');
  const candsOf = (i) => {
    if (i < 0) return [null];
    const sign = places[i].role === 'current' ? -1 : 1;
    const dir = arrow ? { x: sign * arrow.ux, y: sign * arrow.uy } : { x: 0, y: -1 };
    return sideOrder(dir.x, dir.y).map((s) => clampBox(boxAt(i, s), size));
  };
  const focusOk = (b) => {
    if (!b) return true;
    if (hitsArrow(b, 3)) return false;
    if (fixedObstacles.some((o) => overlaps(b, o, LABEL_GAP))) return false;
    return !dotHit(b);
  };
  const cc = candsOf(ci);
  const nc = candsOf(ni);
  let pick = null;
  for (let s = 0; s < cc.length + nc.length - 1 && !pick; s += 1) {
    for (let a = 0; a <= s && !pick; a += 1) {
      const b = s - a;
      if (a >= cc.length || b >= nc.length) continue;
      const bc = cc[a];
      const bn = nc[b];
      if (focusOk(bc) && focusOk(bn) &&!(bc && bn && overlaps(bc, bn, LABEL_GAP))) pick = [bc, bn];
    }
  }
  if (!pick) pick = [cc[0], nc[0]];
  // No side of the dot is free (the plan now fills the area): look for the nearest free spot instead.
  // Focus labels are never left out, so the current one is placed first, then the next one beside it.
  for (const [k, idx] of [[0, ci], [1, ni]]) {
    if (idx < 0) continue;
    const other = pick[1 - k];
    const okBox = (b) => focusOk(b) && !(other && overlaps(b, other, LABEL_GAP));
    if (!okBox(pick[k])) {
      const spot = findSpot(idx, okBox);
      if (spot) pick[k] = spot;
    }
  }

  // Other labels start just above their dots; the focus labels stay where they were put.
  const boxes = places.map((pl, i) => {
    if (i === ci) return { ...pick[0], fixed: true };
    if (i === ni) return { ...pick[1], fixed: true };
    return boxAt(i, 'up');
  });
  boxes.push(...fixedObstacles.map((o) => ({ ...o }))); // after the places, so place indexes are unchanged
  // A non-focus label that the arrow would cross is not drawn on this screen (its dot stays). A label
  // that is not drawn must not push the drawn ones around, so the separation is repeated without the
  // hidden labels until the hidden set stops growing (at most 5 passes; the set only grows).
  const hidden = places.map(() => false);
  for (let pass = 0; pass < 5; pass += 1) {
    separate(boxes.filter((_, i) => !hidden[i]), size);
    let grew = false;
    places.forEach((pl, i) => {
      if (!hidden[i] && pl.role === 'other' && hitsArrow(boxes[i], 2)) { hidden[i] = true; grew = true; }
    });
    if (!grew) break;
  }
  // The push-apart pass can stall in a tight spot (two fixed focus labels with too little room between
  // them), and a label can land on a dot. A drawn "other" label that still overlaps another label, the
  // arrow or ANY named dot (its own included) is moved to the nearest free spot around its dot; when no
  // spot is free it is left out for this screen (its dot stays).
  places.forEach((pl, i) => {
    if (hidden[i] || pl.role !== 'other') return;
    const bad = (b) => boxes.some((o, j) => j !== i && !hidden[j] && overlaps(b, o, LABEL_GAP)) || hitsArrow(b, 3) || dotHit(b);
    if (!bad(boxes[i])) return;
    const spot = findSpot(i, (b) => !bad(b));
    if (spot) Object.assign(boxes[i], { x: spot.x, y: spot.y });
    else hidden[i] = true;
  });
  const shown = boxes.filter((_, i) => !hidden[i]);

  // "로비" is drawn only where its box overlaps no label and not the arrow.
  const lobbyPoly = polygonOf(floor.lobby);
  let lobbyText = '';
  if (lobbyPoly) {
    const unit = lobbyPoly.map(([x, y]) => { const q = to(x, y); return [q.x, q.y]; });
    const w = Math.ceil(textUnits('로비', FLOOR_FONT.lobby));
    const blocked = (r) => shown.some((b) => overlaps(r, b, 0)) || hitsArrow(r, 0);
    const spot = lobbyTextSpot(unit, places.map((p) => p.dot), w, FLOOR_FONT.lobby, blocked);
    if (spot) {
      lobbyText = `<text data-lobby-text="1" x="${f1(spot.x)}" y="${f1(spot.y)}" dy="0.35em" text-anchor="middle" `
        + `font-size="${FLOOR_FONT.lobby}" font-weight="800" fill="#475569">로비</text>`;
    }
  }

  const parts = [];
  parts.push(`<rect x="2" y="2" width="${size.width - 4}" height="${size.height - 4}" rx="16" fill="#fff" stroke="${INK}" stroke-width="3"/>`);
  // Title bar: dark band with the floor title, square at the bottom edge.
  parts.push(`<rect x="2" y="2" width="${size.width - 4}" height="${TITLE_H}" rx="14" fill="${INK}"/>`
    + `<rect x="2" y="${TITLE_H - 12}" width="${size.width - 4}" height="14" fill="${INK}"/>`
    + `<text data-title="1" x="${size.width / 2}" y="${2 + TITLE_H / 2}" dy="0.35em" text-anchor="middle" `
    + `font-size="${FLOOR_FONT.title}" font-weight="800" fill="#fff">${escapeXml(floor.title)}</text>`);
  const outline = polygonOf(floor.outline);
  if (outline) {
    parts.push(`<polygon data-shape="outline" points="${polyAttr(outline.map(([x, y]) => { const q = to(x, y); return [q.x, q.y]; }))}" `
      + `fill="${BUILDING}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>`);
  }
  if (lobbyPoly) {
    parts.push(`<polygon data-shape="lobby" points="${polyAttr(lobbyPoly.map(([x, y]) => { const q = to(x, y); return [q.x, q.y]; }))}" `
      + `fill="${LOBBY}" stroke="${FAINT}" stroke-width="1.5" stroke-linejoin="round"/>`);
  }
  parts.push(lobbyText);

  // Faint dots for facilities that are not named on the picture.
  const named = new Set(places.map((p) => p.ref));
  for (const f of floor.facilities) {
    if (named.has(f.no)) continue;
    const q = to(f.x, f.y);
    parts.push(`<circle data-dot="${f.no}" cx="${f1(q.x)}" cy="${f1(q.y)}" r="4" fill="${SOFT}" stroke="${FAINT}" stroke-width="1.5"/>`);
  }

  // Leader lines from each dot to its label, then the labels.
  places.forEach((pl, i) => {
    if (hidden[i]) return;
    const b = boxes[i];
    const px = Math.min(b.x + b.w, Math.max(b.x, pl.dot.x));
    const py = Math.min(b.y + b.h, Math.max(b.y, pl.dot.y));
    if (Math.hypot(px - pl.dot.x, py - pl.dot.y) > 4) {
      parts.push(`<line data-leader="${pl.ref}" x1="${f1(pl.dot.x)}" y1="${f1(pl.dot.y)}" x2="${f1(px)}" y2="${f1(py)}" `
        + `stroke="${INK}" stroke-width="2"/>`);
    }
  });

  // Draw order: other places, then the arrow (above the building and the dots), then the next and
  // current places, so the two focus labels are always on top of the arrow.
  const drawPlace = (i) => {
    const pl = places[i];
    const b = boxes[i];
    const isCur = pl.role === 'current';
    const isNext = pl.role === 'next';
    const fill = isCur ? INK : (isNext ? STAGE : '#fff');
    const ink = isCur ? '#fff' : INK;
    const nameY = pl.tag ? b.y + 7 + pl.fs / 2 : b.y + b.h / 2;
    const tagY = b.y + b.h - 7 - FLOOR_FONT.tag / 2;
    let dot;
    if (isCur) {
      dot = `<circle cx="${f1(pl.dot.x)}" cy="${f1(pl.dot.y)}" r="12" fill="${INK}" stroke="#fff" stroke-width="2.5"/>${personSvg(pl.dot.x, pl.dot.y)}`;
    } else if (isNext) {
      dot = `<circle cx="${f1(pl.dot.x)}" cy="${f1(pl.dot.y)}" r="9" fill="${STAGE}" stroke="${INK}" stroke-width="4"/>`;
    } else {
      dot = `<circle cx="${f1(pl.dot.x)}" cy="${f1(pl.dot.y)}" r="6" fill="#fff" stroke="${INK}" stroke-width="3"/>`;
    }
    if (hidden[i]) {
      // label left out because the arrow would cross it; the box is kept as data for checks
      parts.push(`<g data-place="${pl.ref}" data-role="${pl.role}" data-label-hidden="1" `
        + `data-box="${f1(b.x)},${f1(b.y)},${b.w},${f1(b.h)}">${dot}</g>`);
      return;
    }
    parts.push(`<g data-place="${pl.ref}" data-role="${pl.role}">`
      + `<rect data-label="1" x="${f1(b.x)}" y="${f1(b.y)}" width="${b.w}" height="${f1(b.h)}" rx="8" fill="${fill}" stroke="${INK}" stroke-width="${isNext ? 4 : 2.5}"/>`
      + `<text data-name="1" x="${f1(b.x + b.w / 2)}" y="${f1(nameY)}" dy="0.35em" text-anchor="middle" font-size="${pl.fs}" font-weight="900" fill="${ink}">${escapeXml(pl.name)}</text>`
      + (pl.tag
        ? `<text data-tag="1" x="${f1(b.x + b.w / 2)}" y="${f1(tagY)}" dy="0.35em" text-anchor="middle" font-size="${FLOOR_FONT.tag}" font-weight="800" fill="${ink}">${escapeXml(pl.tag)}</text>`
        : '')
      + `${dot}</g>`);
  };
  places.forEach((pl, i) => { if (pl.role === 'other') drawPlace(i); });
  if (arrow) {
    parts.push(`<line data-link="1" x1="${f1(arrow.start.x)}" y1="${f1(arrow.start.y)}" x2="${f1(arrow.base.x)}" y2="${f1(arrow.base.y)}" `
      + `stroke="${INK}" stroke-width="5" stroke-dasharray="10 7" stroke-linecap="butt"/>`);
    parts.push(`<polygon data-arrow="1" points="${f1(arrow.tip.x)},${f1(arrow.tip.y)} ${f1(arrow.head[1][0])},${f1(arrow.head[1][1])} `
      + `${f1(arrow.head[2][0])},${f1(arrow.head[2][1])}" fill="${INK}" stroke="${INK}" stroke-width="2" stroke-linejoin="round"/>`);
  }
  if (ni >= 0) drawPlace(ni);
  if (ci >= 0) drawPlace(ci);

  // Note at the top edge (what "up" means) and the north marker. Both are upright; the marker's needle
  // and its letter are placed by computed coordinates, never by a rotate transform.
  parts.push(`<rect data-note-bg="1" x="${f1(noteBox.x)}" y="${f1(noteBox.y)}" width="${noteBox.w}" height="${noteBox.h}" rx="11" `
    + `fill="#fff" fill-opacity="0.92" stroke="${INK}" stroke-width="1.5"/>`
    + `<text data-note="1" x="${f1(size.width / 2)}" y="${f1(noteBox.y + noteBox.h / 2)}" dy="0.35em" text-anchor="middle" `
    + `font-size="${FLOOR_FONT.tag}" font-weight="800" fill="${INK}">${escapeXml(noteText)}</text>`);
  const nr = (geo.northAngle * Math.PI) / 180;
  const nd = { x: Math.sin(nr), y: -Math.cos(nr) }; // unit vector towards north on screen
  const np = { x: -nd.y, y: nd.x }; // perpendicular
  const at = (along, side) => `${f1(northC.x + nd.x * along + np.x * side)},${f1(northC.y + nd.y * along + np.y * side)}`;
  parts.push(`<circle data-north-disc="1" cx="${f1(northC.x)}" cy="${f1(northC.y)}" r="${NORTH_R}" fill="#fff" fill-opacity="0.92" stroke="${FAINT}" stroke-width="1.5"/>`
    + `<polygon data-north-needle="1" points="${at(9, 0)} ${at(-6, 5)} ${at(-2, 0)} ${at(-6, -5)}" fill="${INK}" stroke="${INK}" stroke-width="1.5" stroke-linejoin="round"/>`
    + `<text data-north-label="1" x="${f1(letterC.x)}" y="${f1(letterC.y)}" dy="0.35em" text-anchor="middle" `
    + `font-size="${FLOOR_FONT.tag}" font-weight="900" fill="${INK}">북</text>`);

  const aria = `${floor.title} 모식도. ${texts.now || ''}${texts.next ? ` ${texts.next}` : ''} `
    + `${headingDeg === null ? FLOOR_NORTH_UP_NOTE : '위쪽이 바라보는 쪽이에요'}.`.trim();
  const svg = `<svg class="floor-svg" viewBox="0 0 ${size.width} ${size.height}" role="img" aria-label="${escapeXml(aria)}" `
    + `xmlns="http://www.w3.org/2000/svg" focusable="false">${parts.join('')}</svg>`;
  return `<figure class="floor-map" id="floor-map" data-up="${headingDeg === null ? 'north' : 'heading'}">${svg}`
    + (texts.now ? `<p class="floor-now" id="floor-now">${escapeXml(texts.now)}</p>` : '')
    + (texts.next ? `<p class="floor-next" id="floor-next">${escapeXml(texts.next)}</p>` : '')
    + `<figcaption class="floor-caption" id="floor-caption">${escapeXml(FLOOR_CAPTION)}</figcaption></figure>`;
}
