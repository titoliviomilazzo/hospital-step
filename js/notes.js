// Visit notes: pure functions (no DOM, no network). See docs/PLAN-visit-notes.md sections 3-2..3-4, 5.
//
// The model is never trusted. validateNotesReply() re-checks every item against the transcript:
// the quoted `source` must occur in the text, every number in the item must be backed by that
// source, and a date is accepted only when the source says it. Importable in Node.
import { withObject } from './korean.js';

export const KINDS = Object.freeze(['todo', 'caution', 'med', 'next', 'test']);
export const CARD_ORDER = Object.freeze(['next', 'med', 'test', 'todo', 'caution']);
export const CARD_TITLES = Object.freeze({
  next: '다음에 오는 날',
  med: '약 드시는 법',
  test: '받을 검사',
  todo: '하실 일',
  caution: '조심하실 것',
});
export const DISCLAIMER = '의사·간호사 말씀이 우선입니다. 헷갈리면 다시 물어보세요.';
export const MAX_ITEMS = 12;
export const MAX_TEXT = 140; // characters of an item's `text`
export const MIN_SOURCE = 8; // characters (without spaces): a shorter quote proves nothing
export const MAX_SOURCE = 120; // a longer quote is a sign the model copied the whole talk
export const MASK = '○○○○';

// ---------------------------------------------------------------------------------------------
// scrub: runs on the transcript before anything leaves the phone (design 3-4)
// ---------------------------------------------------------------------------------------------

// Words that end in 님/씨 but are titles or kin terms, not a patient name.
const NOT_A_NAME = /선생|의사|간호사|약사|교수|원장|과장|보호자|어머|아버|할머|할아|부모|아드|따님|손님|고객|사모|어르|환자$/;
const DATE_LIKE = /^(?:19|20)\d{2}[-.]\d{1,2}(?:[-.]\d{1,2})?$/;
const SURNAMES = '김이박최정강조윤장임한오서신권황안송류전홍고문양손배백허유남심노하곽성차주우구민나진지엄채원천방공현함변염여추도소석선설마길연위표명기반왕금옥육인맹제모탁국어은편용예경봉사부';
const NOT_A_NAME_WORD = /^(?:어떻|어찌|무엇|말씀|뭐|뭔가|좀)/;
const DATE_Y = '(?:19|20)?\\d{2}\\s*[년.\\-/]\\s*\\d{1,2}\\s*[월.\\-/]\\s*\\d{1,2}\\s*일?';

/**
 * Masks what could identify the patient: a name before 님/씨/환자분, birth-date shapes, phone and
 * registration numbers (any digit run of 6+ digits, hyphens allowed). Dose numbers ("5 밀리그램")
 * and visit dates ("12월 7일", "2026-12-07") stay.
 */
export function scrub(text) {
  let s = String(text ?? '');
  s = s.replace(/([가-힣]{2,4})(\s*)(님|씨|환자분)/g, (m, name, sp, suf) =>
    (NOT_A_NAME.test(name) ? m : `${'○'.repeat(name.length)}${sp}${suf}`));
  // a name before a kin title ("김영희 어르신"): only a three-letter name that starts with a family name
  s = s.replace(/(?<![가-힣])([가-힣]{3})([ ]?)(어르신|할머니|할아버지)/g, (m, name, sp, suf) =>
    (SURNAMES.includes(name[0]) ? `${'○'.repeat(name.length)}${sp}${suf}` : m));
  // "성함은 홍길동입니다": the word after 성함 (not a question word)
  s = s.replace(/(성함(?:은|이|\s*:)?\s*)([가-힣]{2,4}?)(?=이에요|입니다|이라고|예요|이요|이고|이야|이세요|이십니다|[^가-힣]|$)/g, (m, lead, name) =>
    (NOT_A_NAME_WORD.test(name) ? m : `${lead}${'○'.repeat(name.length)}`));
  // birth dates: "1950년 3월 2일생", "50.03.02 생", "생년월일은 1950-03-02"
  s = s.replace(new RegExp(`(${DATE_Y})(?=\\s*생)`, 'g'), MASK);
  s = s.replace(new RegExp(`(생년월일|생일)(\\s*(?:은|는|이|가|:)?\\s*)${DATE_Y}`, 'g'), `$1$2${MASK}`);
  // birth year and age: "50년생", "75세"
  s = s.replace(/(?<![\d.])\d{2,4}\s*년생/g, `${MASK}생`);
  s = s.replace(/(?<![\d.])\d{1,3}\s*세(?!\s*번)/g, `${MASK}세`);
  // a number said after a number word: any digit run behind 번호/전화 is masked whatever its separators
  s = s.replace(/(등록번호|환자번호|전화번호|전화|번호)(\s*(?:은|는|이|가|:)?\s*)(\d[\d.\s-]*\d)/g, (m, kw, mid, num) =>
    (num.replace(/\D/g, '').length >= 6 ? `${kw}${mid}${MASK}` : m));
  // phone numbers with spaces or hyphens
  s = s.replace(/(?<!\d)0\d{1,2}[-\s]\d{3,4}[-\s]\d{4}(?!\d)/g, MASK);
  // two groups of four ("1234 5678")
  s = s.replace(/(?<![\d.])\d{4}\s\d{4}(?![\d.])/g, MASK);
  // any other run of 6 or more digits, joined by hyphens or dots (resident / registration numbers, "010.1234.5678")
  s = s.replace(/\d(?:[\d.-]*\d)?/g, (m) => (m.replace(/\D/g, '').length >= 6 && !DATE_LIKE.test(m) ? MASK : m));
  return s;
}

