// Visit-notes flow: the state machine behind screens N0..N4 (docs/PLAN-visit-notes.md section 1-2)
// and the pure helpers of the record screens V1/V2. No DOM here: app.js draws what `state` says,
// and everything the flow touches (microphone, network, storage, clock, timers) is injected so the
// tests can run the whole flow in Node.
//
// Rules this module enforces:
//   - the microphone is started only by grantConsent(), which the doctor's own tap on N1 calls;
//     declining, leaving or never reaching N1 never creates a listener;
//   - nothing leaves the phone except the scrubbed transcript, and only when a NOTES_URL is set;
//   - every item of a reply passes validateNotesReply() against the scrubbed transcript;
//   - the record is stored before the user confirms items; each confirm/edit/delete is written back.
import {
  scrub, validateNotesReply, extractByRules, orderItems, locateSource, resolveNextWhen, parseIsoDate, MAX_TEXT,
} from './notes.js';
import { makeRecord, addRecord, listRecords, updateRecord, dropOldest, getRecord } from './notes-store.js';
import { createNotesListener, DEFAULT_MAX_MS } from './notes-listen.js';
import { visitIcs, medIcs } from './ics.js';
import { parseHospitalText } from './paper.js';

export const NOTES_TIMEOUT_MS = 20000;
export const DECLINE_SHOW_MS = 3000;
export const SIM_LINE_MS = 1200;
const MAX_BODY_BYTES = 64 * 1024;

export const SAMPLE_BAND = '예시 대화';
export const SAVED_RESULT_BAND = '저장해 둔 결과';
export const SUMMARY_LATER = '정리하지 못했어요. 받아 적은 글은 [원문 보기]에서 볼 수 있어요.';
export const ALL_DELETED = '모든 항목을 지웠어요.';
export const SAVED_LINE = '받아 적은 글은 휴대폰에 저장했어요. 첫 화면의 내 진료 기록에서 볼 수 있어요.';
export const SAVED_LINE_DELETED = '받아 적은 글은 [원문 보기]에서 볼 수 있어요. 첫 화면의 내 진료 기록에서 열어요.';
export const CONSENT_AI_LINE = '이름과 번호를 가린 글자를 정리용 AI 서비스로 보냅니다';
export const TAP_GUARD_MS = 600; // taps this soon after a screen appears are ignored (app.js turns it on)
export const NO_SAMPLE_MSG = '예시 대화를 불러오지 못했어요. 글로 적어 주세요.';
export const PASTED_BAND = '병원 문자에서 정리';
export const SAMPLE_MESSAGE_BAND = '예시 문자: 가상의 내용이에요';
export const PASTE_HINT = '글 입력칸을 길게 눌러 붙여넣어 주세요';
export const PASTE_EMPTY_MSG = '복사된 글이 없어요. 문자를 길게 눌러 복사한 뒤 다시 눌러 주세요.';
export const PASTE_PRIVACY_LINE = '붙여넣은 글은 이 휴대폰 안에서만 정리해요.';
export const PASTE_NONE_MSG = '정리할 내용을 찾지 못했어요. 문자 안에 날짜나 약 먹는 법이 있는지 확인해 주세요.';
export const PASTED_SUMMARY_LATER = '정리하지 못했어요. 문자는 [원문 보기]에서 볼 수 있어요.';
export const PASTED_ALL_DELETED = '모든 항목을 지웠어요.';
export const PASTED_SAVED_LINE = '문자는 휴대폰에 저장했어요. 첫 화면의 내 진료 기록에서 볼 수 있어요.';
export const DROPPED_PASTE_TEXT = (n) => `${n}개는 정리하지 못했어요. 원문에서 확인하세요`;
export const PASTED_SAVED_LINE_DELETED = '문자는 [원문 보기]에서 볼 수 있어요. 첫 화면의 내 진료 기록에서 열어요.';
export const MAX_PASTE_CHARS = 5000;
export const EMPTY_MSG = '받아 적은 말이 없어요. 아래 칸에 글로 적거나 닫아 주세요.';

// ---------------------------------------------------------------------------------------------
// where the flow sits in the route
// ---------------------------------------------------------------------------------------------

/**
 * True when confirming the point at `index` leads straight to the consultation (the next point
 * waits for the doctor). This is where N0 is asked. Taken from the route data, not from an id.
 */
export function asksNotesAfter(route, index) {
  const here = route && route.points ? route.points[index] : null;
  const next = route && route.points ? route.points[index + 1] : null;
  return Boolean(here && next && here.stage === 'indoor' && next.stage === 'indoor' && next.wait === true);
}

/** I4: the point where the consultation happens. */
export function isConsultPoint(point) {
  return Boolean(point && point.stage === 'indoor' && point.wait === true);
}

/** The big [진료실에 들어왔어요] button on I4: only after the user said yes on N0 and before a note is taken. */
export function showEnterRoomButton(flowState) {
  return Boolean(flowState && flowState.wants === true && flowState.phase === null && !flowState.saved);
}

/** Offer N0 on I4 itself (resuming a visit lands here without confirming the point before). */
export function shouldOfferNotes(point, flowState) {
  return Boolean(isConsultPoint(point) && flowState && flowState.wants === null && flowState.phase === null && !flowState.saved);
}

/** The help card may speak everywhere except while the microphone is open (it would hear the app). */
export function helpMaySpeak(flowState) {
  return !(flowState && flowState.phase === 'n2');
}

