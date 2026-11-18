// State machine and rendering. `nextState` is pure and importable in Node; the DOM boot at the
// bottom runs only in a browser. Later stages hook in at the EXTENSION POINT comments.
import { loadRoute } from './route.js';
import { FIELDS, FIXED_CLIPS, optionFor, HELP_SENTENCE, HELP_SPEECH, REASK_HOSPITAL_SPEECH } from './clips.js';
import { loadState, saveState } from './storage.js';
import { speak, speakThen, preloadManifest, chime, vibrate, stopSpeaking } from './voice.js';
import { createListener, isSupported as listenSupported } from './listen.js';
import { parseVisit } from './intent.js';
import { arrowAngle, bearingDeg, startCompass } from './compass.js';
import { renderArrow2d, setArrow2dAngle } from './arrow2d.js';
import { renderArrow3d, disposeArrow3d } from './arrow3d.js';
import { initialSim, simReducer, simArrow, renderMiniMap, BANNER_TEXT, MAP_NOTE, HEADING_MAX } from './sim.js';
import { WEBHOOK_URL } from '../config.js';

const FIELD_IDS = FIELDS.map((f) => f.id);
const STAGE_LABEL = { prepare: '1단계 방문 준비', travel: '2단계 이동 안내', indoor: '3단계 병원 안' };
const CLIP_TEXT = Object.fromEntries(FIXED_CLIPS.map((c) => [c.clipId, c.text]));
const SIGN_FALLBACK = '표지판을 따라가세요. 어려우면 직원에게 물어보세요.';

// ---------------------------------------------------------------- pure state

export function initialState(lastPointId = null) {
  return {
    index: -1, // -1 is the prepare screen, otherwise the index into route.points
    arrived: false,
    fields: { hospital: null, visit: null, mobility: null, reception: null },
    // true for a field the user set with [수정]; such a value wins over parsing. Memory only.
    manual: { hospital: false, visit: false, mobility: false, reception: false },
    lastPointId,
    helpOpen: false,
    settingsOpen: false,
    chooser: null, // field id while the chooser is open
  };
}