// ---------------------------------------------------------------------------------------------
// Korean numerals: spoken "한 번" and written "1번" must compare equal
// ---------------------------------------------------------------------------------------------

const TENS = { 열: 10, 스물: 20, 스무: 20, 서른: 30, 마흔: 40, 쉰: 50, 예순: 60, 일흔: 70, 여든: 80, 아흔: 90 };
const UNITS = { 하나: 1, 한: 1, 둘: 2, 두: 2, 셋: 3, 세: 3, 석: 3, 넷: 4, 네: 4, 넉: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9 };
const SINO_DIGIT = { 일: 1, 이: 2, 삼: 3, 사: 4, 오: 5, 육: 6, 칠: 7, 팔: 8, 구: 9 };
const SINO_POWER = { 십: 10, 백: 100, 천: 1000 };
const AMBIGUOUS = {
  한두: [1, 2], 두어: [2], 두세: [2, 3], 서너: [3, 4], 서넛: [3, 4], 네다섯: [4, 5], 대여섯: [5, 6],
};
const DAY_WORDS = { 이틀: 2, 사흘: 3, 나흘: 4, 닷새: 5, 엿새: 6, 이레: 7, 열흘: 10, 보름: 15 };
const WORDS = { ...AMBIGUOUS, ...Object.fromEntries(Object.entries(DAY_WORDS).map(([k, v]) => [k, [v]])) };
const nfkc = (v) => String(v ?? '').normalize('NFKC');
// A numeral word only counts when a counter follows ("한 번", "삼 개월"). That keeps "네" (yes),
// "이" (this / particle) and "일" (work) from turning into numbers.
const NATIVE_COUNTER = '번|회|개월|개|알|정|포|캡슐|병|잔|숟가락|숟갈|스푼|방울|장|분|명|가지|차례|달|주일|주|일|시간|시|밀리그램|그램|씩';
const SINO_COUNTER = '개월|주일|주|일|월|년|시간|시|분|회|밀리그램|그램|mg|ml';
const byLength = (o) => Object.keys(o).sort((a, b) => b.length - a.length).join('|');
const NATIVE_RE = new RegExp(
  `(?<![가-힣\\d])(?:(${byLength(TENS)})(?:\\s*(${byLength(UNITS)}))?|(${byLength(UNITS)}))\\s*(?=${NATIVE_COUNTER})`, 'g');
const SINO_RE = new RegExp(
  `(?<![가-힣\\d])((?:[일이삼사오육칠팔구]?[천백십])+[일이삼사오육칠팔구]?|[일이삼사오육칠팔구])\\s*(?=${SINO_COUNTER})`, 'g');
const WORD_RE = new RegExp(Object.keys(WORDS).join('|'), 'g');
const AMBIG_RE = new RegExp(Object.keys(AMBIGUOUS).join('|'));

function sinoValue(s) {
  let total = 0;
  let cur = 0;
  for (const ch of s) {
    if (SINO_DIGIT[ch]) cur = SINO_DIGIT[ch];
    else if (SINO_POWER[ch]) { total += (cur || 1) * SINO_POWER[ch]; cur = 0; }
  }
  return total + cur;
}