/**
 * What the last N4 screen says about the outcome: {lead, saved}. Both null when there are items.
 * "저장했어요" appears only when a record was really stored (state.record); with no items, a failed
 * summary and "the user deleted them all" read differently.
 */
export function finalNote(flowState) {
  const f = flowState || {};
  if (Array.isArray(f.items) && f.items.length) return { lead: null, saved: null };
  const stored = Boolean(f.record);
  if (f.origin === 'paste') {
    if (f.summary === 'none') return { lead: PASTED_SUMMARY_LATER, saved: stored ? PASTED_SAVED_LINE : null };
    return { lead: PASTED_ALL_DELETED, saved: stored ? PASTED_SAVED_LINE_DELETED : null };
  }
  if (f.summary === 'none') return { lead: SUMMARY_LATER, saved: stored ? SAVED_LINE : null };
  return { lead: ALL_DELETED, saved: stored ? SAVED_LINE_DELETED : null };
}

// ---------------------------------------------------------------------------------------------
// time helpers
// ---------------------------------------------------------------------------------------------

const pad2 = (n) => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' of a Date in the phone's local time. */
export function localDate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 'YYYY-MM-DDTHH:MM:SS+09:00' style stamp in the phone's local time. */
export function localStamp(d) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `${localDate(d)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}${sign}${pad2(Math.floor(a / 60))}:${pad2(a % 60)}`;
}

// ---------------------------------------------------------------------------------------------
// screen lock (N1 and N2 keep the phone awake, like the get-off alert does)
// ---------------------------------------------------------------------------------------------

/** {on(), off()} around navigator.wakeLock; every failure is ignored because it is only a comfort. */
export function createWakeLock({ nav = globalThis.navigator, doc = globalThis.document } = {}) {
  let want = false;
  let lock = null;
  async function acquire() {
    try {
      if (!want || lock || !nav || !nav.wakeLock || typeof nav.wakeLock.request !== 'function') return;
      const l = await nav.wakeLock.request('screen');
      if (!want) { if (l && typeof l.release === 'function') l.release(); return; }
      lock = l;
    } catch { /* optional */ }
  }
  const onVisible = () => { if (doc && doc.visibilityState === 'visible') acquire(); else lock = null; };
  return {
    on() {
      if (want) return;
      want = true;
      if (doc && typeof doc.addEventListener === 'function') doc.addEventListener('visibilitychange', onVisible);
      acquire();
    },
    off() {
      if (!want) return;
      want = false;
      if (doc && typeof doc.removeEventListener === 'function') doc.removeEventListener('visibilitychange', onVisible);
      const l = lock;
      lock = null;
      if (l && typeof l.release === 'function') { try { Promise.resolve(l.release()).catch(() => {}); } catch { /* ignore */ } }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// summarising (design 3-2, 3-3)
// ---------------------------------------------------------------------------------------------

function withTimeout(promise, ms, onTimeout) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { onTimeout(); reject(new Error('timeout')); }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Turns a transcript into checked items. The transcript is scrubbed first and everything after
 * that, including the stored record, uses the scrubbed text. With a `url` the scrubbed text is
 * POSTed ({transcript}) with a 20 s limit; the reply is checked by validateNotesReply. On any
 * failure, or when nothing usable comes back, the fallback runs: `fallbackReply` (the saved result
 * of the sample conversation) when given, otherwise extractByRules. Returns
 * {transcript, items, dropped, summary: 'ai'|'rules'|'none', usedSaved}. Never throws.
 */
export async function summarizeTranscript(rawText, {
  url = '', fetch: fetchImpl = globalThis.fetch, timeoutMs = NOTES_TIMEOUT_MS, today = null, fallbackReply = null,
} = {}) {
  const transcript = scrub(rawText).trim();
  let ai = null;
  if (url && typeof fetchImpl === 'function' && transcript) {
    try {
      const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const call = (async () => {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ transcript }),
          signal: ctl ? ctl.signal : undefined,
        });
        if (!res || res.status !== 200) throw new Error(`status ${res && res.status}`);
        const raw = await res.text();
        if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > MAX_BODY_BYTES) throw new Error('body too large');
        return JSON.parse(raw);
      })();
      const body = await withTimeout(call, timeoutMs, () => { if (ctl) ctl.abort(); });
      const v = validateNotesReply(body, transcript, { today });
      if (v.ok) ai = v;
    } catch { ai = null; }
  }
  if (ai && ai.items.length) {
    return { transcript, items: orderItems(ai.items), dropped: ai.dropped, summary: 'ai', usedSaved: false };
  }
  const usedSaved = Boolean(fallbackReply);
  const fb = usedSaved
    ? validateNotesReply(fallbackReply, transcript, { today })
    : extractByRules(transcript, { today });
  if (fb.ok && fb.items.length) {
    return { transcript, items: orderItems(fb.items), dropped: fb.dropped, summary: 'rules', usedSaved };
  }
  return { transcript, items: [], dropped: ai ? ai.dropped : 0, summary: 'none', usedSaved: false };
}

// ---------------------------------------------------------------------------------------------
// the flow controller
// ---------------------------------------------------------------------------------------------

