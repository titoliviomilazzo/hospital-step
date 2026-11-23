// Shared clip ids and fixed phrases. Pure data and row building, no DOM.
// tools/build_voice_script.mjs re-exports this module; voice.js and the tests import it too,
// so every clip id is defined in exactly one place. It lives under app/ so a deployed app/
// folder is self-contained.

import { routeStops, earlyText } from './alight.js';
import { digitsToHangul } from './korean.js';

// Help card sentences. The spoken form is the shown sentence with digits written as Hangul numerals
// (so TTS reads 일동 일층), so what is heard is exactly what is shown. help.js picks the variant.
export const HELP_SENTENCE = '분당서울대병원 첫 방문입니다. 1동 1층 처음오신 창구 위치를 알려주세요.';
export const HELP_SPEECH = digitsToHangul(HELP_SENTENCE);
export const HELP_RETURN_SENTENCE = '분당서울대병원에 다시 왔습니다. 접수하는 곳 위치를 알려주세요.';
export const HELP_RETURN_SPEECH = digitsToHangul(HELP_RETURN_SENTENCE);
// Used while the visit answer is still unknown (and before the route data has loaded).
export const HELP_UNKNOWN_SENTENCE = '분당서울대병원에 가려고 합니다. 가는 길을 알려주세요.';
export const HELP_UNKNOWN_SPEECH = digitsToHangul(HELP_UNKNOWN_SENTENCE);
// Spoken when the hospital is missing; must equal intent.js HOSPITAL_REASK (checked by a test).
export const REASK_HOSPITAL_SPEECH = '어느 병원에 가세요? 지금은 분당서울대병원 가는 길만 안내해 드릴 수 있어요.';

// Spoken when nothing was understood (also shown, in front of the question that is asked again).
export const NOT_HEARD_SENTENCE = '잘 알아듣지 못했어요.';
// The finish screen's sentence and the arrive-main clip are the same words.
export const ARRIVED_SENTENCE = '미금역에 도착했어요. 안내를 모두 마쳤습니다. 수고 많으셨어요.';

/** The four visit fields in screen order. `value` matches the AI contract in the design. */
export const FIELDS = [
  {
    id: 'hospital', label: '병원',
    options: [
      { value: '분당서울대병원', label: '분당서울대병원', clipId: 'field-hospital-snubh',
        phrase: '분당서울대병원에 가시는군요.' },
    ],
  },
  {
    id: 'visit', label: '방문',
    options: [
      { value: 'first', label: '처음 방문', clipId: 'field-visit-first', phrase: '처음 가시는군요.' },
      { value: 'return', label: '가 본 적 있음', clipId: 'field-visit-return', phrase: '전에도 가 보셨군요.' },
    ],
  },
  {
    id: 'mobility', label: '이동',
    options: [
      { value: 'walker', label: '보행기', clipId: 'field-mobility-walker',
        phrase: '보행기를 쓰시는군요.' },
      { value: 'wheelchair', label: '휠체어', clipId: 'field-mobility-wheelchair',
        phrase: '휠체어를 타시는군요.' },
      { value: 'none', label: '도움 필요 없음', clipId: 'field-mobility-none',
        phrase: '걸어 다니시는 데 도움은 필요 없으시군요.' },
    ],
  },
  {
    id: 'reception', label: '병원 안',
    options: [
      { value: 'need', label: '접수 도움 필요', clipId: 'field-reception-need',
        phrase: '접수할 때 도움이 필요하시군요.' },
      { value: 'no', label: '접수 도움 불필요', clipId: 'field-reception-no',
        phrase: '접수는 혼자 하실 수 있으시군요.' },
    ],
  },
];

/** Fixed screen and UI prompts. Only prompts that the app actually plays are listed. */
export const FIXED_CLIPS = [
  { clipId: 'prep-prompt', text: '화면에 적힌 내용이 맞는지 보시고, 맞으면 길 안내 시작을 눌러 주세요.' },
  { clipId: 'prep-checklist', text: '집을 나서기 전에 신분증과 진료의뢰서를 꼭 챙기세요.' },
  { clipId: 'prep-confirm', text: '이 내용이 맞으세요?' },
  { clipId: 'help-main', text: HELP_SPEECH },
  { clipId: 'help-return', text: HELP_RETURN_SPEECH },
  { clipId: 'help-unknown', text: HELP_UNKNOWN_SPEECH },
  { clipId: 'reask-hospital', text: REASK_HOSPITAL_SPEECH },
  { clipId: 'reask-not-heard', text: NOT_HEARD_SENTENCE },
  // Same words as the finish screen shows (app.js ARRIVED_TEXT).
  { clipId: 'arrive-main', text: ARRIVED_SENTENCE },
  { clipId: 'ui-resume', text: '지난번에 멈춘 곳부터 이어서 안내해 드릴게요.' },
  // Large-screen easy mode: one clip per question screen and per action screen.
  { clipId: 'q-hospital', text: '어느 병원에 가세요?' },
  { clipId: 'q-visit', text: '처음 가세요?' },
  { clipId: 'q-mobility', text: '보행기나 휠체어를 쓰세요?' },
  { clipId: 'q-reception', text: '접수할 때 도움이 필요하세요?' },
  { clipId: 'confirm-all', text: '이렇게 가시는 게 맞으면, 길 안내 시작을 눌러 주세요.' },
  { clipId: 'checklist-screen', text: '신분증과 진료의뢰서를 챙기셨으면, 챙겼어요를 눌러 주세요.' },
  { clipId: 'arrive-show', text: '직원에게 이 화면을 보여 주세요.' },
  // Get-off alert on the bus screen (location is used only while the alert is on).
  { clipId: 'alert-intro', text: '위치 확인을 허락하시면, 내리실 정류장에 가까워질 때 알려 드릴게요.' },
  { clipId: 'alert-early', text: '여기는 서울대학교병원 정류장이에요. 아직 내리지 마세요. 다음 정류장에서 내리세요.' },
  { clipId: 'alert-near', text: '다음 정류장, 서울대병원에서 내려요. 하차 벨을 눌러 주세요.' },
  { clipId: 'alert-now', text: '이번 정류장에서 내리세요. 서두르지 마시고 천천히 내리세요.' },
  { clipId: 'alert-off', text: '위치 확인이 꺼져 있어요. 버스 안내 방송을 잘 들어 주세요.' },
];