/** A bare Korean numeral word ("세", "열", "이십삼") as a number, or null. */
export function wordNumber(w) {
  const s = String(w ?? '').trim();
  if (!s) return null;
  if (/^[일이삼사오육칠팔구십백천]+$/.test(s)) return sinoValue(s);
  const m = s.match(new RegExp(`^(?:(${byLength(TENS)})(${byLength(UNITS)})?|(${byLength(UNITS)}))$`));
  if (!m) return null;
  return m[3] ? UNITS[m[3]] : TENS[m[1]] + (m[2] ? UNITS[m[2]] : 0);
}

/**
 * Every number a text states, digits and Korean words alike, as plain numbers ("한 번" and "1번"
 * both give 1; "삼 개월" and "3개월" both give 3). Values only, units are not compared.
 */
export function numbersIn(input, { ambiguous = true } = {}) {
  const s = nfkc(input).replace(/(\d),(?=\d{3}(?!\d))/g, '$1');
  const out = [];
  for (const m of s.matchAll(/\d+(?:\.\d+)?/g)) out.push(Number(m[0]));
  for (const m of s.matchAll(NATIVE_RE)) {
    out.push(m[3] ? UNITS[m[3]] : TENS[m[1]] + (m[2] ? UNITS[m[2]] : 0));
  }
  for (const m of s.matchAll(SINO_RE)) out.push(sinoValue(m[1]));
  for (const m of s.matchAll(WORD_RE)) {
    if (!ambiguous && AMBIG_RE.test(m[0])) continue; // "두세 번" is not a number the speaker fixed
    out.push(...WORDS[m[0]]);
  }
  if (/(?<![가-힣])반\s*(?=알|개|정|포|캡슐|잔|병|숟가락|숟갈)/.test(s)) out.push(0.5);
  if (/시\s*반/.test(s)) out.push(30); // "세 시 반": half past
  return out;
}

/** True when the text has a vague count ("한두 번", "두세 알") that no single number may be taken from. */
export function hasAmbiguousCount(input) {
  return AMBIG_RE.test(nfkc(input));
}

// A number together with its unit, so "3주" and "3개월" differ: ["3|개월", ...]. 주일 is 주, 달 is
// 개월, 회 is 번, 밀리그램 is mg. Vague counts ("두세") give nothing.
const Q_BASE = '개월|밀리그램|주일|mg|일|주|달|년|번|회|알|정|포|분';
const Q_HOUR = '시(?!간)(?![면고는죠겠며니어기작])'; // "시간", "오시면", "네 시작" are not an hour
const Q_UNIT = `${Q_BASE}|${Q_HOUR}`;
const Q_NATIVE = new RegExp(
  String.raw`(?<![가-힣\d])(?:(${byLength(TENS)})(?:\s*(${byLength(UNITS)}))?|(${byLength(UNITS)}))\s*(${Q_UNIT})`, 'g');
const Q_SINO = new RegExp(String.raw`(?<![가-힣\d])((?:[일이삼사오육칠팔구]?[천백십])+[일이삼사오육칠팔구]?|[일이삼사오육칠팔구])\s*(${Q_BASE})`, 'g');
const Q_DIGIT = new RegExp(String.raw`(\d+(?:\.\d+)?)\s*(${Q_UNIT})`, 'g');
const UNIT_CANON = { 주일: '주', 달: '개월', 회: '번', 밀리그램: 'mg' };
const canonUnit = (u) => UNIT_CANON[u] || u;

export function quantitiesIn(input) {
  const s = nfkc(input).replace(/(\d),(?=\d{3}(?!\d))/g, '$1');
  const out = new Set();
  for (const m of s.matchAll(Q_DIGIT)) out.add(`${Number(m[1])}|${canonUnit(m[2])}`);
  for (const m of s.matchAll(Q_NATIVE)) {
    const v = m[3] ? UNITS[m[3]] : TENS[m[1]] + (m[2] ? UNITS[m[2]] : 0);
    out.add(`${v}|${canonUnit(m[4])}`);
  }
  for (const m of s.matchAll(Q_SINO)) out.add(`${sinoValue(m[1])}|${canonUnit(m[2])}`);
  for (const [w, v] of Object.entries(DAY_WORDS)) if (s.includes(w)) out.add(`${v}|일`);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Dates and times said in a source sentence
// ---------------------------------------------------------------------------------------------

const pad2 = (n) => String(n).padStart(2, '0');

function realDate(y, m, d) {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** Parses 'YYYY-MM-DD' to {y, m, d} or null (checks the calendar). */
export function parseIsoDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? ''));
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return realDate(y, mo, d) ? { y, m: mo, d } : null;
}

