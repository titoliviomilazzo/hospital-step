// Bus position for the boarding stop. Hidden until ARRIVAL_URL (config.js) is set. The URL is a
// small proxy that holds the Gyeonggi bus API key; this module never contains a key. It POSTs
// {stationId, routeId} and expects the getBusLocationListv2 reply (live bus positions on the route).
// Positions are used instead of arrival predictions because the boarding stop is the start (seq 1)
// of a loop route, and the official arrival API never gives a prediction at a start stop. Pure parts
// are importable in Node.

export const REFRESH_MS = 30000;
export const TIMEOUT_MS = 6000;

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Reads a getBusLocationListv2 reply into {stopsAway, near?}, or null when no bus runs.
 * Accepts the whole reply, its `response`, or just its `msgBody`; `busLocationList` may be a single
 * object. A bus at the boarding seq with stateCd 1 is at the stop: {stopsAway: 0}. With stateCd 0 or
 * 2 it is {stopsAway: 0, near: true}: the data cannot tell arriving from leaving, so it only counts
 * as "near this stop". Priority across buses: at the stop, then near, then the smallest stopsAway.
 */
export function parseLocations(reply, { loopStops, boardSeq } = {}) {
  if (!Number.isInteger(loopStops) || loopStops < 1 || !Number.isInteger(boardSeq) || boardSeq < 1 || boardSeq > loopStops) return null;
  const root = reply && typeof reply === 'object' ? (reply.response || reply) : null;
  if (!root) return null;
  const body = root.msgBody && typeof root.msgBody === 'object' ? root.msgBody : null;
  let list = body ? body.busLocationList : root.busLocationList;
  if (list && !Array.isArray(list)) list = [list];
  if (!Array.isArray(list)) return null;
  let best = null; // smallest stopsAway among buses elsewhere on the loop
  let atStop = false;
  let near = false;
  for (const bus of list) {
    if (!bus || typeof bus !== 'object') continue;
    const seq = num(bus.stationSeq);
    if (seq === null || !Number.isInteger(seq) || seq < 1 || seq > loopStops) continue;
    if (seq === boardSeq) {
      if (num(bus.stateCd) === 1) atStop = true;
      else near = true;
      continue;
    }
    const away = (boardSeq - seq + loopStops) % loopStops;
    if (best === null || away < best) best = away;
  }
  if (atStop) return { stopsAway: 0 };
  if (near) return { stopsAway: 0, near: true };
  return best === null ? null : { stopsAway: best };
}

/** The sentence to show for a parse result. No minutes are promised. `hasHours`: the point has `hours` data. */
export function locationText(parsed, routeName = '7-1', hasHours = true) {
  if (!parsed) {
    // The stop-1 hours sentence is only true for the first stop; a point without `hours` data says less.
    return hasHours
      ? `지금은 ${routeName}번 버스 위치 정보가 없어요. 평일 아침 7시 13분부터 저녁 7시까지 다녀요.`
      : `지금은 ${routeName}번 버스 위치 정보가 없어요.`;
  }
  if (parsed.near) return `${routeName}번 버스가 이 정류장 근처에 있어요`;
  if (parsed.stopsAway <= 0) return `${routeName}번 버스가 지금 정류장에 와 있어요`;
  if (parsed.stopsAway === 1) return `${routeName}번 버스가 바로 전 정류장에 있어요`;
  return `${routeName}번 버스가 ${parsed.stopsAway}정거장 전에 있어요`;
}

/** POSTs the request and resolves to the parsed bus position, or null on any failure or empty reply. */
export async function fetchArrival(url, { stationId, routeId, loopStops, boardSeq }, { fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => { if (ctl) ctl.abort(); }, timeoutMs);
  let guard = null;
  try {
    const res = await Promise.race([
      fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stationId, routeId }),
        signal: ctl ? ctl.signal : undefined,
      }),
      new Promise((_, rej) => { guard = setTimeout(() => rej(new Error('timeout')), timeoutMs + 50); }),
    ]);
    if (!res.ok) return null;
    return parseLocations(await res.json(), { loopStops, boardSeq });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    clearTimeout(guard);
  }
}
