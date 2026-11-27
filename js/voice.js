// Voice output. Recorded mp3 first (audio/<f|m>/<clipId>.mp3), Web Speech as the fallback.
// A manifest (audio/manifest.json, written by tools/generate_voice.py) says which clips exist
// and for which sentence, so no request is made for a clip that was never recorded and a
// changed sentence falls back to Web Speech until it is re-recorded.
// With sound off every function is silent. Pure helpers are importable in Node.

import { versioned } from './version.js';

export const AUDIO_ROOT = 'audio';
// Recorded clips play at 1.2x by default (owner found 1.0x too slow); 'relaxed' is the old natural speed.
const MP3_PLAYBACK_RATE = { normal: 1.2, relaxed: 1 };
const SPEECH_RATE = { normal: 1.15, relaxed: 0.95 };

export function audioPath(voice, clipId) {
  return `${AUDIO_ROOT}/${voice}/${clipId}.mp3`;
}

export function mp3RateFor(rate) {
  return MP3_PLAYBACK_RATE[rate] ?? MP3_PLAYBACK_RATE.normal;
}

export function speechRateFor(rate) {
  return SPEECH_RATE[rate] ?? SPEECH_RATE.normal;
}

/** Picks a Korean voice from `speechSynthesis.getVoices()`; prefers ko-KR, then any ko. */
export function pickKoreanVoice(voices) {
  if (!Array.isArray(voices) || voices.length === 0) return null;
  const lang = (v) => String(v.lang || '').replace('_', '-').toLowerCase();
  const exact = voices.filter((v) => lang(v) === 'ko-kr');
  const pool = exact.length ? exact : voices.filter((v) => lang(v).startsWith('ko'));
  if (!pool.length) return null;
  return pool.find((v) => v.localService) || pool[0];
}

/** True when the manifest has a recording of exactly this sentence for this voice. */
export function hasRecording(manifest, voice, clipId, text) {
  const clip = manifest && manifest.clips && manifest.clips[clipId];
  return Boolean(clip && clip.text === text && clip.voices && clip.voices[voice]);
}

let manifestPromise = null;
let currentAudio = null;
// ONE element plays every clip. iOS Safari only lets an element that was started by a tap play
// later without a tap (chained clips, location alerts), so the element is kept and its src swapped.
let sharedAudio = null;
let audioCtx = null;
// Bumped by every speak() and stopSpeaking(). A call whose generation is no longer current is
// stale: it must not start, fall back or let a chained clip fire.
let generation = 0;
let settleActive = null; // settles the pending playback of the current output (rejects AbortError)
export const MP3_TIMEOUT_MS = 10000;

function abortError() {
  const e = new Error('playback aborted');
  e.name = 'AbortError';
  return e;
}

/** Loads audio/manifest.json once. A missing or invalid manifest means "no recordings". */
export function loadManifest(fetchImpl = globalThis.fetch) {
  if (!manifestPromise) {
    manifestPromise = (async () => {
      try {
        const res = await fetchImpl(versioned(`${AUDIO_ROOT}/manifest.json`));
        if (!res.ok) return null;
        return await res.json();
      } catch {
        return null;
      }
    })();
  }
  return manifestPromise;
}

/** Starts the manifest request at boot so the first clip does not wait for it. */
export function preloadManifest() {
  return loadManifest();
}

/** Test hook: forgets the cached manifest and any current output. */
export function resetVoiceForTests() {
  manifestPromise = null;
  currentAudio = null;
  sharedAudio = null;
  unlockPromise = null;
  speechPrimed = false;
  settleActive = null;
  generation = 0;
}

function haltOutput() {
  const settle = settleActive;
  settleActive = null;
  if (currentAudio) {
    try {
      currentAudio.pause();
    } catch { /* ignore */ }
    currentAudio = null;
  }
  try {
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
  } catch { /* ignore */ }
  if (settle) settle();
}

/** Stops whatever is playing and invalidates every in-flight speak(). */
export function stopSpeaking() {
  generation += 1;
  haltOutput();
}

function getSharedAudio() {
  if (!sharedAudio) sharedAudio = new Audio();
  return sharedAudio;
}

// 16 samples of 8-bit silence, only used to unlock the shared element inside a user gesture.
const SILENT_WAV = 'data:audio/wav;base64,UklGRjQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YRAAAACAgICAgICAgICAgICAgICA';
let unlockPromise = null; // pending or successful unlock; null when none was tried or the last try failed
let speechPrimed = false;

/**
 * Call from a user gesture. Starts the shared audio element with a silent sound and pauses it again,
 * and primes Web Speech once with an empty utterance, so later clips and alerts that start without a
 * tap are not blocked (iOS Safari). Resolves to true once the element is unlocked. After a success it
 * does nothing; after a failure (the browser did not count that event as a gesture) the next gesture
 * tries again. Never interrupts a clip that is already playing.
 */
export function unlockAudio() {
  if (unlockPromise) return unlockPromise;
  let result = Promise.resolve(true);
  try {
    if (typeof Audio !== 'undefined' && !currentAudio) {
      const a = getSharedAudio();
      a.src = SILENT_WAV;
      const p = a.play();
      if (p && typeof p.then === 'function') result = p.then(() => true, () => false);
      a.pause();
    }
  } catch {
    result = Promise.resolve(false);
  }
  try {
    if (!speechPrimed && typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined'
      && !speechSynthesis.speaking) {
      speechPrimed = true;
      const u = new SpeechSynthesisUtterance('');
      u.volume = 0;
      speechSynthesis.speak(u);
    }
  } catch { /* ignore */ }
  const mine = result.then((ok) => {
    if (!ok && unlockPromise === mine) unlockPromise = null;
    return ok;
  });
  unlockPromise = mine;
  return mine;
}

