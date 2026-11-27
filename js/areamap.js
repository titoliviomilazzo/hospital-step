// Outdoor map between Migeum station and the hospital. Pure functions (data checks, projection,
// geometry, riding progress, the SVG string) importable in Node. The map data is one stored file
// (data/area.migeum-snubh.json, built once from OpenStreetMap by tools/build_area_map.py); the app
// never calls a map service while running, so the phone's position stays on the phone.
// Bus stop coordinates are NOT in that file: they come from the route data (official GBIS values).
//
// Follows the floor plan's pattern (floor.js): one rotation about the centre so the heading points up
// (0 means north up, quantised by compass.js quantiseHeading before it gets here), one uniform scale,
// every label placed by computed coordinates and kept upright (no rotate transform anywhere).

import { haversineMeters, STOP_MAX_ACCURACY_M } from './alight.js';
import { targetAngle } from './navarrow.js';
import { bearingDeg } from './compass.js';

export const AREA_ATTRIBUTION = '지도 © OpenStreetMap 기여자';
export const AREA_CAPTION = '대략적인 위치예요. 걷는 길이 아니라 직선이에요.';
export const AREA_SIZE = Object.freeze({ width: 360, height: 300 });
export const ROAD_CLASSES = Object.freeze(['primary', 'secondary', 'tertiary']);
// Roads a walker should not be sent across with a straight arrow.
export const MAJOR_CLASSES = Object.freeze(['primary', 'secondary']);
export const AT_STOP_M = 60; // within this of a route stop: "at the stop"
export const OFF_ROUTE_M = 400; // farther than this from the stop-to-stop line (and any stop): no progress claim
export const EXITS_MIN_SCALE = 0.45; // px per metre; zoomed out further than this, exit numbers are hidden

const EARTH_R = 6371008.8; // same radius as haversineMeters
const RAD = Math.PI / 180;
const norm360 = (deg) => ((deg % 360) + 360) % 360;
const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isFix = (p) => Boolean(p) && isNum(p.lat) && isNum(p.lon);
const f1 = (v) => Number(v).toFixed(1);
const escapeXml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------------------------------------------------------------- data

/** Error strings for the stored area file; empty means valid. */
export function validateArea(area) {
  const errors = [];
  if (!area || typeof area !== 'object' || Array.isArray(area)) return ['area must be an object'];
  for (const k of ['id', 'title', 'source', 'licence', 'retrieved']) {
    if (!isNonEmptyString(area[k])) errors.push(`area.${k} is missing`);
  }
  if (isNonEmptyString(area.licence) && !/OpenStreetMap/.test(area.licence)) errors.push('area.licence must name OpenStreetMap');
  const b = area.bbox;
  if (!b || !['minLat', 'minLon', 'maxLat', 'maxLon'].every((k) => isNum(b[k])) || b.minLat >= b.maxLat || b.minLon >= b.maxLon) {
    errors.push('area.bbox must have minLat < maxLat and minLon < maxLon');
  }
  const okPt = (p) => Array.isArray(p) && p.length === 2 && isNum(p[0]) && isNum(p[1]) && p[0] >= -90 && p[0] <= 90 && p[1] >= -180 && p[1] <= 180;
  if (!Array.isArray(area.roads) || area.roads.length === 0) errors.push('area.roads must be a non-empty array');
  else {
    area.roads.forEach((r, i) => {
      const where = `roads[${i}]`;
      if (!r || !Number.isInteger(r.id)) errors.push(`${where}.id must be an integer`);
      if (!r || !ROAD_CLASSES.includes(r.highway)) errors.push(`${where}.highway must be one of ${ROAD_CLASSES.join(', ')}`);
      if (r && r.name !== undefined && !isNonEmptyString(r.name)) errors.push(`${where}.name must be a non-empty string`);
      if (r && r.lanes !== undefined && !(Number.isInteger(r.lanes) && r.lanes > 0)) errors.push(`${where}.lanes must be a positive integer`);
      if (!r || !Array.isArray(r.pts) || r.pts.length < 2 || !r.pts.every(okPt)) errors.push(`${where}.pts must be 2 or more [lat, lon]`);
    });
  }
  if (!Array.isArray(area.exits) || area.exits.length === 0) errors.push('area.exits must be a non-empty array');
  else {
    const refs = new Set();
    area.exits.forEach((e, i) => {
      const where = `exits[${i}]`;
      if (!e || !isNonEmptyString(e.ref)) errors.push(`${where}.ref is missing`);
      else if (refs.has(e.ref)) errors.push(`${where}: duplicate ref ${e.ref}`);
      else refs.add(e.ref);
      if (!e || !Number.isInteger(e.id)) errors.push(`${where}.id (OSM node) must be an integer`);
      if (!e || !isFix(e)) errors.push(`${where} needs lat and lon`);
    });
  }
  const h = area.hospital;
  if (!h || !Number.isInteger(h.wayId) || !Array.isArray(h.outline) || h.outline.length < 3 || !h.outline.every(okPt)) {
    errors.push('area.hospital must have wayId and an outline of 3 or more [lat, lon]');
  }
  return errors;
}

