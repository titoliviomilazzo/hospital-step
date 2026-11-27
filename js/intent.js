// Turns a spoken or typed sentence into the five visit fields. Rules run locally; an optional
// webhook (an AI scenario) is tried first and validated strictly against the contract. The model
// never supplies route or eligibility text. Pure logic, importable in Node.
//
// Contract reply: { hospital, visit, mobility, reception, reAsk } (the four field keys are required; the model's reAsk text is ignored). `hospital` may be "snubh" or
// the label in clips.js; it is normalised to the clips.js value so SET_FIELD accepts it. `dept` (the
// department) is optional in a reply: a known value is kept, anything else is ignored. The department is
// also read by the local rules, so the webhook contract did not have to change.
import { optionFor, ANSWER_BUTTONS } from './clips.js';

export const HOSPITAL_VALUE = '분당서울대병원';
export const HOSPITAL_REASK = '어느 병원에 가세요? 지금은 분당서울대병원 가는 길만 안내해 드릴 수 있어요.';
export const MAX_BODY_BYTES = 4096;
const EMPTY = () => ({ hospital: null, dept: null, visit: null, mobility: null, reception: null });

/** Maps a model-provided hospital string to the clips.js value, or null when unknown. */
export function normalizeHospital(v) {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\s+/g, '').toLowerCase();
  if (t === 'snubh' || t === HOSPITAL_VALUE || t === '분당서울대학교병원') return HOSPITAL_VALUE;
  return null;
}

/**
 * Display-only: writes the hospital's full name wherever the user said an abbreviation (분서대,
 * 분당서울대 without 병원/학교, snubh). Parsing always uses the raw text, never this result.
 */
export function expandAbbreviations(text) {
  return String(text ?? '')
    .replace(/분서대(?:\s*병원)?/g, HOSPITAL_VALUE)
    .replace(/snubh(?:\s*병원)?/gi, HOSPITAL_VALUE)
    .replace(/분당\s*서울대(?!\s*(?:병원|학교))/g, HOSPITAL_VALUE);
}

function rulesHospital(t) {
  return /분당\s*서울대|분서대|snubh/i.test(t) ? HOSPITAL_VALUE : null;
}

// ---- clause-based rules ------------------------------------------------------------------
// Korean negation inverts meaning ("못 해요", "적 없어요", "아니에요"), so each field is judged per
// clause. A clause that mentions a field and contains a negation the rules do not handle
// explicitly makes that field unknown (null) instead of a wrong value.

const NEG = /못|없|아니|않|(?:^|\s)안\s|(?:^|\s)안(?=써|쓰|타|해|가|와|왔|갔|걸|걷|돼|되|필요|할|하)/;
const UNKNOWN = Symbol('unknown');

/** Splits on punctuation, sentence endings and conjunction endings (고, 는데, 지만, 서, 라). */
export function splitClauses(text) {
  return String(text)
    .replace(/(고|는데|지만|(?<!혼자|스스로|직접)서|이라|니까|(?<!필|중)요|[다죠])(?=\s)/g, '$1|')
    .split(/[|,.!?;\n，。]/)
    .map((c) => c.trim())
    .filter(Boolean);
}

/** Removes explicitly handled negation text; true when an unhandled negation is left. */
function negLeft(clause, masks) {
  let rest = clause;
  for (const m of masks) rest = typeof m === 'string' ? rest.split(m).join(' ') : rest.replace(m, ' ');
  return NEG.test(rest);
}

function mergeClauses(values) {
  if (values.includes(UNKNOWN)) return null;
  const set = new Set(values.filter((v) => v !== undefined));
  return set.size === 1 ? [...set][0] : null;
}

function visitClause(c) {
  if (!/재방문|재진|다시|두\s*번째|이전|전에|다녀온|[가와]\s*(?:본|봤)|왔|갔|처음|첫|초진/.test(c)) return undefined;
  if (/적\s*(이|은)?\s*없/.test(c) && /와|왔|가|갔|다녀|방문|온|본/.test(c)) {
    return negLeft(c, [/적\s*(이|은)?\s*없\S*/g]) ? UNKNOWN : 'first';
  }
  if (/처음\s*(이|은)?\s*아니/.test(c)) return negLeft(c, [/아니\S*/g]) ? UNKNOWN : 'return';
  if (NEG.test(c)) return UNKNOWN;
  if (/재방문|재진|다시\s*(방문|가는|갑니다|가요|왔)|두\s*번째|이전에\s*(왔|갔|다녀)|전에\s*(도\s*)?(와|왔|갔|다녀)|다녀온\s*적/.test(c)) return 'return';
  if (/처음|첫\s*(방문|진료|내원|번째)|초진/.test(c)) return 'first';
  if (/[가와]\s*(?:봤|본\s*적)/.test(c)) return 'return'; // "가 봤어요", "와 본 적 있어요"
  return undefined;
}

