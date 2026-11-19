// Route schema validation and loading. Pure, importable in Node (no DOM access).

const STAGES = ['travel', 'indoor', 'return'];
const KINDS = ['walk', 'bus', 'indoor'];
// Stages that happen outdoors on foot or by bus; the get-off arrows and board lookups treat them alike.
export const OUTDOOR_STAGES = Object.freeze(['travel', 'return']);
const STATUSES = ['현장 미확인', '현장 확인'];
const STRING_FIELDS = ['id', 'display', 'speech', 'confirmLabel', 'source'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';
const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

/** Returns a list of error strings. An empty list means the route is valid. */
export function validateRoute(obj) {
  const errors = [];
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return ['route must be an object'];
  }
  for (const name of ['id', 'title', 'retrieved']) {
    if (!isNonEmptyString(obj[name])) errors.push(`route.${name} is missing`);
  }
  if (!Array.isArray(obj.points) || obj.points.length === 0) {
    errors.push('route.points must be a non-empty array');
    return errors;
  }
  const seen = new Set();
  obj.points.forEach((p, i) => {
    const where = `points[${i}]`;
    if (p === null || typeof p !== 'object') {
      errors.push(`${where} must be an object`);
      return;
    }
    const tag = isNonEmptyString(p.id) ? `${where} (${p.id})` : where;
    for (const f of STRING_FIELDS) {
      if (!isNonEmptyString(p[f])) errors.push(`${tag}.${f} is missing`);
    }
    if (isNonEmptyString(p.id)) {
      if (seen.has(p.id)) errors.push(`${tag}: duplicate id`);
      seen.add(p.id);
    }
    if (!STAGES.includes(p.stage)) errors.push(`${tag}.stage must be one of ${STAGES.join(', ')}`);
    if (!KINDS.includes(p.kind)) errors.push(`${tag}.kind must be one of ${KINDS.join(', ')}`);
    if (STAGES.includes(p.stage) && KINDS.includes(p.kind)) {
      if ((p.stage === 'indoor') !== (p.kind === 'indoor')) {
        errors.push(`${tag}: stage ${p.stage} does not match kind ${p.kind}`);
      }
      // travel and return are the outdoor stages: walk or bus only (indoor is caught above)
    }
    if (p.facility !== undefined && !(Number.isInteger(p.facility) && p.facility > 0)) {
      errors.push(`${tag}.facility must be a positive integer`);
    }
    if (p.floor !== undefined && !isNonEmptyString(p.floor)) errors.push(`${tag}.floor must be a non-empty string`);
    if (p.facility !== undefined && p.floor === undefined) errors.push(`${tag}: facility needs a floor`);
    if (p.wait !== undefined && typeof p.wait !== 'boolean') errors.push(`${tag}.wait must be a boolean`);
    if (p.order !== i + 1) errors.push(`${tag}.order must be ${i + 1}`);
    if (typeof p.detail !== 'string') errors.push(`${tag}.detail must be a string (may be empty)`);
    if (p.sign !== null && !isNonEmptyString(p.sign)) errors.push(`${tag}.sign must be a string or null`);
    if (p.busNumber !== null && !isNonEmptyString(p.busNumber)) {
      errors.push(`${tag}.busNumber must be a string or null`);
    }
    if (p.kind !== 'bus' && p.busNumber) errors.push(`${tag}: busNumber is only allowed on kind bus`);
    if (p.coord !== null) {
      const c = p.coord;
      const ok = c && typeof c === 'object' && isFiniteNumber(c.lat) && isFiniteNumber(c.lon) &&
        c.lat >= -90 && c.lat <= 90 && c.lon >= -180 && c.lon <= 180;
      if (!ok) errors.push(`${tag}.coord must be null or {lat, lon}`);
    }
    for (const key of ['alertCoord', 'boardCoord']) {
      if (p[key] === undefined) continue;
      const c = p[key];
      const ok = c && typeof c === 'object' && isFiniteNumber(c.lat) && isFiniteNumber(c.lon) &&
        c.lat >= -90 && c.lat <= 90 && c.lon >= -180 && c.lon <= 180 &&
        isNonEmptyString(c.source) && STATUSES.includes(c.status);
      if (!ok) errors.push(`${tag}.${key} must be {lat, lon, source, status}`);
    }
    if (p.hours !== undefined && !isNonEmptyString(p.hours)) errors.push(`${tag}.hours must be a non-empty string`);
    if (p.arrival !== undefined) {
      const a = p.arrival;
      if (!a || !isFiniteNumber(a.stationId) || !isFiniteNumber(a.routeId) || !isNonEmptyString(a.routeName) ||
        !Number.isInteger(a.loopStops) || a.loopStops < 1 || !Number.isInteger(a.boardSeq) || a.boardSeq < 1 || a.boardSeq > a.loopStops) {
        errors.push(`${tag}.arrival must be {stationId, routeId, routeName, loopStops, boardSeq} with 1 <= boardSeq <= loopStops`);
      }
    }
    if (p.busRoute !== undefined) {
      const b = p.busRoute;
      const stopOk = (st) => st && Number.isInteger(st.seq) && isFiniteNumber(st.id) && isNonEmptyString(st.name) &&
        isFiniteNumber(st.lat) && isFiniteNumber(st.lon) && st.lat >= -90 && st.lat <= 90 && st.lon >= -180 && st.lon <= 180;
      const ok = b && isNonEmptyString(b.routeName) && isFiniteNumber(b.routeId) && isNonEmptyString(b.source) &&
        Array.isArray(b.stops) && b.stops.length >= 2 && b.stops.every(stopOk) &&
        b.stops.every((st, i) => i === 0 || st.seq > b.stops[i - 1].seq) &&
        b.stops.some((st) => st.seq === b.alightSeq);
      if (!ok) errors.push(`${tag}.busRoute must have routeName, routeId, source, ordered stops and an alightSeq that is one of them`);
    }
    if (!p.sim || !isFiniteNumber(p.sim.x) || !isFiniteNumber(p.sim.y)) {
      errors.push(`${tag}.sim must be {x, y} numbers`);
    }
    if (!STATUSES.includes(p.status)) {
      errors.push(`${tag}.status must be one of ${STATUSES.join(', ')}`);
    } else if (p.status === '현장 확인') {
      if (typeof p.checkedOn !== 'string' || !DATE_RE.test(p.checkedOn)) {
        errors.push(`${tag}: status 현장 확인 needs checkedOn as YYYY-MM-DD`);
      }
    } else if (p.checkedOn !== null) {
      errors.push(`${tag}: status 현장 미확인 requires checkedOn null`);
    }
    if (typeof p.gap !== 'boolean') errors.push(`${tag}.gap must be a boolean`);
  });
  return errors;
}

/** Fetches, parses and validates a route. Throws with the error list on failure. */
export async function loadRoute(url, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`route request failed: ${res.status}`);
  const obj = await res.json();
  const errors = validateRoute(obj);
  if (errors.length) throw new Error(`invalid route: ${errors.join('; ')}`);
  return obj;
}