export async function loadArea(url, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`area request failed: ${res.status}`);
  const obj = await res.json();
  const errors = validateArea(obj);
  if (errors.length) throw new Error(`invalid area: ${errors.join('; ')}`);
  return obj;
}

/** All stops of the loop, one per seq, from the route's busRoute blocks (the official GBIS values). */
export function loopStops(route) {
  const bySeq = new Map();
  for (const p of route.points) {
    if (!p.busRoute) continue;
    for (const st of p.busRoute.stops) if (!bySeq.has(st.seq)) bySeq.set(st.seq, { ...st });
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** Short stop name for a map label: the part before the first "." and any "(...)" dropped. */
export function shortStopName(name) {
  const first = String(name).split('.')[0].replace(/\(.*?\)/g, '').trim();
  return first || String(name);
}

// ---------------------------------------------------------------- projection and geometry

/** Local flat projection about `origin` ({lat, lon}): east/north metres. */
export function toLocal(origin, p) {
  const mLat = EARTH_R * RAD;
  const mLon = mLat * Math.cos(origin.lat * RAD);
  return { x: (p.lon - origin.lon) * mLon, y: (p.lat - origin.lat) * mLat };
}

/** Does segment a-b cross segment c-d? Points are {x, y}. Touching at an end counts as crossing. */
export function segmentsCross(a, b, c, d) {
  const o = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const o1 = o(a, b, c);
  const o2 = o(a, b, d);
  const o3 = o(c, d, a);
  const o4 = o(c, d, b);
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return true;
  const within = (p, q, r) => Math.min(p.x, q.x) <= r.x && r.x <= Math.max(p.x, q.x) && Math.min(p.y, q.y) <= r.y && r.y <= Math.max(p.y, q.y);
  return (o1 === 0 && within(a, b, c)) || (o2 === 0 && within(a, b, d)) || (o3 === 0 && within(c, d, a)) || (o4 === 0 && within(c, d, b));
}

/**
 * The major roads (primary, secondary) a straight line from `a` to `b` crosses, as [{id, name, highway}].
 * An empty list means the arrow would not send a walker across a big road.
 */
export function majorRoadCrossings(area, a, b) {
  const origin = { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 };
  const A = toLocal(origin, a);
  const B = toLocal(origin, b);
  const out = [];
  for (const r of area.roads) {
    if (!MAJOR_CLASSES.includes(r.highway)) continue;
    const pts = r.pts.map(([lat, lon]) => toLocal(origin, { lat, lon }));
    let hit = false;
    for (let i = 0; i + 1 < pts.length && !hit; i += 1) hit = segmentsCross(A, B, pts[i], pts[i + 1]);
    if (hit) out.push({ id: r.id, name: r.name || null, highway: r.highway });
  }
  return out;
}

/** Smallest distance in metres from the line a-b to any major road vertex or edge (for margin checks). */
export function majorRoadClearanceM(area, a, b) {
  const origin = { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 };
  const A = toLocal(origin, a);
  const B = toLocal(origin, b);
  const segDist = (p, s, e) => {
    const dx = e.x - s.x;
    const dy = e.y - s.y;
    const L2 = dx * dx + dy * dy;
    const t = L2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - s.x) * dx + (p.y - s.y) * dy) / L2));
    return Math.hypot(p.x - (s.x + t * dx), p.y - (s.y + t * dy));
  };
  let best = Infinity;
  for (const r of area.roads) {
    if (!MAJOR_CLASSES.includes(r.highway)) continue;
    const pts = r.pts.map(([lat, lon]) => toLocal(origin, { lat, lon }));
    for (let i = 0; i + 1 < pts.length; i += 1) {
      // distance between two segments = min of the four endpoint-to-segment distances (they do not cross)
      best = Math.min(best, segDist(pts[i], A, B), segDist(pts[i + 1], A, B), segDist(A, pts[i], pts[i + 1]), segDist(B, pts[i], pts[i + 1]));
    }
  }
  return best;
}

/**
 * Geometry of the map: heading up (`headingDeg` null means north up), one uniform scale that fits the
 * bounding box of `points` (at least `minSpanM` metres across) into the drawing box, centred.
 * Returns {at(lat, lon) -> {x, y} (SVG units, y down), scale (px per metre), northAngle, headingUsed}.
 */