export const MAX_INFER_DAYS = 300; // a spoken day without a year further away than this is not guessed

/** Whole days from 'YYYY-MM-DD' `a` to date parts `b` {y, m, d}; null when `a` is not a date. */
function daysFromToday(today, y, m, d) {
  const t = parseIsoDate(today);
  if (!t) return null;
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(t.y, t.m - 1, t.d)) / 86400000);
}

/** The year a month/day refers to when the speaker gave none: the next such day on or after `today`. */
export function inferYear(m, d, today) {
  const t = parseIsoDate(today);
  if (!t) return null;
  return m < t.m || (m === t.m && d < t.d) ? t.y + 1 : t.y;
}

/** Dates literally present in a text: [{y|null, m, d, literal}]. Digits or Sino-Korean numerals. */
export function datesIn(text) {
  const s = String(text ?? '');
  const out = [];
  for (const m of s.matchAll(/(\d{4})\s*[-./]\s*(\d{1,2})\s*[-./]\s*(\d{1,2})(?!\d)/g)) {
    out.push({ y: Number(m[1]), m: Number(m[2]), d: Number(m[3]), literal: m[0] });
  }
  for (const m of s.matchAll(/(?:(\d{4})\s*년\s*)?(\d{1,2})\s*월\s*(\d{1,2})\s*일/g)) {
    out.push({ y: m[1] ? Number(m[1]) : null, m: Number(m[2]), d: Number(m[3]), literal: m[0] });
  }
  for (const m of s.matchAll(/(?<![가-힣])([일이삼사오육칠팔구십]{1,3})\s*월\s*([일이삼사오육칠팔구십]{1,4})\s*일/g)) {
    out.push({ y: null, m: sinoValue(m[1]), d: sinoValue(m[2]), literal: m[0] });
  }
  return out.filter((x) => x.m >= 1 && x.m <= 12 && x.d >= 1 && x.d <= 31);
}

const MERIDIEM = '오전|오후|아침|저녁|낮|밤|새벽';
// Hours said in words count only as native numerals ("두 시"); "일시적", "오시면", "네 시작" are not times.
const HOUR_WORDS = '열두|열한|다섯|여섯|일곱|여덟|아홉|열|한|두|세|네';
const TIME_RE = new RegExp(
  String.raw`(?:(${MERIDIEM})\s*)?(?<![가-힣\d])(\d{1,2}|${HOUR_WORDS})\s*시(?!간)(?![면고는죠겠며니어기작])(?:\s*(\d{1,2}|[가-힣]{1,3})\s*분|\s*(반))?`, 'g');

function hoursFor(h, mer) {
  if (h < 0 || h > 24) return [];
  if (mer === '밤' && h === 12) return [0];
  if (mer === '오후' || mer === '저녁' || mer === '밤') return h < 12 ? [h + 12] : [h];
  if (mer === '오전' || mer === '아침' || mer === '새벽') return [h === 12 ? 0 : h];
  if (mer === '낮') return h >= 1 && h <= 6 ? [h + 12] : [h];
  if (h >= 13) return [h]; // already 24-hour
  return h >= 1 ? [h, h + 12] : [h];
}

/** Times literally present in a text: [{hours: [24h candidates], minute, ampm: bool, literal}]. */
export function timesIn(text) {
  const s = String(text ?? '');
  const out = [];
  for (const m of s.matchAll(TIME_RE)) {
    const h = /^\d+$/.test(m[2]) ? Number(m[2]) : wordNumber(m[2]);
    if (h === null) continue;
    let minute = 0;
    if (m[4]) minute = 30;
    else if (m[3] !== undefined) {
      const mm = /^\d+$/.test(m[3]) ? Number(m[3]) : wordNumber(m[3]);
      if (mm === null || mm > 59) continue;
      minute = mm;
    }
    const hours = hoursFor(h, m[1]);
    if (hours.length) out.push({ hours, minute, ampm: Boolean(m[1]) || h >= 13, literal: m[0].trim() });
  }
  const clock = new RegExp(String.raw`(?:(${MERIDIEM})\s*)?(?<![\d:])(\d{1,2}):(\d{2})(?!\d)`, 'g');
  for (const m of s.matchAll(clock)) {
    const h = Number(m[2]);
    const mm = Number(m[3]);
    if (h > 24 || mm > 59) continue;
    // "14:00" or "09:30" is 24-hour style; "2:30" without a word for am/pm stays ambiguous
    const h24 = !m[1] && (h >= 13 || h === 0 || (m[2].length === 2 && m[2][0] === '0'));
    const hours = h24 ? [h] : hoursFor(h, m[1]);
    if (hours.length) out.push({ hours, minute: mm, ampm: Boolean(m[1]) || h24, literal: m[0].trim() });
  }
  return out;
}