function blankState() {
  return {
    wants: null, // N0 answer: null not asked, true, false
    phase: null, // null (the route screen shows) | n0 | n1 | n1-declined | n2 | n3 | full | n4 | p0 (paste) | p1 (nothing found)
    consentAt: null,
    source: null, // listen | typed | sample
    lines: [], // text shown on N2, one entry per phrase (raw: dropped as soon as it is summarised)
    typed: '', // text typed on N2 (kept here so an automatic stop does not lose it)
    listening: false,
    typedOpen: false,
    msg: null, // a line under the N2 text (why typing is offered)
    sample: false, // N2/N4 run on the example conversation
    usedSaved: false, // the items come from the saved result, not from a live call
    record: null, // id of the stored record, or null while nothing is stored
    pendingRecord: null, // built but not stored yet (the store is full and the user is asked)
    saveNote: null, // why the record is not stored
    transcript: '',
    items: [],
    dropped: 0,
    summary: null,
    idx: 0, // N4: which item; items.length is the last screen
    editing: false,
    saved: false, // a note was taken in this visit (I4 does not offer the button again)
    origin: null, // 'paste' while the pasted-message screens (p0, p1, and N4 on its items) run
    pasteText: '', // raw pasted text (p0 only: dropped as soon as it is scrubbed, and on leave)
    pasteMsg: null, // a line under the paste box
    pasteSample: false, // the box holds the example message (simulation)
    visitRecord: null, // the visit's own record id, kept aside while a pasted message uses state.record
  };
}

/**
 * Deps (all optional except what a path needs):
 *   createListener  listen.js signature (the notes listener wraps it)
 *   sim()           true in simulation mode
 *   sample          the parsed data/sample-visit.json
 *   sampleMessage   the parsed data/sample-message.json ({text}), simulation only
 *   listenOn()      true when the optional doctor-speech transcription is switched on (default off)
 *   nav             navigator (clipboard.readText for [붙여넣기])
 *   notesUrl        NOTES_URL ('' = rules only)
 *   fetch, now(), store, hospital, wakeLock {on, off}, onChange(state)
 *   setTimeout / clearTimeout, maxMs, simLineMs, declineMs, timeoutMs
 */
