// State machine and rendering. `nextState` is pure and importable in Node; the DOM boot at the
// bottom runs only in a browser. Later stages hook in at the EXTENSION POINT comments.
import { loadRoute, OUTDOOR_STAGES } from './route.js';
import { FIELDS, FIXED_CLIPS, NOTES_SENTENCES, QUESTION_STEPS, ANSWER_BUTTONS, optionFor, HELP_UNKNOWN_SENTENCE, HELP_UNKNOWN_SPEECH, REASK_HOSPITAL_SPEECH, ARRIVED_SENTENCE, alertSentences } from './clips.js';
import { helpFor } from './help.js';
import { NOT_HEARD, appliedNotice, blockedNotice } from './notices.js';
import { loadState, saveState } from './storage.js';
import { speak, speakThen, preloadManifest, chime, vibrate, stopSpeaking, installAudioUnlock } from './voice.js';
import { createListener, isSupported as micSupported } from './listen.js';
import { parseVisit, expandAbbreviations } from './intent.js';
import { arrowAngle, bearingDeg, createCompassController, quantiseHeading } from './compass.js';
import { renderArrow2d, setArrow2dAngle } from './arrow2d.js';
import { renderArrow3d, disposeArrow3d } from './arrow3d.js';
import { initialSim, simReducer, simArrow, renderMiniMap, BANNER_TEXT, MAP_NOTE, HEADING_MAX } from './sim.js';
import { pictoSpec, pictoSvg, doneSvg, itemSvg, itemKind, svgNode, heroSvg, HERO_BY_STEP, MOBILITY_ICON } from './pictos.js';
import { POSITION_MSG, createPositionController, navItems, targetAngle, targetCaption, autoStartPlan, needsArrowButton } from './navarrow.js';
import { startAlightWatch, simulatedSource, simulatedRouteSource } from './alight.js';
import { loadFloor, renderFloorMap, floorFocus, FLOOR_BEARING_NOTE } from './floor.js';
import { arrivalPointFor, fetchArrivalDetail, locationText, REFRESH_MS, stopLabel } from './arrival.js';
import { loadArea, renderAreaMap, sceneFor, ridingProgress, walkStart, remainingText, nextStopText } from './areamap.js';
import {
  createNotesFlow, createWakeLock, asksNotesAfter, isConsultPoint, showEnterRoomButton, showRecordsButton, recordForDate, localDate,
  shouldOfferNotes, helpMaySpeak, TAP_GUARD_MS,
} from './notes-flow.js';
import { createNotesUi } from './notes-ui.js';
import { listRecords, getRecord, clearRecords } from './notes-store.js';
import { WEBHOOK_URL, ARRIVAL_URL, NOTES_URL } from '../config.js';
import { APP_VERSION, versioned } from './version.js';
import { attachZoom } from './zoom.js';

const FIELD_IDS = FIELDS.map((f) => f.id);
export const STAGE_LABEL = {
  prepare: '1단계 방문 준비', travel: '2단계 이동 안내', indoor: '3단계 병원 안', return: '4단계 돌아가기',
};
const CLIP_TEXT = Object.fromEntries(FIXED_CLIPS.map((c) => [c.clipId, c.text]));
const SIGN_FALLBACK = '표지판을 따라가세요. 어려우면 직원에게 물어보세요.';
const STEP_CLIP = {
  hospital: 'q-hospital', visit: 'q-visit', mobility: 'q-mobility', reception: 'q-reception',
  confirm: 'confirm-all', checklist: 'checklist-screen',
};
// On-screen sentence of the two wizard screens whose spoken clip is too long for three lines of 36px.
const STEP_SCREEN_TEXT = { confirm: '이렇게 가시는 게 맞나요?', checklist: '신분증과 진료의뢰서를 챙기세요.' };

/**
 * What to say and show after a spoken sentence has been merged. `prev` and `next` are the states
 * before and after SET_FIELDS, `heard` is the parsed fields. The screen decides ("follow the screen"):
 * an answer to the question on screen always applies, even over a button choice; a value for another
 * question is written down unless a button choice already holds that field (then it is kept and the
 * user is told how to change it). Returns null when the screen moved on and nothing was blocked.
 * Otherwise {kind, prefix, question, text, speak, prefixClip}: `text` is shown, and is also what is
 * spoken (prefix first, then the question). kind is 'nothing' (nothing understood), 'applied',
 * 'blocked' or 'both'. `speak: 'hospital'` means the question is the fixed hospital sentence.
 */
export function reAskFor(prev, next, parsedReAsk = null, heard = null) {
  if (prev.index >= 0 || next.index >= 0) return null;
  const step = prev.prepStep;
  if (!QUESTION_STEPS.includes(step)) return null;
  const said = heard || Object.fromEntries(FIELD_IDS.map((id) => [id, next.fields[id] !== prev.fields[id] ? next.fields[id] : null]));
  const valid = (id) => optionFor(id, said[id] ?? null) !== null;
  const others = FIELD_IDS.filter((id) => id !== step && valid(id));
  const blocked = others.filter((id) => prev.manual[id] && prev.fields[id] !== said[id]);
  const applied = others.filter((id) => !blocked.includes(id));
  const moved = next.prepStep !== step;
  const lines = moved ? [] : applied.map((id) => appliedNotice(id, said[id]));
  lines.push(...blocked.map((id) => blockedNotice(id, prev.fields[id])));
  if (moved && lines.length === 0) return null;
  const hospitalAgain = !moved && step === 'hospital' && next.fields.hospital === null;
  const hasApplied = !moved && applied.length > 0;
  let kind = 'nothing';
  if (hasApplied && blocked.length) kind = 'both';
  else if (blocked.length) kind = 'blocked';
  else if (hasApplied) kind = 'applied';
  // Nothing understood at the hospital question keeps the fixed hospital sentence (it names the limit).
  const prefix = lines.length ? lines.join(' ') : (hospitalAgain ? '' : NOT_HEARD);
  const question = hospitalAgain ? (parsedReAsk || REASK_HOSPITAL_SPEECH) : CLIP_TEXT[STEP_CLIP[next.prepStep]];
  return {
    kind,
    prefix,
    question,
    text: prefix ? `${prefix} ${question}` : question,
    speak: hospitalAgain ? 'hospital' : 'step',
    prefixClip: kind === 'nothing' ? 'reask-not-heard' : 'reask-notice',
  };
}
const BUS_NOTE = '버스 안 안내 방송과 화면에 나오는 정류장 이름을 확인하세요. 잘 모르시겠으면 기사님께 물어보세요.';
export const ARRIVED_TEXT = ARRIVED_SENTENCE;
export const TODAY_ORDER_TITLE = '오늘 순서';
export const DEMO_NOTE = '시연용 예시 일정이에요. 실제 검사와 순서는 사람마다 달라요.';
// Get-off alert texts (the spoken versions are the alert-* clips in clips.js).
const ALERT_BUTTON = '내릴 곳 가까워지면 알려 주기';
const ALERT_EXPLAIN = '위치 확인을 허락하시면 내리실 정류장에 가까워질 때 소리와 진동으로 알려 드려요.';
const ALERT_SIM_NOTE = '시뮬레이션: 버스가 움직이는 것처럼 보여 드려요';
const ALERT_WAITING = '알림 켜짐: 내리실 정류장을 기다리는 중';
const ALERT_NOW_BANNER = '이번 정류장에서 내리세요.';
// Alert sentences of a point: from its own busRoute stops; the fixed outbound clips as a fallback.
const FALLBACK_ALERTS = {
  early: { clipId: 'alert-early', text: CLIP_TEXT['alert-early'] },
  near: { clipId: 'alert-near', text: CLIP_TEXT['alert-near'] },
  now: { clipId: 'alert-now', text: CLIP_TEXT['alert-now'] },
};
const alertsFor = (p) => alertSentences(p) || FALLBACK_ALERTS;
/** Banner text for an alert level of this point: the spoken sentence, except "now", which is short. */
export function alertBannerText(p, level) {
  return level === 'now' ? ALERT_NOW_BANNER : alertsFor(p)[level].text;
}
const ALERT_OFF_TEXT = '위치 확인이 꺼져 있어요. 버스 안내 방송을 잘 들어 주세요.';
const ALERT_VIBRATION = [400, 200, 400];
// Items shown on the "what to bring" screen when data/support.json is missing.
const FALLBACK_ITEMS = ['신분증', '진료의뢰서'];
// Screen 1 is a wizard: one question per screen, then confirm, then the checklist.
export const WIZARD_STEPS = [...QUESTION_STEPS, 'confirm', 'checklist'];
const BLANK_FIELDS = { hospital: null, visit: null, mobility: null, reception: null };
const BLANK_MANUAL = { hospital: false, visit: false, mobility: false, reception: false };

/** First question (in order, optionally only after `after`) whose field is still empty, or null. */
function firstUnfilled(fields, after = null) {
  const start = after === null ? 0 : QUESTION_STEPS.indexOf(after) + 1;
  return QUESTION_STEPS.slice(start).find((id) => fields[id] === null) ?? null;
}

// ---------------------------------------------------------------- pure state

export function initialState(lastPointId = null) {
  return {
    index: -1, // -1 is the prepare screen, otherwise the index into route.points
    arrived: false,
    prepStep: 'hospital', // wizard step while index is -1, one of WIZARD_STEPS
    editing: false, // true after [수정]: the next answer returns to the confirm screen
    fields: { ...BLANK_FIELDS },
    // true for a field the user answered with a button; such a value wins over parsing. Memory only.
    manual: { ...BLANK_MANUAL },
    lastPointId,
    helpOpen: false,
    settingsOpen: false,
    companionOpen: false,
  };
}

export function screenOf(state, route) {
  return state.index < 0 ? 'prepare' : route.points[state.index].stage;
}

/**
 * Header progress: "cur / total", counted inside the current stage. On the wizard the four
 * questions count; on the route it is the position among the points of the same stage.
 */
export function progressOf(state, route) {
  if (state.index >= 0) {
    const here = route.points[state.index];
    const inStage = route.points.filter((q) => q.stage === here.stage);
    return { cur: inStage.findIndex((q) => q.id === here.id) + 1, total: inStage.length };
  }
  const i = QUESTION_STEPS.indexOf(state.prepStep);
  return { cur: i < 0 ? QUESTION_STEPS.length : i + 1, total: QUESTION_STEPS.length };
}

/**
 * The fixed bar's primary button: its label, whether it shows, and what it does. The button always
 * keeps its place in the bar; on a question screen it shows `→ 다음` only once that question has an
 * answer, otherwise it is invisible and disabled (the answers themselves are in the main area).
 */
