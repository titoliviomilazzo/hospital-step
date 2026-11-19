// State machine and rendering. `nextState` is pure and importable in Node; the DOM boot at the
// bottom runs only in a browser. Later stages hook in at the EXTENSION POINT comments.
import { loadRoute } from './route.js';
import { FIELDS, FIXED_CLIPS, QUESTION_STEPS, ANSWER_BUTTONS, optionFor, HELP_SENTENCE, HELP_SPEECH, REASK_HOSPITAL_SPEECH } from './clips.js';
import { loadState, saveState } from './storage.js';
import { speak, speakThen, preloadManifest, chime, vibrate, stopSpeaking } from './voice.js';
import { createListener } from './listen.js';
import { parseVisit, expandAbbreviations } from './intent.js';
import { arrowAngle, bearingDeg, startCompass } from './compass.js';
import { renderArrow2d, setArrow2dAngle } from './arrow2d.js';
import { renderArrow3d, disposeArrow3d } from './arrow3d.js';
import { initialSim, simReducer, simArrow, renderMiniMap, BANNER_TEXT, MAP_NOTE, HEADING_MAX } from './sim.js';
import { pictoSpec, pictoSvg, doneSvg, itemSvg, itemKind, svgNode, heroSvg, HERO_BY_STEP, MOBILITY_ICON } from './pictos.js';
import { startAlightWatch, simulatedSource, simulatedRouteSource } from './alight.js';
import { fetchArrival, locationText, REFRESH_MS } from './arrival.js';
import { WEBHOOK_URL, ARRIVAL_URL } from '../config.js';

const FIELD_IDS = FIELDS.map((f) => f.id);
const STAGE_LABEL = { prepare: '1단계 방문 준비', travel: '2단계 이동 안내', indoor: '3단계 병원 안' };
const CLIP_TEXT = Object.fromEntries(FIXED_CLIPS.map((c) => [c.clipId, c.text]));
const SIGN_FALLBACK = '표지판을 따라가세요. 어려우면 직원에게 물어보세요.';
const STEP_CLIP = {
  hospital: 'q-hospital', visit: 'q-visit', mobility: 'q-mobility', reception: 'q-reception',
  confirm: 'confirm-all', checklist: 'checklist-screen',
};
// On-screen sentence of the two wizard screens whose spoken clip is too long for three lines of 36px.
const STEP_SCREEN_TEXT = { confirm: '이렇게 가시는 게 맞나요?', checklist: '신분증과 진료의뢰서를 챙기세요.' };
const BUS_NOTE = '버스 안 안내 방송과 화면에 나오는 정류장 이름을 확인하세요. 잘 모르시겠으면 기사님께 물어보세요.';
const ARRIVED_TEXT = '안내를 모두 마쳤습니다.';
// Get-off alert texts (the spoken versions are the alert-* clips in clips.js).
const ALERT_BUTTON = '내릴 곳 가까워지면 알려 주기';
const ALERT_EXPLAIN = '위치 확인을 허락하시면 내리실 정류장에 가까워질 때 소리와 진동으로 알려 드려요.';
const ALERT_SIM_NOTE = '시뮬레이션: 버스가 움직이는 것처럼 보여 드려요';
const ALERT_WAITING = '알림 켜짐: 내리실 정류장을 기다리는 중';
const ALERT_BANNER = { early: CLIP_TEXT['alert-early'], near: CLIP_TEXT['alert-near'], now: '이번 정류장에서 내리세요.' };
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

