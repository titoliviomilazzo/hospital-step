// Single-utterance speech recognition (ko-KR). Browser only; isSupported() is safe anywhere.
// Support and permission differ per browser, so the UI always offers typed input as well.

function ctor() {
  return typeof globalThis !== 'undefined'
    ? globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition || null
    : null;
}

export function isSupported() {
  return Boolean(ctor());
}

/**
 * Creates a listener. Callbacks: onStart(), onEnd(), onResult(text), onDenied(), onUnsupported(),
 * onError(code), onNoSpeech(), onBlocked() (the browser's speech service is not allowed: not a
 * permission problem the user can fix), onStartTimeout() (onstart did not fire within `startTimeoutMs`).
 * Returns {start(), stop(), cancel(), active()}. An `aborted` ending is reported only through onEnd;
 * `no-speech` also calls onNoSpeech (the UI asks the user to try again). cancel() drops the session
 * silently: no callback of it fires afterwards (a late result is never delivered).
 */
export function createListener({
  onStart, onEnd, onResult, onDenied, onUnsupported, onError, onNoSpeech, onBlocked, onStartTimeout,
  startTimeoutMs = 8000,
} = {}) {
  let rec = null;
  let active = false;
  let starting = false; // set synchronously so two quick taps cannot create two recognisers
  let timer = null;
  const call = (fn, ...args) => { try { if (fn) fn(...args); } catch { /* ignore callback errors */ } };
  const clearTimer = () => { if (timer !== null) { clearTimeout(timer); timer = null; } };
  const detach = (r) => { r.onstart = null; r.onresult = null; r.onerror = null; r.onend = null; };

  function start() {
    const Ctor = ctor();
    if (!Ctor) {
      call(onUnsupported);
      return false;
    }
    if (active || starting) return true;
    starting = true;
    try {
      const mine = new Ctor();
      rec = mine;
      rec.lang = 'ko-KR';
      rec.continuous = false;
      rec.interimResults = false;
      rec.maxAlternatives = 1;
      rec.onstart = () => { clearTimer(); active = true; starting = false; call(onStart); };
      rec.onresult = (e) => {
        const alt = e.results && e.results[0] && e.results[0][0];
        const text = alt && typeof alt.transcript === 'string' ? alt.transcript.trim() : '';
        if (text) call(onResult, text);
      };
      rec.onerror = (e) => {
        const code = e && e.error;
        clearTimer();
        if (code === 'not-allowed') call(onDenied);
        else if (code === 'service-not-allowed') call(onBlocked);
        else if (code === 'no-speech') call(onNoSpeech);
        else if (code !== 'aborted') call(onError, code || 'unknown');
      };
      rec.onend = () => { clearTimer(); active = false; starting = false; rec = null; call(onEnd); };
      rec.start();
      // Some browsers never fire onstart (no prompt, no error): give up so the button is usable again.
      timer = setTimeout(() => {
        timer = null;
        if (rec !== mine || active) return;
        detach(mine);
        try { mine.abort(); } catch { /* ignore */ }
        rec = null;
        starting = false;
        call(onStartTimeout);
      }, startTimeoutMs);
      return true;
    } catch (err) {
      clearTimer();
      active = false;
      starting = false;
      rec = null;
      call(onError, err && err.name ? err.name : 'start-failed');
      return false;
    }
  }

  function stop() {
    if (rec) {
      try { rec.stop(); } catch { /* ignore */ }
    }
  }

  function cancel() {
    clearTimer();
    const r = rec;
    rec = null;
    active = false;
    starting = false;
    if (r) {
      detach(r);
      try { r.abort(); } catch { try { r.stop(); } catch { /* ignore */ } }
    }
  }

  return { start, stop, cancel, active: () => active };
}