/**
 * Deterministic date/time from what a sentence literally says (never from a model). Returns
 * {date: 'YYYY-MM-DD'|null, time: 'HH:MM'|null, dateLiteral, timeLiteral} or null when no date
 * and no time is spoken. A date without a year needs `today` ('YYYY-MM-DD') to pick the next
 * occurrence; without it the date stays null. A time without am/pm stays null (ambiguous).
 */
export function resolveNextWhen(text, { today = null } = {}) {
  const dt = datesIn(text)[0] || null;
  const tm = timesIn(text)[0] || null;
  if (!dt && !tm) return null;
  let date = null;
  if (dt) {
    const y = dt.y ?? inferYear(dt.m, dt.d, today);
    if (y && realDate(y, dt.m, dt.d)) {
      const far = dt.y === null && daysFromToday(today, y, dt.m, dt.d) > MAX_INFER_DAYS; // "11월 20일" said in late November
      if (!far) date = `${y}-${pad2(dt.m)}-${pad2(dt.d)}`;
    }
  }
  const time = tm && tm.ampm && tm.hours.length === 1 ? `${pad2(tm.hours[0])}:${pad2(tm.minute)}` : null;
  return { date, time, dateLiteral: dt ? dt.literal : null, timeLiteral: tm ? tm.literal : null };
}

// ---------------------------------------------------------------------------------------------
// validateNotesReply (design 3-3)
// ---------------------------------------------------------------------------------------------