const AID = /(휠체어|보행기|워커)((?:[\s을를은는이가도]*(?:\S{0,3}지\s*않|안\s*\S|안(?=[써쓰타사짚])|않|없|필요\s*없|필요하지\s*않))\S*)?/g;

function mobilityClause(c) {
  if (!/휠체어|보행기|워커|걸|걷|이동/.test(c)) return undefined;
  const masks = [];
  const pos = new Set();
  let negAid = false;
  for (const m of c.matchAll(AID)) {
    if (m[2]) {
      negAid = true;
      masks.push(m[2]);
    } else {
      pos.add(m[1] === '휠체어' ? 'wheelchair' : 'walker');
    }
  }
  let none = false;
  for (const re of [/걷는\s*데\s*(문제|지장)\s*없\S*/, /이동[^]*?(필요\s*없|문제\s*없)\S*/, /도움\s*없이\s*(걸|걷|이동)\S*/]) {
    const m = c.match(re);
    if (m) { none = true; masks.push(m[0]); }
  }
  if (negLeft(c, masks)) return UNKNOWN;
  if (!none && /(혼자|스스로)\s*(걸|걷|이동|갈|다닐)|걸을\s*수\s*있|이동[^]*?괜찮/.test(c)) none = true;
  return { pos, none, negAid };
}

function mergeMobility(parts) {
  if (parts.includes(UNKNOWN)) return null;
  const rs = parts.filter(Boolean);
  const pos = new Set(rs.flatMap((r) => [...r.pos]));
  const none = rs.some((r) => r.none);
  const negAid = rs.some((r) => r.negAid);
  if (pos.size > 1) return null;
  if (pos.size === 1) return none ? null : [...pos][0];
  return none || negAid ? 'none' : null;
}

function receptionClause(c) {
  if (!/접수|동행|도와줄\s*사람/.test(c)) return undefined;
  if (/접수/.test(c) && /혼자|스스로|직접/.test(c) && /못/.test(c)) {
    return negLeft(c, [/못\S*/g]) ? UNKNOWN : 'need';
  }
  if (/(접수|동행|도와줄\s*사람|도움)[^]*(필요\s*없|필요하지\s*않|안\s*필요|필요\s*않|불필요)/.test(c)) {
    return negLeft(c, [/(필요\s*없|필요하지\s*않|안\s*필요|필요\s*않|불필요)\S*/g]) ? UNKNOWN : 'no';
  }
  if (NEG.test(c)) return UNKNOWN;
  if (/접수[^]*(혼자|스스로|직접|괜찮)|(혼자|스스로|직접)\s*(서\s*)?접수/.test(c)) return 'no';
  if (/접수[^]*(도와|도움|부탁|필요|대신|해\s*줘|해\s*주)|도와줄\s*사람|동행/.test(c)) return 'need';
  return undefined;
}

// ---- department -------------------------------------------------------------------------------
// Keyword rules per department. A word that is part of a longer word does not count ("안내과" is not 내과;
// 안과 must not start inside another Hangul word). A clause that names a department and says no to it
// ("안과는 아니고", "내과 안 가요") makes the answer unknown; two different departments in one sentence
// are ambiguous, so the answer is null as well.
const DEPT_RULES = [
  ['geriatric', /노인\s*의료|노인\s*센터|노인과/],
  ['joint', /관절/],
  ['spine', /척추|허리/],
  ['eye', /(?<![가-힣])안과|(?<![가-힣])눈(?:이|을)?\s*(?:아프|아파|안\s*좋|침침|나빠|나쁘|불편|검사|수술|진료)/],
  ['internal', /(?<![가-힣])내과|종합내과/],
  ['heart', /심장/],
  ['rehab', /재활/],
  ['lung', /폐센터|흉부|(?<![가-힣])폐(?:렴|암|결핵|가|를|는|\s|$)/],
];
const DEPT_NEG = /아니|아닌|말고|않|안\s*가|안\s*갈|안\s*갑/;
// On the department question itself a bare "노인" ("노인 쪽이요") is a clear answer; elsewhere it is not
// ("노인가구" is about who lives with the user).
const DEPT_LOOSE = [['geriatric', /노인/]];

