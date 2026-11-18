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

/**
 * Compass heading from a DeviceOrientationEvent, or null when it is not a real compass reading.
 * iOS gives `webkitCompassHeading`; elsewhere `alpha` is a compass value only when `absolute`.
 */
export function headingFromEvent(e) {
  if (!e) return null;
  if (typeof e.webkitCompassHeading === 'number' && Number.isFinite(e.webkitCompassHeading)) {
    return norm360(e.webkitCompassHeading);
  }
  if (e.absolute === true && typeof e.alpha === 'number' && Number.isFinite(e.alpha)) {
    return norm360(360 - e.alpha);
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
    const h = headingFromEvent(e);
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