const EDGE_PUNCT = /^[\s.,!?…"'“”‘’。、]+|[\s.,!?…"'“”‘’。、]+$/g;
const squash = (s) => String(s ?? '').replace(/\s+/g, '');

/**
 * Finds `source` in `transcript` ignoring whitespace (and punctuation at its edges). Returns the
 * transcript's own text for that stretch (with its original spacing), or null when absent.
 */
export function locateSource(transcript, source) {
  const want = squash(String(source ?? '').replace(EDGE_PUNCT, ''));
  if (want.length < 2) return null;
  const t = String(transcript ?? '');
  const map = [];
  let norm = '';
  for (let i = 0; i < t.length; i += 1) {
    if (!/\s/.test(t[i])) { map.push(i); norm += t[i]; }
  }
  const at = norm.indexOf(want);
  if (at < 0) return null;
  return t.slice(map[at], map[at + want.length - 1] + 1);
}

const isStr = (v) => typeof v === 'string';
const isIntIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const orNull = (v) => (isStr(v) && v.trim() ? v.trim() : null);

function reject(reason) {
  return { ok: false, items: [], dropped: 0, reason };
}

/**
 * Checks a model reply against the transcript. `reply` is the parsed object or its JSON text.
 * Returns {ok, items, dropped, reason}. ok=false means the whole reply is unusable (not JSON,
 * unknown kind, text too long, more than 12 items): the caller keeps the transcript only.
 * Items that fail the evidence checks are dropped one by one and counted in `dropped`.
 * `opts.today` ('YYYY-MM-DD') lets a date without a spoken year be checked against the next
 * occurrence of that day; without it such a date is set to null.
 */
export function validateNotesReply(reply, transcript, opts = {}) {
  let obj = reply;
  if (isStr(reply)) {
    try { obj = JSON.parse(reply); } catch { return reject('bad_json'); }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return reject('not_object');
  if (!Array.isArray(obj.items)) return reject('no_items');
  if (obj.items.length > MAX_ITEMS) return reject('too_many');
  const tNorm = squash(transcript);
  const items = [];
  let dropped = 0;
  for (const raw of obj.items) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return reject('bad_item');
    if (!KINDS.includes(raw.kind)) return reject('bad_kind');
    if (!isStr(raw.text)) return reject('bad_item');
    if (raw.text.length > MAX_TEXT) return reject('too_long');
    const item = checkItem(raw, String(transcript ?? ''), tNorm, opts);
    if (item) items.push(item);
    else dropped += 1;
  }
  return { ok: true, items, dropped, reason: null };
}

// Words that put a sentence in the past: no "next visit" may be taken from it.
export const PAST_RE = /지난|저번|했던|드렸던|셨던|전에/;
const NEG_RE = /(?<![가-힣])(?:안|못)\s|않|없|말(?:고|라|아|지|것)|금지|지\s*마|마세요/;
const FOREIGN_NUM = /(?![0-9])\p{N}/u; // any numeral that is not 0-9 after NFKC

// Endings and particles, longest first; the longest one a word ends with is cut off.
const TAILS = ['으세요', '하세요', '드세요', '드시고', '드시면', '드셔야', '하셔야', '입니다', '합니다', '이에요',
  '세요', '으로', '에서', '에게', '한테', '부터', '까지', '보다', '처럼', '이나', '이랑', '예요', '해야', '하는', '하게', '하고',
  '를', '을', '은', '는', '이', '가', '도', '만', '에', '로', '와', '과', '의', '요', '다', '고', '서', '며', '면', '께']
  .sort((a, b) => b.length - a.length);
function stemOf(tok) {
  const tail = TAILS.find((e) => tok.endsWith(e) && tok.length > e.length);
  const t = tail ? tok.slice(0, -tail.length) : tok;
  return t.length >= 2 ? t : ''; // a bare ending ("오세요", "드세요") says nothing about content
}

/** Content words (2+ Hangul letters, endings cut off) of a sentence. */
export function contentWords(text) {
  const out = [];
  for (const tok of nfkc(text).match(/[가-힣]+/g) || []) {
    const st = stemOf(tok);
    if (st.length >= 2) out.push(st);
  }
  return out;
}

/** What the item's own text claims that its quote must contain: 약 names, test names, most content words. */
function overlapOk(text, srcSquash) {
  for (const w of nfkc(text).match(/[가-힣]{1,8}약/g) || []) if (!srcSquash.includes(w)) return false;
  const tests = new RegExp(TEST_RE.source, 'g');
  for (const m of nfkc(text).matchAll(tests)) if (!srcSquash.toLowerCase().includes(m[1].toLowerCase())) return false;
  const words = contentWords(text);
  if (!words.length) return true;
  const hit = words.filter((w) => srcSquash.includes(w)).length;
  return hit / words.length >= 0.6;
}

function checkItem(raw, transcript, tNorm, opts) {
  const text = raw.text.trim();
  if (!text) return null;
  if (!isStr(raw.source)) return null;
  const sq = squash(String(raw.source).replace(EDGE_PUNCT, '')).length;
  if (sq < MIN_SOURCE || squash(raw.source).length > MAX_SOURCE) return null; // too short to prove anything, or a whole talk
  const src = locateSource(transcript, raw.source);
  if (src === null) return null; // quote not in the transcript
  const item = { kind: raw.kind, text, source: src };
  const srcN = nfkc(src);
  const textN = nfkc(text);
  if (FOREIGN_NUM.test(textN) || FOREIGN_NUM.test(srcN)) return null; // numerals other than 0-9 are not compared
  if (!overlapOk(text, squash(srcN))) return null; // the text says what the quote does not
  if (NEG_RE.test(textN) !== NEG_RE.test(srcN)) return null; // a "no" gained or lost
  const nums = numbersIn(text, { ambiguous: false });

  // number and unit together: "3주 뒤" is not backed by "3개월 뒤"
  const have2 = quantitiesIn(srcN);
  for (const q of quantitiesIn(textN)) if (!have2.has(q)) return null;

  if (raw.kind === 'med') {
    const m = raw.med && typeof raw.med === 'object' ? raw.med : {};
    const name = orNull(m.name);
    if (name && !tNorm.includes(squash(name))) return null; // a drug name nobody said
    const timesPerDay = isIntIn(m.timesPerDay, 1, 12) ? m.timesPerDay : null;
    const days = isIntIn(m.days, 1, 365) ? m.days : null;
    const slots = (Array.isArray(m.slots) ? m.slots : [])
      .filter((x) => isStr(x) && x.trim() && squash(src).includes(squash(x)))
      .map((x) => x.trim())
      .slice(0, 6);
    if (timesPerDay !== null) nums.push(timesPerDay);
    if (days !== null) nums.push(days);
    if (name) nums.push(...numbersIn(name, { ambiguous: false }));
    item.med = { name, timesPerDay, slots, days };
  } else if (raw.kind === 'next') {
    if (PAST_RE.test(srcN)) return null; // "지난번에 ... 오셨을 때": a past visit, not the next one
    const n = raw.next && typeof raw.next === 'object' ? raw.next : {};
    const said = orNull(n.said);
    const place = orNull(n.place);
    let sayOk = said && squash(src).includes(squash(said)) ? said : null;
    const placeOk = place && squash(src).includes(squash(place)) ? place : null;
    if (sayOk) nums.push(...numbersIn(sayOk, { ambiguous: false }));
    sayOk = sayOk || null;
    item.next = { date: checkDate(n.date, src, opts.today), time: checkTime(n.time, src), place: placeOk, said: sayOk };
  }

  const have = new Set(numbersIn(srcN, { ambiguous: false }));
  if (!nums.every((v) => have.has(v))) return null; // a number the source does not say
  return item;
}

function checkDate(date, src, today) {
  const d = parseIsoDate(date);
  if (!d) return null;
  for (const c of datesIn(src)) {
    if (c.m !== d.m || c.d !== d.d) continue;
    if (c.y !== null) { if (c.y === d.y) return date; continue; }
    if (today && inferYear(d.m, d.d, today) === d.y && daysFromToday(today, d.y, d.m, d.d) <= MAX_INFER_DAYS) return date;
  }
  return null; // not a full date the source says: the words stay in `said`
}

// A time is taken from the model only when the source fixes am/pm ("오후 2시", "14:00"): a bare "2시" stays empty.
function checkTime(time, src) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(time ?? ''));
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return timesIn(src).some((c) => c.ampm && c.hours.length === 1 && c.hours[0] === h && c.minute === min) ? time : null;
}