export function areaGeometry({ points, headingDeg = null, size = AREA_SIZE, margin = 34, minSpanM = 200 }) {
  const pts = points.filter(isFix);
  const lats = pts.map((p) => p.lat);
  const lons = pts.map((p) => p.lon);
  const origin = pts.length
    ? { lat: (Math.min(...lats) + Math.max(...lats)) / 2, lon: (Math.min(...lons) + Math.max(...lons)) / 2 }
    : { lat: 37.351, lon: 127.116 };
  const headingUsed = Number.isFinite(headingDeg) ? norm360(headingDeg) : 0;
  const theta = -headingUsed * RAD; // clockwise on screen (y down); heading -> up
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const rot = (p) => {
    const q = toLocal(origin, p);
    const vx = q.x;
    const vy = -q.y; // north is up on the screen
    return { x: vx * cos - vy * sin, y: vx * sin + vy * cos };
  };
  const r = pts.map(rot);
  const x0 = r.length ? Math.min(...r.map((p) => p.x)) : 0;
  const x1 = r.length ? Math.max(...r.map((p) => p.x)) : 0;
  const y0 = r.length ? Math.min(...r.map((p) => p.y)) : 0;
  const y1 = r.length ? Math.max(...r.map((p) => p.y)) : 0;
  const spanX = Math.max(x1 - x0, minSpanM);
  const spanY = Math.max(y1 - y0, minSpanM);
  const scale = Math.min((size.width - 2 * margin) / spanX, (size.height - 2 * margin) / spanY);
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const at = (lat, lon) => {
    const q = rot({ lat, lon });
    return { x: size.width / 2 + scale * (q.x - cx), y: size.height / 2 + scale * (q.y - cy) };
  };
  return { at, scale, northAngle: norm360(-headingUsed), headingUsed };
}

// ---------------------------------------------------------------- walking: where the line starts

/**
 * Where a walk point starts, for the map in simulation mode and for the fit before a first position
 * fix: the stop the previous bus point ends at (O4, R4), else the approximate hospital entrance (R1,
 * after the indoor part), else the station exit the first point names (O1). null when unknown.
 */
export function walkStart(route, area, index) {
  const p = route.points[index];
  if (!p || !p.target) return null;
  const prev = route.points[index - 1];
  if (prev && prev.alertCoord) return { lat: prev.alertCoord.lat, lon: prev.alertCoord.lon, name: '내린 정류장' };
  if (prev && prev.stage === 'indoor') {
    const gate = route.points.find((q) => q.target && q.target.approx);
    return gate ? { lat: gate.target.lat, lon: gate.target.lon, name: gate.target.name } : null;
  }
  if (!prev) {
    const m = /(\d+)번 출구/.exec(p.display);
    const ex = m && area ? area.exits.find((e) => e.ref === m[1]) : null;
    return ex ? { lat: ex.lat, lon: ex.lon, name: `미금역 ${ex.ref}번 출구` } : null;
  }
  return null;
}

/**
 * Simulation arrow of a walking point (O1, O4, R1, R4): from where the walk starts (walkStart, the
 * same place the distance line uses) to the point's official target. Returns {bearing, angle} or null
 * when the point has no target, the start is unknown or the heading is not a number.
 */
export function simWalkArrow(route, area, index, headingDeg) {
  const p = route.points[index];
  const start = walkStart(route, area, index);
  if (!p || !p.target || !start) return null;
  const angle = targetAngle(start, p.target, headingDeg);
  return angle === null ? null : { bearing: bearingDeg(start, p.target), angle };
}

// ---------------------------------------------------------------- riding progress

/**
 * Progress along the stops of a ride. `stops` is the ordered list up to the alight stop (the route
 * point's busRoute.stops), `alightSeq` the stop to get off at, `prev` the previous result (progress
 * never goes backwards). A fix with accuracy over 80 m changes nothing. Returns null while unknown,
 * else {lastIndex, atStop, nextIndex, remaining}: `lastIndex` is the last stop passed (or the stop the
 * bus is at), `nextIndex` the stop ahead, `remaining` the number of stops until the alight stop (0 at it).
 */