export function createNotesFlow(deps = {}) {
  const d = {
    createListener: null,
    sim: () => false,
    sample: null,
    sampleMessage: null,
    listenOn: () => false,
    nav: globalThis.navigator,
    notesUrl: '',
    fetch: globalThis.fetch,
    now: () => new Date(),
    store: null,
    hospital: '분당서울대병원',
    wakeLock: null,
    onChange: null,
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id) => globalThis.clearTimeout(id),
    maxMs: DEFAULT_MAX_MS,
    simLineMs: SIM_LINE_MS,
    declineMs: DECLINE_SHOW_MS,
    timeoutMs: NOTES_TIMEOUT_MS,
    doc: globalThis.document,
    win: globalThis.window,
    tapGuardMs: 0, // app.js passes TAP_GUARD_MS; 0 = no guard
    ...deps,
  };
  let st = blankState();
  let nl = null; // the notes listener of the running session
  let token = 0; // bumped when a screen is left: late callbacks of an older session do nothing
  let timer = null;
  let simIndex = 0;

  let screenAt = 0; // when the screen last changed (see tapReady)
  let screenKey = '';
  const nowMs = () => { try { return d.now().getTime(); } catch { return Date.now(); } };
  const keyOf = () => `${st.phase}|${st.idx}|${st.editing}`;
  const change = () => {
    const k = keyOf();
    if (k !== screenKey) { screenKey = k; screenAt = nowMs(); }
    if (typeof d.onChange === 'function') { try { d.onChange(st); } catch { /* ignore */ } }
  };
  /** False while a tap would land within tapGuardMs of the screen appearing (a double tap, a tap meant for the last screen). */
  const tapReady = () => !(d.tapGuardMs > 0 && nowMs() - screenAt < d.tapGuardMs);
  /** app.js calls this when the route screen changes (I4 shows) so [진료실에 들어왔어요] is guarded too. */
  const touchScreen = () => { screenAt = nowMs(); };
  const set = (patch) => { st = { ...st, ...patch }; change(); };
  const clearTimer = () => { if (timer !== null) { d.clearTimeout(timer); timer = null; } };
  const awake = (on) => { if (d.wakeLock) { try { if (on) d.wakeLock.on(); else d.wakeLock.off(); } catch { /* ignore */ } } };
  const storeArg = () => d.store || null;

  function endCapture() {
    clearTimer();
    if (nl) { try { nl.stop(); } catch { /* ignore */ } nl = null; }
  }

  /** Drops the running screen (capture, timers, wake lock). Stored records stay. */
  function leave() {
    token += 1;
    endCapture();
    awake(false);
    st = { ...st, lines: [], typed: '', pasteText: '', pasteMsg: null, pasteSample: false }; // raw text never outlives its screen
    if (st.origin === 'paste') st = { ...st, origin: null, sample: false, record: st.visitRecord, visitRecord: null, transcript: '', items: [], pendingRecord: null };
    if (st.phase !== null) set({ phase: null, listening: false, editing: false });
  }

  /**
   * The mode (simulation on/off) changed. A running capture (N1, N2) belongs to the old mode and is
   * dropped; N3 (summarising), the "store full" question and N4 already hold a result, so they run to
   * the end instead of silently discarding it.
   */
  function modeChanged() {
    // The example message exists only in simulation: it goes when the mode changes, text the user typed stays.
    if (st.pasteSample) { st = { ...st, pasteText: '', pasteMsg: null, pasteSample: false }; change(); }
    if (['n3', 'full', 'n4', 'p0', 'p1'].includes(st.phase)) return;
    leave();
  }

  /** The optional transcription was switched off: its screens (N0..N2) end, the microphone with them. */
  function listenSettingChanged() {
    if (d.listenOn()) return;
    if (['n0', 'n1', 'n1-declined', 'n2'].includes(st.phase)) leave();
    if (st.wants !== null && st.phase === null) st = { ...st, wants: null };
    change();
  }

  function reset() {
    token += 1;
    endCapture();
    awake(false);
    st = blankState();
    change();
  }

  /** Drops every text the flow holds in memory (settings: 진료 기록 모두 지우기). Records are not touched here. */
  function forget() {
    // Like leave(): whatever screen was open (N2 with the microphone, a pasted message's N4) ends, so no
    // button of it can mark the visit as noted or move the route on afterwards.
    token += 1;
    endCapture();
    awake(false);
    st = {
      ...st, lines: [], typed: '', pasteText: '', pasteMsg: null, pasteSample: false, transcript: '', items: [], pendingRecord: null,
      record: null, visitRecord: null, origin: null, sample: false, idx: 0, editing: false, listening: false, phase: null,
    };
    change();
  }

  // ---- N0
  function askAfterConfirm() {
    if (!d.listenOn() || st.wants !== null || st.phase !== null) return false;
    set({ phase: 'n0' });
    return true;
  }

  function answerN0(yes) {
    if (st.phase !== 'n0') return;
    set({ wants: Boolean(yes), phase: null });
  }

  // ---- N1
  function enterRoom() {
    if (!d.listenOn() || st.wants !== true || st.phase !== null || st.saved || !tapReady()) return;
    awake(true); // the phone is shown to the doctor: keep the screen on
    set({ phase: 'n1' });
  }

  function declineConsent() {
    if (st.phase !== 'n1') return;
    awake(false);
    const mine = ++token;
    set({ phase: 'n1-declined' });
    clearTimer();
    timer = d.setTimeout(() => {
      timer = null;
      if (mine === token && st.phase === 'n1-declined') set({ phase: null });
    }, d.declineMs);
  }

  /** Back to I4 at once (the 3 s message is skipped). */
  function closeDeclined() {
    if (st.phase !== 'n1-declined') return;
    clearTimer();
    token += 1;
    set({ phase: null });
  }

  // ---- N2
  /** Called only from the doctor's tap on [네, 괜찮습니다]. Starts the capture. */
  function grantConsent() {
    if (st.phase !== 'n1' || !d.listenOn()) return false;
    const stamp = localStamp(d.now());
    const mine = ++token;
    const simOn = Boolean(d.sim());
    const sampleRun = Boolean(simOn && d.sample && Array.isArray(d.sample.lines) && d.sample.lines.length);
    set({
      phase: 'n2', consentAt: sampleRun ? null : stamp, lines: [], typed: '', listening: false, typedOpen: false, msg: null,
      sample: sampleRun, source: sampleRun ? 'sample' : null, usedSaved: false,
    });
    awake(true);
    if (simOn && !sampleRun) {
      // simulation must never reach the real microphone
      set({ typedOpen: true, msg: NO_SAMPLE_MSG });
      return true;
    }
    if (sampleRun) {
      simIndex = 0;
      set({ listening: true });
      const tick = () => {
        timer = null;
        if (mine !== token || st.phase !== 'n2') return;
        const line = d.sample.lines[simIndex];
        if (line) {
          simIndex += 1;
          set({ lines: [...st.lines, line.text] });
        }
        if (simIndex < d.sample.lines.length) timer = d.setTimeout(tick, d.simLineMs);
      };
      timer = d.setTimeout(tick, d.simLineMs);
      return true;
    }
    if (typeof d.createListener !== 'function') {
      set({ typedOpen: true, msg: '이 기기에서는 받아 적기를 쓸 수 없어요. 글로 적어 주세요.' });
      return true;
    }
    nl = createNotesListener({
      createListener: d.createListener,
      maxMs: d.maxMs,
      setTimeout: d.setTimeout,
      clearTimeout: d.clearTimeout,
      onText: (t) => {
        if (mine !== token || st.phase !== 'n2') return;
        set({ lines: [...st.lines, t], source: 'listen' });
      },
      onState: (state, info) => {
        if (mine !== token || st.phase !== 'n2') return;
        if (state === 'listening') { set({ listening: true }); return; }
        if (state === 'failed') {
          const why = info && info.reason === 'denied' ? '마이크 사용이 허용되지 않았어요. 글로 적어 주세요.'
            : info && info.reason === 'errors' ? '음성 인식에 문제가 계속 생겨 멈췄어요. 글로 적어 주세요.'
              : '이 브라우저에서는 받아 적기를 쓸 수 없어요. 글로 적어 주세요.';
          nl = null;
          set({ listening: false, typedOpen: true, msg: why });
        } else if (state === 'stopped' && info && info.reason === 'timeout') {
          nl = null;
          set({ listening: false, msg: '20분이 지나 받아 적기를 멈췄어요.' });
          finishCapture(''); // keeps what was typed (st.typed) as well as what was heard
        }
      },
    });
    nl.start();
    return true;
  }

  /** The [글로 적기] box without waiting for a failure. */
  function openTyped() {
    if (st.phase === 'n2') set({ typedOpen: true });
  }

  /** Remembers the typed text without a redraw (a redraw would drop the keyboard). */
  function setTyped(text) {
    st = { ...st, typed: String(text ?? '') };
  }

  // Leaving the screen while the microphone is open: stop it and keep what was heard (design: auto-stop
  // "when the screen is left"). The normal stop path runs, so the text is summarised and saved like any
  // other stop; with nothing heard the typed box opens instead.
  const onHide = (e) => {
    const hidden = e && e.type === 'pagehide' ? true : Boolean(d.doc && d.doc.visibilityState === 'hidden');
    if (hidden && st.phase === 'n2') stop();
  };
  if (d.doc && typeof d.doc.addEventListener === 'function') d.doc.addEventListener('visibilitychange', onHide);
  if (d.win && typeof d.win.addEventListener === 'function') d.win.addEventListener('pagehide', onHide);

  /** [그만 적기]: stops at once, adds the typed text if any, then goes to N3. */
  function stop(extraTyped = '') {
    if (st.phase !== 'n2') return Promise.resolve(false);
    if (!String(extraTyped || '').trim()) extraTyped = st.typed;
    token += 1; // anything the microphone still delivers is dropped
    endCapture();
    awake(false);
    set({ listening: false });
    return finishCapture(extraTyped);
  }

  /** [적지 않고 닫기]: stops the microphone, drops what was heard and typed, saves nothing, back to I4. */
  function cancelCapture() {
    if (st.phase !== 'n2') return;
    leave(); // clears lines and typed text too
    st = { ...st, source: null, sample: false, msg: null, typedOpen: false, listening: false };
    change();
  }

  async function finishCapture(extraTyped) {
    const extra = String(extraTyped || st.typed || '').trim();
    const lines = extra ? [...st.lines, extra] : st.lines;
    if (!lines.length) {
      set({ lines, listening: false, typedOpen: true, msg: EMPTY_MSG });
      return false;
    }
    const source = st.sample ? 'sample' : (st.source === 'listen' ? 'listen' : 'typed');
    const mine = ++token;
    set({ lines, source, phase: 'n3', listening: false, typed: '' });
    awake(false);
    const sampleRun = st.sample;
    const today = sampleRun && d.sample.visitDate ? d.sample.visitDate : localDate(d.now());
    const raw = lines.join('\n');
    const out = await summarizeTranscript(raw, {
      url: d.notesUrl, fetch: d.fetch, timeoutMs: d.timeoutMs, today,
      fallbackReply: sampleRun && d.sample && Array.isArray(d.sample.savedItems) ? { items: d.sample.savedItems } : null,
    });
    if (mine !== token || st.phase !== 'n3') return false;
    st = { ...st, lines: [] }; // the raw text is gone: only the scrubbed transcript goes on
    const date = sampleRun && d.sample.visitDate ? d.sample.visitDate : today;
    const existing = listRecords(storeArg()).map((r) => r.id);
    const rec = makeRecord({
      date, hospital: sampleRun && d.sample.hospital ? d.sample.hospital : d.hospital,
      consentAt: sampleRun ? null : st.consentAt, source, transcript: out.transcript, items: out.items,
      dropped: out.dropped, summary: out.summary, existingIds: existing,
    });
    set({
      transcript: out.transcript, items: rec.items, dropped: out.dropped, summary: out.summary,
      usedSaved: out.usedSaved, idx: 0, editing: false, pendingRecord: rec,
    });
    storeRecord(rec);
    return true;
  }

  /** The visit's own note marks the visit as noted; a pasted message never does. */
  const savedFlag = () => (st.origin === 'paste' ? {} : { saved: true });

  /** Stores a built record and moves to N4 (or asks first when the store is full). */
  function storeRecord(rec) {
    const added = addRecord(rec, storeArg());
    if (added.ok) {
      set({ record: rec.id, pendingRecord: null, saveNote: null, ...savedFlag(), phase: 'n4' });
    } else if (added.reason === 'full') {
      set({ phase: 'full', saveNote: null });
    } else {
      set({ record: null, pendingRecord: null, saveNote: '이 휴대폰에는 저장하지 못했어요.', ...savedFlag(), phase: 'n4' });
    }
  }

  // ---- pasted hospital message (P0 paste, P1 nothing found)
  /** [병원 문자 넣기]: opens the paste screen. The visit's own record id is parked until it closes. */
  function openPaste() {
    if (st.phase !== null || !tapReady()) return false;
    token += 1;
    st = {
      ...st, origin: 'paste', visitRecord: st.record, record: null, pasteText: '', pasteMsg: null, pasteSample: false,
      sample: false, usedSaved: false, transcript: '', items: [], dropped: 0, summary: null, idx: 0, editing: false,
      pendingRecord: null, saveNote: null,
    };
    set({ phase: 'p0' });
    return true;
  }

  /** Remembers the box text without a redraw (a redraw would drop the keyboard). */
  function setPasteText(text) {
    st = { ...st, pasteText: String(text ?? '').slice(0, MAX_PASTE_CHARS), pasteSample: false };
  }

  /** [붙여넣기]: reads the clipboard when the browser allows it; every failure shows the hint. */
  async function pasteFromClipboard() {
    if (st.phase !== 'p0' || !tapReady()) return false;
    const nav = d.nav;
    if (!nav || !nav.clipboard || typeof nav.clipboard.readText !== 'function') {
      set({ pasteMsg: PASTE_HINT });
      return false;
    }
    const mine = token;
    let text = null;
    try { text = await nav.clipboard.readText(); } catch { text = null; }
    if (mine !== token || st.phase !== 'p0') return false;
    if (typeof text !== 'string') { set({ pasteMsg: PASTE_HINT }); return false; }
    if (!text.trim()) { set({ pasteMsg: PASTE_EMPTY_MSG }); return false; }
    set({ pasteText: text.slice(0, MAX_PASTE_CHARS), pasteMsg: null, pasteSample: false });
    return true;
  }

  /** [예시 문자 넣기] (simulation only): fills the box with the fictional message. */
  function fillSampleMessage() {
    if (st.phase !== 'p0' || !d.sim() || !d.sampleMessage || typeof d.sampleMessage.text !== 'string') return false;
    set({ pasteText: d.sampleMessage.text, pasteMsg: null, pasteSample: true });
    return true;
  }

  /** The hospital name in a leading "[...]" tag of the (scrubbed) message, if it looks like one. */
  const hospitalOf = (text) => {
    const m = /^\s*\[([^\]\n]{2,20}(?:병원|의원|센터))\]/.exec(text);
    return m ? m[1] : null;
  };

  /**
   * [정리하기]: rules only, on the phone. The raw text is replaced by the scrubbed text before anything
   * else is stored or shown. Items go to the N4 confirm screens; nothing found goes to P1.
   */
  function organise() {
    if (st.phase !== 'p0') return false;
    const raw = String(st.pasteText || '');
    if (!raw.trim()) return false;
    const today = localDate(d.now());
    let res;
    try { res = parseHospitalText(raw, { today }); } catch { res = null; }
    const text = res && typeof res.text === 'string' ? res.text.trim() : '';
    if (!text) { set({ pasteText: '', pasteMsg: null, pasteSample: false, phase: 'p1', transcript: '' }); return true; }
    const items = res && res.ok ? orderItems(res.items) : [];
    if (!items.length) {
      set({ pasteText: '', pasteMsg: null, transcript: text, dropped: res ? res.dropped : 0, phase: 'p1' }); // pasteSample stays: [그냥 저장] needs it
      return true;
    }
    // the example message (simulation) is stored as an example: its band, speech note and share text apply
    const sampleRun = Boolean(st.pasteSample && d.sim());
    const rec = makeRecord({
      date: today, hospital: hospitalOf(text), consentAt: null, source: sampleRun ? 'sample' : 'pasted', msg: sampleRun,
      transcript: text, items, dropped: res.dropped, summary: 'rules', existingIds: listRecords(storeArg()).map((r) => r.id),
    });
    set({
      pasteText: '', pasteMsg: null, pasteSample: false, sample: sampleRun, transcript: text, items: rec.items, dropped: res.dropped,
      summary: 'rules', idx: 0, editing: false, pendingRecord: rec,
    });
    storeRecord(rec);
    return true;
  }

  /** P1 [다시 넣기]: back to an empty paste box. */
  function pasteAgain() {
    if (st.phase !== 'p1' || !tapReady()) return false;
    set({ phase: 'p0', transcript: '', dropped: 0, pasteText: '', pasteMsg: null, pasteSample: false });
    return true;
  }

  /** P1 [그냥 저장]: saves the scrubbed text only (no items). */
  function saveTextOnly() {
    if (st.phase !== 'p1' || !st.transcript) return false;
    const sampleRun = Boolean(st.pasteSample && d.sim());
    const rec = makeRecord({
      date: localDate(d.now()), hospital: hospitalOf(st.transcript), consentAt: null, source: sampleRun ? 'sample' : 'pasted', msg: sampleRun,
      transcript: st.transcript, items: [], dropped: st.dropped, summary: 'none', existingIds: listRecords(storeArg()).map((r) => r.id),
    });
    set({ items: [], dropped: 0, summary: 'none', idx: 0, editing: false, pendingRecord: rec });
    storeRecord(rec);
    return true;
  }

  /** The store holds 20 records: 'drop' deletes the oldest and saves, 'skip' keeps this one unsaved. */
  function resolveFull(choice) {
    if (st.phase !== 'full') return false;
    const rec = st.pendingRecord;
    if (choice === 'drop') {
      dropOldest(storeArg());
      const added = addRecord(rec, storeArg());
      set({
        record: added.ok ? rec.id : null, pendingRecord: null, ...savedFlag(), phase: 'n4',
        saveNote: added.ok ? null : '이 휴대폰에는 저장하지 못했어요.',
      });
    } else {
      set({ record: null, pendingRecord: null, ...savedFlag(), phase: 'n4', saveNote: '기록을 저장하지 않았어요.' });
    }
    return true;
  }

  // ---- N4
  const persistItems = () => {
    if (st.record) updateRecord(st.record, { items: st.items }, storeArg());
  };

  function itemAction(kind) {
    if (st.phase !== 'n4' || st.idx >= st.items.length || st.editing || !tapReady()) return false;
    if (kind === 'ok') {
      const items = st.items.map((it, i) => (i === st.idx ? { ...it, status: 'confirmed' } : it));
      st = { ...st, items, idx: st.idx + 1 };
    } else if (kind === 'delete') {
      st = { ...st, items: st.items.filter((_, i) => i !== st.idx) };
    } else if (kind === 'edit') {
      st = { ...st, editing: true };
    } else {
      return false;
    }
    persistItems();
    change();
    return true;
  }

  /** [고칠게요] then the new sentence: marked 직접 고침, the doctor's quote stays. */
  function saveEdit(text) {
    const t = String(text || '').trim().slice(0, MAX_TEXT);
    if (st.phase !== 'n4' || !st.editing || !t) return false;
    // The new sentence is the user's own: what was read from the doctor's words (date, time, doses)
    // no longer describes it, so the calendar asks the user again.
    const items = st.items.map((it, i) => (i === st.idx ? clearStructured({ ...it, text: t, edited: true, status: 'confirmed' }) : it));
    st = { ...st, items, editing: false, idx: st.idx + 1 };
    persistItems();
    change();
    return true;
  }

  function cancelEdit() {
    if (st.phase === 'n4' && st.editing) set({ editing: false });
  }

  function prevItem() {
    if (st.phase === 'n4' && !st.editing && st.idx > 0) set({ idx: st.idx - 1 });
  }

  /** [확인했어요] on the last screen: back to the route (the app then continues to the next point). */
  function finish() {
    if (st.phase !== 'n4') return null;
    const id = st.record;
    token += 1;
    if (st.origin === 'paste') {
      // A pasted message is not part of the visit: the visit's own record and its "noted" flag stay as they were.
      st = { ...st, origin: null, sample: false, record: st.visitRecord, visitRecord: null, transcript: '', items: [], pendingRecord: null };
      set({ phase: null, editing: false });
      return id;
    }
    set({ phase: null, saved: true, editing: false });
    return id;
  }

  return {
    get state() { return st; },
    askAfterConfirm, answerN0, enterRoom, declineConsent, closeDeclined, grantConsent, openTyped, stop,
    cancelCapture, resolveFull, itemAction, saveEdit, cancelEdit, prevItem, finish, leave, reset,
    setTyped, modeChanged, listenSettingChanged, forget, touchScreen, tapOk: tapReady,
    openPaste, setPasteText, pasteFromClipboard, fillSampleMessage, organise, pasteAgain, saveTextOnly,
  };
}

