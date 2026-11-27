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
    if (p.mark !== undefined && !isNonEmptyString(p.mark)) errors.push(`${tag}.mark must be a non-empty string`);
    if (p.help !== undefined && !isNonEmptyString(p.help)) errors.push(`${tag}.help must be a non-empty string`);
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
    if (p.target !== undefined) {
      const c = p.target;
      const ok = c && typeof c === 'object' && isFiniteNumber(c.lat) && isFiniteNumber(c.lon) &&
        c.lat >= -90 && c.lat <= 90 && c.lon >= -180 && c.lon <= 180 &&
        isNonEmptyString(c.name) && isNonEmptyString(c.source) && STATUSES.includes(c.status);
      if (!ok) errors.push(`${tag}.target must be {lat, lon, name, source, status}`);
      else if (c.approx !== undefined && typeof c.approx !== 'boolean') errors.push(`${tag}.target.approx must be a boolean`);
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

// ---------------------------------------------------------------- department choice
// The visit wizard asks which department the user goes to. The answer changes route points I3 (where to
// register) and I4 (waiting) through applyDept(); the route file itself is never edited. This table is the
// one place that knows the departments: `value` is the answer id, `label` the button and confirm-screen
// wording, `name` the short form used inside spoken sentences. `facility` is the number on the 1F plan
// (data/floor.snubh-1dong-1f.json, checked by tests/dept.test.mjs); `floorName` is that plan's own label.
// A department without a facility on this plan lists the plan marks it may point to in `marks`.
export const DEPARTMENTS = Object.freeze([
  { value: 'geriatric', label: '노인의료센터', name: '노인의료센터', facility: 9, floorName: '노인의료센터' },
  { value: 'joint', label: '관절센터', name: '관절센터', facility: 6, floorName: '관절센터' },
  { value: 'spine', label: '척추센터', name: '척추센터', facility: 5, floorName: '척추센터' },
  // 안과 is on 1동 2층 (no. 15 of the hospital's 2F guide); the app has no 2F plan, so it points to the
  // elevator (walker, wheelchair) or the escalator on the 1F plan.
  { value: 'eye', label: '안과', name: '안과', marks: ['elevator', 'escalator'], upstairs: '1동 2층 15번 안과' },
  { value: 'internal', label: '내과', name: '내과', facility: 11, floorName: '내과' },
  { value: 'heart', label: '심장혈관센터', name: '심장혈관센터', facility: 4, floorName: '심장혈관센터' },
  { value: 'rehab', label: '재활의학과', name: '재활의학과', facility: 10, floorName: '재활의학과' },
  { value: 'lung', label: '폐센터(흉부외과)', name: '폐센터', facility: 8, floorName: '폐센터 흉부외과' },
  // Unknown department: the information desk on the 1F plan.
  { value: 'other', label: '다른 진료과', name: '다른 진료과', marks: ['info'] },
]);

export const DEFAULT_DEPT = 'geriatric'; // what the route was written for; also the meaning of "no answer"
const LIFT_MOBILITY = Object.freeze(['walker', 'wheelchair']); // these users are sent to the elevator

export const deptByValue = (value) => DEPARTMENTS.find((d) => d.value === value) || null;

const NEAR_STAFF_DETAIL = '순서가 되면 이름을 불러요. 잘 모르시겠으면 가까운 직원에게 물어보세요.';
const WAIT_HELP_TAIL = '진료를 기다리고 있어요. 어디서 기다리면 되는지 알려주세요.';
const EYE_UPSTAIRS = '안과는 2층에 있어요.';
export const DEPT_OTHER_SENTENCE = '1층 안내에서 진료과가 어디인지 물어보세요.';
export const DEPT_EYE_LIFT_SENTENCE = `${EYE_UPSTAIRS} 엘리베이터를 타고 2층으로 가서 안과 표지판을 찾으세요.`;
export const DEPT_EYE_STAIRS_SENTENCE = `${EYE_UPSTAIRS} 에스컬레이터나 엘리베이터를 타고 2층으로 가서 안과 표지판을 찾으세요.`;
export const deptRegisterSentence = (d) => `${d.name}에서 접수하세요.`;
export const deptWaitHelp = (d) => (d.value === 'other' ? WAIT_HELP_TAIL : `${d.name}에서 ${WAIT_HELP_TAIL}`);

/**
 * A copy of `route` for the chosen department; the input is never changed. `dept` null, unknown or the
 * default (노인의료센터) leaves every text as it is (so the existing recordings still match). Otherwise
 * points I3 and I4 get the department's sentences and place (`facility` or `mark`). `mobility`
 * (walker, wheelchair, none, null) only matters for 안과: the lift for walker and wheelchair, otherwise
 * the escalator or the lift.
 *
 * Changed points also get clip ids, because the sentence is no longer the one the recording of the
 * point id holds: `clipId` (spoken sentence), `detailClipId` and `helpClipId`. Where an id is set,
 * the app plays and the voice script records the sentence under it.
 */
export function applyDept(route, dept, mobility = null) {
  const copy = { ...route, points: route.points.map((p) => ({ ...p })) };
  const d = deptByValue(dept);
  if (!d || d.value === DEFAULT_DEPT) return copy;
  const i3 = copy.points.find((p) => p.id === 'I3');
  const i4 = copy.points.find((p) => p.id === 'I4');
  const lift = d.value === 'eye' && LIFT_MOBILITY.includes(mobility);
  const variant = `${d.value}${lift ? '-lift' : ''}`;
  let place; // {facility} or {mark}
  let sentence;
  let sourceTail;
  if (d.facility) {
    place = { facility: d.facility };
    sentence = deptRegisterSentence(d);
    sourceTail = `층별안내 1동 1층 ${d.facility}번 ${d.floorName}`;
  } else if (d.value === 'eye') {
    place = { mark: lift ? 'elevator' : 'escalator' };
    sentence = lift ? DEPT_EYE_LIFT_SENTENCE : DEPT_EYE_STAIRS_SENTENCE;
    sourceTail = `층별안내 ${d.upstairs}`;
  } else {
    place = { mark: d.marks[0] };
    sentence = DEPT_OTHER_SENTENCE;
    sourceTail = '층별안내 1동 1층 안내';
  }
  const retarget = (p) => {
    delete p.facility;
    delete p.mark;
    Object.assign(p, place);
    p.source = String(p.source).replace(/층별안내 .*$/, sourceTail);
  };
  if (i3) {
    retarget(i3);
    i3.display = sentence;
    i3.speech = sentence;
    i3.clipId = `I3-dept-${variant}`;
    i3.helpClipId = `help-I3-dept-${variant}`;
  }
  if (i4) {
    retarget(i4);
    i4.help = deptWaitHelp(d);
    i4.helpClipId = `help-I4-dept-${d.value}`; // the sentence does not depend on the lift
    if (typeof i4.detail === 'string' && i4.detail.trim() !== '') {
      i4.detail = NEAR_STAFF_DETAIL;
      i4.detailSpeech = null;
      i4.detailClipId = 'I4-dept-detail';
    }
  }
  return copy;
}

/** Every distinct {dept, mobility} the route can be recomputed for, besides the default department. */
export function deptVariants() {
  const out = [];
  for (const d of DEPARTMENTS) {
    if (d.value === DEFAULT_DEPT) continue;
    out.push({ dept: d.value, mobility: null });
    if (d.value === 'eye') out.push({ dept: d.value, mobility: 'walker' });
  }
  return out;
}
