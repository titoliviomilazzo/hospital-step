// The sentence of the help card, chosen from what the screen is about. The user shows it to a
// passer-by or a staff member, so it must describe the screen the user is on. Pure, importable in Node.
// The spoken form is the shown sentence with digits written as Hangul numerals (same words).
import {
  HELP_SENTENCE, HELP_RETURN_SENTENCE, HELP_UNKNOWN_SENTENCE, shortStopName,
} from './clips.js';
import { facilityByNo, facilityLabel } from './floor.js';
import { withObject, digitsToHangul } from './korean.js';

const FIND_TAIL = '가는 길을 알려주세요.';
const GENERIC_PLACE = '안내에 나온 곳';

/** Plain place name of a stop or entrance: no parenthetical, " 정류장" never doubled. */
function placeName(name) {
  return String(name)
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/([^\s\d])(\d+번)/g, '$1 $2') // "미금역3번출구" -> "미금역 3번출구"
    .replace(/(\d+번)(?=\S)/g, '$1 ') // "3번출구" -> "3번 출구"
    .trim();
}

/** The place a travel or return point leads to, or null when the data names none. */
export function helpPlace(route, index, floor = null) {
  const p = route.points[index];
  if (!p) return null;
  if (p.stage === 'indoor') {
    if (Number.isInteger(p.facility) && floor) {
      const f = facilityByNo(floor, p.facility);
      if (f) return facilityLabel(f);
    }
    return Number.isInteger(p.facility) ? null : '처음 오신 창구';
  }
  if (p.target && p.target.name) return placeName(p.target.name);
  if (p.busRoute && p.busRoute.stops) {
    const stop = p.busRoute.stops.find((s) => s.seq === p.busRoute.alightSeq);
    if (stop) return `${shortStopName(stop.name)} 정류장`;
  }
  // A boarding point has no target of its own: the stop is where the walk before it ended.
  for (let i = index - 1; i >= 0 && route.points[i].stage === p.stage; i -= 1) {
    const q = route.points[i];
    if (q.target && q.target.name) return placeName(q.target.name);
  }
  return null;
}

/** Help sentence of one route point: "<place>을 찾고 있어요. 가는 길을 알려주세요." */
export function helpSentenceForPoint(route, index, floor = null) {
  const place = helpPlace(route, index, floor) || GENERIC_PLACE;
  return `${withObject(place)} 찾고 있어요. ${FIND_TAIL}`;
}

/**
 * The help card for a state: {clipId, sentence, speech}. Wizard: by the visit answer (first, return,
 * not answered yet). On the route: by the current point. `state` needs {index, fields}.
 */
export function helpFor(state, route, floor = null) {
  if (!route || state.index < 0) {
    const visit = state.fields ? state.fields.visit : null;
    if (visit === 'first') return { clipId: 'help-main', sentence: HELP_SENTENCE, speech: digitsToHangul(HELP_SENTENCE) };
    if (visit === 'return') {
      return { clipId: 'help-return', sentence: HELP_RETURN_SENTENCE, speech: digitsToHangul(HELP_RETURN_SENTENCE) };
    }
    return { clipId: 'help-unknown', sentence: HELP_UNKNOWN_SENTENCE, speech: digitsToHangul(HELP_UNKNOWN_SENTENCE) };
  }
  const sentence = helpSentenceForPoint(route, state.index, floor);
  return { clipId: `help-${route.points[state.index].id}`, sentence, speech: digitsToHangul(sentence) };
}

/** `{clipId, text}` rows of the per-point help clips (spoken form), for the voice script. */
export function helpRows(route, floor = null) {
  return route.points.map((p, i) => ({
    clipId: `help-${p.id}`,
    text: digitsToHangul(helpSentenceForPoint(route, i, floor)),
  }));
}