function deptClause(c, loose) {
  const found = new Set();
  for (const [value, re] of [...DEPT_RULES, ...(loose ? DEPT_LOOSE : [])]) if (re.test(c)) found.add(value);
  if (found.size === 0) return undefined;
  if (DEPT_NEG.test(c)) return UNKNOWN;
  return found.size === 1 ? [...found][0] : UNKNOWN;
}

/** Department value named in the text, or null (none, ambiguous or refused). `loose` is for the department question. */
export function rulesDept(text, loose = false) {
  return mergeClauses(splitClauses(text).map((c) => deptClause(c, loose)));
}

// ---- answers to the question on screen ------------------------------------------------------
// A short reply such as "네", "아니요" or a button's own words only means something on the screen it
// answers, so the keyword rules (which know no screen) cannot read it. These patterns apply to the
// WHOLE utterance (spaces and punctuation removed) and only for the step on screen. There is no cane
// button, so "지팡이" is deliberately not understood.
const YES = '(?:네|예|응|넵|넹|맞아요|맞습니다|그래요|그렇습니다)';
const NO = '(?:아니요|아니오|아뇨|아니에요|아니예요|아닙니다)';
const NEED_NONE = '(?:필요없어요|필요없습니다|필요없음|도움(?:이)?필요없어요|도움(?:이)?필요없습니다|도움(?:이)?필요없음|(?:도움(?:이)?)?불필요(?:해요|합니다)?)';
const whole = (body) => new RegExp(`^${body}$`);
const STEP_PATTERNS = {
  hospital: [],
  dept: [
    [whole('(?:(?:다른진료과|다른과|다른곳|딴곳)(?:이에요|예요|이요|요|입니다)?|잘모르겠어요|모르겠어요|몰라요)'), 'other'],
  ],
  visit: [
    [whole(YES), 'first'],
    [whole(NO), 'return'],
    [whole(`${NO}?(?:가봤|와봤|가본적있|와본적있|다녀왔)\\S*`), 'return'],
  ],
  mobility: [
    [whole(NO), 'none'],
    [whole(`${NO}?(?:안써요|안씁니다|안써|안짚어요|안타요|없어요|없습니다|괜찮아요|괜찮습니다|${NEED_NONE})`), 'none'],
  ],
  reception: [
    [whole(YES), 'need'],
    [whole(`${YES}?(?:필요해요|필요합니다|도움(?:이)?필요해요|도움(?:이)?필요합니다|도와주세요|도와줘요|부탁해요|부탁드려요|부탁합니다)`), 'need'],
    [whole(NO), 'no'],
    [whole(`${NO}?(?:괜찮아요|괜찮습니다|혼자할수있어요|혼자할게요|혼자서할수있어요|${NEED_NONE})`), 'no'],
  ],
};