// ---------------------------------------------------------------------------------------------
// Cards, reading aloud, sharing (design 5, 4)
// ---------------------------------------------------------------------------------------------

/** Items in card order (next, med, test, todo, caution), original order kept inside a kind. */
export function orderItems(items) {
  const rank = (k) => CARD_ORDER.indexOf(k);
  return (items || [])
    .map((it, i) => ({ it, i }))
    .sort((a, b) => rank(a.it.kind) - rank(b.it.kind) || a.i - b.i)
    .map((x) => x.it);
}

/** [{kind, title, items}] for the kinds that have items, in card order. */
export function cardsFor(items) {
  const out = [];
  for (const kind of CARD_ORDER) {
    const list = (items || []).filter((it) => it.kind === kind);
    if (list.length) out.push({ kind, title: CARD_TITLES[kind], items: list });
  }
  return out;
}

export const SAMPLE_SPEECH = '예시 대화입니다.';
export const UNCONFIRMED_MARK = '(확인 전)';
export const EDITED_MARK = '(직접 고침)';

/** The line of an item as read or shared: unconfirmed and hand-edited items say so. */
export function itemLine(it) {
  const mark = it.edited ? EDITED_MARK : (it.status === 'unconfirmed' ? UNCONFIRMED_MARK : '');
  return mark ? `${mark} ${it.text}` : it.text;
}

/** The read-aloud sentences for a record: one title then its items per card, then the reminder. */
export function speechFor(record) {
  const cards = cardsFor(record && record.items);
  const out = [];
  if (record && record.source === 'sample') out.push(SAMPLE_SPEECH);
  if (!cards.length) out.push('정리된 내용이 없어요.');
  for (const c of cards) {
    out.push(c.title);
    for (const it of c.items) out.push(itemLine(it));
  }
  out.push(DISCLAIMER);
  return out;
}