export function barPrimary(state, route) {
  if (state.index < 0) {
    if (QUESTION_STEPS.includes(state.prepStep)) {
      return { label: '→ 다음', visible: state.fields[state.prepStep] !== null, action: 'next' };
    }
    if (state.prepStep === 'confirm') return { label: '→ 길 안내 시작', visible: true, action: 'next' };
    return { label: '→ 챙겼어요', visible: true, action: 'start' };
  }
  if (state.arrived) return { label: '처음 화면으로', visible: true, action: 'restart' };
  const p = route.points[state.index];
  return { label: `→ ${p.confirmLabel || '여기에 도착했어요'}`, visible: true, action: 'confirm' };
}

/** The nearest point at or before `index` that has a boardCoord (where the current bus was boarded). */
export function boardPointFor(route, index) {
  for (let i = Math.min(index, route.points.length - 1); i >= 0; i -= 1) {
    if (route.points[i].boardCoord) return route.points[i];
  }
  return null;
}

/** On-screen sentences of the indoor points, in order (the "오늘 순서" list). */
export function indoorOrder(route) {
  return route.points.filter((q) => q.stage === 'indoor').map((q) => q.display);
}

/** Label of the resume button: stage and position in the stage, exactly as the header shows them. */
export function resumeLabel(state, route) {
  const i = resumeIndex(state, route);
  if (i === null) return null;
  const { cur, total } = progressOf({ ...state, index: i }, route);
  return `이어서 안내 받기 (${STAGE_LABEL[route.points[i].stage]} ${cur} / ${total})`;
}

/** Identity of what the screen shows; a change means the user is looking at something new. */
export function screenKeyOf(state, route) {
  return `${state.index}|${state.arrived}|${state.prepStep}|${screenOf(state, route)}`;
}

/** Scroll to the top only when the screen changed and no overlay is open. */
export function shouldScrollTop(prevKey, key, overlayOpen) {
  return !overlayOpen && prevKey !== key;
}

/**
 * Remembers which `<details>` (by id) are open and which element (by id) has focus inside `root`,
 * so a full re-render can put them back. `active` is document.activeElement.
 */
export function captureUiState(root, active) {
  const open = [...root.querySelectorAll('details[open]')].map((d) => d.id).filter(Boolean);
  let focus = null;
  if (active && active.id && root.contains(active)) {
    focus = { id: active.id };
    if (typeof active.selectionStart === 'number') {
      focus.selStart = active.selectionStart;
      focus.selEnd = active.selectionEnd;
    }
  }
  return { open, focus };
}

/** Counterpart of captureUiState, run on the freshly built `root`. */
export function restoreUiState(root, saved) {
  if (!saved) return;
  const byId = (id) => [...root.querySelectorAll('[id]')].find((el) => el.id === id) || null;
  for (const id of saved.open) {
    const d = byId(id);
    if (d && d.tagName === 'DETAILS') d.open = true;
  }
  if (saved.focus) {
    const el = byId(saved.focus.id);
    if (el && typeof el.focus === 'function') {
      el.focus({ preventScroll: true });
      if (saved.focus.selStart !== undefined && typeof el.setSelectionRange === 'function') {
        try { el.setSelectionRange(saved.focus.selStart, saved.focus.selEnd); } catch { /* ignore */ }
      }
    }
  }
}

/** Index to resume at: the point after the last confirmed one, or null when there is none. */
export function resumeIndex(state, route) {
  if (!state.lastPointId) return null;
  const i = route.points.findIndex((p) => p.id === state.lastPointId);
  if (i < 0 || i >= route.points.length - 1) return null;
  return i + 1;
}

export function nextState(state, action, route) {
  const last = route.points.length - 1;
  switch (action.type) {
    case 'START':
      return { ...state, index: 0, arrived: false };
    case 'RESUME': {
      const i = resumeIndex(state, route);
      return i === null ? state : { ...state, index: i, arrived: false };
    }
    case 'CONFIRM': {
      if (state.index < 0) return state;
      const lastPointId = route.points[state.index].id;
      if (state.index === last) return { ...state, lastPointId, arrived: true };
      return { ...state, lastPointId, index: state.index + 1 };
    }
    case 'PREV':
      // On the finish screen PREV only leaves it: the user stays on the last point.
      if (state.arrived) return { ...state, arrived: false };
      return state.index <= 0
        ? { ...state, index: -1, arrived: false }
        : { ...state, index: state.index - 1, arrived: false };
    case 'RESTART':
      // A new start: the previous visit answers are dropped so the next person is asked afresh.
      return { ...state, index: -1, arrived: false, prepStep: 'hospital', editing: false,
        fields: { ...BLANK_FIELDS }, manual: { ...BLANK_MANUAL } };
    case 'SET_FIELD': {
      if (!FIELD_IDS.includes(action.field)) return state;
      if (action.value !== null && !optionFor(action.field, action.value)) return state;
      return {
        ...state,
        fields: { ...state.fields, [action.field]: action.value },
        manual: { ...state.manual, [action.field]: true },
      };
    }
    case 'ANSWER': {
      // A button answer on a question screen. Moves to the next unanswered question, or to the
      // confirm screen when none is left or when the answer was an edit from the confirm screen.
      if (state.index >= 0 || !QUESTION_STEPS.includes(action.field) || !optionFor(action.field, action.value)) return state;
      const fields = { ...state.fields, [action.field]: action.value };
      return {
        ...state,
        fields,
        manual: { ...state.manual, [action.field]: true },
        prepStep: state.editing ? 'confirm' : (firstUnfilled(fields) ?? 'confirm'),
        editing: false,
      };
    }
    case 'WIZARD_NEXT': {
      if (state.index >= 0) return state;
      if (state.editing) return { ...state, prepStep: 'confirm', editing: false };
      if (QUESTION_STEPS.includes(state.prepStep)) {
        return { ...state, prepStep: firstUnfilled(state.fields, state.prepStep) ?? 'confirm' };
      }
      return state.prepStep === 'confirm' ? { ...state, prepStep: 'checklist' } : state;
    }
    case 'WIZARD_BACK': {
      // Stays inside the wizard. Returning to a question reopens it, so a spoken answer can replace it.
      if (state.index >= 0) return state;
      const reopen = (id) => ({ ...state, prepStep: id, editing: false, manual: { ...state.manual, [id]: false } });
      if (state.editing) return { ...state, prepStep: 'confirm', editing: false };
      if (state.prepStep === 'checklist') return { ...state, prepStep: 'confirm' };
      if (state.prepStep === 'confirm') return reopen(QUESTION_STEPS[QUESTION_STEPS.length - 1]);
      const i = QUESTION_STEPS.indexOf(state.prepStep);
      return i > 0 ? reopen(QUESTION_STEPS[i - 1]) : state;
    }
    case 'EDIT_FIELD':
      if (state.index >= 0 || !QUESTION_STEPS.includes(action.field)) return state;
      return { ...state, prepStep: action.field, editing: true, manual: { ...state.manual, [action.field]: false } };
    case 'SET_FIELDS': {
      // Merges a parsed sentence: only valid non-null parsed values are written. The answer to the
      // question on screen always applies (it replaces a button choice for that field); a value for
      // another field never replaces a button choice. On a question screen the wizard moves on only when
      // the question on screen was answered: to the confirm screen after an edit, else to the next
      // unanswered question.
      const src = action.fields || {};
      const onQuestion = state.index < 0 && QUESTION_STEPS.includes(state.prepStep);
      const fields = { ...state.fields };
      const manual = { ...state.manual };
      for (const id of FIELD_IDS) {
        const v = src[id] ?? null;
        if (v === null || !optionFor(id, v)) continue;
        if (onQuestion && id === state.prepStep) {
          fields[id] = v;
          manual[id] = false;
        } else if (!(state.manual && state.manual[id])) {
          fields[id] = v;
        }
      }
      let { prepStep, editing } = state;
      if (onQuestion && optionFor(prepStep, src[prepStep] ?? null)) {
        if (editing) {
          prepStep = 'confirm';
          editing = false;
        } else {
          prepStep = firstUnfilled(fields) ?? 'confirm';
        }
      }
      return { ...state, fields, manual, prepStep, editing };
    }
    case 'OPEN_COMPANION':
      return { ...state, companionOpen: true };
    case 'CLOSE_COMPANION':
      return { ...state, companionOpen: false };
    case 'OPEN_HELP':
      return { ...state, helpOpen: true };
    case 'CLOSE_HELP':
      return { ...state, helpOpen: false };
    case 'OPEN_SETTINGS':
      return { ...state, settingsOpen: true };
    case 'CLOSE_SETTINGS':
      return { ...state, settingsOpen: false };
    default:
      return state;
  }
}

// ---------------------------------------------------------------- DOM helpers

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

function row(label, value) {
  return h('div', { class: 'kv' }, h('span', { class: 'kv-k' }, label), h('span', { class: 'kv-v' }, value));
}

/** Makes everything behind an overlay unreachable (focus and screen readers) while one is open. */
function setBackgroundInert(on) {
  for (const sel of ['.top', '#main', '.bar']) {
    const el = document.querySelector(sel);
    if (el) el.inert = on;
  }
}

/** Keeps the page's bottom padding equal to the bar's real height (--bar-real). */
function syncBarHeight() {
  const bar = document.querySelector('.bar');
  if (!bar || !document.documentElement) return;
  document.documentElement.style.setProperty('--bar-real', `${Math.ceil(bar.getBoundingClientRect().height)}px`);
}
let barObserver = null;
function watchBar() {
  const bar = document.querySelector('.bar');
  if (barObserver || !bar || typeof ResizeObserver === 'undefined') return;
  barObserver = new ResizeObserver(syncBarHeight);
  barObserver.observe(bar);
}

/** Sets the one persistent instruction heading (inside the aria-live region) only when it changes. */
function setInstruction(text) {
  const el = document.getElementById('instruction');
  if (el && el.textContent !== text) el.textContent = text;
}

let booted = false;

// ---------------------------------------------------------------- app

