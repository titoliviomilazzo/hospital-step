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
 * onError(code), onNoSpeech(). Returns {start(), stop(), active()}. An `aborted` ending is reported
 * only through onEnd; `no-speech` also calls onNoSpeech (the UI asks the user to try again).
 */
export function createListener({ onStart, onEnd, onResult, onDenied, onUnsupported, onError, onNoSpeech } = {}) {
  let rec = null;
  let active = false;
  let starting = false; // set synchronously so two quick taps cannot create two recognisers
  const call = (fn, ...args) => { try { if (fn) fn(...args); } catch { /* ignore callback errors */ } };

  function start() {
    const Ctor = ctor();
    if (!Ctor) {
      call(onUnsupported);
      return false;
    }
    if (active || starting) return true;
    starting = true;
    try {
      rec = new Ctor();
      rec.lang = 'ko-KR';
      rec.continuous = false;
      rec.interimResults = false;
      rec.maxAlternatives = 1;
      rec.onstart = () => { active = true; starting = false; call(onStart); };
      rec.onresult = (e) => {
        const alt = e.results && e.results[0] && e.results[0][0];
        const text = alt && typeof alt.transcript === 'string' ? alt.transcript.trim() : '';
        if (text) call(onResult, text);
      };
      rec.onerror = (e) => {
        const code = e && e.error;
        if (code === 'not-allowed' || code === 'service-not-allowed') call(onDenied);
        else if (code === 'no-speech') call(onNoSpeech);
        else if (code !== 'aborted') call(onError, code || 'unknown');
      };
      rec.onend = () => { active = false; starting = false; rec = null; call(onEnd); };
      rec.start();
      return true;
    } catch (err) {
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

  return { start, stop, active: () => active };
}