/** An item whose sentence the user rewrote: date, time and dose fields are emptied. */
function clearStructured(it) {
  const out = { ...it };
  if (it.next) out.next = { ...it.next, date: null, time: null, userDate: false };
  if (it.med) out.med = { ...it.med, timesPerDay: null, slots: [], days: null };
  return out;
}

// ---------------------------------------------------------------------------------------------
// record screens (V1, V2): pure helpers
// ---------------------------------------------------------------------------------------------

/** Label of a record in the list: date and hospital. */
export function recordTitle(rec) {
  return [rec.date, rec.hospital].filter(Boolean).join(' ');
}

/**
 * The newest record of a date (the record of today's visit), or null. Example records count only
 * when `sim` is true: a real visit never offers the example conversation back.
 */
export function recordForDate(records, date, { sim = true } = {}) {
  return (records || []).find((r) => r.date === date && isVisitRecord(r, { sim })) || null;
}

/** A hospital message (pasted, or the example message): it says nothing about what was said in a visit. */
export const isMessageRecord = (rec) => Boolean(rec && (rec.source === 'pasted' || rec.msg === true));

/**
 * A record of a visit itself: heard (listen), typed or the example conversation (only in simulation).
 * A pasted message is never "today's visit", whatever day it was put in.
 */
export function isVisitRecord(rec, { sim = true } = {}) {
  if (!rec || isMessageRecord(rec)) return false;
  return rec.source === 'listen' || rec.source === 'typed' || (rec.source === 'sample' && Boolean(sim));
}