function boot(route, support, floor = null, area = null, sample = null) {
  booted = true;
  const $ = (id) => document.getElementById(id);
  const stored = loadState(route.points.map((p) => p.id));
  let settings = stored.settings;
  let state = initialState(stored.lastPointId);
  let wasOverlay = false;
  let lastScreenKey = null; // screenKeyOf() at the last scroll-to-top
  let openerSel = null; // selector of the control that opened the overlay; focus returns there

  // Screen 1 parse state. Memory only; never persisted.
  let utterance = null;
  let badge = null;
  let reAsk = null; // text shown in the heard card after a sentence that did not settle the question
  let reAskDecision = null; // the reAskFor() result behind it, so [다시 듣기] can say it again
  let parsing = false;
  let parseToken = 0;
  let typedOpen = !micSupported(); // without speech recognition the typed box is there from the start
  let typedText = '';
  let listening = false;
  let listenMsg = null;
  let listenStep = null; // the question on screen when the microphone was opened

  // Arrow state. `heading` is the real compass reading (null until one arrives).
  let heading = null;
  let compassMsg = null;
  // Arrow auto-start (real mode): see autoStartPlan(). `gesture` is true only while a tap is handled.
  let gesture = false;
  let compassGranted = false; // a heading arrived once, so iOS keeps the permission for this page
  let autoCompassTried = false;
  let autoPosTried = false;
  let pos = null; // latest position fix {lat, lon, accuracy}; memory only, never stored or sent
  let posMsg = null; // why the position is unavailable (denied / unavailable)
  let floorStep = null; // steady heading (multiple of 15) the floor map is drawn with; null = north up
  let floorHost = null; // the element that holds the floor figure currently on screen
  let sim = initialSim();
  let arrowCtl = null; // {setAngle(deg)} of the arrow currently on screen
  let arrowToken = 0;
  const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Get-off alert. Memory only; positions are never kept, only the resulting level.
  let alightStop = null; // stop() of the running watch, or null
  let alightPointId = null; // the route point the watch belongs to
  let alightLevel = 'far'; // 'far' | 'near' | 'now'
  let alightFailed = false; // permission denied or no position available
  let ridePos = null; // latest fix of the get-off watch, for the map only; memory only, never stored or sent
  let rideProgress = null; // {lastIndex, atStop, nextIndex, remaining} along the stops of the ride
  let areaHost = null; // the element that holds the outdoor map currently on screen
  let areaZoom = null; // zoom controller of areaHost (state per host: a new panel starts at 1x)
  let floorZoom = null; // zoom controller of floorHost

  // Bus arrival info on a point that has `arrival` (only when ARRIVAL_URL is configured).
  let arrivalPointId = null;
  let arrivalTimer = null;
  let arrivalToken = 0;
  let arrivalMsg = null;
  let arrivalSeqs = []; // loop stop numbers of the live buses (for the map)

  const say = (clipId, text) => speak(clipId, text, settings);
  preloadManifest();
  const persist = () => saveState({ settings, lastPointId: state.lastPointId });

  // Visit notes (docs/PLAN-visit-notes.md). The flow owns N0..N4, the ui draws them and V1/V2.
  const flow = createNotesFlow({
    createListener, // listen.js; the flow never starts it before the doctor's tap on N1
    sim: () => settings.sim,
    sample,
    notesUrl: NOTES_URL,
    wakeLock: createWakeLock(),
    tapGuardMs: TAP_GUARD_MS, // a tap within 0.6 s of a new notes screen is ignored (double taps, taps meant for the last screen)
    onChange: () => render(),
  });
  const notesUi = createNotesUi({
    h, svgNode, flow, say, stopSpeaking, rerender: () => render(), online: Boolean(NOTES_URL),
    onSpeakPoint: () => sayCurrent(),
    notesUrl: NOTES_URL,
    onBack: () => {
      flow.leave();
      dispatch({ type: 'PREV' });
      sayCurrent();
    },
    onContinue: () => {
      // N4 done: the consultation is over, so go on exactly like [진료가 끝났어요].
      chime(settings);
      dispatch({ type: 'CONFIRM' });
      sayCurrent();
    },
  });
  /** The record of this visit (just taken, or one dated today), for the finish screen. */
  // Example records (simulation) are offered back only while simulation is on.
  const todayRecord = () => {
    const own = flow.state.record ? getRecord(flow.state.record) : null;
    if (own && (own.source !== 'sample' || settings.sim)) return own;
    return recordForDate(listRecords(), localDate(new Date()), { sim: settings.sim });
  };

  /** Drops what was heard on a wizard screen (the sentence, its badge, typed text, messages). */
  function clearHeard() {
    utterance = null;
    badge = null;
    reAsk = null;
    reAskDecision = null;
    typedText = '';
    typedOpen = !micSupported();
    listenMsg = null;
  }

  function dispatch(action, { keepHeard = false } = {}) {
    const prev = state;
    state = nextState(state, action, route);
    if (action.type === 'RESTART') { flow.reset(); notesUi.reset(); } // a new visit asks N0 afresh
    // The watch belongs to one screen: leaving it (confirm, back, reset) ends it.
    if (alightPointId !== null && (currentPoint() === null || currentPoint().id !== alightPointId || state.arrived)) stopAlight();
    if (state.lastPointId !== prev.lastPointId) persist();
    // What the microphone hears belongs to the screen it was opened on: a new screen, or an answer
    // button pressed while listening, ends the session so a late result cannot land on the wrong screen.
    if (prev.prepStep !== state.prepStep || prev.index !== state.index || action.type === 'ANSWER') cancelListening();
    if (prev.index < 0 && state.index >= 0) leavePrepare();
    else if (!keepHeard && prev.prepStep !== state.prepStep) {
      parseToken += 1; // a sentence still being parsed belongs to the screen that was left
      parsing = false;
      clearHeard();
    }
    render();
  }

  function cancelListening() {
    listener.cancel();
    listening = false;
    listenStep = null;
  }

  /** Leaving screen 1: drop the utterance and cancel any late parse or recognition result. */
  function leavePrepare() {
    parseToken += 1;
    parsing = false;
    clearHeard();
    listener.stop();
  }

  function stopAlight() {
    if (alightStop) alightStop();
    alightStop = null;
    alightPointId = null;
    alightLevel = 'far';
    alightFailed = false;
    ridePos = null;
    rideProgress = null;
  }

  /** Taps [내릴 곳 가까워지면 알려 주기]: starts the watch; the browser asks for location itself. */
  function startAlight(p) {
    stopAlight();
    alightPointId = p.id;
    alightFailed = false;
    // The board point is the nearest one before this stop, so the return leg uses R2, not O2.
    const board = boardPointFor(route, route.points.findIndex((q) => q.id === p.id));
    let source = null;
    if (settings.sim && p.busRoute) {
      // Ride along the real stop sequence, standing ~8 s at each stop in between.
      const stops = p.busRoute.stops.filter((st) => st.seq <= p.busRoute.alightSeq);
      const dwell = {};
      for (let i = 1; i < stops.length - 1; i += 1) dwell[i] = 8;
      source = simulatedRouteSource(stops, { durationMs: 24000, intervalMs: 1000, dwell });
    } else if (settings.sim && board) {
      source = simulatedSource(board.boardCoord, p.alertCoord);
    }
    say('alert-intro', CLIP_TEXT['alert-intro']);
    const ctl = startAlightWatch({
      target: p.alertCoord,
      busRoute: p.busRoute || null,
      source,
      onFix: (fix) => {
        if (alightPointId !== p.id) return;
        ridePos = fix;
        if (p.busRoute) {
          const stops = p.busRoute.stops.filter((st) => st.seq <= p.busRoute.alightSeq);
          rideProgress = ridingProgress(fix, stops, p.busRoute.alightSeq, rideProgress);
        }
        redrawArea(); // only the map and its count line change, so open details and focus stay
      },
      onLevel: (level) => {
        if (alightPointId !== p.id) return;
        alightLevel = level;
        const clip = alertsFor(p)[level];
        say(clip.clipId, clip.text);
        vibrate(ALERT_VIBRATION);
        refreshAlightPanel(p); // background event: only the panel changes, open details and focus stay
      },
      onError: () => {
        if (alightPointId !== p.id) return;
        alightStop = null;
        alightFailed = true;
        say('alert-off', CLIP_TEXT['alert-off']);
        refreshAlightPanel(p);
      },
    });
    if (alightPointId === p.id && !alightFailed) alightStop = ctl.stop;
    render();
  }

  /** Rebuilds only the alert panel in place; falls back to a full render when it is not on screen. */
  function refreshAlightPanel(p) {
    const old = document.getElementById('alight-panel');
    if (!old || !old.isConnected) {
      render();
      return;
    }
    const active = document.activeElement;
    const focusId = active && old.contains(active) ? active.id : '';
    const fresh = alightPanel(p);
    old.replaceWith(fresh);
    if (focusId) {
      const el = [...fresh.querySelectorAll('[id]')].find((e) => e.id === focusId);
      if (el) el.focus({ preventScroll: true });
    }
  }

  /** The get-off alert controls and status for a point that has an alertCoord. */
  function alightPanel(p) {
    // Children go through h(), which skips null; a raw DOM append() would print "null" as text.
    const kids = [];
    // Once the ride count is known it already says the alert is on, so the waiting line is dropped
    // (it takes two lines on a small phone and pushed [알림 끄기] under the bar).
    if (alightStop && alightLevel !== 'far') {
      kids.push(h('p', { class: `alight-banner ${alightLevel}`, id: 'alight-banner', role: 'alert' }, alertBannerText(p, alightLevel)));
    } else if (alightStop && !(p.busRoute && remainingText(rideProgress))) {
      kids.push(h('p', { class: 'alight-status', id: 'alight-status', role: 'status' }, ALERT_WAITING));
    }
    if (alightStop) kids.push(...rideTextNodes(p));
    if (alightFailed) kids.push(h('p', { class: 'alight-banner off', id: 'alight-off', role: 'status' }, ALERT_OFF_TEXT));
    if (alightStop) {
      kids.push(h('button', { class: 'btn small ghost', id: 'btn-alight-off', onclick: () => {
        stopAlight();
        render();
      } }, '알림 끄기'));
    } else {
      kids.push(
        h('button', { class: 'btn secondary', id: 'btn-alight', onclick: () => startAlight(p) }, ALERT_BUTTON),
        h('p', { class: 'note' }, ALERT_EXPLAIN),
        settings.sim ? h('p', { class: 'muted', id: 'alight-sim-note' }, ALERT_SIM_NOTE) : null,
      );
    }
    return h('div', { class: 'card alight', id: 'alight-panel' }, kids);
  }

  function stopArrival() {
    if (arrivalTimer !== null) clearInterval(arrivalTimer);
    arrivalTimer = null;
    arrivalPointId = null;
    arrivalToken += 1;
    arrivalMsg = null;
    arrivalSeqs = [];
  }

  /** Starts the 30 s refresh on a point with `arrival`; ends it on any other screen. */
  function syncArrival(p) {
    const src = p && !state.arrived ? arrivalPointFor(route, state.index) : null; // O1/R1 use O2/R2's bus
    const wanted = ARRIVAL_URL && src ? { id: p.id, arrival: src.arrival, hours: src.hours, stop: p.arrival ? null : stopLabel(p.target) } : null;
    if (!wanted) {
      if (arrivalPointId !== null) stopArrival();
      return;
    }
    if (arrivalPointId === wanted.id) return;
    stopArrival();
    arrivalPointId = wanted.id;
    const token = arrivalToken;
    const load = async () => {
      const detail = await fetchArrivalDetail(ARRIVAL_URL, wanted.arrival);
      if (token !== arrivalToken) return;
      const parsed = detail ? detail.parsed : null;
      const seqs = detail ? detail.seqs : [];
      if (seqs.join(',') !== arrivalSeqs.join(',')) {
        arrivalSeqs = seqs;
        redrawArea();
      }
      const text = locationText(parsed, wanted.arrival.routeName, Boolean(wanted.hours), wanted.stop);
      if (text !== arrivalMsg) {
        arrivalMsg = text;
        // Background refresh: change only the panel text; a full render would close open details.
        const el = document.querySelector('#arrival-panel .arrival-text');
        if (el) el.textContent = text;
        else render();
      }
    };
    arrivalMsg = '버스 위치를 확인하는 중이에요...';
    load();
    arrivalTimer = setInterval(load, REFRESH_MS);
  }

  function arrivalPanel() {
    return h('div', { class: 'card arrival', id: 'arrival-panel', role: 'status' },
      h('p', { class: 'arrival-text' }, arrivalMsg));
  }

  function currentPoint() {
    return state.index >= 0 ? route.points[state.index] : null;
  }

  /** Plays the clip of the wizard screen that is showing. */
  function sayStep() {
    const id = STEP_CLIP[state.prepStep];
    return say(id, CLIP_TEXT[id]);
  }

  function sayCurrent() {
    const p = currentPoint();
    if (!p) return sayStep();
    // The finish screen has no "show this to staff" step any more, so only the closing clip plays.
    if (state.arrived) return say('arrive-main', CLIP_TEXT['arrive-main']);
    return say(p.id, p.speech);
  }

  /** Says a re-ask: the sentence in front (when there is one), then the question, as shown. */
  function speakReAsk(d) {
    const question = () => (d.speak === 'hospital'
      ? say(d.question === REASK_HOSPITAL_SPEECH ? 'reask-hospital' : 'reask', d.question)
      : sayStep());
    return d.prefix ? speakThen(say(d.prefixClip, d.prefix), question) : question();
  }

  /** [다시 듣기]: says again what the screen shows as its key message (a re-ask, an alert, the finish text). */
  function replayCurrent() {
    if (flow.state.phase !== null || notesUi.isOpen()) return notesUi.replay();
    const p = currentPoint();
    if (!p && reAskDecision && reAsk) return speakReAsk(reAskDecision);
    if (p && !state.arrived && alightPointId === p.id) {
      if (alightStop && alightLevel !== 'far') {
        const clip = alertsFor(p)[alightLevel];
        return say(clip.clipId, clip.text);
      }
      if (alightFailed) return say('alert-off', CLIP_TEXT['alert-off']);
    }
    return sayCurrent();
  }

  // ------------------------------------------------------------ screens

  /** A big full-width answer button: leading symbol, then the label. */
  function answerButton(sym, label, attrs, iconKind = null) {
    const { class: extra, ...rest } = attrs;
    const lead = iconKind
      ? h('span', { class: 'sym icon', 'aria-hidden': 'true' }, svgNode(heroSvg(iconKind, 'btn-icon')))
      : h('span', { class: 'sym', 'aria-hidden': 'true' }, sym);
    return h('button', { type: 'button', ...rest, class: `btn answer${extra ? ` ${extra}` : ''}` },
      lead, h('span', { class: 'answer-text' }, label));
  }

  function heardCard() {
    // Display only: abbreviations the user said are written out in full; parsing used the raw text.
    return h('div', { class: 'card heard', id: 'heard' },
      h('div', { class: 'heard-head' },
        h('p', { class: 'muted' }, '들은 말 (이 화면을 닫으면 사라져요)'),
        badge ? h('span', { class: 'badge', id: 'parse-badge' }, badge) : null),
      h('p', { class: 'quote' }, expandAbbreviations(utterance)),
      reAsk ? h('p', { class: 'reask', id: 'reask', role: 'status' }, reAsk) : null);
  }

  function renderQuestion(step) {
    const field = FIELDS.find((f) => f.id === step);
    const main = h('div', { class: utterance ? 'stack has-heard' : 'stack' });
    if (utterance) main.append(heardCard());

    const ri = step === 'hospital' ? resumeIndex(state, route) : null;
    if (ri !== null) {
      main.append(h('button', { class: 'btn wide', id: 'btn-resume', onclick: () => {
        dispatch({ type: 'RESUME' });
        // Resuming can land straight on the consultation point: N0 is still asked, once.
        const offer = shouldOfferNotes(currentPoint(), flow.state) && flow.askAfterConfirm();
        speakThen(say('ui-resume', CLIP_TEXT['ui-resume']), () => (offer ? say('notes-ask', NOTES_SENTENCES.ask) : sayCurrent()));
      } }, resumeLabel(state, route)));
    }

    // [내 진료 기록]: only on the first screen and only when a record exists.
    if (step === 'hospital' && !state.editing && showRecordsButton(listRecords().length)) {
      main.append(h('button', { class: 'btn wide', id: 'btn-records', onclick: () => notesUi.openList() }, '내 진료 기록'));
    }

    const heroKinds = HERO_BY_STEP[step] || [];
    if (heroKinds.length) {
      main.append(h('div', { class: `hero hero-${step}`, id: 'hero' }, heroKinds.map((k) => svgNode(heroSvg(k)))));
    }

    const answers = h('div', { class: 'answers' });
    for (const o of field.options) {
      const ui = ANSWER_BUTTONS[field.id][o.value];
      const selected = state.fields[field.id] === o.value;
      answers.append(answerButton(ui.sym, ui.label, {
        'data-value': o.value,
        'aria-current': selected ? 'true' : null,
        class: selected ? 'selected' : '',
        onclick: () => {
          dispatch({ type: 'ANSWER', field: field.id, value: o.value });
          speakThen(say(o.clipId, o.phrase), () => sayStep());
        },
      }, field.id === 'mobility' ? MOBILITY_ICON[o.value] : null));
    }
    main.append(answers);

    main.append(answerButton('🎤', listening ? '듣는 중... 눌러서 끝내기' : '말로 대답하기',
      { id: 'btn-talk', class: 'talk-btn', disabled: parsing, onclick: onTalk }));
    if (listenMsg) main.append(h('p', { class: 'note', role: 'status' }, listenMsg));
    if (typedOpen) {
      main.append(h('div', { class: 'typed' },
        h('label', { for: 'typed-text', class: 'note' }, '방문 내용을 적어 주세요.'),
        h('textarea', { id: 'typed-text', rows: 2, oninput: (e) => { typedText = e.target.value; } }, typedText),
        h('button', { class: 'btn', id: 'btn-typed-go', disabled: parsing,
          onclick: () => interpret(typedText) }, '이 내용으로 채우기')));
    }
    if (parsing) main.append(h('p', { class: 'note', role: 'status' }, '해석하는 중이에요...'));

    const footer = wizardFooter();
    if (footer) main.append(footer);
    return main;
  }

  function renderConfirm() {
    const main = h('div', { class: 'stack' });
    if (utterance) main.append(heardCard());
    const rows = h('div', { class: 'confirm-rows' });
    for (const f of FIELDS) {
      const opt = optionFor(f.id, state.fields[f.id]);
      rows.append(h('div', { class: 'confirm-row' },
        h('div', { class: 'confirm-text' },
          h('span', { class: 'confirm-label' }, f.label),
          h('span', { class: opt ? 'confirm-value' : 'confirm-value unknown' }, opt ? opt.label : '아직 몰라요')),
        h('button', { class: 'btn edit-btn', 'aria-label': `${f.label} 수정`, 'data-field': f.id, onclick: () => {
          openerSel = `[aria-label="${f.label} 수정"]`;
          dispatch({ type: 'EDIT_FIELD', field: f.id });
          sayStep();
        } }, '수정')));
    }
    main.append(rows);
    if (support) {
      main.append(h('button', { class: 'btn wide secondary', id: 'btn-companion', onclick: () => {
        openerSel = '#btn-companion';
        dispatch({ type: 'OPEN_COMPANION' });
      } }, '동행 신청 알아보기'));
    }
    const footer = wizardFooter();
    if (footer) main.append(footer);
    return main;
  }

  function renderChecklist() {
    const main = h('div', { class: 'stack' });
    const items = support ? support.visitChecklist.items : FALLBACK_ITEMS;
    const list = h('div', { class: 'items', id: 'checklist-items' });
    for (const item of items) {
      list.append(h('div', { class: 'item-row' }, svgNode(itemSvg(itemKind(item), item)),
        h('span', { class: 'item-name' }, item)));
    }
    main.append(list);
    if (support) {
      main.append(h('details', { class: 'more', id: 'details-checklist' }, h('summary', {}, '자세히'),
        row('출처', support.visitChecklist.source)));
    }
    const footer = wizardFooter();
    if (footer) main.append(footer);
    return main;
  }

  /** Small text button at the bottom of a wizard screen: back one screen, or back to confirm. */
  function wizardFooter() {
    if (state.prepStep === 'hospital' && !state.editing) return null;
    const label = state.editing ? '확인 화면으로 돌아가기'
      : (state.prepStep === 'checklist' ? '확인 화면으로' : '이전 질문으로');
    return h('div', { class: 'bottom-links' },
      h('button', { class: 'btn small ghost', id: 'btn-wizard-back', onclick: () => {
        dispatch({ type: 'WIZARD_BACK' });
        sayStep();
      } }, label));
  }

  function renderPrepare() {
    if (state.prepStep === 'confirm') return renderConfirm();
    if (state.prepStep === 'checklist') return renderChecklist();
    return renderQuestion(state.prepStep);
  }

  function companionCard() {
    const s = support;
    return h('div', { class: 'overlay-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': `${s.city} 동행 신청` },
      h('h2', {}, `${s.city} 동행 신청`),
      h('p', {}, '혼자 사시거나 사실상 혼자 지내시는 분(노인가구, 한부모가정 등)은 병원 동행을 신청할 수 있어요.'),
      h('a', { class: 'btn wide link', href: s.onlineUrl, target: '_blank', rel: 'noopener noreferrer' },
        '성남시 동행 신청 열기'),
      h('details', { class: 'more' }, h('summary', {}, '자세히'),
        row('사업', s.program),
        row('대상', s.target),
        row('이용 요금', s.fee),
        row('운영 시간', s.hours),
        row('문의', `${s.contact.name} ${s.contact.phone}`),
        row('출처', `${s.source.name} ${s.source.url}`),
        row('확인한 날', s.retrieved)),
      h('button', { class: 'btn wide primary', id: 'btn-companion-close',
        onclick: () => dispatch({ type: 'CLOSE_COMPANION' }) }, '닫기'));
  }

  function pointDetails(p) {
    const d = h('details', { class: 'more', id: `details-${p.id}` }, h('summary', {}, '자세히'));
    if (p.sign) d.append(row('찾을 표지판', p.sign));
    if (p.hours) d.append(row('운행 시간', p.hours));
    if (p.detail) {
      d.append(
        h('p', {}, p.detail),
        h('button', { class: 'btn small', onclick: () => say(`${p.id}-detail`, p.detailSpeech || p.detail) }, '설명 듣기'),
      );
    }
    d.append(row('상태', p.checkedOn ? `${p.status} (${p.checkedOn})` : p.status), row('출처', p.source));
    const firstIndoor = route.points.find((q) => q.stage === 'indoor');
    if (firstIndoor && p.id === firstIndoor.id) {
      const ol = h('ol', { class: 'summary', id: 'today-order' });
      indoorOrder(route).forEach((text) => ol.append(h('li', {}, text)));
      d.append(h('p', { class: 'setting-title' }, TODAY_ORDER_TITLE), h('p', { id: 'demo-note' }, DEMO_NOTE), ol);
    }
    return d;
  }

  // ------------------------------------------------------------ arrow and simulation

  /** Angle to draw the arrow at for the current point, or null when only the sign panel applies. */
  function arrowInfo() {
    if (state.index < 0) return null;
    if (settings.sim) {
      const a = simArrow(route, state.index, sim.heading);
      return a ? { angle: a.angle } : null;
    }
    const p = route.points[state.index];
    if (p.target) {
      const a = targetAngle(pos, p.target, heading);
      return a === null ? null : { angle: a };
    }
    const next = route.points[state.index + 1];
    if (OUTDOOR_STAGES.includes(p.stage) && next && next.stage === p.stage && p.coord && next.coord && heading !== null) {
      return { angle: arrowAngle(bearingDeg(p.coord, next.coord), heading) };
    }
    return null;
  }

  /** Real mode: an arrow could be drawn once a heading exists (both points have coord). */
  function arrowCouldDraw() {
    if (settings.sim || state.index < 0) return false;
    const p = route.points[state.index];
    if (p.target) return true;
    const next = route.points[state.index + 1];
    return Boolean(OUTDOOR_STAGES.includes(p.stage) && next && next.stage === p.stage && p.coord && next.coord);
  }

  /** The official target of the current point in real mode (an arrow can point at it), else null. */
  function currentTarget() {
    if (settings.sim || state.index < 0) return null;
    return route.points[state.index].target || null;
  }

  /** Lines under the arrow (distance, accuracy, underground notes) for the current target point. */
  function navStatusNodes(p) {
    // Simulation: the dot stays at the point's start (a fixed place), so the distance can be shown too.
    const start = settings.sim ? walkStart(route, area, state.index) : null;
    const here = settings.sim ? (start ? { lat: start.lat, lon: start.lon, accuracy: 10 } : null) : pos;
    return navItems({
      pos: here, target: p.target, watching: !settings.sim && positionCtl.active, posMsg: settings.sim ? null : posMsg,
      underground: !settings.sim && p.id === 'O1',
    }).map((x) => h('p', { class: x.main ? 'nav-dist' : 'note' }, x.text));
  }

  /** The two parts of the status: the one big line (distance) next to the arrow, the notes below the row. */
  function navParts(p) {
    const nodes = navStatusNodes(p);
    return { main: nodes.filter((n) => n.classList.contains('nav-dist')), notes: nodes.filter((n) => !n.classList.contains('nav-dist')) };
  }

  /** Rewrites the status area in place (no full render, so the page does not jump). */
  function updateNavStatus() {
    const p = currentPoint();
    const box = typeof document !== 'undefined' ? document.getElementById('nav-status') : null;
    if (!p || !p.target || !box) return;
    const parts = navParts(p);
    box.replaceChildren(...parts.main);
    const notes = document.getElementById('nav-notes');
    if (notes) notes.replaceChildren(...parts.notes);
  }

  function mountArrow(holder, angle) {
    const make2d = () => {
      const svg = renderArrow2d(angle);
      holder.replaceChildren(svg);
      arrowCtl = { setAngle: (a) => setArrow2dAngle(svg, a) };
    };
    if (settings.arrow !== '3d' || reducedMotion()) {
      make2d();
      return;
    }
    const token = arrowToken;
    holder.append(h('span', { class: 'muted', id: 'arrow3d-wait' }, '입체 화살표를 불러오는 중이에요...'));
    renderArrow3d(holder, angle).then((ctl) => {
      if (token !== arrowToken || !holder.isConnected) return;
      const wait = holder.querySelector('#arrow3d-wait');
      if (wait) wait.remove();
      if (!ctl) {
        make2d();
        return;
      }
      arrowCtl = ctl;
      const info = arrowInfo();
      if (info) ctl.setAngle(info.angle);
    });
  }

  function refreshArrow() {
    const info = arrowInfo();
    if (info && arrowCtl) arrowCtl.setAngle(info.angle);
  }

  /**
   * Keeps `floorStep` (the steady, 15-degree heading the floor map is drawn with) up to date from its
   * source: the simulation slider in simulation mode, the device compass reading (`heading`, set by
   * onCompass) in real mode. null means no heading is known, so the map stays north up.
   * Returns true when the step changed, which is the only time the map is redrawn.
   */
  function syncFloorStep() {
    const raw = settings.sim ? sim.heading : heading;
    const nextStep = raw === null ? null : quantiseHeading(raw, floorStep);
    const changed = nextStep !== floorStep;
    floorStep = nextStep;
    return changed;
  }

  /** The map of the current point (walk, wait or ride) as a scene, or null when it has none. */
  function areaSceneFor(p) {
    if (!area || !p) return null;
    syncFloorStep();
    const sim = settings.sim;
    // The map turns to the heading only where an arrow can point (real mode; in simulation, with the slider).
    const turns = Boolean(p.target) && (!sim || Boolean(simArrow(route, state.index, 0)));
    return sceneFor(route, area, state.index, {
      pos: p.target ? (sim ? null : pos) : ridePos,
      sim,
      headingDeg: turns ? floorStep : null,
      progress: rideProgress,
      busSeqs: arrivalSeqs,
    });
  }

  /** True when the current point gets an outdoor map. */
  function areaShown(p) {
    return Boolean(area && p && (p.target || p.arrival || p.busRoute));
  }

  /** The outdoor map card, or null. */
  function areaPanel(p) {
    const scene = areaSceneFor(p);
    if (!scene) return null;
    areaHost = h('div', { class: 'area-host' }, svgNode(renderAreaMap(area, scene.opts)));
    areaZoom = attachZoom(areaHost, { bar: zoomBar(() => areaZoom, 'area') });
    return h('div', { class: 'card area-card', id: 'area-panel' }, areaHost);
  }

  /** Count and next-stop lines of a ride, shown inside the get-off panel (above the bar). */
  function rideTextNodes(p) {
    if (!p.busRoute) return [];
    const stops = p.busRoute.stops.filter((st) => st.seq <= p.busRoute.alightSeq);
    const count = remainingText(rideProgress);
    const next = nextStopText(rideProgress, stops);
    return [
      count ? h('p', { class: 'ride-count', id: 'ride-count' }, count) : null,
      next ? h('p', { class: 'ride-next', id: 'ride-next' }, next) : null,
    ].filter(Boolean);
  }

  /** Rewrites the two ride lines in place (the panel's buttons are never replaced under a finger). */
  function updateRideText(p) {
    const box = document.getElementById('alight-panel');
    if (!box || !alightStop) return;
    const nodes = rideTextNodes(p);
    const oldC = document.getElementById('ride-count');
    const oldN = document.getElementById('ride-next');
    const same = (oldC ? oldC.textContent : '') === (nodes.find((n) => n.id === 'ride-count')?.textContent || '')
      && (oldN ? oldN.textContent : '') === (nodes.find((n) => n.id === 'ride-next')?.textContent || '');
    if (same) return;
    if (oldC) oldC.remove();
    if (oldN) oldN.remove();
    const anchor = box.querySelector('#alight-banner, #alight-status');
    if (anchor) anchor.after(...nodes);
    else box.prepend(...nodes);
    if (nodes.some((n) => n.id === 'ride-count')) {
      const waiting = document.getElementById('alight-status');
      if (waiting) waiting.remove(); // the count line says it all
    }
  }

  /** Redraws only the map (no full render, so the page does not jump back to the top). */
  function redrawArea() {
    const p = currentPoint();
    if (!area || !p || !areaHost || !areaHost.isConnected) return;
    const scene = areaSceneFor(p);
    if (!scene) return;
    areaHost.replaceChildren(svgNode(renderAreaMap(area, scene.opts)));
    if (areaZoom) areaZoom.reapply(); // the fresh svg gets the same zoom and pan back
    if (scene.kind === 'ride') updateRideText(p);
  }

  /** Redraws only the floor figure (no full render, so the page does not jump back to the top). */
  function redrawFloor() {
    const p = currentPoint();
    if (!floorHost || !floorHost.isConnected || !showsFloorMap(p)) return;
    const { current, next } = floorFocus(route, state.index);
    floorHost.replaceChildren(svgNode(renderFloorMap(floor, current, next, route, { headingDeg: floorStep })));
    if (floorZoom) floorZoom.reapply(); // the fresh svg gets the same zoom and pan back
  }

  /** [크게] [작게] [원래대로] right under the map frame (zoom.js places it): pinching is hard for many users. Never redrawn. */
  function zoomBar(getCtl, key) {
    const ctl = { zoomIn: () => getCtl().zoomIn(), zoomOut: () => getCtl().zoomOut(), reset: () => getCtl().reset() };
    const btn = (id, label, fn) => h('button', { type: 'button', class: 'btn zoom-btn', id: `zoom-${key}-${id}`, onclick: fn }, label);
    return h('div', { class: 'zoom-bar', role: 'group', 'aria-label': '지도 크기' },
      btn('in', '크게', () => ctl.zoomIn()), btn('out', '작게', () => ctl.zoomOut()), btn('reset', '원래대로', () => ctl.reset()));
  }

  /**
   * Indoor point: the floor plan, turned to the direction the user faces. Simulation mode adds the
   * heading slider; real mode adds the note that indoor compass readings can be off.
   */
  function floorPanel() {
    const { current, next } = floorFocus(route, state.index);
    syncFloorStep();
    floorHost = h('div', { class: 'floor-host' },
      svgNode(renderFloorMap(floor, current, next, route, { headingDeg: floorStep })));
    floorZoom = attachZoom(floorHost, { bar: zoomBar(() => floorZoom, 'floor') });
    const box = h('div', { class: 'card', id: 'sim-panel' }, floorHost);
    if (settings.sim) {
      const readout = h('output', { id: 'heading-readout', for: 'heading-slider' }, `${sim.heading}도`);
      box.append(
        h('label', { for: 'heading-slider', class: 'setting-title' }, '내가 바라보는 방향 (0도는 북쪽, 90도는 동쪽)'),
        h('input', { type: 'range', id: 'heading-slider', min: 0, max: HEADING_MAX, step: 1, value: sim.heading,
          oninput: (e) => {
            sim = simReducer(sim, { type: 'SET_HEADING', value: e.target.value });
            readout.textContent = `${sim.heading}도`;
            if (syncFloorStep()) redrawFloor();
          } }),
        readout,
      );
    } else {
      box.append(h('p', { class: 'note', id: 'floor-bearing-note' }, FLOOR_BEARING_NOTE));
    }
    return box;
  }

  /** True when the floor plan applies: an indoor point of the loaded floor (both modes). */
  function showsFloorMap(p) {
    return Boolean(floor && p && p.stage === 'indoor' && p.floor === floor.id);
  }

  function simPanel() {
    const here = currentPoint();
    if (floor && here && here.stage === 'indoor' && here.floor === floor.id) return floorPanel();
    const box = h('div', { class: 'card', id: 'sim-panel' }, renderMiniMap(route, state.index),
      h('p', { class: 'muted' }, MAP_NOTE));
    if (simArrow(route, state.index, sim.heading)) {
      const readout = h('output', { id: 'heading-readout', for: 'heading-slider' }, `${sim.heading}도`);
      box.append(
        h('label', { for: 'heading-slider', class: 'setting-title' }, '내가 바라보는 방향 (모식도 위쪽이 0도)'),
        h('input', { type: 'range', id: 'heading-slider', min: 0, max: HEADING_MAX, step: 1, value: sim.heading,
          oninput: (e) => {
            sim = simReducer(sim, { type: 'SET_HEADING', value: e.target.value });
            readout.textContent = `${sim.heading}도`;
            refreshArrow();
            if (syncFloorStep()) redrawArea();
          } }),
        readout,
      );
    }
    return box;
  }

  const compass = createCompassController({
    onHeading: (hd) => {
      const first = heading === null;
      const hadMsg = compassMsg !== null; // a late reading after a 'no-data' message clears it
      heading = hd;
      compassGranted = true;
      compassMsg = null;
      if (first || hadMsg) render();
      else {
        refreshArrow();
        updateNavStatus();
        // The map redraws only when the 15-degree step changes (see quantiseHeading).
        if (!settings.sim && syncFloorStep()) {
          redrawFloor();
          redrawArea();
        }
      }
    },
    onUnavailable: (reason) => {
      compassMsg = reason === 'denied'
        ? '방향 센서 사용이 허용되지 않았어요. 표지판을 따라가세요.'
        : '이 기기에서는 방향 센서를 쓸 수 없어요. 표지판을 따라가세요.';
      render();
    },
  });

  function onCompass() {
    if (compass.starting) return; // a second tap while the permission prompt is open
    compassMsg = null;
    compass.turnOn();
  }

  const positionCtl = createPositionController({
    onFix: (fix) => {
      const first = pos === null;
      pos = fix;
      posMsg = null;
      if (first) render();
      else {
        refreshArrow();
        updateNavStatus();
        redrawArea();
      }
    },
    onUnavailable: (reason) => {
      posMsg = POSITION_MSG[reason] || POSITION_MSG.unavailable;
      pos = null;
      render();
    },
  });

  /** [방향 화살표 켜기]: one tap starts both the compass (iOS asks for permission here) and the position watch. */
  function onNavArrow() {
    posMsg = null;
    compassMsg = null;
    pos = null;
    onCompass();
    positionCtl.turnOff();
    positionCtl.turnOn();
    render();
  }

  /**
   * Starts the position watch and the compass by itself on a screen that uses them. The compass
   * request runs inside the tap that opened the screen (iOS needs that); without a gesture and
   * without a prior grant the [방향 화살표 켜기] button stays. Each is tried once per stay.
   */
  function autoStartArrow(p) {
    if (settings.sim || !p || state.arrived) return;
    const wantsPosition = Boolean(p.target);
    const wantsCompass = arrowCouldDraw() || showsFloorMap(p);
    const needsPermission = typeof window !== 'undefined' && window.DeviceOrientationEvent
      && typeof window.DeviceOrientationEvent.requestPermission === 'function';
    const plan = autoStartPlan({
      sim: settings.sim, wantsCompass, wantsPosition,
      compassActive: compass.active, positionActive: positionCtl.active,
      triedCompass: autoCompassTried, triedPosition: autoPosTried,
      gesture, needsPermission: Boolean(needsPermission), granted: compassGranted,
    });
    if (wantsCompass) autoCompassTried = true;
    if (wantsPosition) autoPosTried = true;
    if (plan.compass) {
      compassMsg = null;
      compass.turnOn(); // synchronous up to requestPermission(), so it is still inside the tap
    }
    if (plan.position) {
      posMsg = null;
      pos = null;
      positionCtl.turnOn();
    }
    if (plan.compass || plan.position) render();
  }

  /** Ends the position watch when the visible screen has no target arrow. */
  function syncPosition(p) {
    const wanted = !settings.sim && p !== null && Boolean(p.target);
    if (!wanted) autoPosTried = false;
    if (wanted || !(positionCtl.active || pos !== null || posMsg !== null)) return;
    positionCtl.turnOff();
    pos = null;
    posMsg = null;
  }

  /** Ends the compass when the visible screen has no use for it, so it can be turned on again later. */
  function syncCompass(p) {
    const wanted = !settings.sim && p !== null && (arrowCouldDraw() || showsFloorMap(p));
    if (!wanted) autoCompassTried = false;
    if (wanted || !(compass.active || heading !== null || compassMsg !== null)) return;
    compass.turnOff();
    heading = null;
    compassMsg = null;
    if (!settings.sim) floorStep = null; // north up until a new reading; sim mode keeps its slider step
  }

  // ------------------------------------------------------------ screen 1 input

  const typedFallback = (msg) => { listenMsg = msg; typedOpen = true; render(); };
  const listener = createListener({
    onStart: () => { listening = true; stopSpeaking(); chime(settings, 'start'); render(); },
    onEnd: () => { listening = false; chime(settings, 'end'); render(); },
    onResult: (text) => {
      // Only for the question that was on screen when the microphone opened.
      if (state.index < 0 && QUESTION_STEPS.includes(state.prepStep) && state.prepStep === listenStep) interpret(text);
    },
    onDenied: () => typedFallback('마이크 사용이 허용되지 않았어요. 직접 입력해 주세요.'),
    onBlocked: () => typedFallback('이 브라우저에서는 말하기를 쓸 수 없어요. 아래 칸에 적어 주세요.'),
    onUnsupported: () => typedFallback('이 기기에서는 말하기를 쓸 수 없어요. 직접 입력해 주세요.'),
    onError: () => typedFallback('음성 인식에 문제가 있어요. 다시 해 보거나 직접 입력해 주세요.'),
    onNoSpeech: () => { listenMsg = '잘 못 들었어요. 다시 눌러 말씀해 주세요.'; render(); },
    onStartTimeout: () => { listening = false; typedFallback('말하기를 시작하지 못했어요. 아래 칸에 적어 주셔도 돼요.'); },
  });

  function onTalk() {
    if (listening) {
      listener.stop();
      return;
    }
    listenMsg = null;
    listenStep = state.prepStep;
    stopSpeaking(); // the microphone must not hear the app's own voice
    listener.start();
  }

  async function interpret(text) {
    const t = String(text || '').trim();
    if (!t || state.index >= 0) return;
    const step = state.prepStep; // the answer belongs to the question on screen now
    const token = ++parseToken;
    utterance = t;
    reAsk = null;
    reAskDecision = null;
    parsing = true;
    render();
    const result = await parseVisit(t, { webhookUrl: WEBHOOK_URL, step });
    if (token !== parseToken || state.index >= 0 || state.prepStep !== step) return;
    parsing = false;
    badge = result.source === 'ai' ? '인공지능 해석' : '규칙 해석';
    typedText = '';
    typedOpen = !micSupported();
    const before = state;
    dispatch({ type: 'SET_FIELDS', fields: result.fields }, { keepHeard: true });
    const decision = reAskFor(before, state, result.reAsk, result.fields);
    reAsk = decision ? decision.text : null;
    reAskDecision = decision;
    if (decision) render();
    if (decision) speakReAsk(decision);
    else sayStep();
  }

  /** The picture box: a pictogram by point kind, or the big arrow when one can be drawn. */
  function navStatusBox(p) {
    return h('div', { id: 'nav-status', role: 'status' }, ...navParts(p).main);
  }

  function navNotesBox(p) {
    return h('div', { id: 'nav-notes', class: 'nav-notes' }, ...navParts(p).notes);
  }

  function pictureBox(p, compact = false) {
    const spec = pictoSpec(p);
    const box = h('div', { class: compact ? 'picto-box compact' : 'picto-box', id: 'arrow-box' });
    const info = arrowInfo();
    const showNav = Boolean(p.target) && (Boolean(currentTarget()) || settings.sim);
    if (info) {
      const holder = h('div', { class: 'arrow-holder', id: 'arrow-holder' });
      box.classList.add('arrow-mode');
      box.append(holder);
      mountArrow(holder, info.angle);
      if (showNav) {
        // Arrow on the left, straight-line distance and target name on the right: one short row; notes below.
        box.classList.add('nav-box');
        box.replaceChildren(h('div', { class: 'nav-row' }, holder,
          h('div', { class: 'nav-side' }, navStatusBox(p), h('p', { class: 'picto-caption' }, targetCaption(p.target)))), navNotesBox(p));
      } else if (spec.label) box.append(h('p', { class: 'picto-caption' }, spec.label));
    } else {
      if (showNav) {
        // No arrow yet: the picture on the left, the status (finding, notes) on the right.
        box.classList.add('nav-box');
        box.append(h('div', { class: 'nav-row' }, h('div', { class: 'nav-pic' }, svgNode(pictoSvg(spec))),
          h('div', { class: 'nav-side' }, navStatusBox(p))), navNotesBox(p));
      } else box.append(svgNode(pictoSvg(spec)));
    }
    return box;
  }

  function renderPoint(p) {
    const main = h('div', { class: 'stack' });
    const arrivedHere = state.arrived && state.index === route.points.length - 1;

    // The user said yes on N0: the doctor's consent card (N1) opens from this one big button, which
    // sits first so it is above the bar without scrolling, even in simulation mode.
    if (isConsultPoint(p) && showEnterRoomButton(flow.state)) {
      main.append(h('button', { class: 'btn wide primary notes-btn lead', id: 'btn-enter-room', onclick: () => {
        flow.enterRoom();
        if (flow.state.phase === 'n1') say('notes-consent', NOTES_SENTENCES.consent); // an ignored early tap says nothing
      } }, '진료실에 들어왔어요'));
    }

    if (arrivedHere) {
      main.append(h('div', { class: 'picto-box done', id: 'arrow-box' }, svgNode(doneSvg())));
      const rec = todayRecord();
      if (rec) {
        main.append(h('button', { class: 'btn wide', id: 'btn-today-record', onclick: () => notesUi.openRecord(rec.id, { read: true }) },
          '오늘 진료 내용 다시 듣기'));
      }
    } else {
      // The get-off alert panel sits right under the instruction so its button never needs scrolling.
      // Target points (O1/R1) show it below the arrow block instead, so the arrow stays on top.
      if (arrivalMsg && p.arrival) main.append(arrivalPanel());
      if (p.alertCoord) main.append(alightPanel(p));
      // Indoor (both modes): the floor plan comes first so it is visible without scrolling, and the
      // picture below it shrinks to the compact size.
      const planFirst = showsFloorMap(p);
      if (planFirst) main.append(floorPanel());
      main.append(pictureBox(p, Boolean(p.alertCoord) || planFirst || areaShown(p)));
      // On a target point the arrow button comes first (the sign note moves below it).
      const signNote = arrowInfo() ? null : h('p', { class: 'sign-note' }, p.kind === 'bus' && p.alertCoord ? BUS_NOTE : SIGN_FALLBACK);
      if (signNote && !currentTarget()) main.append(signNote);
      const floorTurns = !settings.sim && planFirst;
      if (currentTarget()) {
        // Target point: one button starts the compass and the position watch together.
        // It starts by itself when the screen opens; the button stays only when that did not happen or failed.
        const showButton = needsArrowButton({ heading, compassActive: compass.active, compassMsg }) || posMsg !== null;
        if (showButton && !arrowInfo()) main.append(h('button', { class: 'btn', id: 'btn-compass', onclick: onNavArrow }, '방향 화살표 켜기'));
        if (compassMsg) main.append(h('p', { class: 'note', role: 'status' }, compassMsg));
      } else if ((arrowCouldDraw() || floorTurns) && needsArrowButton({ heading, compassActive: compass.active, compassMsg })) {
        main.append(h('button', { class: 'btn', id: 'btn-compass', onclick: onCompass }, '방향 센서 켜기'));
        if (floorTurns) main.append(h('p', { class: 'note', id: 'compass-hint' }, '방향 센서를 켜면 지도가 바라보는 쪽으로 돌아가요.'));
      }
      // On the floor map a refused or missing compass is not an error: the map just stays north up.
      if (compassMsg && !settings.sim && !planFirst && !currentTarget()) main.append(h('p', { class: 'note', role: 'status' }, compassMsg));
      if (signNote && currentTarget()) main.append(signNote);
      // Target points: the bus position panel comes after the button, so the button stays above the bar.
      if (arrivalMsg && p.target && !p.arrival && arrivalPointFor(route, state.index)) main.append(arrivalPanel());
      const outdoorMap = areaPanel(p);
      if (outdoorMap) main.append(outdoorMap);
      if (p.gap) main.append(h('p', { class: 'warn', id: 'gap-warning', role: 'note' }, '이 구간은 끊어진 곳이 있어요. 우회하거나 직원에게 물어보세요.'));
    }
    if (settings.sim && !arrivedHere && !showsFloorMap(p)) main.append(simPanel(p));

    const links = h('div', { class: 'bottom-links' }, pointDetails(p));
    const prevLabel = p.stage === 'indoor' ? '이전 지점으로 돌아가기' : (state.index === 0 ? '처음 화면으로' : '이전 지점으로');
    const row2 = h('div', { class: 'link-row' },
      h('button', { class: 'btn small ghost', id: 'btn-prev', onclick: () => {
        dispatch({ type: 'PREV' });
        sayCurrent();
      } }, prevLabel));
    links.append(row2);
    main.append(links);
    return main;
  }

  // ------------------------------------------------------------ overlays

  function buildHelp() {
    const card = h('div', { class: 'overlay-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': '도움 요청' },
      h('p', { class: 'help-sentence' }, helpFor(state, route, floor).sentence));
    for (const f of FIELDS) {
      const opt = optionFor(f.id, state.fields[f.id]);
      if (opt) card.append(h('p', { class: 'help-line' }, `${f.label}: ${opt.label}`));
    }
    card.append(h('button', { class: 'btn wide primary', id: 'btn-help-close',
      onclick: () => { stopSpeaking(); dispatch({ type: 'CLOSE_HELP' }); } }, '닫기'));
    return card;
  }

  /** Builds an overlay once when it opens and clears it when it closes; never rebuilt while open. */
  function syncOverlay(el, isOpen, build) {
    el.hidden = !isOpen;
    if (!isOpen) {
      if (el.firstChild) el.replaceChildren();
    } else if (!el.firstChild) {
      el.append(build());
    }
  }

  /** While the microphone is open a modal must not hide that it is: a red bar stays on top of every overlay. */
  function syncRecIndicator(overlayOpen) {
    const want = overlayOpen && flow.state.phase === 'n2' && flow.state.listening;
    let el = document.getElementById('overlay-rec');
    if (!want) {
      if (el) el.remove();
      document.body.classList.remove('has-overlay-rec');
      return;
    }
    if (!el) {
      el = h('div', { id: 'overlay-rec', class: 'rec-bar live overlay-rec', role: 'status' },
        h('span', { class: 'rec-dot', 'aria-hidden': 'true' }), h('span', { class: 'rec-label' }, '받아 적는 중'));
      document.body.append(el);
    }
    document.body.classList.add('has-overlay-rec');
  }

  function renderOverlays() {
    syncOverlay($('overlay-help'), state.helpOpen, buildHelp);
    syncOverlay($('overlay-companion'), state.companionOpen && Boolean(support), companionCard);
    syncOverlay($('overlay-settings'), state.settingsOpen, settingsCard);

    const open = state.helpOpen || (state.companionOpen && Boolean(support)) || state.settingsOpen;
    document.body.classList.toggle('modal-open', open);
    syncRecIndicator(open);
    setBackgroundInert(open);
    if (open && !wasOverlay) {
      const first = document.querySelector('.overlay:not([hidden]) button, .overlay:not([hidden]) input');
      if (first) first.focus();
    } else if (!open && wasOverlay && openerSel) {
      const opener = document.querySelector(openerSel);
      openerSel = null;
      if (opener) opener.focus();
    }
    wasOverlay = open;
  }

  /** [진료 기록 모두 지우기] with one confirm step inside the settings card. */
  function clearNotesControl() {
    const box = h('div', { class: 'clear-notes', id: 'clear-notes' });
    const show = (mode, msg = null) => {
      const n = listRecords().length;
      box.replaceChildren(...[
        mode === 'confirm'
          ? h('p', { class: 'warn', role: 'alert' }, `진료 기록 ${n}건을 모두 지울까요? 되돌릴 수 없어요.`)
          : null,
        msg ? h('p', { class: 'muted', role: 'status' }, msg) : null,
        mode === 'confirm'
          ? h('div', { class: 'link-row' },
            h('button', { class: 'btn', id: 'btn-clear-notes-yes', onclick: () => {
              const cleared = clearRecords();
              flow.forget(); // no text of a visit stays in memory
              notesUi.closeViews();
              show('idle', cleared ? '진료 기록을 모두 지웠어요.' : '지우지 못했어요. 브라우저의 저장 공간을 확인한 뒤 다시 눌러 주세요.');
            } }, '모두 지우기'),
            h('button', { class: 'btn', id: 'btn-clear-notes-no', onclick: () => show('idle') }, '그만두기'))
          : h('button', { class: 'btn wide', id: 'btn-clear-notes', disabled: n === 0, onclick: () => show('confirm') },
            n === 0 ? '진료 기록 모두 지우기 (기록 없음)' : '진료 기록 모두 지우기'),
      ].filter(Boolean));
    };
    show('idle');
    return box;
  }

  function settingsCard() {
    const update = (patch) => {
      if ('sim' in patch && patch.sim !== settings.sim) stopAlight(); // a status from the other mode is stale
      if ('sim' in patch && patch.sim !== settings.sim) flow.modeChanged(); // so is a running capture (a summary in progress finishes saving)
      settings = { ...settings, ...patch };
      persist();
      if (!settings.sound) stopSpeaking();
      render(); // the settings card itself is not rebuilt, so focus stays on the control
    };
    const toggle = (key, label, note) => h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: settings[key] ? true : null,
        onchange: (e) => update({ [key]: e.target.checked }) }),
      h('span', {}, label, note ? h('small', { class: 'muted' }, ` ${note}`) : null));
    const radios = (key, options) => h('div', { class: 'radio-row' }, options.map(([v, label]) =>
      h('label', { class: 'radio' },
        h('input', { type: 'radio', name: key, value: v, checked: settings[key] === v ? true : null,
          onchange: () => update({ [key]: v }) }),
        h('span', {}, label))));

    return h('div', { class: 'overlay-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': '설정' },
      h('h2', {}, '설정'),
      toggle('sound', '소리 켜기'),
      h('p', { class: 'setting-title' }, '목소리'),
      radios('voice', [['f', '여성 목소리'], ['m', '남성 목소리']]),
      h('p', { class: 'setting-title' }, '말하는 속도'),
      radios('rate', [['normal', '보통'], ['slow', '천천히']]),
      h('p', { class: 'setting-title' }, '화살표 종류'),
      radios('arrow', [['2d', '평면'], ['3d', '입체']]),
      reducedMotion() ? h('p', { class: 'muted' }, '움직임 줄이기 설정이 켜져 있어서 평면 화살표만 보여요.') : null,
      toggle('largeText', '큰 글씨'),
      toggle('sim', '시뮬레이션', '(모식도로 화살표를 연습해 봐요)'),
      h('p', { class: 'muted' }, '로그인이 없어요. 설정과 마지막으로 확인한 지점만 이 기기에 저장하고, 말한 내용과 방문 정보는 저장하지 않아요. 단, 진료 말씀 적어 두기를 쓰고 선생님이 허락하신 경우에는 글자로 정리한 진료 기록이 이 기기에만 남아요. 소리는 저장하지 않아요.'),
      h('p', { class: 'muted' }, '내릴 곳 알림을 켜면 휴대폰 위치를 쓰지만, 위치는 저장하거나 보내지 않아요.'),
      h('p', { class: 'muted' }, '말하기 기능을 쓰면 휴대폰 브라우저가 음성을 인식하려고 소리를 인터넷으로 보낼 수 있어요.'),
      clearNotesControl(),
      h('p', { class: 'muted', id: 'app-version' }, `앱 버전 ${APP_VERSION}`),
      h('button', { class: 'btn wide primary', onclick: () => dispatch({ type: 'CLOSE_SETTINGS' }) }, '닫기'),
    );
  }

  // ------------------------------------------------------------ frame

  function renderDots(cur, total) {
    const dots = $('dots');
    dots.replaceChildren(...Array.from({ length: total }, (_, i) =>
      h('span', { class: i + 1 < cur ? 'dot done' : (i + 1 === cur ? 'dot current' : 'dot') })));
  }

  function render() {
    const screen = screenOf(state, route);
    const nScreen = notesUi.current(); // a notes screen (N0..N4, V1, V2) takes over #screen and the heading
    const p = nScreen ? null : currentPoint();
    document.documentElement.dataset.screen = screen;
    document.documentElement.classList.toggle('large', settings.largeText);

    const prog = progressOf(state, route);
    if (nScreen && nScreen.header) {
      // The record screens (list, one record) are not a step of the visit: own header, no step counter.
      $('stage-pill').textContent = nScreen.header;
      $('progress').textContent = '';
      $('progress').removeAttribute('aria-label');
      renderDots(0, 0);
    } else {
      $('stage-pill').textContent = STAGE_LABEL[screen];
      $('progress').textContent = `${prog.cur} / ${prog.total}`;
      $('progress').setAttribute('aria-label', `이 단계 ${prog.total}개 중 ${prog.cur}번째`);
      renderDots(prog.cur, prog.total);
    }
    if (nScreen) setInstruction(nScreen.instruction);
    else if (p) setInstruction(state.arrived ? ARRIVED_TEXT : p.display);
    else setInstruction(STEP_SCREEN_TEXT[state.prepStep] || CLIP_TEXT[STEP_CLIP[state.prepStep]]);

    // While the get-off watch runs the instruction shrinks, so the alert, the stop count and the next
    // stop sit above the fixed bar (the rider already read the instruction before turning the watch on).
    $('instruction').classList.toggle('compact', Boolean((p && p.alertCoord) || (nScreen && nScreen.compact)
      || (p && isConsultPoint(p) && showEnterRoomButton(flow.state)))); // I4 with the room button: the button must stay above the bar
    areaHost = null; // set again only when this screen builds a map
    syncArrival(p);
    syncCompass(p);
    syncPosition(p);
    disposeArrow3d();
    arrowCtl = null;
    arrowToken += 1;
    const saved = captureUiState($('screen'), document.activeElement);
    $('screen').replaceChildren(...[
      settings.sim ? h('div', { class: 'sim-banner', role: 'status' }, BANNER_TEXT) : null,
      nScreen ? nScreen.node : (p ? renderPoint(p) : renderPrepare()),
    ].filter(Boolean));
    notesUi.afterRender();
    $('btn-replay').disabled = Boolean(nScreen && nScreen.noReplay); // never speak into the open microphone
    restoreUiState($('screen'), saved);
    // The document scrolls, not #main. Go to the top only when the screen changed, never for a
    // background re-render and never while an overlay is open.
    const overlayOpen = state.helpOpen || (state.companionOpen && Boolean(support)) || state.settingsOpen;
    const key = `${screenKeyOf(state, route)}|${nScreen ? nScreen.key : ''}`;
    if (shouldScrollTop(lastScreenKey, key, overlayOpen)) {
      if (typeof window !== 'undefined' && typeof window.scrollTo === 'function') window.scrollTo(0, 0);
      lastScreenKey = key;
      flow.touchScreen(); // a new screen: taps in the first 0.6 s are ignored
    }

    // The primary button keeps its place on every screen; when it has nothing to do it is only hidden.
    const primary = $('btn-primary');
    const bp = nScreen ? { label: primary.textContent, visible: false, action: null } : barPrimary(state, route);
    primary.textContent = bp.label;
    primary.classList.toggle('vacant', !bp.visible);
    primary.disabled = !bp.visible;
    primary.setAttribute('aria-hidden', bp.visible ? 'false' : 'true');
    syncBarHeight();
    watchBar();
    renderOverlays();
    if (!(state.helpOpen || state.settingsOpen || (state.companionOpen && Boolean(support)))) autoStartArrow(p);
  }

  // ------------------------------------------------------------ bar wiring (static buttons)
  // Assigned as properties so the handlers installed before loading are replaced.

  // Marks the taps: a click is the user gesture iOS wants for the compass permission request.
  document.addEventListener('click', () => {
    gesture = true;
    setTimeout(() => { gesture = false; }, 0);
  }, true);

  $('btn-replay').disabled = false;
  $('btn-settings').disabled = false;
  $('btn-replay').onclick = () => { replayCurrent(); };
  $('btn-help').onclick = () => {
    openerSel = '#btn-help';
    dispatch({ type: 'OPEN_HELP' });
    if (!helpMaySpeak(flow.state)) return; // the card stays silent while the microphone is open (it would hear the app)
    const help = helpFor(state, route, floor);
    say(help.clipId, help.speech);
  };
  $('btn-settings').onclick = () => {
    openerSel = '#btn-settings';
    dispatch({ type: 'OPEN_SETTINGS' });
  };
  $('btn-primary').onclick = () => {
    if (flow.state.phase !== null || notesUi.isOpen()) return; // a notes screen has its own buttons
    const { action } = barPrimary(state, route);
    if (action === 'next') {
      dispatch({ type: 'WIZARD_NEXT' });
      sayStep();
    } else if (action === 'start') {
      chime(settings);
      dispatch({ type: 'START' });
      sayCurrent();
    } else if (action === 'restart') {
      dispatch({ type: 'RESTART' });
      sayCurrent();
    } else if (action === 'confirm') {
      chime(settings);
      vibrate(80);
      // Confirming the point before the consultation asks N0 once per visit (the screen is up before
      // the route moves on, so I4 never flashes in between).
      const askNotes = asksNotesAfter(route, state.index) && flow.state.wants === null;
      if (askNotes) flow.askAfterConfirm();
      dispatch({ type: 'CONFIRM' });
      if (askNotes) say('notes-ask', NOTES_SENTENCES.ask);
      else sayCurrent();
    }
  };
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (state.helpOpen) { stopSpeaking(); dispatch({ type: 'CLOSE_HELP' }); }
    else if (state.companionOpen) dispatch({ type: 'CLOSE_COMPANION' });
    else if (state.settingsOpen) dispatch({ type: 'CLOSE_SETTINGS' });
  });

  render();
}