export function screenOf(state, route) {
  return state.index < 0 ? 'prepare' : route.points[state.index].stage;
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
      return { ...state, index: -1, arrived: false };
    case 'SET_FIELD': {
      if (!FIELD_IDS.includes(action.field)) return state;
      if (action.value !== null && !optionFor(action.field, action.value)) return state;
      return {
        ...state,
        fields: { ...state.fields, [action.field]: action.value },
        manual: { ...state.manual, [action.field]: true },
        chooser: null,
      };
    }
    case 'SET_FIELDS': {
      // Merges a parsed sentence: only valid non-null parsed values are written, and a field the
      // user set with [수정] keeps its value.
      const src = action.fields || {};
      const fields = { ...state.fields };
      for (const id of FIELD_IDS) {
        if (state.manual && state.manual[id]) continue;
        const v = src[id] ?? null;
        if (v !== null && optionFor(id, v)) fields[id] = v;
      }
      return { ...state, fields, chooser: null };
    }
    case 'OPEN_CHOOSER':
      return FIELD_IDS.includes(action.field) ? { ...state, chooser: action.field } : state;
    case 'CLOSE_CHOOSER':
      return { ...state, chooser: null };
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
  let typedOpen = !listenSupported();
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

  const say = (clipId, text) => speak(clipId, text, settings);
  preloadManifest();
  const persist = () => saveState({ settings, lastPointId: state.lastPointId });

  function dispatch(action) {
    const prev = state;
    state = nextState(state, action, route);
    if (state.lastPointId !== prev.lastPointId) persist();
    if (prev.index < 0 && state.index >= 0) leavePrepare();
    render();
  }

  /** Leaving screen 1: drop the utterance and cancel any late parse or recognition result. */
  function leavePrepare() {
    parseToken += 1;
    parsing = false;
    utterance = null;
    badge = null;
    reAsk = null;
    typedText = '';
    listenMsg = null;
    listener.stop();
  }

  function currentPoint() {
    return state.index >= 0 ? route.points[state.index] : null;
  }

  function sayCurrent() {
    const p = currentPoint();
    if (!p) return say('prep-prompt', CLIP_TEXT['prep-prompt']);
    if (state.arrived) return say('arrive-main', CLIP_TEXT['arrive-main']);
    return say(p.id, p.speech);
  }

  // ------------------------------------------------------------ screens

  function renderPrepare() {
    const main = h('div', { class: 'stack' });

    const talk = h('div', { class: 'talk' },
      h('button', { class: 'btn', id: 'btn-talk', disabled: !listenSupported() || parsing, onclick: onTalk },
        listening ? '듣는 중... 눌러서 끝내기' : '누르고 말하기'),
      h('button', { class: 'btn small ghost', id: 'btn-typed-toggle', 'aria-expanded': String(typedOpen),
        onclick: () => { typedOpen = !typedOpen; render(); } }, '말하기 대신 직접 입력하기'));
    if (listenMsg) talk.append(h('p', { class: 'muted', role: 'status' }, listenMsg));
    if (typedOpen) {
      talk.append(
        h('label', { for: 'typed-text', class: 'muted' }, '방문 내용을 적어 주세요.'),
        h('textarea', { id: 'typed-text', rows: 2, oninput: (e) => { typedText = e.target.value; } }, typedText),
        h('button', { class: 'btn', id: 'btn-typed-go', disabled: parsing,
          onclick: () => interpret(typedText) }, '이 내용으로 채우기'));
    }
    main.append(talk);
    if (parsing) main.append(h('p', { class: 'muted', role: 'status' }, '해석하는 중이에요...'));
    if (utterance) {
      main.append(
        h('div', { class: 'card', id: 'heard' },
          h('p', { class: 'muted' }, '들은 말 (이 화면을 닫으면 사라져요)'),
          h('p', { class: 'quote' }, utterance),
          badge ? h('span', { class: 'badge', id: 'parse-badge' }, badge) : null,
          reAsk ? h('p', { class: 'reask', id: 'reask', role: 'status' }, reAsk) : null),
      );
    }
    main.append(h('p', { class: 'muted' }, '아래 [수정] 버튼으로 직접 고를 수도 있어요.'));

    const fields = h('div', { class: 'card' });
    for (const f of FIELDS) {
      const opt = optionFor(f.id, state.fields[f.id]);
      fields.append(
        h('div', { class: 'field' },
          h('span', { class: 'field-label' }, f.label),
          h('span', { class: opt ? 'field-value' : 'field-value unknown' }, opt ? opt.label : '아직 몰라요'),
          h('button', { class: 'btn small', 'aria-label': `${f.label} 수정`,
            onclick: () => {
              openerSel = `[aria-label="${f.label} 수정"]`;
              dispatch({ type: 'OPEN_CHOOSER', field: f.id });
            } }, '수정')),
      );
    }
    main.append(fields);

    const ri = resumeIndex(state, route);
    if (ri !== null) {
      main.append(
        h('button', { class: 'btn wide', id: 'btn-resume', onclick: () => {
          dispatch({ type: 'RESUME' });
          speakThen(say('ui-resume', CLIP_TEXT['ui-resume']), () => sayCurrent());
        } }, `이어서 안내 받기 (${ri + 1}번째 지점)`),
      );
    }

    if (support) {
      const list = h('div', { class: 'card' }, h('h2', {}, '챙길 것'));
      support.visitChecklist.items.forEach((item, i) => {
        list.append(h('label', { class: 'check' },
          h('input', { type: 'checkbox', id: `chk-${i}` }), h('span', {}, item)));
      });
      list.append(
        h('button', { class: 'btn small', onclick: () => say('prep-checklist', CLIP_TEXT['prep-checklist']) }, '챙길 것 듣기'),
        h('details', {}, h('summary', {}, '자세히'),
          row('출처', support.visitChecklist.source)),
      );
      main.append(list);

      main.append(
        h('div', { class: 'card' },
          h('h2', {}, `${support.city} 동행 신청`),
          h('p', {}, '혼자 사시거나 사실상 혼자 지내시는 분(노인가구, 한부모가정 등)은 병원 동행을 신청할 수 있어요.'),
          h('a', { class: 'btn wide link', href: support.onlineUrl, target: '_blank', rel: 'noopener noreferrer' },
            '성남시 동행 신청 열기'),
          h('details', {}, h('summary', {}, '자세히'),
            row('사업', support.program),
            row('대상', support.target),
            row('이용 요금', support.fee),
            row('운영 시간', support.hours),
            row('문의', `${support.contact.name} ${support.contact.phone}`),
            row('출처', `${support.source.name} ${support.source.url}`),
            row('확인한 날', support.retrieved))),
      );
    }
    return main;
  }

  function pointDetails(p) {
    const d = h('details', {}, h('summary', {}, '자세히'));
    const frag = [];
    if (p.sign) d.append(row('찾을 표지판', p.sign));
    if (p.detail) {
      d.append(
        h('p', {}, p.detail),
        h('button', { class: 'btn small', onclick: () => say(`${p.id}-detail`, p.detailSpeech || p.detail) }, '설명 듣기'),
      );
    }
    d.append(row('상태', p.checkedOn ? `${p.status} (${p.checkedOn})` : p.status), row('출처', p.source));
    if (p.gap) frag.push(h('p', { class: 'warn', id: 'gap-warning', role: 'note' }, '이 구간은 끊어진 곳이 있어요. 우회하거나 직원에게 물어보세요.'));
    frag.push(d);
    return h('div', { class: 'stack' }, frag);
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
    onResult: (text) => { if (state.index < 0) interpret(text); },
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
    badge = result.source === 'ai' ? 'AI 해석' : '규칙 해석';
    reAsk = result.reAsk;
    dispatch({ type: 'SET_FIELDS', fields: result.fields });
    if (reAsk) say(reAsk === REASK_HOSPITAL_SPEECH ? 'reask-hospital' : 'reask', reAsk);
    else say('prep-confirm', CLIP_TEXT['prep-confirm']);
  }

  function renderPoint(p) {
    const main = h('div', { class: 'stack' });

    if (p.stage === 'travel') {
      const box = h('div', { class: 'arrow-box', id: 'arrow-box' });
      if (p.busNumber) {
        box.append(h('div', { class: 'bus-plate', role: 'img', 'aria-label': `버스 ${p.busNumber}번` }, p.busNumber));
      }
      const info = arrowInfo();
      if (info) {
        const holder = h('div', { class: 'arrow-holder', id: 'arrow-holder' });
        box.append(holder);
        mountArrow(holder, info.angle);
      } else {
        box.append(h('div', { class: 'sign-panel' }, SIGN_FALLBACK));
      }
      if (arrowCouldDraw() && heading === null) {
        box.append(h('button', { class: 'btn', id: 'btn-compass', onclick: onCompass }, '방향 센서 켜기'));
      }
      if (compassMsg && !settings.sim) box.append(h('p', { class: 'muted', role: 'status' }, compassMsg));
      main.append(box);
    } else {
      main.append(h('div', { class: 'arrow-box' }, h('div', { class: 'sign-panel' }, SIGN_FALLBACK)));
    }
    if (settings.sim) main.append(simPanel(p));

    if (p.id === route.points[route.points.length - 1].id) {
      const summary = h('div', { class: 'card', id: 'arrival-summary' },
        h('h2', {}, state.arrived ? '안내를 모두 마쳤어요' : '병원 안 순서'));
      const ol = h('ol', { class: 'summary' });
      route.points.filter((q) => q.stage === 'indoor').forEach((q) => ol.append(h('li', {}, q.display)));
      summary.append(ol);
      main.append(summary);
    }

    main.append(pointDetails(p));

    const prevLabel = p.stage === 'indoor' ? '이전 지점으로 돌아가기' : (state.index === 0 ? '처음 화면으로' : '이전 지점으로');
    main.append(h('button', { class: 'btn wide ghost', id: 'btn-prev', onclick: () => {
      dispatch({ type: 'PREV' });
      if (state.index >= 0) sayCurrent();
    } }, prevLabel));
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

  function buildChooser() {
    const f = FIELDS.find((x) => x.id === state.chooser);
    const card = h('div', { class: 'overlay-card small', role: 'dialog', 'aria-modal': 'true', 'aria-label': `${f.label} 고르기` },
      h('h2', {}, `${f.label} 고르기`));
    for (const o of f.options) {
      card.append(h('button', { class: 'btn wide', onclick: () => {
        dispatch({ type: 'SET_FIELD', field: f.id, value: o.value });
        speakThen(say(o.clipId, o.phrase), () => say('prep-confirm', CLIP_TEXT['prep-confirm']));
      } }, o.label));
    }
    card.append(
      h('button', { class: 'btn wide ghost', onclick: () => dispatch({ type: 'SET_FIELD', field: f.id, value: null }) }, '모르겠어요'),
      h('button', { class: 'btn wide ghost', onclick: () => dispatch({ type: 'CLOSE_CHOOSER' }) }, '닫기'),
    );
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
    syncOverlay($('overlay-chooser'), Boolean(state.chooser), buildChooser);
    syncOverlay($('overlay-settings'), state.settingsOpen, settingsCard);

    const open = state.helpOpen || Boolean(state.chooser) || state.settingsOpen;
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
      h('p', { class: 'muted' }, '말하기 기능을 쓰면 휴대폰 브라우저가 음성을 인식하려고 소리를 인터넷으로 보낼 수 있어요.'),
      h('button', { class: 'btn wide primary', onclick: () => dispatch({ type: 'CLOSE_SETTINGS' }) }, '닫기'),
    );
  }

  // ------------------------------------------------------------ frame

  function render() {
    const screen = screenOf(state, route);
    const p = currentPoint();
    document.documentElement.dataset.screen = screen;
    document.documentElement.classList.toggle('large', settings.largeText);

    $('stage-pill').textContent = STAGE_LABEL[screen];
    $('progress').textContent = p ? `${route.points.length}단계 중 ${p.order}단계` : '';
    setInstruction(p ? p.display : CLIP_TEXT['prep-prompt']);

    disposeArrow3d();
    arrowCtl = null;
    arrowToken += 1;
    $('screen').replaceChildren(...[
      settings.sim ? h('div', { class: 'sim-banner', role: 'status' }, BANNER_TEXT) : null,
      p ? renderPoint(p) : renderPrepare(),
    ].filter(Boolean));
    if (!state.helpOpen && !state.chooser && !state.settingsOpen) $('main').scrollTop = 0;

    const primary = $('btn-primary');
    if (!p) {
      primary.textContent = '길 안내 시작';
    } else if (state.arrived) {
      primary.textContent = '처음 화면으로';
    } else {
      primary.textContent = p.confirmLabel || '여기에 도착했어요';
    }
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
    const p = currentPoint();
    if (!p) {
      dispatch({ type: 'START' });
      sayCurrent();
    } else if (state.arrived) {
      dispatch({ type: 'RESTART' });
    } else {
      chime(settings);
      vibrate(80);
      dispatch({ type: 'CONFIRM' });
      sayCurrent();
    }
  };
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (state.helpOpen) dispatch({ type: 'CLOSE_HELP' });
    else if (state.chooser) dispatch({ type: 'CLOSE_CHOOSER' });
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