/** [달력에 넣기] for a next-visit item needs a real date: the stored one or one the user picked. */
export function nextNeedsDate(item) {
  return Boolean(item && item.kind === 'next' && !(item.next && item.next.date));
}

/** What to prefill the date input with: only a date the doctor's sentence literally says. */
export function datePrefill(item, today = null) {
  if (item && item.edited) return ''; // the sentence was rewritten: the old quote no longer applies
  const w = item && item.source ? resolveNextWhen(item.source, { today }) : null;
  return w && w.date ? w.date : '';
}

/** Fixed name of the downloaded calendar file. */
export function icsFilename(kind) {
  return kind === 'med' ? 'hospital-medicine.ics' : 'hospital-visit.ics';
}

/**
 * Calendar text for one next-visit item, or null while it has no date. With `recordId` and `index`
 * the UID is stable (record + item), so importing again updates the entry instead of doubling it;
 * `sequence` rises with every new export.
 */
export function visitIcsFor(item, { dtstamp, recordId = null, index = 0, sequence = 0 } = {}) {
  if (!item || item.kind !== 'next' || !item.next || !item.next.date) return null;
  return visitIcs({
    date: item.next.date, time: item.next.time || null, place: item.next.place || null, dtstamp, sequence,
    uid: recordId ? `visit-${recordId}-${index}@hospital-step` : null,
  });
}