export function ridingProgress(pos, stops, alightSeq, prev = null) {
  const alightIdx = stops.findIndex((s) => s.seq === alightSeq);
  if (alightIdx < 0) return prev;
  if (!isFix(pos)) return prev;
  if (Number.isFinite(pos.accuracy) && pos.accuracy > STOP_MAX_ACCURACY_M) return prev;
  const floor = prev ? prev.lastIndex : 0;
  const make = (lastIndex, atStop) => {
    const last = Math.min(Math.max(lastIndex, floor), alightIdx);
    const at = atStop && last === lastIndex;
    return { lastIndex: last, atStop: at, nextIndex: Math.min(last + 1, alightIdx), remaining: alightIdx - last };
  };
  // At a stop: the nearest stop at or after the last one passed, within 60 m.
  let nearest = -1;
  let nearestD = Infinity;
  for (let i = floor; i <= alightIdx; i += 1) {
    const d = haversineMeters(pos, stops[i]);
    if (d < nearestD) { nearestD = d; nearest = i; }
  }
  if (nearest >= 0 && nearestD <= AT_STOP_M) return make(nearest, true);
  // Between two stops: the straight stop-to-stop segment (at or after the last one passed) nearest to the fix.
  let bestSeg = -1;
  let bestD = Infinity;
  for (let i = floor; i < alightIdx; i += 1) {
    const origin = stops[i];
    const P = toLocal(origin, pos);
    const E = toLocal(origin, stops[i + 1]);
    const L2 = E.x * E.x + E.y * E.y;
    const t = L2 === 0 ? 0 : Math.max(0, Math.min(1, (P.x * E.x + P.y * E.y) / L2));
    const d = Math.hypot(P.x - t * E.x, P.y - t * E.y);
    if (d < bestD) { bestD = d; bestSeg = i; }
  }
  if (bestSeg < 0 || bestD > OFF_ROUTE_M) return prev;
  return make(bestSeg, false);
}

/** "내릴 곳까지 3정거장" (the count of stops until the alight stop); "내릴 곳에 왔어요" at it. null when unknown. */
export function remainingText(progress) {
  if (!progress) return null;
  return progress.remaining <= 0 ? '내릴 곳에 왔어요' : `내릴 곳까지 ${progress.remaining}정거장`;
}

/** Name line under the count: "다음 정류장: 서울대학교병원" (null at the alight stop or when unknown). */
export function nextStopText(progress, stops) {
  if (!progress || progress.remaining <= 0) return null;
  const st = stops[progress.nextIndex];
  return st ? `다음 정류장: ${shortStopName(st.name)}` : null;
}

// ---------------------------------------------------------------- scene for one route point

/** Live buses as map markers: each loop seq to its official stop coordinate. */
export function busMarkers(route, seqs) {
  const stops = loopStops(route);
  const out = [];
  for (const seq of seqs || []) {
    const st = stops.find((s) => s.seq === seq);
    if (st) out.push({ seq, lat: st.lat, lon: st.lon });
  }
  return out;
}

/**
 * What to draw for route point `index`, or null when this point has no outdoor map.
 *  walk (a point with `target`): me (a real fix, or in simulation the start), target, dashed line.
 *  wait (a point with `arrival`): the loop stops, the boarding stop, live buses.
 *  ride (a point with `busRoute`): the stops of the ride, me, passed/next/alight stops.
 * `state`: {pos, sim, headingDeg, progress, busSeqs}.
 */
export function sceneFor(route, area, index, { pos = null, sim = false, headingDeg = null, progress = null, busSeqs = [] } = {}) {
  const p = route.points[index];
  if (!p || !area) return null;
  if (p.target) {
    const start = walkStart(route, area, index);
    const me = sim ? (start ? { lat: start.lat, lon: start.lon, accuracy: 10 } : null) : (isFix(pos) ? pos : null);
    const fit = [p.target, me || start].filter(isFix);
    const aria = me
      ? `바깥 지도. 내 위치에서 ${p.target.name}까지 직선 거리 약 ${Math.round(haversineMeters(me, p.target))} m.`
      : `바깥 지도. ${p.target.name} 위치.`;
    return {
      kind: 'walk',
      opts: { me, target: { lat: p.target.lat, lon: p.target.lon, label: shortStopName(p.target.name) }, line: Boolean(me), fit, headingDeg, aria },
    };
  }
  if (p.arrival) {
    const loop = loopStops(route);
    const board = p.boardCoord;
    const buses = busMarkers(route, busSeqs);
    const stops = loop.map((st) => ({ ...st, role: st.seq === p.arrival.boardSeq ? 'board' : 'stop' }));
    const fit = [board, ...buses].filter(isFix);
    return {
      kind: 'wait',
      opts: { stops, routeLine: loop, buses, fit, headingDeg: null, aria: `바깥 지도. 타는 정류장과 ${p.arrival.routeName}번 버스 위치.` },
    };
  }
  if (p.busRoute) {
    const ride = p.busRoute.stops.filter((st) => st.seq <= p.busRoute.alightSeq);
    const stops = ride.map((st, i) => {
      let role = 'stop';
      if (st.seq === p.busRoute.alightSeq) role = 'alight';
      else if (progress && i === progress.nextIndex) role = 'next';
      else if (progress && i <= progress.lastIndex) role = 'passed';
      return { ...st, role };
    });
    const me = isFix(pos) ? pos : null;
    const fit = [...ride, me].filter(isFix);
    return {
      kind: 'ride',
      opts: { stops, routeLine: ride, me, fit, headingDeg: null, aria: `바깥 지도. ${p.busRoute.routeName}번 버스가 지나는 정류장과 내 위치.` },
      texts: { remaining: remainingText(progress), next: nextStopText(progress, ride) },
    };
  }
  return null;
}

