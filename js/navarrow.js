// Real-mode direction arrow towards an official target coordinate (a bus stop). Pure helpers plus a
// small injectable position controller. Positions live in memory only and are never stored or sent.

import { arrowAngle, bearingDeg } from './compass.js';
import { geolocationSource, haversineMeters } from './alight.js';

export const NEAR_TARGET_M = 25; // within this of the target: "you are near"
export const COARSE_ACCURACY_M = 50; // fixes less precise than this get a warning note
export const ROUND_FINE_M = 10; // distances under 100 m are rounded to this
export const ROUND_COARSE_M = 50; // distances from 100 m up are rounded to this
const MAX_TIMEOUTS_WITHOUT_FIX = 3;

export const FINDING_TEXT = '위치를 찾는 중이에요...';
export const NEAR_TEXT = '정류장 근처에 왔어요.';
export const COARSE_NOTE = '위치가 정확하지 않아요. 표지판도 함께 보세요.';
export const UNDERGROUND_NOTE = '역 안에서는 화살표가 틀릴 수 있어요. 표지판을 따라 밖으로 나오세요.';
export const POSITION_MSG = Object.freeze({
  denied: '위치 확인이 꺼져 있어요. 표지판을 따라가세요.',
  unavailable: '위치를 확인할 수 없어요. 표지판을 따라가세요.',
});

const isFix = (p) => Boolean(p) && Number.isFinite(p.lat) && Number.isFinite(p.lon);

/** Angle to draw the arrow at, or null while the position, the heading or the target is missing. */
export function targetAngle(pos, target, heading) {
  if (!isFix(pos) || !isFix(target) || !Number.isFinite(heading)) return null;
  return arrowAngle(bearingDeg(pos, target), heading);
}

/** Metres to the target, or null without a position. */
export function targetDistanceM(pos, target) {
  if (!isFix(pos) || !isFix(target)) return null;
  return haversineMeters(pos, target);
}

/** Distance rounded for reading aloud: to 10 m under 100 m, else to 50 m. */
export function roundDistanceM(m) {
  if (!Number.isFinite(m)) return null;
  const step = m < 100 ? ROUND_FINE_M : ROUND_COARSE_M;
  return Math.round(m / step) * step;
}

/** The line under the arrow: "정류장까지 약 120 m", or the near sentence within 25 m. null if unknown. */
export function distanceText(m) {
  if (!Number.isFinite(m)) return null;
  if (m <= NEAR_TARGET_M) return NEAR_TEXT;
  return `정류장까지 약 ${roundDistanceM(m)} m`;
}

/** Warning when the fix is not precise enough to trust the arrow; null otherwise. */
export function accuracyNote(accuracyM) {
  return Number.isFinite(accuracyM) && accuracyM > COARSE_ACCURACY_M ? COARSE_NOTE : null;
}

/**
 * Text lines for the status area under the arrow, in order. `s` = {pos, target, watching, posMsg,
 * underground}. While waiting for the first fix only the "finding" line (plus the underground note).
 */
export function navLines(s) {
  return navItems(s).map((x) => x.text);
}

/** Same lines as navLines, as {text, main}: `main` marks the one big line (distance or "finding"). */
export function navItems({ pos, target, watching, posMsg, underground }) {
  const items = [];
  if (posMsg) items.push({ text: posMsg, main: false });
  else if (isFix(pos)) {
    const d = distanceText(targetDistanceM(pos, target));
    if (d) items.push({ text: d, main: true });
    const a = accuracyNote(pos.accuracy);
    if (a) items.push({ text: a, main: false });
  } else if (watching) items.push({ text: FINDING_TEXT, main: true });
  if (underground) items.push({ text: UNDERGROUND_NOTE, main: false });
  return items;
}

/** Caption under the arrow on a target point: the arrow points at the stop, not at the sign. */
export function targetCaption(target) {
  return `${target.name} 쪽`;
}

/**
 * One position watch for the app. `source` (default: real geolocation, looked up on turnOn) is
 * `(onPosition, onError) => stop`. `onFix({lat, lon, accuracy})`, `onUnavailable('denied' |
 * 'unavailable')` (after which the watch is stopped). Late callbacks of an ended session are dropped.
 */
export function createPositionController({ source, onFix, onUnavailable }) {
  let stop = null;
  let active = false;
  let session = 0;
  const end = () => {
    session += 1;
    active = false;
    const s = stop;
    stop = null;
    if (s) s();
  };
  return {
    get active() { return active; },
    turnOn() {
      if (active) return false;
      const mine = ++session;
      const src = source === undefined ? geolocationSource() : source;
      let gotFix = false;
      let timeouts = 0;
      const fail = (reason) => {
        if (mine !== session) return;
        end();
        onUnavailable(reason);
      };
      if (!src) {
        onUnavailable('unavailable');
        return true;
      }
      active = true;
      let s = null;
      try {
        s = src(
          (pos) => {
            if (mine !== session || !isFix(pos)) return;
            gotFix = true;
            timeouts = 0;
            onFix({ lat: pos.lat, lon: pos.lon, accuracy: pos.accuracy });
          },
          (err) => {
            const code = err && err.code;
            if (code === 1) fail('denied');
            else if (code === 3) {
              timeouts += 1;
              if (!gotFix && timeouts >= MAX_TIMEOUTS_WITHOUT_FIX) fail('unavailable');
            } else fail('unavailable');
          },
        );
      } catch {
        fail('unavailable');
        return true;
      }
      if (mine !== session) { if (typeof s === 'function') s(); return true; } // ended during start
      stop = typeof s === 'function' ? s : null;
      return true;
    },
    turnOff: end,
  };
}