const squash = (s) => String(s ?? '').toLowerCase().replace(/[\s.,!?;~…'"“”‘’·\-]/g, '');

/**
 * Value of the question on screen (`step`) for a short reply: a button's own words, a bare yes or no,
 * or a plain phrase for that question. Returns null when the text means nothing for that step.
 */
export function interpretForStep(step, text) {
  const t = squash(text);
  if (!t || !STEP_PATTERNS[step]) return null;
  for (const [value, ui] of Object.entries(ANSWER_BUTTONS[step] || {})) {
    if (squash(ui.label) === t) return value;
  }
  if (/지팡이/.test(t)) return null;
  for (const [re, value] of STEP_PATTERNS[step]) {
    if (re.test(t)) return value;
  }
  return null;
}

/** Fills the question on screen from `interpretForStep` when the other rules found no value for it. */
function withStepAnswer(fields, text, step) {
  if (!step || !Object.prototype.hasOwnProperty.call(fields, step) || fields[step] !== null) return fields;
  const v = interpretForStep(step, text);
  return v === null ? fields : { ...fields, [step]: v };
}

/**
 * Keyword rules. Returns the five fields plus `reAsk` (a question when the hospital is missing).
 * `step` is the question on screen (hospital, dept, visit, mobility, reception) or null.
 */
export function parseByRules(text, step = null) {
  const t = typeof text === 'string' ? text : '';
  const clauses = splitClauses(t);
  const fields = withStepAnswer({
    hospital: rulesHospital(t),
    dept: rulesDept(t, step === 'dept'),
    visit: mergeClauses(clauses.map(visitClause)),
    mobility: mergeMobility(clauses.map(mobilityClause)),
    reception: mergeClauses(clauses.map(receptionClause)),
  }, t, step);
  return { ...fields, reAsk: fields.hospital ? null : HOSPITAL_REASK };
}

// Models sometimes write JSON null as the text "null"; treat that and an empty string as null.
const asNull = (v) => (v === null || (typeof v === 'string' && /^\s*(null)?\s*$/i.test(v)) ? null : v);

/**
 * Validates a webhook reply against the contract. The four field keys must be present: hospital,
 * visit, mobility and reception are a known value or null. `reAsk` is optional and, if present,
 * must be a string or null; its text is never shown or spoken (the only question is the fixed
 * HOSPITAL_REASK when the hospital is null). Anything else is invalid (null is returned and the
 * caller uses the rules). Measured on 2026-11-19: gpt-4o-mini often omits reAsk and sometimes
 * writes "null" as text (docs/*-ai-eval.md), which used to reject otherwise correct replies.
 */
export function validateAiReply(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  for (const k of ['hospital', 'visit', 'mobility', 'reception']) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) return null;
  }
  if (obj.reAsk !== undefined && obj.reAsk !== null && typeof obj.reAsk !== 'string') return null;
  const out = EMPTY();
  // The department is optional and never makes a reply invalid: an unknown value is just ignored.
  const dept = asNull(obj.dept);
  if (typeof dept === 'string' && optionFor('dept', dept)) out.dept = dept;
  const hospital = asNull(obj.hospital);
  if (hospital !== null) {
    out.hospital = normalizeHospital(hospital);
    if (!out.hospital) return null;
  }
  for (const id of ['visit', 'mobility', 'reception']) {
    const v = asNull(obj[id]);
    if (v === null) continue;
    if (typeof v !== 'string' || !optionFor(id, v)) return null;
    out[id] = v;
  }
  return { ...out, reAsk: out.hospital ? null : HOSPITAL_REASK };
}

function withTimeout(promise, ms, onTimeout) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { onTimeout(); reject(new Error('timeout')); }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Parses an utterance. Returns {fields, reAsk, source}; `source` is 'ai' or 'rules'. Never
 * throws: an empty webhook URL, a non-200 status, a timeout, bad JSON or a non-object reply all
 * fall back to the rules.
 */
export async function parseVisit(text, { webhookUrl = '', fetch: fetchImpl = globalThis.fetch, timeoutMs = 6000, step = null } = {}) {
  // The department question is answered by the local rules only: the webhook contract has no department.
  if (step === 'dept') webhookUrl = '';
  const viaRules = () => {
    const { reAsk, ...fields } = parseByRules(text, step);
    return { fields, reAsk, source: 'rules' };
  };
  if (!webhookUrl || typeof fetchImpl !== 'function') return viaRules();
  try {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const call = (async () => {
      const res = await fetchImpl(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // `step` is an extra field: the scenario may ignore it; the step-aware reading below runs either way.
        body: JSON.stringify(step ? { text, step } : { text }),
        signal: ctl ? ctl.signal : undefined,
      });
      if (!res || res.status !== 200) throw new Error(`status ${res && res.status}`);
      const raw = await res.text();
      if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > MAX_BODY_BYTES) throw new Error('body too large');
      return JSON.parse(raw);
    })();
    const body = await withTimeout(call, timeoutMs, () => { if (ctl) ctl.abort(); });
    const checked = validateAiReply(body);
    if (!checked) return viaRules();
    const { reAsk, ...fields } = checked;
    // The reply may omit the department; the local rules fill it in (never over a value the reply gave).
    const withStep = withStepAnswer({ ...fields, dept: fields.dept ?? rulesDept(text) }, text, step);
    return { fields: withStep, reAsk: withStep.hospital ? null : reAsk, source: 'ai' };
  } catch {
    return viaRules();
  }
}
