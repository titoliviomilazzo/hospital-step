// Bearings and compass heading. All angles are degrees clockwise from north in [0, 360).
// Pure functions are importable in Node; startCompass() is browser-only.

const RAD = Math.PI / 180;
const norm360 = (deg) => ((deg % 360) + 360) % 360;

/** Initial great-circle bearing from a to b. `a` and `b` are {lat, lon} in degrees. */
export function bearingDeg(a, b) {
  const phi1 = a.lat * RAD;
  const phi2 = b.lat * RAD;
  const dLon = (b.lon - a.lon) * RAD;
  const y = Math.sin(dLon) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
  return norm360(Math.atan2(y, x) / RAD);
}

/**
 * Bearing between two points of the simulation schematic. Axis convention: +x is east and +y is
 * NORTH (up on the mini map), so a point with a larger y lies north of one with a smaller y.
 * Identical points give 0.
 */
export function schematicBearingDeg(a, b) {
  return norm360(Math.atan2(b.x - a.x, b.y - a.y) / RAD);
}

/** Angle to draw the arrow at: how far the target bearing is clockwise from the heading. */
export function arrowAngle(bearing, heading) {
  return norm360(bearing - heading + 360);
}

export const HEADING_STEP_DEG = 15;
// A step is kept until the raw heading is more than 12.5 degrees away from it: half a step (7.5, the
// plain rounding boundary) plus 5 degrees of hysteresis, so a reading that wobbles around a boundary
// never flips the picture back and forth.
export const HEADING_HOLD_DEG = HEADING_STEP_DEG / 2 + 5;

/**
 * Steady heading for the turning floor map: `raw` snapped to a multiple of 15 degrees with hysteresis.
 * `prevStep` is the step in use (null/undefined at the start). While the raw heading is within
 * 12.5 degrees of `prevStep` the same step is returned; beyond that it moves to the nearest multiple
 * of 15. Result is in [0, 360); a non-finite `raw` keeps `prevStep` (or 0).
 */
export function quantiseHeading(raw, prevStep = null) {
  const hasPrev = Number.isFinite(prevStep);
  if (!Number.isFinite(raw)) return hasPrev ? norm360(prevStep) : 0;
  const r = norm360(raw);
  if (hasPrev) {
    const prev = norm360(prevStep);
    const diff = Math.abs(((r - prev + 540) % 360) - 180); // shortest angular distance
    if (diff <= HEADING_HOLD_DEG) return prev;
  }
  return norm360(Math.round(r / HEADING_STEP_DEG) * HEADING_STEP_DEG);
}

/**
 * Rotation of the screen in degrees clockwise-from-portrait (0, 90, 180, 270), or 0 when unknown.
 * Uses screen.orientation.angle, then the older window.orientation (which may be -90 for 270).
 */
export function screenAngleDeg(win = globalThis.window) {
  if (!win) return 0;
  const a = win.screen && win.screen.orientation && win.screen.orientation.angle;
  if (typeof a === 'number' && Number.isFinite(a)) return a;
  if (typeof win.orientation === 'number' && Number.isFinite(win.orientation)) return win.orientation;
  return 0;
}

/**
 * Compass heading from a DeviceOrientationEvent, or null when it is not a real compass reading.
 * iOS gives `webkitCompassHeading`; elsewhere `alpha` is a compass value only when `absolute`.
 * Both describe the device's top edge, so the screen rotation `angleDeg` is added here (the only
 * place) to get the direction the screen top points to: heading = norm360(raw + angle).
 */
export function headingFromEvent(e, angleDeg = 0) {
  if (!e) return null;
  const turn = Number.isFinite(angleDeg) ? angleDeg : 0;
  if (typeof e.webkitCompassHeading === 'number' && Number.isFinite(e.webkitCompassHeading)) {
    return norm360(e.webkitCompassHeading + turn);
  }
  if (e.absolute === true && typeof e.alpha === 'number' && Number.isFinite(e.alpha)) {
    return norm360(360 - e.alpha + turn);
  }
  return null;
}

/**
 * Browser only; call it from a tap (iOS asks for permission there). Resolves to a stop function,
 * or null when no heading can be had. `onUnavailable(reason)` reason is 'unsupported', 'denied'
 * or 'no-data' (no usable reading within 3 s, for example on a desktop browser).
 */
export async function startCompass(onHeading, onUnavailable, timeoutMs = 3000) {
  if (typeof window === 'undefined' || !('DeviceOrientationEvent' in window)) {
    onUnavailable('unsupported');
    return null;
  }
  const DOE = window.DeviceOrientationEvent;
  if (typeof DOE.requestPermission === 'function') {
    try {
      if ((await DOE.requestPermission()) !== 'granted') {
        onUnavailable('denied');
        return null;
      }
    } catch {
      onUnavailable('denied');
      return null;
    }
  }
  let got = false;
  const handler = (e) => {
    const h = headingFromEvent(e, screenAngleDeg(window));
    if (h === null) return;
    got = true;
    onHeading(h);
  };
  window.addEventListener('deviceorientationabsolute', handler, true);
  window.addEventListener('deviceorientation', handler, true);
  const timer = setTimeout(() => { if (!got) onUnavailable('no-data'); }, timeoutMs);
  return () => {
    clearTimeout(timer);
    window.removeEventListener('deviceorientationabsolute', handler, true);
    window.removeEventListener('deviceorientation', handler, true);
  };
}

/**
 * Owns one compass session for the app: ignores a second turnOn() while the first is still starting
 * (permission prompt pending), lets a session be ended from outside, and drops late callbacks of an
 * ended session. `start` is injectable for tests.
 */
export function createCompassController({ start = startCompass, onHeading, onUnavailable }) {
  let starting = false;
  let stop = null;
  let session = 0;
  return {
    get starting() { return starting; },
    get active() { return starting || stop !== null; },
    /** Starts (or restarts) the compass. Returns false and does nothing while a start is pending. */
    turnOn() {
      if (starting) return false;
      if (stop) { stop(); stop = null; }
      starting = true;
      const mine = ++session;
      Promise.resolve(start(
        (hd) => { if (mine === session) onHeading(hd); },
        (reason) => { if (mine === session) onUnavailable(reason); },
      )).catch(() => null).then((s) => {
        if (mine !== session) { if (typeof s === 'function') s(); return; } // ended while starting
        starting = false;
        stop = typeof s === 'function' ? s : null;
      });
      return true;
    },
    /** Ends the session; a pending start is cancelled and its late result is discarded. */
    turnOff() {
      session += 1;
      starting = false;
      if (stop) stop();
      stop = null;
    },
  };
}
