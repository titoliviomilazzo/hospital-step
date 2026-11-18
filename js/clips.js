// Shared clip ids and fixed phrases. Pure data and row building, no DOM.
// tools/build_voice_script.mjs re-exports this module; voice.js and the tests import it too,
// so every clip id is defined in exactly one place. It lives under app/ so a deployed app/
// folder is self-contained.

export const HELP_SENTENCE = '분당서울대병원 첫 방문입니다. 1동 1층 처음오신 창구 위치를 알려주세요.';
// Spoken form of HELP_SENTENCE: first person, numbers in Hangul so TTS reads them as 일동 일층.
export const HELP_SPEECH = '저는 분당서울대병원에 처음 왔습니다. 일동 일층 처음 오신 창구가 어디인지 알려 주세요.';
// Spoken when the hospital is missing; must equal intent.js HOSPITAL_REASK (checked by a test).
export const REASK_HOSPITAL_SPEECH = '어느 병원에 가세요? 지금은 분당서울대병원 가는 길만 안내해 드릴 수 있어요.';

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
      { value: 'return', label: '재방문', clipId: 'field-visit-return', phrase: '전에도 가 보셨군요.' },
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
    id: 'reception', label: '원내',
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
  { clipId: 'reask-hospital', text: REASK_HOSPITAL_SPEECH },
  { clipId: 'arrive-main', text: '안내를 모두 마쳤습니다. 수고 많으셨어요.' },
  { clipId: 'ui-resume', text: '지난번에 멈춘 곳부터 이어서 안내해 드릴게요.' },
  // Large-screen easy mode: one clip per question screen and per action screen.
  { clipId: 'q-hospital', text: '어느 병원에 가세요?' },
  { clipId: 'q-visit', text: '처음 가세요?' },
  { clipId: 'q-mobility', text: '보행기나 휠체어를 쓰세요?' },
  { clipId: 'q-reception', text: '접수할 때 도움이 필요하세요?' },
  { clipId: 'confirm-all', text: '이렇게 가시는 게 맞으면, 길 안내 시작을 눌러 주세요.' },
  { clipId: 'checklist-screen', text: '신분증과 진료의뢰서를 챙기셨으면, 챙겼어요를 눌러 주세요.' },
  { clipId: 'arrive-show', text: '직원에게 이 화면을 보여 주세요.' },
];

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
