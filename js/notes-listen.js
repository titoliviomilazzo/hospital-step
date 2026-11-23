// Continuous note taking on top of the one-utterance listener (listen.js is not changed).
// Each recognition session ends after one phrase, so this layer restarts it after every end,
// collects the final texts, and enforces the stop rules of design 3-1 and 2-1:
//   - stop() is immediate and any result that arrives later is discarded;
//   - 3 errors in a row stop the session with state 'failed';
//   - a denied / blocked / unsupported microphone fails at once (retrying cannot help);
//   - the session ends by itself after `maxMs` (default 20 minutes).
// Everything outside is injected, so it runs in Node with a fake listener.

export const MAX_ERRORS = 3;
export const DEFAULT_MAX_MS = 20 * 60 * 1000;

/**
 * Callbacks: onText(latest, all) for each phrase; onState(state, info) with state 'listening',
 * 'stopped' (info.reason 'user' | 'timeout') or 'failed' (info.reason 'denied' | 'blocked' |
 * 'unsupported' | 'errors', info.code the last error code). `createListener` has the signature of
 * listen.js. Returns {start(), stop(), text(), isRunning(), elapsedMs()}.
 */
export function createNotesListener({
  createListener,
  onText,
  onState,
  maxMs = DEFAULT_MAX_MS,
  restartDelayMs = 150,
  now = () => Date.now(),
  setTimeout: setT = (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: clearT = (id) => globalThis.clearTimeout(id),
} = {}) {
  let running = false;
  let generation = 0; // a callback of an older session never reaches the caller
  let inner = null;
  let parts = [];
  let errors = 0;
  let startedAt = 0;
  let limitTimer = null;
  let restartTimer = null;
  let lastCode = null;

  const emit = (fn, ...args) => { try { if (fn) fn(...args); } catch { /* ignore callback errors */ } };
  const clearTimers = () => {
    if (limitTimer !== null) { clearT(limitTimer); limitTimer = null; }
    if (restartTimer !== null) { clearT(restartTimer); restartTimer = null; }
  };

  function finish(state, reason) {
    if (!running) return;
    running = false;
    generation += 1; // everything still in flight is now stale
    clearTimers();
    const l = inner;
    inner = null;
    if (l) { try { l.cancel(); } catch { /* ignore */ } }
    emit(onState, state, { reason, code: lastCode });
  }

  function fail(reason) { finish('failed', reason); }

  function countError(code) {
    lastCode = code || 'unknown';
    errors += 1;
    if (errors >= MAX_ERRORS) fail('errors');
  }

  function begin() {
    if (!running || !inner) return;
    if (now() - startedAt >= maxMs) { finish('stopped', 'timeout'); return; }
    if (inner.start() === false && running) countError('start-failed');
  }

  function start() {
    if (running) return true;
    running = true;
    generation += 1;
    const mine = generation;
    parts = [];
    errors = 0;
    lastCode = null;
    startedAt = now();
    const live = (fn) => (...args) => { if (running && mine === generation) fn(...args); };
    inner = createListener({
      onResult: live((text) => {
        const t = String(text ?? '').trim();
        if (!t) return;
        errors = 0; // only a phrase that came back counts as progress
        parts.push(t);
        emit(onText, t, parts.join(' '));
      }),
      onNoSpeech: live(() => { /* silence in a consultation is normal: not an error */ }),
      onError: live((code) => countError(code)),
      onStartTimeout: live(() => countError('start-timeout')),
      onDenied: live(() => fail('denied')),
      onBlocked: live(() => fail('blocked')),
      onUnsupported: live(() => fail('unsupported')),
      onEnd: live(() => {
        if (restartTimer !== null) return;
        restartTimer = setT(() => { restartTimer = null; begin(); }, restartDelayMs);
      }),
    });
    limitTimer = setT(() => { limitTimer = null; finish('stopped', 'timeout'); }, maxMs);
    emit(onState, 'listening', { reason: null, code: null });
    begin();
    return running;
  }

  /** Stops at once. Returns the text collected so far; a phrase still on its way is dropped. */
  function stop() {
    finish('stopped', 'user');
    return parts.join(' ');
  }

  return {
    start,
    stop,
    text: () => parts.join(' '),
    isRunning: () => running,
    elapsedMs: () => (startedAt ? now() - startedAt : 0),
  };
}