const UNLOCK_EVENTS = ['pointerdown', 'touchend', 'click', 'keydown'];

/**
 * Unlocks audio on the first user gesture on `doc` (several event types, because browsers differ in
 * which one counts). The listeners stay until an unlock succeeded. Returns a function that removes them.
 */
export function installAudioUnlock(doc = globalThis.document) {
  if (!doc || typeof doc.addEventListener !== 'function') return () => {};
  const off = () => UNLOCK_EVENTS.forEach((t) => doc.removeEventListener(t, onGesture, true));
  function onGesture() {
    unlockAudio().then((ok) => { if (ok) off(); });
  }
  UNLOCK_EVENTS.forEach((t) => doc.addEventListener(t, onGesture, true));
  return off;
}

function playMp3(url, rate, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (typeof Audio === 'undefined') {
      reject(new Error('no Audio'));
      return;
    }
    let timer = null;
    let done = false;
    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (settleActive === abort) settleActive = null;
      // The element is reused: detach this clip's handlers, and stop a clip that failed or stalled.
      a.onended = null;
      a.onerror = null;
      if (fn === reject) {
        try { a.pause(); } catch { /* ignore */ }
      }
      fn(arg);
    };
    const abort = () => finish(reject, abortError());
    const a = getSharedAudio();
    // Handlers first: a previous clip's handlers must not see this clip's load.
    a.onended = null;
    a.onerror = null;
    a.src = url;
    a.playbackRate = mp3RateFor(rate); // after src: loading a new source resets the rate
    currentAudio = a;
    settleActive = abort;
    a.onended = () => finish(resolve);
    a.onerror = () => finish(reject, new Error('mp3 failed'));
    timer = setTimeout(() => finish(reject, new Error('mp3 timeout')), timeoutMs);
    try {
      const p = a.play();
      if (p && typeof p.catch === 'function') p.catch((e) => finish(reject, e));
    } catch (e) {
      finish(reject, e);
    }
  });
}

function speakWithSynthesis(text, rate) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      if (settleActive === abort) settleActive = null;
      resolve(ok);
    };
    const abort = () => finish(false);
    try {
      if (typeof speechSynthesis === 'undefined' || typeof SpeechSynthesisUtterance === 'undefined') {
        resolve(true); // nothing to play; nothing was interrupted
        return;
      }
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'ko-KR';
      u.rate = speechRateFor(rate);
      const v = pickKoreanVoice(speechSynthesis.getVoices());
      if (v) u.voice = v;
      settleActive = abort;
      u.onend = () => finish(true);
      u.onerror = () => finish(false);
      speechSynthesis.speak(u);
    } catch {
      finish(false);
    }
  });
}

/**
 * Speaks one clip. `settings` is {sound, voice, rate}. Resolves to true when the clip played to
 * its end (or there was nothing to play and nothing interrupted it), false when it was
 * interrupted by a newer speak()/stopSpeaking() or failed. Never throws and never rejects.
 * A stale call never falls back to Web Speech, and an AbortError never triggers the fallback.
 */
export async function speak(clipId, text, settings, { timeoutMs = MP3_TIMEOUT_MS } = {}) {
  if (!settings || !settings.sound || !text) return false;
  const gen = (generation += 1);
  haltOutput();
  const manifest = await loadManifest();
  if (gen !== generation) return false;
  if (hasRecording(manifest, settings.voice, clipId, text)) {
    try {
      await playMp3(audioPath(settings.voice, clipId), settings.rate, timeoutMs);
      return gen === generation;
    } catch (err) {
      if (gen !== generation || (err && err.name === 'AbortError')) return false;
      // fall through to Web Speech, with the same (current) text
    }
  }
  if (gen !== generation) return false;
  const ok = await speakWithSynthesis(text, settings.rate);
  return ok && gen === generation;
}

/** Runs `next()` only when `first` (a speak() promise) completed normally; returns that boolean. */
export async function speakThen(first, next) {
  if (await first) {
    await next();
    return true;
  }
  return false;
}

const CHIME_TONES = {
  ok: [660, 880], // confirmation (default)
  start: [880], // microphone opened
  end: [660], // microphone closed
};

/** Short chime through WebAudio. Silent when sound is off or WebAudio is missing. */
export function chime(settings, kind = 'ok') {
  if (!settings || !settings.sound) return;
  try {
    const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Ctx) return;
    audioCtx = audioCtx || new Ctx();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const t0 = audioCtx.currentTime;
    (CHIME_TONES[kind] || CHIME_TONES.ok).forEach((freq, i) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const start = t0 + i * 0.14;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.25, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.22);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(start);
      osc.stop(start + 0.25);
    });
  } catch { /* ignore */ }
}

/**
 * Guarded vibration. Haptics are independent of the sound setting. Chrome logs a console error
 * when vibrate() runs before any user gesture, so it is skipped until the page has had one.
 */
export function vibrate(pattern = 80) {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      const act = navigator.userActivation;
      if (act && !act.hasBeenActive) return;
      navigator.vibrate(pattern);
    }
  } catch { /* ignore */ }
}