// ---------------------------------------------------------------- drawing

const INK = '#111827';
const LAND = '#f1f5f9';
const BUILDING = '#cbd5e1';
const ROAD_FILL = '#ffffff';
const ROAD_EDGE = '#64748b';
const ROUTE = '#7c3aed';
const ME = '#2563eb';
const TARGET = '#dc2626';
const FONT = { label: 17, small: 14, road: 15 };

const textW = (text, size) => [...String(text)].reduce((w, ch) => w + (/[ᄀ-ᇿ㄰-㆏가-힯]/.test(ch) ? size : size * 0.6), 0);

/** Placed label boxes; `place` tries the candidate spots in order and keeps the first free one. */
function labelPlacer(size, obstacles) {
  const boxes = [...obstacles];
  const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  return {
    place(text, ax, ay, r, fontSize, prefer = ['up', 'right', 'down', 'left']) {
      const w = textW(text, fontSize) + 6;
      const h = fontSize + 6;
      const spots = prefer.map((side) => {
        if (side === 'up') return { x: ax - w / 2, y: ay - r - 4 - h, anchor: 'middle' };
        if (side === 'down') return { x: ax - w / 2, y: ay + r + 4, anchor: 'middle' };
        if (side === 'left') return { x: ax - r - 5 - w, y: ay - h / 2, anchor: 'end' };
        if (side === 'center') return { x: ax - w / 2, y: ay - h / 2, anchor: 'middle' };
        return { x: ax + r + 5, y: ay - h / 2, anchor: 'start' };
      });
      let chosen = null;
      for (const s of spots) {
        const box = { x: Math.min(Math.max(s.x, 2), size.width - w - 2), y: Math.min(Math.max(s.y, 2), size.height - h - 2), w, h };
        if (!boxes.some((b) => hit(box, b))) { chosen = { box, anchor: s.anchor }; break; }
      }
      if (!chosen) return null;
      boxes.push(chosen.box);
      const { box, anchor } = chosen;
      const tx = anchor === 'middle' ? box.x + box.w / 2 : (anchor === 'end' ? box.x + box.w - 3 : box.x + 3);
      return { x: tx, y: box.y + box.h / 2, anchor };
    },
  };
}

/**
 * The longest stretch of a screen polyline that lies at least `inset` px inside the box: sampled every
 * 4 px; returns {length (px), samples [{x, y}]} or null when no sample is inside.
 */
function longestVisibleRun(pts, size, inset) {
  const inside = (q) => q.x > inset && q.x < size.width - inset && q.y > inset && q.y < size.height - inset;
  let best = null;
  let cur = [];
  const close = () => {
    if (cur.length && (!best || cur.length > best.samples.length)) best = { length: cur.length * 4, samples: cur };
    cur = [];
  };
  for (let i = 0; i + 1 < pts.length; i += 1) {
    const a = pts[i];
    const b = pts[i + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 4));
    for (let k = 0; k < n; k += 1) {
      const q = { x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n };
      if (inside(q)) cur.push(q);
      else close();
    }
  }
  close();
  return best;
}

function haloText(text, pos, { size, weight = 800, fill = INK, attrs = '' }) {
  return `<text ${attrs} x="${f1(pos.x)}" y="${f1(pos.y)}" dy="0.35em" text-anchor="${pos.anchor}" font-size="${size}" font-weight="${weight}" `
    + `fill="${fill}" stroke="#fff" stroke-width="4" stroke-linejoin="round" paint-order="stroke">${escapeXml(text)}</text>`;
}

/**
 * The outdoor map as one HTML string: a figure with an inline SVG and the attribution caption.
 * `opts`: {me {lat, lon, accuracy}, target {lat, lon, label}, line, stops [{seq, name, lat, lon, role}],
 * routeLine [{lat, lon}], buses [{lat, lon}], fit [{lat, lon}], headingDeg, aria}. Stop circles carry
 * data-seq/data-lat/data-lon and exit circles data-ref/data-lat/data-lon, so the picture can be
 * checked against the route data and the stored OpenStreetMap values.
 */