// ---------------------------------------------------------------- early wiring and loading

let earlyInstalled = false;

/** Help works before (and without) the route data: the fixed sentence and a close button. */
function installEarlyHelp() {
  if (earlyInstalled) return;
  earlyInstalled = true;
  const overlay = document.getElementById('overlay-help');
  const btn = document.getElementById('btn-help');
  const close = () => {
    stopSpeaking();
    overlay.hidden = true;
    overlay.replaceChildren();
    setBackgroundInert(false);
    document.body.classList.remove('modal-open');
    btn.focus();
  };
  btn.onclick = () => {
    overlay.replaceChildren(h('div', { class: 'overlay-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': '도움 요청' },
      h('p', { class: 'help-sentence' }, HELP_UNKNOWN_SENTENCE),
      h('button', { class: 'btn wide primary', id: 'btn-help-close', onclick: close }, '닫기')));
    overlay.hidden = false;
    document.body.classList.add('modal-open');
    setBackgroundInert(true);
    document.getElementById('btn-help-close').focus();
    speak('help-unknown', HELP_UNKNOWN_SPEECH, loadState([]).settings);
  };
  document.addEventListener('keydown', (e) => {
    if (!booted && e.key === 'Escape' && !overlay.hidden) close();
  });
}

function supportOk(s) {
  return Boolean(s && typeof s === 'object' && typeof s.city === 'string' && typeof s.onlineUrl === 'string'
    && typeof s.program === 'string' && typeof s.target === 'string' && typeof s.fee === 'string'
    && typeof s.hours === 'string' && typeof s.retrieved === 'string'
    && s.contact && typeof s.contact.name === 'string' && typeof s.contact.phone === 'string'
    && s.source && typeof s.source.name === 'string' && typeof s.source.url === 'string'
    && s.visitChecklist && Array.isArray(s.visitChecklist.items) && typeof s.visitChecklist.source === 'string');
}

