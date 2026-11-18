// Get-off alert: tells the rider when the bus nears the stop where they should get off.
// Pure helpers (distance, alert level, simulated positions) are importable in Node; the controller
// takes its browser dependencies (geolocation, wake lock, document) as parameters so tests can
// inject fakes. Positions are never stored or sent anywhere: they only feed alertLevel().

export const NEAR_M = 500; // "near" at or below this distance
export const NOW_M = 120; // "now" at or below this distance
export const MAX_ACCURACY_M = 150; // fixes less precise than this are ignored
export const LEVELS = ['far', 'near', 'now'];
const EARTH_RADIUS_M = 6371008.8;
const RAD = Math.PI / 180;
const MAX_TIMEOUTS_WITHOUT_FIX = 3;

/** Great-circle distance in metres between two {lat, lon} points. */
export function haversineMeters(a, b) {
  const dLat = (b.lat - a.lat) * RAD;
  const dLon = (b.lon - a.lon) * RAD;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Next level for one position fix: 'far' | 'near' | 'now'. A fix with accuracy worse than 150 m
 * (or a non-numeric distance) changes nothing, and the level never goes backwards.
 */
export function alertLevel(distanceM, accuracyM, prevLevel = 'far') {
  const prev = LEVELS.includes(prevLevel) ? prevLevel : 'far';
  if (!Number.isFinite(distanceM)) return prev;
  if (Number.isFinite(accuracyM) && accuracyM > MAX_ACCURACY_M) return prev;
  let raw = 'far';
  if (distanceM <= NOW_M) raw = 'now';
  else if (distanceM <= NEAR_M) raw = 'near';
  return LEVELS.indexOf(raw) > LEVELS.indexOf(prev) ? raw : prev;
}

/**
 * A position source that walks a straight line from `from` to `to`, one fix per `intervalMs`
 * (accuracy 10 m), reaching `to` after `durationMs`. Same shape as the real source:
 * `source(onPosition, onError)` returns a stop function.
 */
export function simulatedSource(from, to, durationMs = 20000, intervalMs = 1000) {
  const steps = Math.max(1, Math.round(durationMs / intervalMs));
  return (onPosition) => {
    let i = 0;
    let timer = null;
    const emit = () => {
      const t = Math.min(1, i / steps);
      onPosition({
        lat: from.lat + (to.lat - from.lat) * t,
        lon: from.lon + (to.lon - from.lon) * t,
        accuracy: 10,
      });
      if (i >= steps && timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      i += 1;
    };
    emit();
    if (i <= steps) timer = setInterval(emit, intervalMs);
    return () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
  };
}

/** Real position source from `navigator.geolocation`, or null when the browser has none. */
export function geolocationSource(nav = globalThis.navigator) {
  const geo = nav && nav.geolocation;
  if (!geo || typeof geo.watchPosition !== 'function') return null;
  return (onPosition, onError) => {
    const id = geo.watchPosition(
      (pos) => onPosition({ lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy }),
      (err) => onError(err),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 },
    );
    return () => geo.clearWatch(id);
  };
}

/**
 * Starts watching. `target` is {lat, lon}; `onLevel('near' | 'now')` fires only when the level
 * changes; `onError('denied' | 'unavailable')` fires once, after which the watch is stopped.
 * `source` overrides the real geolocation (simulation, tests). While active a screen wake lock
 * is held (best effort) and re-requested when the page becomes visible again.
 * Returns {stop()}.
 */
export function startAlightWatch({
  target, onLevel, onError, source = null,
  nav = globalThis.navigator, doc = globalThis.document,
}) {
  let level = 'far';
  let active = true;
  let gotFix = false;
  let timeouts = 0;
  let lock = null;
  let stopSource = null;

  const releaseLock = () => {
    const l = lock;
    lock = null;
    if (l && typeof l.release === 'function') {
      try {
        Promise.resolve(l.release()).catch(() => {});
      } catch { /* ignore */ }
    }
  };
  const requestLock = async () => {
    try {
      if (!active || lock || !nav || !nav.wakeLock || typeof nav.wakeLock.request !== 'function') return;
      const l = await nav.wakeLock.request('screen');
      if (!active) {
        if (l && typeof l.release === 'function') l.release();
        return;
      }
      lock = l;
    } catch { /* wake lock is optional */ }
  };
  const onVisibility = () => {
    if (doc && doc.visibilityState === 'visible') requestLock();
    else lock = null; // the browser releases it when the page is hidden
  };

  const stop = () => {
    if (!active) return;
    active = false;
    if (stopSource) stopSource();
    stopSource = null;
    if (doc && typeof doc.removeEventListener === 'function') doc.removeEventListener('visibilitychange', onVisibility);
    releaseLock();
  };

  const fail = (reason) => {
    if (!active) return;
    stop();
    if (onError) onError(reason);
  };

  const src = source || geolocationSource(nav);
  if (!src) {
    active = false;
    if (onError) onError('unavailable');
    return { stop };
  }

  if (doc && typeof doc.addEventListener === 'function') doc.addEventListener('visibilitychange', onVisibility);
  requestLock();

  const handlePosition = (pos) => {
    if (!active) return;
    gotFix = true;
    timeouts = 0;
    const next = alertLevel(haversineMeters(pos, target), pos.accuracy, level);
    if (next !== level) {
      level = next;
      if (onLevel) onLevel(level);
    }
  };
  const handleError = (err) => {
    const code = err && err.code;
    if (code === 1) fail('denied');
    else if (code === 3 && !gotFix) {
      timeouts += 1;
      if (timeouts >= MAX_TIMEOUTS_WITHOUT_FIX) fail('unavailable');
    } else if (code !== 3) fail('unavailable');
  };

  try {
    stopSource = src(handlePosition, handleError);
  } catch {
    fail('unavailable');
  }
  // A source may deliver fixes synchronously and stop() may have run meanwhile.
  if (!active && stopSource) {
    stopSource();
    stopSource = null;
  }
  return { stop };
}