export function renderAreaMap(area, opts = {}) {
  const size = AREA_SIZE;
  const stops = opts.stops || [];
  const buses = opts.buses || [];
  const fitPts = (opts.fit && opts.fit.length ? opts.fit : [opts.me, opts.target, ...stops, ...buses]).filter(isFix);
  const geo = areaGeometry({ points: fitPts, headingDeg: opts.headingDeg ?? null, size });
  const P = (o) => geo.at(o.lat, o.lon);
  const parts = [];
  const inView = (pt, m = 40) => pt.x > -m && pt.x < size.width + m && pt.y > -m && pt.y < size.height + m;
  const polyBox = (pts) => {
    const xs = pts.map((q) => q.x);
    const ys = pts.map((q) => q.y);
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  };
  const overlapsView = (pts) => {
    const b = polyBox(pts);
    return b.x1 > -40 && b.x0 < size.width + 40 && b.y1 > -40 && b.y0 < size.height + 40;
  };
  const pointsAttr = (pts) => pts.map((q) => `${f1(q.x)},${f1(q.y)}`).join(' ');

  parts.push(`<rect x="0" y="0" width="${size.width}" height="${size.height}" fill="${LAND}"/>`);

  // hospital building
  const hosp = area.hospital.outline.map(([lat, lon]) => geo.at(lat, lon));
  if (overlapsView(hosp)) {
    parts.push(`<polygon data-hospital="1" points="${pointsAttr(hosp)}" fill="${BUILDING}" stroke="#94a3b8" stroke-width="1.5" stroke-linejoin="round"/>`);
  }

  // roads: small ones first, big ones on top
  const roadOrder = { tertiary: 0, secondary: 1, primary: 2 };
  const roads = [...area.roads].sort((a, b) => roadOrder[a.highway] - roadOrder[b.highway]);
  const roadScreen = new Map();
  for (const r of roads) {
    const pts = r.pts.map(([lat, lon]) => geo.at(lat, lon));
    if (!overlapsView(pts)) continue;
    roadScreen.set(r, pts);
    const widthM = (r.lanes || 2) * 3.5;
    const w = Math.min(14, Math.max(3.5, geo.scale * widthM));
    parts.push(`<polyline data-road="${r.id}" points="${pointsAttr(pts)}" fill="none" stroke="${ROAD_EDGE}" stroke-width="${f1(w + 3)}" stroke-linecap="round" stroke-linejoin="round"/>`);
  }
  for (const [r, pts] of roadScreen) {
    const widthM = (r.lanes || 2) * 3.5;
    const w = Math.min(14, Math.max(3.5, geo.scale * widthM));
    parts.push(`<polyline points="${pointsAttr(pts)}" fill="none" stroke="${ROAD_FILL}" stroke-width="${f1(w)}" stroke-linecap="round" stroke-linejoin="round"/>`);
  }
  // The edges of all roads first and the fills after: crossings read as junctions, not as bridges.

  // bus route line
  if (opts.routeLine && opts.routeLine.length > 1) {
    parts.push(`<polyline data-route-line="1" points="${pointsAttr(opts.routeLine.map(P))}" fill="none" stroke="${ROUTE}" stroke-width="5" stroke-dasharray="2 8" stroke-linecap="round" stroke-linejoin="round" opacity="0.9"/>`);
  }

  // walk line: me -> target
  const me = isFix(opts.me) ? P(opts.me) : null;
  const tgt = isFix(opts.target) ? P(opts.target) : null;
  if (opts.line && me && tgt) {
    parts.push(`<line data-walk-line="1" x1="${f1(me.x)}" y1="${f1(me.y)}" x2="${f1(tgt.x)}" y2="${f1(tgt.y)}" stroke="${INK}" stroke-width="4.5" stroke-dasharray="9 7" stroke-linecap="butt"/>`);
  }

  // accuracy ring (kept readable: at most 70 px)
  if (me && Number.isFinite(opts.me.accuracy)) {
    const rr = Math.min(70, Math.max(0, opts.me.accuracy * geo.scale));
    if (rr > 12) parts.push(`<circle data-accuracy="1" cx="${f1(me.x)}" cy="${f1(me.y)}" r="${f1(rr)}" fill="${ME}" fill-opacity="0.15" stroke="${ME}" stroke-opacity="0.5" stroke-width="1.5"/>`);
  }

  const obstacles = [];
  const circles = [];
  const labels = [];

  // station exits
  const showExits = geo.scale >= EXITS_MIN_SCALE;
  const exitPts = area.exits.map((e) => ({ e, q: geo.at(e.lat, e.lon) }));
  for (const { e, q } of exitPts) {
    const isTarget = tgt && Math.hypot(q.x - tgt.x, q.y - tgt.y) < 4;
    if (!showExits || !inView(q, 0) || isTarget) continue;
    circles.push(`<circle data-exit="1" data-ref="${escapeXml(e.ref)}" data-lat="${e.lat}" data-lon="${e.lon}" cx="${f1(q.x)}" cy="${f1(q.y)}" r="10" fill="#fff" stroke="${INK}" stroke-width="2.5"/>`
      + `<text x="${f1(q.x)}" y="${f1(q.y)}" dy="0.35em" text-anchor="middle" font-size="13" font-weight="900" fill="${INK}">${escapeXml(e.ref)}</text>`);
    obstacles.push({ x: q.x - 11, y: q.y - 11, w: 22, h: 22 });
  }

  // stops
  const stopDraw = [];
  for (const st of stops) {
    const q = P(st);
    if (!inView(q, 10)) continue;
    const role = st.role || 'stop';
    const fill = { passed: '#94a3b8', next: '#fde047', alight: '#fb923c', board: '#6ee7b7', stop: '#fff' }[role] || '#fff';
    const r = role === 'alight' || role === 'next' || role === 'board' ? 10 : 7.5;
    circles.push(`<circle data-stop="1" data-seq="${st.seq}" data-lat="${st.lat}" data-lon="${st.lon}" data-role="${role}" cx="${f1(q.x)}" cy="${f1(q.y)}" r="${r}" fill="${fill}" stroke="${INK}" stroke-width="${role === 'stop' || role === 'passed' ? 2.5 : 3.5}"/>`);
    obstacles.push({ x: q.x - r - 2, y: q.y - r - 2, w: 2 * r + 4, h: 2 * r + 4 });
    stopDraw.push({ st, q, r, role });
  }

  // buses
  const busDraw = [];
  for (const b of buses) {
    const q = P(b);
    if (!inView(q, 10)) continue;
    circles.push(`<g data-bus="1" data-seq="${b.seq ?? ''}"><rect x="${f1(q.x - 17)}" y="${f1(q.y - 24)}" width="34" height="20" rx="6" fill="${ME}" stroke="#fff" stroke-width="2.5"/>`
      + `<text x="${f1(q.x)}" y="${f1(q.y - 14)}" dy="0.35em" text-anchor="middle" font-size="13" font-weight="900" fill="#fff">버스</text></g>`);
    obstacles.push({ x: q.x - 18, y: q.y - 26, w: 36, h: 24 });
    busDraw.push(q);
  }

  // target
  if (tgt) {
    circles.push(`<g data-target="1"><circle cx="${f1(tgt.x)}" cy="${f1(tgt.y)}" r="16" fill="none" stroke="${TARGET}" stroke-width="3.5"/>`
      + `<circle cx="${f1(tgt.x)}" cy="${f1(tgt.y)}" r="7" fill="${TARGET}" stroke="#fff" stroke-width="2.5"/></g>`);
    obstacles.push({ x: tgt.x - 18, y: tgt.y - 18, w: 36, h: 36 });
  }

  // me (on top): a dot, with a small wedge pointing up when the map is turned to the heading
  if (me) {
    const wedge = opts.headingDeg !== null && opts.headingDeg !== undefined
      ? `<polygon points="${f1(me.x)},${f1(me.y - 19)} ${f1(me.x - 7)},${f1(me.y - 8)} ${f1(me.x + 7)},${f1(me.y - 8)}" fill="${ME}" stroke="#fff" stroke-width="2" stroke-linejoin="round"/>`
      : '';
    circles.push(`<g data-me="1">${wedge}<circle cx="${f1(me.x)}" cy="${f1(me.y)}" r="9" fill="${ME}" stroke="#fff" stroke-width="3.5"/></g>`);
    obstacles.push({ x: me.x - 12, y: me.y - 22, w: 24, h: 34 });
  }

  // labels, most important first
  const placer = labelPlacer(size, obstacles);
  if (tgt && opts.target.label) {
    const pos = placer.place(opts.target.label, tgt.x, tgt.y, 16, FONT.label, ['up', 'down', 'right', 'left']);
    if (pos) labels.push(haloText(opts.target.label, pos, { size: FONT.label, fill: TARGET, attrs: 'data-label="target"' }));
  }
  const roleText = { alight: '내릴 곳', next: '다음', board: '타는 곳' };
  for (const role of ['alight', 'next', 'board']) {
    for (const d of stopDraw.filter((x) => x.role === role)) {
      const text = `${roleText[role]} ${shortStopName(d.st.name)}`;
      const pos = placer.place(text, d.q.x, d.q.y, d.r, FONT.label, ['up', 'down', 'right', 'left']);
      if (pos) labels.push(haloText(text, pos, { size: FONT.label, attrs: `data-label="${role}"` }));
    }
  }
  // road names: once per name, on the middle of the longest stretch that lies inside the view
  const named = new Map();
  for (const [r, pts] of roadScreen) {
    if (!r.name || !MAJOR_CLASSES.includes(r.highway)) continue;
    const run = longestVisibleRun(pts, size, 30);
    if (!run) continue;
    const prev = named.get(r.name);
    if (!prev || run.length > prev.length) named.set(r.name, run);
  }
  for (const [name, run] of named) {
    const mid = run.samples[Math.floor(run.samples.length / 2)];
    const pos = placer.place(name, mid.x, mid.y, 0, FONT.road, ['center', 'up', 'down']);
    if (pos) labels.push(haloText(name, pos, { size: FONT.road, weight: 700, fill: '#475569', attrs: 'data-label="road"' }));
  }
  // the station name when exit numbers are hidden or elsewhere on the map
  const stationPts = exitPts.map((x) => x.q).filter((q) => inView(q, 0));
  if (stationPts.length) {
    const cx = stationPts.reduce((a, q) => a + q.x, 0) / stationPts.length;
    const cy = stationPts.reduce((a, q) => a + q.y, 0) / stationPts.length;
    const pos = placer.place('미금역', cx, cy, showExits ? 22 : 6, FONT.label, ['down', 'up', 'right', 'left']);
    if (pos) labels.push(haloText('미금역', pos, { size: FONT.label, weight: 900, attrs: 'data-label="station"' }));
  }
  const hospIn = hosp.filter((q) => inView(q, -10));
  if (hospIn.length >= 3) {
    const cx = hospIn.reduce((a, q) => a + q.x, 0) / hospIn.length;
    const cy = hospIn.reduce((a, q) => a + q.y, 0) / hospIn.length;
    const pos = placer.place('병원', cx, cy, 0, FONT.label, ['center', 'up', 'down']);
    if (pos) labels.push(haloText('병원', pos, { size: FONT.label, weight: 900, fill: '#475569', attrs: 'data-label="hospital"' }));
  }

  parts.push(...circles, ...labels);

  // north marker (upright; needle placed by computed coordinates)
  const nc = { x: size.width - 24, y: 24 };
  const nr = (geo.northAngle * Math.PI) / 180;
  const nd = { x: Math.sin(nr), y: -Math.cos(nr) };
  const np = { x: -nd.y, y: nd.x };
  const at = (along, side) => `${f1(nc.x + nd.x * along + np.x * side)},${f1(nc.y + nd.y * along + np.y * side)}`;
  parts.push(`<circle data-north-disc="1" cx="${f1(nc.x)}" cy="${f1(nc.y)}" r="17" fill="#fff" fill-opacity="0.92" stroke="#94a3b8" stroke-width="1.5"/>`
    + `<polygon data-north-needle="1" points="${at(11, 0)} ${at(-7, 6)} ${at(-2, 0)} ${at(-7, -6)}" fill="${INK}" stroke="${INK}" stroke-width="1.5" stroke-linejoin="round"/>`
    + `<text data-north-label="1" x="${f1(nc.x - 17 - 12)}" y="${f1(nc.y)}" dy="0.35em" text-anchor="middle" font-size="${FONT.label}" font-weight="900" fill="${INK}" stroke="#fff" stroke-width="4" paint-order="stroke">북</text>`);

  const aria = opts.aria || '바깥 지도';
  const svg = `<svg class="area-svg" viewBox="0 0 ${size.width} ${size.height}" role="img" aria-label="${escapeXml(aria)}" `
    + `xmlns="http://www.w3.org/2000/svg" focusable="false">${parts.join('')}</svg>`;
  const upNote = opts.headingDeg === null || opts.headingDeg === undefined ? '위쪽이 북쪽이에요.' : '위쪽이 바라보는 쪽이에요.';
  return `<figure class="area-map" id="area-map" data-up="${opts.headingDeg === null || opts.headingDeg === undefined ? 'north' : 'heading'}">${svg}`
    + `<figcaption class="area-caption" id="area-caption">${escapeXml(upNote)} ${escapeXml(AREA_CAPTION)} ${escapeXml(AREA_ATTRIBUTION)}</figcaption></figure>`;
}