/**
 * The time slots to ask the user about for a medicine item: one per dose, labelled by the slot
 * the doctor said when there is one. Null when the doses per day are unknown (nothing to ask).
 */
export function medSlotsFor(item) {
  if (!item || item.kind !== 'med' || !item.med) return null;
  const slots = Array.isArray(item.med.slots) ? item.med.slots : [];
  const n = Number.isInteger(item.med.timesPerDay) ? item.med.timesPerDay : (slots.length || null);
  if (!n) return null;
  return Array.from({ length: n }, (_, i) => ({ label: slots[i] || `${i + 1}번째`, time: '' }));
}

/** medIcs text from the user's chosen times ([{label, time}]); null when no slot has a time. */
export function medIcsFor(item, picked, startDate, { dtstamp, recordId = null, index = 0, sequence = 0 } = {}) {
  if (!item || item.kind !== 'med' || !item.med) return null;
  const days = Number.isInteger(item.med.days) ? item.med.days : undefined;
  return medIcs({ slots: picked, startDate, days, dtstamp, sequence, uidBase: recordId ? `med-${recordId}-${index}` : null });
}

const addDays = (iso, n) => {
  const d = parseIsoDate(iso);
  const t = new Date(Date.UTC(d.y, d.m - 1, d.d + n));
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
};