/** Header progress: "cur / total". On the wizard the four questions count; later screens are 4 / 4. */
export function progressOf(state, route) {
  if (state.index >= 0) return { cur: route.points[state.index].order, total: route.points.length };
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
  if (state.arrived) return { label: '직원에게 보여주기', visible: true, action: 'show' };
  const p = route.points[state.index];
  return { label: `→ ${p.confirmLabel || '여기에 도착했어요'}`, visible: true, action: 'confirm' };
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
      // Merges a parsed sentence: only valid non-null parsed values are written, and a field the
      // user set with [수정] keeps its value.
      // On a question screen a sentence that carried any valid value moves the wizard on: to the
      // confirm screen after an edit that answered the edited field, else to the next unanswered one.
      const src = action.fields || {};
      const fields = { ...state.fields };
      let heardAny = false;
      for (const id of FIELD_IDS) {
        const v = src[id] ?? null;
        const valid = v !== null && optionFor(id, v);
        if (valid) heardAny = true;
        if (state.manual && state.manual[id]) continue;
        if (valid) fields[id] = v;
      }
      let { prepStep, editing } = state;
      if (state.index < 0 && QUESTION_STEPS.includes(prepStep) && heardAny) {
        if (editing) {
          if (optionFor(prepStep, src[prepStep] ?? null)) { prepStep = 'confirm'; editing = false; }
        } else {
          prepStep = firstUnfilled(fields) ?? 'confirm';
        }
      }
      return { ...state, fields, prepStep, editing };
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

/** Sets the one persistent instruction heading (inside the aria-live region) only when it changes. */
function setInstruction(text) {
  const el = document.getElementById('instruction');
  if (el && el.textContent !== text) el.textContent = text;
}

let booted = false;

// ---------------------------------------------------------------- app

function boot(route, support) {
  booted = true;
  const $ = (id) => document.getElementById(id);
  const stored = loadState(route.points.map((p) => p.id));
  let settings = stored.settings;
  let state = initialState(stored.lastPointId);
  let wasOverlay = false;
  let openerSel = null; // selector of the control that opened the overlay; focus returns there

  // Screen 1 parse state. Memory only; never persisted.
  let utterance = null;
  let badge = null;
  let reAsk = null;
  let parsing = false;
  let parseToken = 0;
  let typedOpen = false;
  let typedText = '';
  let listening = false;
  let listenMsg = null;

  // Arrow state. `heading` is the real compass reading (null until one arrives).
  let heading = null;
  let compassMsg = null;
  let stopCompass = null;
  let sim = initialSim();
  let arrowCtl = null; // {setAngle(deg)} of the arrow currently on screen
  let arrowToken = 0;
  const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Get-off alert. Memory only; positions are never kept, only the resulting level.
  let alightStop = null; // stop() of the running watch, or null
  let alightPointId = null; // the route point the watch belongs to
  let alightLevel = 'far'; // 'far' | 'near' | 'now'
  let alightFailed = false; // permission denied or no position available

  // Bus arrival info on a point that has `arrival` (only when ARRIVAL_URL is configured).
  let arrivalPointId = null;
  let arrivalTimer = null;
  let arrivalToken = 0;
  let arrivalMsg = null;

  const say = (clipId, text) => speak(clipId, text, settings);
  preloadManifest();
  const persist = () => saveState({ settings, lastPointId: state.lastPointId });

  /** Drops what was heard on a wizard screen (the sentence, its badge, typed text, messages). */
  function clearHeard() {
    utterance = null;
    badge = null;
    reAsk = null;
    typedText = '';
    typedOpen = false;
    listenMsg = null;
  }

  function dispatch(action, { keepHeard = false } = {}) {
    const prev = state;
    state = nextState(state, action, route);
    // The watch belongs to one screen: leaving it (confirm, back, reset) ends it.
    if (alightPointId !== null && (currentPoint() === null || currentPoint().id !== alightPointId || state.arrived)) stopAlight();
    if (state.lastPointId !== prev.lastPointId) persist();
    if (prev.index < 0 && state.index >= 0) leavePrepare();
    else if (!keepHeard && prev.prepStep !== state.prepStep) {
      parseToken += 1; // a sentence still being parsed belongs to the screen that was left
      parsing = false;
      clearHeard();
    }
    render();
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
  }

  /** Taps [내릴 곳 가까워지면 알려 주기]: starts the watch; the browser asks for location itself. */
  function startAlight(p) {
    stopAlight();
    alightPointId = p.id;
    alightFailed = false;
    const board = route.points.find((q) => q.boardCoord);
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
      onLevel: (level) => {
        if (alightPointId !== p.id) return;
        alightLevel = level;
        const id = `alert-${level}`;
        say(id, CLIP_TEXT[id]);
        vibrate(ALERT_VIBRATION);
        render();
      },
      onError: () => {
        if (alightPointId !== p.id) return;
        alightStop = null;
        alightFailed = true;
        say('alert-off', CLIP_TEXT['alert-off']);
        render();
      },
    });
    if (alightPointId === p.id && !alightFailed) alightStop = ctl.stop;
    render();
  }

  /** The get-off alert controls and status for a point that has an alertCoord. */
  function alightPanel(p) {
    // Children go through h(), which skips null; a raw DOM append() would print "null" as text.
    const kids = [];
    if (alightStop && alightLevel !== 'far') {
      kids.push(h('p', { class: `alight-banner ${alightLevel}`, id: 'alight-banner', role: 'alert' }, ALERT_BANNER[alightLevel]));
    } else if (alightStop) {
      kids.push(h('p', { class: 'alight-status', id: 'alight-status', role: 'status' }, ALERT_WAITING));
    }
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
  }

  /** Starts the 30 s refresh on a point with `arrival`; ends it on any other screen. */
  function syncArrival(p) {
    const wanted = ARRIVAL_URL && p && p.arrival && !state.arrived ? p : null;
    if (!wanted) {
      if (arrivalPointId !== null) stopArrival();
      return;
    }
    if (arrivalPointId === wanted.id) return;
    stopArrival();
    arrivalPointId = wanted.id;
    const token = arrivalToken;
    const load = async () => {
      const parsed = await fetchArrival(ARRIVAL_URL, wanted.arrival);
      if (token !== arrivalToken) return;
      const text = locationText(parsed, wanted.arrival.routeName);
      if (text !== arrivalMsg) {
        arrivalMsg = text;
        render();
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
    if (state.arrived) return speakThen(say('arrive-main', CLIP_TEXT['arrive-main']), () => say('arrive-show', CLIP_TEXT['arrive-show']));
    return say(p.id, p.speech);
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

    const ri = step === 'hospital' ? resumeIndex(state, route) : null;
    if (ri !== null) {
      main.append(h('button', { class: 'btn wide', id: 'btn-resume', onclick: () => {
        dispatch({ type: 'RESUME' });
        speakThen(say('ui-resume', CLIP_TEXT['ui-resume']), () => sayCurrent());
      } }, `이어서 안내 받기 (${ri + 1}번째 지점)`));
    }
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
      main.append(h('details', { class: 'more' }, h('summary', {}, '자세히'),
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
    const d = h('details', { class: 'more' }, h('summary', {}, '자세히'));
    if (p.sign) d.append(row('찾을 표지판', p.sign));
    if (p.hours) d.append(row('운행 시간', p.hours));
    if (p.detail) {
      d.append(
        h('p', {}, p.detail),
        h('button', { class: 'btn small', onclick: () => say(`${p.id}-detail`, p.detailSpeech || p.detail) }, '설명 듣기'),
      );
    }
    d.append(row('상태', p.checkedOn ? `${p.status} (${p.checkedOn})` : p.status), row('출처', p.source));
    if (p.id === route.points[route.points.length - 1].id) {
      const ol = h('ol', { class: 'summary', id: 'arrival-summary' });
      route.points.filter((q) => q.stage === 'indoor').forEach((q) => ol.append(h('li', {}, q.display)));
      d.append(h('p', { class: 'setting-title' }, '병원 안 순서'), ol);
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
    const next = route.points[state.index + 1];
    if (p.stage === 'travel' && next && p.coord && next.coord && heading !== null) {
      return { angle: arrowAngle(bearingDeg(p.coord, next.coord), heading) };
    }
    return null;
  }

  /** Real mode: an arrow could be drawn once a heading exists (both points have coord). */
  function arrowCouldDraw() {
    if (settings.sim || state.index < 0) return false;
    const p = route.points[state.index];
    const next = route.points[state.index + 1];
    return Boolean(p.stage === 'travel' && next && p.coord && next.coord);
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

  function simPanel() {
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
          } }),
        readout,
      );
    }
    return box;
  }

  function onCompass() {
    if (stopCompass) stopCompass();
    compassMsg = null;
    startCompass(
      (hd) => {
        const first = heading === null;
        heading = hd;
        if (first) render();
        else refreshArrow();
      },
      (reason) => {
        compassMsg = reason === 'denied'
          ? '방향 센서 사용이 허용되지 않았어요. 표지판을 따라가세요.'
          : '이 기기에서는 방향 센서를 쓸 수 없어요. 표지판을 따라가세요.';
        render();
      },
    ).then((stop) => { stopCompass = stop; });
  }

  // ------------------------------------------------------------ screen 1 input

  const listener = createListener({
    onStart: () => { listening = true; chime(settings, 'start'); render(); },
    onEnd: () => { listening = false; chime(settings, 'end'); render(); },
    onResult: (text) => { if (state.index < 0 && QUESTION_STEPS.includes(state.prepStep)) interpret(text); },
    onDenied: () => { listenMsg = '마이크 사용이 허용되지 않았어요. 직접 입력해 주세요.'; typedOpen = true; render(); },
    onUnsupported: () => { listenMsg = '이 기기에서는 말하기를 쓸 수 없어요. 직접 입력해 주세요.'; typedOpen = true; render(); },
    onError: () => { listenMsg = '음성 인식에 문제가 있어요. 다시 해 보거나 직접 입력해 주세요.'; typedOpen = true; render(); },
    onNoSpeech: () => { listenMsg = '잘 못 들었어요. 다시 눌러 말씀해 주세요.'; render(); },
  });

  function onTalk() {
    if (listening) {
      listener.stop();
      return;
    }
    listenMsg = null;
    stopSpeaking();
    listener.start();
  }

  async function interpret(text) {
    const t = String(text || '').trim();
    if (!t || state.index >= 0) return;
    const token = ++parseToken;
    utterance = t;
    reAsk = null;
    parsing = true;
    render();
    const result = await parseVisit(t, { webhookUrl: WEBHOOK_URL });
    if (token !== parseToken || state.index >= 0) return;
    parsing = false;
    badge = result.source === 'ai' ? '인공지능 해석' : '규칙 해석';
    reAsk = result.reAsk;
    typedText = '';
    typedOpen = false;
    dispatch({ type: 'SET_FIELDS', fields: result.fields }, { keepHeard: true });
    if (reAsk) say(reAsk === REASK_HOSPITAL_SPEECH ? 'reask-hospital' : 'reask', reAsk);
    else sayStep();
  }

  /** The picture box: a pictogram by point kind, or the big arrow when one can be drawn. */
  function pictureBox(p, compact = false) {
    const spec = pictoSpec(p);
    const box = h('div', { class: compact ? 'picto-box compact' : 'picto-box', id: 'arrow-box' });
    const info = arrowInfo();
    if (info) {
      const holder = h('div', { class: 'arrow-holder', id: 'arrow-holder' });
      box.classList.add('arrow-mode');
      box.append(holder);
      mountArrow(holder, info.angle);
      if (spec.label) box.append(h('p', { class: 'picto-caption' }, spec.label));
    } else {
      box.append(svgNode(pictoSvg(spec)));
    }
    return box;
  }

  function renderPoint(p) {
    const main = h('div', { class: 'stack' });
    const arrivedHere = state.arrived && state.index === route.points.length - 1;

    if (arrivedHere) {
      main.append(h('div', { class: 'picto-box done', id: 'arrow-box' }, svgNode(doneSvg())));
    } else {
      // The get-off alert panel sits right under the instruction so its button never needs scrolling.
      if (arrivalMsg && p.arrival) main.append(arrivalPanel());
      if (p.alertCoord) main.append(alightPanel(p));
      main.append(pictureBox(p, Boolean(p.alertCoord)));
      if (!arrowInfo()) main.append(h('p', { class: 'sign-note' }, p.kind === 'bus' && p.alertCoord ? BUS_NOTE : SIGN_FALLBACK));
      if (arrowCouldDraw() && heading === null) {
        main.append(h('button', { class: 'btn', id: 'btn-compass', onclick: onCompass }, '방향 센서 켜기'));
      }
      if (compassMsg && !settings.sim) main.append(h('p', { class: 'note', role: 'status' }, compassMsg));
      if (p.gap) main.append(h('p', { class: 'warn', id: 'gap-warning', role: 'note' }, '이 구간은 끊어진 곳이 있어요. 우회하거나 직원에게 물어보세요.'));
    }
    if (settings.sim && !arrivedHere) main.append(simPanel(p));

    const links = h('div', { class: 'bottom-links' }, pointDetails(p));
    const prevLabel = p.stage === 'indoor' ? '이전 지점으로 돌아가기' : (state.index === 0 ? '처음 화면으로' : '이전 지점으로');
    const row2 = h('div', { class: 'link-row' },
      h('button', { class: 'btn small ghost', id: 'btn-prev', onclick: () => {
        dispatch({ type: 'PREV' });
        sayCurrent();
      } }, prevLabel));
    if (arrivedHere) {
      row2.append(h('button', { class: 'btn small ghost', id: 'btn-restart', onclick: () => {
        dispatch({ type: 'RESTART' });
        sayCurrent();
      } }, '처음 화면으로'));
    }
    links.append(row2);
    main.append(links);
    return main;
  }

  // ------------------------------------------------------------ overlays

  function buildHelp() {
    const card = h('div', { class: 'overlay-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': '도움 요청' },
      h('p', { class: 'help-sentence' }, HELP_SENTENCE));
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

  function renderOverlays() {
    syncOverlay($('overlay-help'), state.helpOpen, buildHelp);
    syncOverlay($('overlay-companion'), state.companionOpen && Boolean(support), companionCard);
    syncOverlay($('overlay-settings'), state.settingsOpen, settingsCard);

    const open = state.helpOpen || (state.companionOpen && Boolean(support)) || state.settingsOpen;
    document.body.classList.toggle('modal-open', open);
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

  function settingsCard() {
    const update = (patch) => {
      if ('sim' in patch && patch.sim !== settings.sim) stopAlight(); // a status from the other mode is stale
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
      h('p', { class: 'muted' }, '로그인이 없어요. 설정과 마지막으로 확인한 지점만 이 기기에 저장하고, 말한 내용과 방문 정보는 저장하지 않아요.'),
      h('p', { class: 'muted' }, '내릴 곳 알림을 켜면 휴대폰 위치를 쓰지만, 위치는 저장하거나 보내지 않아요.'),
      h('p', { class: 'muted' }, '말하기 기능을 쓰면 휴대폰 브라우저가 음성을 인식하려고 소리를 인터넷으로 보낼 수 있어요.'),
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
    const p = currentPoint();
    document.documentElement.dataset.screen = screen;
    document.documentElement.classList.toggle('large', settings.largeText);

    const prog = progressOf(state, route);
    $('stage-pill').textContent = STAGE_LABEL[screen];
    $('progress').textContent = `${prog.cur} / ${prog.total}`;
    $('progress').setAttribute('aria-label', `${prog.total}단계 중 ${prog.cur}단계`);
    renderDots(prog.cur, prog.total);
    if (p) setInstruction(state.arrived ? ARRIVED_TEXT : p.display);
    else setInstruction(STEP_SCREEN_TEXT[state.prepStep] || CLIP_TEXT[STEP_CLIP[state.prepStep]]);

    syncArrival(p);
    disposeArrow3d();
    arrowCtl = null;
    arrowToken += 1;
    $('screen').replaceChildren(...[
      settings.sim ? h('div', { class: 'sim-banner', role: 'status' }, BANNER_TEXT) : null,
      p ? renderPoint(p) : renderPrepare(),
    ].filter(Boolean));
    if (!state.helpOpen && !state.companionOpen && !state.settingsOpen) $('main').scrollTop = 0;

    // The primary button keeps its place on every screen; when it has nothing to do it is only hidden.
    const primary = $('btn-primary');
    const bp = barPrimary(state, route);
    primary.textContent = bp.label;
    primary.classList.toggle('vacant', !bp.visible);
    primary.disabled = !bp.visible;
    primary.setAttribute('aria-hidden', bp.visible ? 'false' : 'true');
    renderOverlays();
  }

  // ------------------------------------------------------------ bar wiring (static buttons)
  // Assigned as properties so the handlers installed before loading are replaced.

  $('btn-replay').disabled = false;
  $('btn-settings').disabled = false;
  $('btn-replay').onclick = () => { sayCurrent(); };
  $('btn-help').onclick = () => {
    openerSel = '#btn-help';
    dispatch({ type: 'OPEN_HELP' });
    say('help-main', HELP_SPEECH);
  };
  $('btn-settings').onclick = () => {
    openerSel = '#btn-settings';
    dispatch({ type: 'OPEN_SETTINGS' });
  };
  $('btn-primary').onclick = () => {
    const { action } = barPrimary(state, route);
    if (action === 'next') {
      dispatch({ type: 'WIZARD_NEXT' });
      sayStep();
    } else if (action === 'start') {
      chime(settings);
      dispatch({ type: 'START' });
      sayCurrent();
    } else if (action === 'show') {
      openerSel = '#btn-primary';
      dispatch({ type: 'OPEN_HELP' });
      say('help-main', HELP_SPEECH);
    } else if (action === 'confirm') {
      chime(settings);
      vibrate(80);
      dispatch({ type: 'CONFIRM' });
      sayCurrent();
    }
  };
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (state.helpOpen) dispatch({ type: 'CLOSE_HELP' });
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
      h('p', { class: 'help-sentence' }, HELP_SENTENCE),
      h('button', { class: 'btn wide primary', id: 'btn-help-close', onclick: close }, '닫기')));
    overlay.hidden = false;
    document.body.classList.add('modal-open');
    setBackgroundInert(true);
    document.getElementById('btn-help-close').focus();
    speak('help-main', HELP_SPEECH, loadState([]).settings);
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
    const res = await fetch('data/support.json');
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
  $('btn-settings').disabled = true;
  $('btn-replay').disabled = true;
  setInstruction('안내 자료를 불러오는 중이에요...');
  $('screen').replaceChildren();
  let route;
  try {
    route = await loadRoute('data/route.migeum-snubh.json');
  } catch (err) {
    showLoadError(err);
    return;
  }
  const support = await loadSupport();
  boot(route, support);
}

if (typeof document !== 'undefined') start();