/** Plain text for the share sheet: the organised items only, never the transcript. */
export function shareText(record) {
  const lines = [];
  if (record && record.source === 'sample') lines.push(SAMPLE_SPEECH, '');
  const head = ['진료 기록'];
  if (record && record.date) head.push(`(${record.date})`);
  lines.push(head.join(' '));
  if (record && record.hospital) lines.push(record.hospital);
  if (record && record.source === 'sample') lines.push('[예시 대화]');
  for (const c of cardsFor(record && record.items)) {
    lines.push('', c.title);
    for (const it of c.items) lines.push(`- ${itemLine(it)}`);
  }
  lines.push('', DISCLAIMER);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Local rule-based fallback (used when the AI call fails or is not allowed)
// ---------------------------------------------------------------------------------------------

const SPEAKER_TAG = /^\s*(?:의사|간호사|환자|보호자|doctor|nurse|patient)\s*[:：]\s*/i;
const NEGATION = /(?:^|\s)안\s|않|없|아니|못\s|말고|마세요|하지\s*마/;
const NOT_DRUG = /예약|계약|조약|절약|요약|공약|규약|제약|협약|취약|언약|서약|연약/;
const SLOT_RE = /아침|점심|저녁|자기\s*전|취침\s*전|식전|식후|식사\s*후/g;
const FREQ_RE = /(?:하루(?:에)?\s*)?(?:\d+|[가-힣]{1,3})\s*번(?:씩)?/g;
const VISIT_VERB = /오세요|오시|오셔|뵐|뵙|뵈|방문|내원|예약|진료|보자|봅시다|만나/;
const REL_RE = /(?:\d+|[가-힣]{1,3})\s*(?:개월|주일|주|달|년|일)\s*(?:뒤|후)|다음\s*(?:달|주)|내달|내주/g;
const TEST_RE = /(?<![가-힣])([가-힣]{0,4}검사|채혈|엑스레이|초음파|심전도|내시경|CT|MRI)/;

function splitSentences(transcript) {
  const out = [];
  for (const line of String(transcript ?? '').split(/\n+/)) {
    for (const part of line.match(/[^.!?。]+[.!?。]*/g) || []) {
      for (const sub of part.split(/(?<=[요다죠까])\s+/)) {
        const s = sub.replace(SPEAKER_TAG, '').trim();
        if (s) out.push(s);
      }
    }
  }
  return out;
}

/**
 * Pulls out only what a sentence can back: medicine frequency phrases, explicit dates or relative
 * next-visit phrases, and 검사 mentions. Everything goes through validateNotesReply, so the result
 * has the same guarantees as the AI path. Returns {ok, items, dropped, reason}.
 */
export function extractByRules(transcript, opts = {}) {
  const items = [];
  const seen = new Set();
  const push = (it) => {
    const key = `${it.kind}|${it.text}`;
    if (!seen.has(key)) { seen.add(key); items.push(it); }
  };
  for (const sentence of splitSentences(transcript)) {
    const isQuestion = /[?？]\s*$/.test(sentence) || /(?:까요|나요|ㄴ가요|가요)\s*$/.test(sentence);
    if (isQuestion || NEGATION.test(sentence)) continue;
    const source = sentence.replace(/[.!?。\s]+$/, '');

    // medicine with a frequency or time-of-day
    const name = (source.match(/[가-힣]{1,8}약/g) || []).find((w) => !NOT_DRUG.test(w));
    if (name && /드시|드세|드셔|먹|복용|복약/.test(source)) {
      const slots = [...new Set((source.match(SLOT_RE) || []).map((x) => x.replace(/\s+/g, ' ')))];
      const freq = (source.match(FREQ_RE) || []).find((f) => numbersIn(f).length > 0) || null;
      if (freq || slots.length) {
        const per = freq ? numbersIn(freq).find((n) => Number.isInteger(n) && n >= 1 && n <= 12) ?? null : null;
        const when = [slots.length ? `${slots.join('·')}에` : null, freq].filter(Boolean).join(' ');
        push({
          kind: 'med',
          text: `${withObject(name)} ${when} 드세요.`,
          med: { name, timesPerDay: per, slots, days: null },
          source,
        });
      }
    }

    // next visit: an explicit date/time, or a relative phrase
    if (VISIT_VERB.test(source) && !PAST_RE.test(source)) {
      const when = resolveNextWhen(source, opts);
      const rel = (source.match(REL_RE) || []).find((r) => numbersIn(r).length > 0 || /다음|내달|내주/.test(r)) || null;
      if (when && when.dateLiteral) {
        const lit = [when.dateLiteral, when.timeLiteral].filter(Boolean).join(' ');
        push({
          kind: 'next',
          text: `${lit}에 오세요.`,
          next: { date: when.date, time: when.time, place: null, said: null },
          source,
        });
      } else if (rel) {
        push({ kind: 'next', text: `${rel}에 다시 오세요.`, next: { date: null, time: null, place: null, said: rel }, source });
      }
    }

    // tests
    const t = source.match(TEST_RE);
    if (t && /하고|받|하세요|하셔|하시|해야|하실|예정|가세요|가시|해\s*주|합니다/.test(source)) {
      push({ kind: 'test', text: `${/오늘/.test(source) ? '오늘 ' : ''}${withObject(t[1])} 받으세요.`, source });
    }
  }
  return validateNotesReply({ items: items.slice(0, MAX_ITEMS) }, transcript, opts);
}
