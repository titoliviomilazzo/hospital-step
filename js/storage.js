// localStorage wrapper. Stores ONLY {settings, lastPointId}. The utterance and the four visit
// fields are never persisted (design section 1). Every access is guarded so Node and private
// browsing both work.

export const STORAGE_KEY = 'hospital-step.v2'; // v2: the route grew to 17 points, so v1 "resume" records would point at the wrong place

export const DEFAULT_SETTINGS = Object.freeze({
  sound: true,
  voice: 'f', // 'f' female, 'm' male
  rate: 'slow', // 'normal' | 'slow'
  arrow: '2d', // '2d' | '3d' (used from stage 4)
  largeText: false,
  sim: false, // used from stage 4
  listenNotes: false, // optional: write down the doctor's words (off until the owner turns it on in settings)
});

const ENUMS = {
  voice: ['f', 'm'],
  rate: ['normal', 'slow'],
  arrow: ['2d', '3d'],
};
const BOOLS = ['sound', 'largeText', 'sim', 'listenNotes'];

/** Turns any parsed value into a safe `{settings, lastPointId}`. Drops unknown keys. */
export function sanitize(raw, knownPointIds = null) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const inSettings = src.settings && typeof src.settings === 'object' ? src.settings : {};
  const settings = { ...DEFAULT_SETTINGS };
  for (const k of BOOLS) if (typeof inSettings[k] === 'boolean') settings[k] = inSettings[k];
  for (const [k, allowed] of Object.entries(ENUMS)) {
    if (allowed.includes(inSettings[k])) settings[k] = inSettings[k];
  }
  let lastPointId = typeof src.lastPointId === 'string' ? src.lastPointId : null;
  if (lastPointId !== null && Array.isArray(knownPointIds) && !knownPointIds.includes(lastPointId)) {
    lastPointId = null;
  }
  return { settings, lastPointId };
}

function getStore(store) {
  if (store) return store;
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export function loadState(knownPointIds = null, store = null) {
  const s = getStore(store);
  if (!s) return sanitize(null);
  try {
    const text = s.getItem(STORAGE_KEY);
    return sanitize(text ? JSON.parse(text) : null, knownPointIds);
  } catch {
    return sanitize(null);
  }
}

export function saveState(state, store = null) {
  const s = getStore(store);
  if (!s) return false;
  try {
    s.setItem(STORAGE_KEY, JSON.stringify(sanitize(state)));
    return true;
  } catch {
    return false;
  }
}