/**
 * Where the medicine calendar starts: the visit date while today still falls inside the days the
 * medicine is taken (visit date .. visit date + days - 1; 30 days when the doctor gave none), else today.
 * Returns {date, fromRecord}.
 */
export function medStartDate(record, item, today) {
  const days = item && item.med && Number.isInteger(item.med.days) ? item.med.days : 30;
  const visit = record && record.date;
  if (parseIsoDate(visit) && parseIsoDate(today) && visit <= today && today < addDays(visit, days)) {
    return isMessageRecord(record) ? { date: visit, fromRecord: true, pasted: true } : { date: visit, fromRecord: true };
  }
  return { date: today, fromRecord: false };
}

/** The sentence under the medicine times: where the days are counted from, and for how long. */
export function medStartNote(start, days) {
  const n = Number.isInteger(days) ? days : 30;
  const span = Number.isInteger(days) ? `${n}일 동안 매일 알려 줘요.` : `며칠 치인지 말씀이 없어서 ${n}일 동안 매일 알려 줘요.`;
  if (start && start.fromRecord) {
    const d = parseIsoDate(start.date);
    return `${start.pasted ? '문자를 넣은 날' : '진료 받은 날'}(${d.m}월 ${d.d}일)부터 세어요. ${span}`;
  }
  return `오늘부터 세어요. ${span}`;
}

/**
 * [다시 정리하기]: runs the summary again on the transcript stored in a record (scrubbed already) and
 * writes the new items, status 확인 전, back. Returns {ok, record} or {ok: false, reason}.
 */
export async function resummarise(id, { store = null, url = '', fetch: fetchImpl = globalThis.fetch, timeoutMs = NOTES_TIMEOUT_MS, today = null } = {}) {
  const rec = getRecord(id, store);
  if (!rec) return { ok: false, reason: 'missing' };
  if (!String(rec.transcript || '').trim()) return { ok: false, reason: 'empty' };
  const when = today || rec.date || localDate(new Date());
  // A pasted hospital message is organised by its own rules, on the phone, never by the speech summary.
  const out = isMessageRecord(rec)
    ? (() => {
      const r = parseHospitalText(rec.transcript, { today: when });
      const items = r.ok ? orderItems(r.items) : [];
      return { items, dropped: r.dropped, summary: items.length ? 'rules' : 'none' };
    })()
    : await summarizeTranscript(rec.transcript, { url, fetch: fetchImpl, timeoutMs, today: when });
  if (out.summary === 'none') return { ok: false, reason: 'none' };
  const items = out.items.map((it) => ({ ...it, status: 'unconfirmed', edited: false }));
  const next = updateRecord(id, { items, dropped: out.dropped, summary: out.summary }, store);
  return next ? { ok: true, record: next } : { ok: false, reason: 'storage' };
}

/**
 * Splits the transcript into [{text, mark}] so the sentences the items quote can be highlighted.
 * Uses locateSource (whitespace-insensitive), so a quote found there is marked at its position.
 */
export function highlightSegments(transcript, items) {
  const t = String(transcript || '');
  const ranges = [];
  for (const it of items || []) {
    const found = locateSource(t, it.source);
    if (!found) continue;
    const at = t.indexOf(found);
    if (at >= 0) ranges.push([at, at + found.length]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  const out = [];
  let pos = 0;
  for (const [a, b] of merged) {
    if (a > pos) out.push({ text: t.slice(pos, a), mark: false });
    out.push({ text: t.slice(a, b), mark: true });
    pos = b;
  }
  if (pos < t.length) out.push({ text: t.slice(pos), mark: false });
  return out;
}

/**
 * Shares the text through the phone's share sheet, else copies it. Returns 'shared', 'cancelled'
 * (the user closed the sheet), 'copied' or 'unavailable'. `nav` is injectable.
 */
export async function shareOrCopy(text, nav = globalThis.navigator) {
  if (nav && typeof nav.share === 'function') {
    try {
      await nav.share({ text });
      return 'shared';
    } catch (e) {
      if (e && e.name === 'AbortError') return 'cancelled';
    }
  }
  if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
    try {
      await nav.clipboard.writeText(text);
      return 'copied';
    } catch { /* fall through */ }
  }
  return 'unavailable';
}