// The spoken "now" alert names no stop, so the outbound and the return leg share one clip.
const ALERT_NOW_SPEECH = '이번 정류장에서 내리세요. 서두르지 마시고 천천히 내리세요.';

/**
 * Plain stop name for a spoken sentence: the part before the first ".". Official names such as
 * "청솔마을.주공9단지.동아아파트" list landmarks after dots, which is too long to say aloud.
 */
export function shortStopName(name) {
  return String(name).split('.')[0].trim();
}

/**
 * The early / near / now alert sentences of the bus point being ridden, built from its busRoute:
 * early names the stop before the alight stop, near names the alight stop. Returns
 * {early, near, now} of {clipId, text}, or null when the point has no usable busRoute. The outbound
 * leg keeps its recorded clip ids (alert-early, alert-near); the return leg has its own
 * alert-return-* ids because its sentences name other stops.
 */
export function alertSentences(point) {
  if (!point || !point.busRoute) return null;
  const { alight, prev } = routeStops(point.busRoute);
  if (!alight || !prev) return null;
  const prefix = point.stage === 'return' ? 'alert-return' : 'alert';
  return {
    early: { clipId: `${prefix}-early`, text: earlyText(shortStopName(prev.name)) },
    near: { clipId: `${prefix}-near`, text: `다음 정류장, ${shortStopName(alight.name)}에서 내려요. 하차 벨을 눌러 주세요.` },
    now: { clipId: 'alert-now', text: ALERT_NOW_SPEECH },
  };
}

/** Wording and leading symbol of each answer button on the question screens, by field and value. */
export const ANSWER_BUTTONS = {
  hospital: { '분당서울대병원': { sym: '→', label: '분당서울대병원' } },
  visit: {
    first: { sym: '○', label: '네, 처음이에요' },
    return: { sym: '×', label: '아니요, 가 봤어요' },
  },
  mobility: {
    walker: { sym: '→', label: '보행기' },
    wheelchair: { sym: '→', label: '휠체어' },
    none: { sym: '×', label: '안 써요' },
  },
  reception: {
    need: { sym: '○', label: '네, 필요해요' },
    no: { sym: '×', label: '아니요' },
  },
};

/** Question screens in order; each field has one question clip (clipId `q-<field>`). */
export const QUESTION_STEPS = FIELDS.map((f) => f.id);

export function optionFor(fieldId, value) {
  const field = FIELDS.find((f) => f.id === fieldId);
  return field ? field.options.find((o) => o.value === value) || null : null;
}

/** Builds the `{clipId, text}` rows recorded by tools/generate_voice.py. Throws on duplicate ids. */
export function buildVoiceRows(route) {
  const rows = [];
  for (const p of route.points) {
    rows.push({ clipId: p.id, text: p.speech });
    if (typeof p.detail === 'string' && p.detail.trim() !== '') {
      rows.push({ clipId: `${p.id}-detail`, text: p.detailSpeech || p.detail });
    }
  }
  for (const c of FIXED_CLIPS) rows.push({ ...c });
  // Return-leg alert clips: the outbound ones are fixed above, so only add ids that are not there yet.
  for (const p of route.points) {
    const sent = alertSentences(p);
    if (!sent) continue;
    for (const k of ['early', 'near']) {
      if (!FIXED_CLIPS.some((c) => c.clipId === sent[k].clipId)) rows.push({ ...sent[k] });
    }
  }
  for (const f of FIELDS) {
    for (const o of f.options) rows.push({ clipId: o.clipId, text: o.phrase });
  }
  const seen = new Set();
  for (const r of rows) {
    if (seen.has(r.clipId)) throw new Error(`duplicate clip id: ${r.clipId}`);
    seen.add(r.clipId);
  }
  return rows;
}

/** CSV with every cell quoted and the header `clipId,text`. */
export function rowsToCsv(rows) {
  const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const lines = ['clipId,text', ...rows.map((r) => `${q(r.clipId)},${q(r.text)}`)];
  return `${lines.join('\n')}\n`;
}