/** support.json is optional: any failure or wrong shape means "no Seongnam panel". */
async function loadSupport() {
  try {
    const res = await fetch(versioned('data/support.json'));
    if (!res.ok) return null;
    const data = await res.json();
    return supportOk(data) ? data : null;
  } catch {
    return null;
  }
}

function showLoadError(err) {
  const $ = (id) => document.getElementById(id);
  setInstruction('안내 자료를 불러오지 못했어요.');
  $('screen').replaceChildren(
    h('p', { class: 'muted' }, '인터넷 연결을 확인한 뒤 아래 버튼을 눌러 주세요. 도움이 필요하면 [도움 요청]을 눌러 주세요.'),
    h('button', { class: 'btn wide primary', id: 'btn-retry', onclick: () => start() }, '다시 불러오기'),
    h('details', {}, h('summary', {}, '자세히'), h('p', {}, String(err && err.message ? err.message : err))),
  );
  const primary = $('btn-primary');
  primary.textContent = '다시 불러오기';
  primary.onclick = () => start();
}

async function start() {
  const $ = (id) => document.getElementById(id);
  installEarlyHelp();
  installAudioUnlock(); // first tap unlocks the shared audio element for later untapped clips
  $('btn-settings').disabled = true;
  $('btn-replay').disabled = true;
  setInstruction('안내 자료를 불러오는 중이에요...');
  $('screen').replaceChildren();
  let route;
  try {
    route = await loadRoute(versioned('data/route.migeum-snubh.json'));
  } catch (err) {
    showLoadError(err);
    return;
  }
  const support = await loadSupport();
  // The floor schematic is optional: without it indoor screens work, only the map is missing.
  let floor = null;
  try {
    floor = await loadFloor(versioned('data/floor.snubh-1dong-1f.json'));
  } catch {
    floor = null;
  }
  // The outdoor map is optional too: without it only the map is missing.
  let area = null;
  try {
    area = await loadArea(versioned('data/area.migeum-snubh.json'));
  } catch {
    area = null;
  }
  // The example conversation for simulation mode is optional: without it simulation just has no notes demo.
  let sample = null;
  try {
    const res = await fetch(versioned('data/sample-visit.json'));
    if (res.ok) {
      const data = await res.json();
      if (data && Array.isArray(data.lines) && typeof data.transcript === 'string') sample = data;
    }
  } catch {
    sample = null;
  }
  boot(route, support, floor, area, sample);
}

if (typeof document !== 'undefined') start();
