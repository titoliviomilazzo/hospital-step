// Turns a spoken or typed sentence into the four visit fields. Rules run locally; an optional
// webhook (an AI scenario) is tried first and validated strictly against the contract. The model
// never supplies route or eligibility text. Pure logic, importable in Node.
//
// Contract reply: { hospital, visit, mobility, reception, reAsk } (all five keys required; the model's reAsk text is ignored). `hospital` may be "snubh" or
// the label in clips.js; it is normalised to the clips.js value so SET_FIELD accepts it.
import { optionFor } from './clips.js';

export const HOSPITAL_VALUE = '분당서울대병원';
export const HOSPITAL_REASK = '어느 병원에 가세요? 지금은 분당서울대병원 가는 길만 안내해 드릴 수 있어요.';
export const MAX_BODY_BYTES = 4096;
const EMPTY = () => ({ hospital: null, visit: null, mobility: null, reception: null });

/** Maps a model-provided hospital string to the clips.js value, or null when unknown. */
export function normalizeHospital(v) {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\s+/g, '').toLowerCase();
  if (t === 'snubh' || t === HOSPITAL_VALUE || t === '분당서울대학교병원') return HOSPITAL_VALUE;
  return null;
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
  if (!/재방문|재진|다시|두\s*번째|이전|전에|다녀온|와\s*본|왔|갔|처음|첫|초진/.test(c)) return undefined;
  if (/적\s*(이|은)?\s*없/.test(c) && /와|왔|가|갔|다녀|방문|온|본/.test(c)) {
    return negLeft(c, [/적\s*(이|은)?\s*없\S*/g]) ? UNKNOWN : 'first';
  }
  if (/처음\s*(이|은)?\s*아니/.test(c)) return negLeft(c, [/아니\S*/g]) ? UNKNOWN : 'return';
  if (NEG.test(c)) return UNKNOWN;
  if (/재방문|재진|다시\s*(방문|가는|갑니다|가요|왔)|두\s*번째|이전에\s*(왔|갔|다녀)|전에\s*(도\s*)?(와|왔|갔|다녀)|다녀온\s*적/.test(c)) return 'return';
  if (/처음|첫\s*(방문|진료|내원|번째)|초진/.test(c)) return 'first';
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
  if (/(접수|동행|도와줄\s*사람|도움)[^]*(필요\s*없|필요하지\s*않|안\s*필요|필요\s*않)/.test(c)) {
    return negLeft(c, [/(필요\s*없|필요하지\s*않|안\s*필요|필요\s*않)\S*/g]) ? UNKNOWN : 'no';
  }
  if (NEG.test(c)) return UNKNOWN;
  if (/접수[^]*(혼자|스스로|직접|괜찮)|(혼자|스스로|직접)\s*(서\s*)?접수/.test(c)) return 'no';
  if (/접수[^]*(도와|도움|부탁|필요|대신|해\s*줘|해\s*주)|도와줄\s*사람|동행/.test(c)) return 'need';
  return undefined;
}

/** Keyword rules. Returns the four fields plus `reAsk` (a question when the hospital is missing). */
export function parseByRules(text) {
  const t = typeof text === 'string' ? text : '';
  const clauses = splitClauses(t);
  const fields = {
    hospital: rulesHospital(t),
    visit: mergeClauses(clauses.map(visitClause)),
    mobility: mergeMobility(clauses.map(mobilityClause)),
    reception: mergeClauses(clauses.map(receptionClause)),
  };
  return { ...fields, reAsk: fields.hospital ? null : HOSPITAL_REASK };
}

/**
 * Validates a webhook reply against the contract. All five keys must be present: hospital, visit,
 * mobility and reception are a known value or null, reAsk is a string or null. Anything else is
 * invalid (null is returned and the caller uses the rules). The model's free text in `reAsk` is
 * never shown or spoken; the only question is the fixed HOSPITAL_REASK when the hospital is null.
 */
export function validateAiReply(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  for (const k of ['hospital', 'visit', 'mobility', 'reception', 'reAsk']) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) return null;
  }
  if (obj.reAsk !== null && typeof obj.reAsk !== 'string') return null;
  const out = EMPTY();
  if (obj.hospital !== null) {
    out.hospital = normalizeHospital(obj.hospital);
    if (!out.hospital) return null;
  }
  for (const id of ['visit', 'mobility', 'reception']) {
    const v = obj[id];
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
export async function parseVisit(text, { webhookUrl = '', fetch: fetchImpl = globalThis.fetch, timeoutMs = 6000 } = {}) {
  const viaRules = () => {
    const { reAsk, ...fields } = parseByRules(text);
    return { fields, reAsk, source: 'rules' };
  };
  if (!webhookUrl || typeof fetchImpl !== 'function') return viaRules();
  try {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const call = (async () => {
      const res = await fetchImpl(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
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
    return { fields, reAsk, source: 'ai' };
  } catch {
    return viaRules();
  }
}
