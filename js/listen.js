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

/**
 * Opt-in listener for answering a question out loud (screen 1). Unlike createListener it keeps
 * listening through pauses (continuous + interim results), restarts the browser session when it ends
 * early (Chrome on Android often ends after each phrase), shows live text through onInterim(text),
 * and delivers ONE onResult(fullText) when the user stops, pauses too long, or a time limit is hit.
 * Limits: first word within `firstWaitMs`, `pauseMs` after the last speech, `maxMs` in total.
 * Callbacks as createListener, plus onInterim(text). onEnd fires once per attempt, after onResult.
 * Timers are injectable (`setTimeout`, `clearTimeout`, `now`) so tests run on a fake clock.
 * Returns {start(), stop(), cancel(), active()}; stop() means "done talking": deliver what was heard.
 */
export function createAnswerListener({
  onStart, onEnd, onResult, onInterim, onDenied, onUnsupported, onError, onNoSpeech, onBlocked, onStartTimeout,
  startTimeoutMs = 8000, pauseMs = 3200, firstWaitMs = 10000, maxMs = 30000,
  setTimeout: setT = (...a) => globalThis.setTimeout(...a),
  clearTimeout: clearT = (...a) => globalThis.clearTimeout(...a),
  now = () => Date.now(),
} = {}) {
  let rec = null;
  let active = false;
  let starting = false;
  let began = 0; // when this attempt started (for the overall cap)
  let committed = []; // text of sessions that already ended
  let sessionFinal = ''; // final text of the running session
  let sessionInterim = ''; // not yet final
  let heard = false;
  let startT = null; let firstT = null; let pauseT = null; let maxT = null;
  const call = (fn, ...args) => { try { if (fn) fn(...args); } catch { /* ignore callback errors */ } };
  const clear = (t) => { if (t !== null) clearT(t); return null; };
  const clearAll = () => { startT = clear(startT); firstT = clear(firstT); pauseT = clear(pauseT); maxT = clear(maxT); };
  const detach = (r) => { r.onstart = null; r.onresult = null; r.onerror = null; r.onend = null; };
  const join = (...xs) => xs.map((x) => String(x || '').trim()).filter(Boolean).join(' ');
  const fullText = () => join(...committed, sessionFinal, sessionInterim);

  function reset() {
    committed = []; sessionFinal = ''; sessionInterim = ''; heard = false;
  }

  /** Ends the attempt. deliver=true hands over whatever was heard (once); false drops it. */
  function finish(deliver) {
    const wasRunning = active || starting || rec !== null;
    clearAll();
    const r = rec;
    rec = null; active = false; starting = false;
    if (r) { detach(r); try { r.abort(); } catch { try { r.stop(); } catch { /* ignore */ } } }
    const text = fullText();
    reset();
    if (!wasRunning) return;
    call(onInterim, '');
    if (deliver && text) call(onResult, text);
    call(onEnd);
  }

  function armPause() {
    pauseT = clear(pauseT);
    pauseT = setT(() => { pauseT = null; finish(true); }, pauseMs);
  }

  function openSession() {
    const Ctor = ctor();
    const mine = new Ctor();
    rec = mine;
    mine.lang = 'ko-KR';
    mine.continuous = true;
    mine.interimResults = true;
    mine.maxAlternatives = 1;
    mine.onstart = () => {
      if (rec !== mine) return;
      startT = clear(startT);
      starting = false;
      if (!active) {
        active = true;
        if (!heard) firstT = setT(() => { firstT = null; finish(true); }, firstWaitMs);
        call(onStart);
      }
    };
    mine.onresult = (e) => {
      if (rec !== mine) return;
      let fin = ''; let tmp = '';
      const results = (e && e.results) || [];
      for (let i = 0; i < results.length; i += 1) {
        const alt = results[i] && results[i][0];
        const t = alt && typeof alt.transcript === 'string' ? alt.transcript.trim() : '';
        if (!t) continue;
        if (results[i].isFinal) fin = join(fin, t); else tmp = join(tmp, t);
      }
      sessionFinal = fin;
      sessionInterim = tmp;
      const text = fullText();
      if (!text) return;
      heard = true;
      firstT = clear(firstT);
      armPause();
      call(onInterim, text);
    };
    mine.onerror = (e) => {
      if (rec !== mine) return;
      const code = e && e.error;
      if (code === 'aborted') return; // onend follows and decides
      if (code === 'no-speech') {
        // Nothing heard in this session: browsers end it themselves. With text kept, just finish.
        if (fullText()) finish(true);
        else { finish(false); call(onNoSpeech); }
        return;
      }
      if (fullText()) { finish(true); return; }
      finish(false);
      if (code === 'not-allowed') call(onDenied);
      else if (code === 'service-not-allowed') call(onBlocked);
      else call(onError, code || 'unknown');
    };
    mine.onend = () => {
      if (rec !== mine) return;
      // The browser ended the session early: keep the text and listen again while within limits.
      committed = fullText() ? [fullText()] : [];
      sessionFinal = ''; sessionInterim = '';
      rec = null;
      if (now() - began >= maxMs) { finish(true); return; }
      try { openSession(); } catch { finish(true); }
    };
    mine.start();
  }

  function start() {
    if (!ctor()) { call(onUnsupported); return false; }
    if (active || starting) return true;
    starting = true;
    reset();
    began = now();
    try {
      openSession();
      maxT = setT(() => { maxT = null; finish(true); }, maxMs);
      startT = setT(() => {
        startT = null;
        if (active) return;
        const r = rec;
        rec = null; starting = false;
        clearAll();
        if (r) { detach(r); try { r.abort(); } catch { /* ignore */ } }
        call(onStartTimeout);
      }, startTimeoutMs);
      return true;
    } catch (err) {
      clearAll();
      rec = null; active = false; starting = false;
      call(onError, err && err.name ? err.name : 'start-failed');
      return false;
    }
  }

  function stop() { if (active || starting) finish(true); }

  function cancel() {
    clearAll();
    const r = rec;
    rec = null; active = false; starting = false;
    reset();
    if (r) { detach(r); try { r.abort(); } catch { try { r.stop(); } catch { /* ignore */ } } }
  }

  return { start, stop, cancel, active: () => active };
}
