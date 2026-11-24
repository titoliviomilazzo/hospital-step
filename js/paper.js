// Hospital paper and message text -> visit-note items (rules only). See docs/PLAN-visit-notes-v2.md.
//
// Input is text the hospital wrote (pasted SMS, or the text read from a photo of a paper). The
// result has the same shape as validateNotesReply(): {ok, items, dropped, reason}. Nothing is
// invented: every item quotes a stretch of the (scrubbed) text as `source`, and every item is run
// through validateNotesReply(), which re-checks numbers, units, drug names and dates against that
// quote. A date or time that cannot be fixed with certainty stays empty or the item is dropped.
//
// Governing rule: a wrong date or dose reaching an elderly user is the worst failure, a dropped item
// is acceptable. A chunk that is ambiguous, conditional, multi-drug, cancelled or relative therefore
// gives NO item, and is counted in `dropped` so the screen can say so. Pure functions, importable in Node.
import {
  scrub, validateNotesReply, datesIn, timesIn, inferYear, parseIsoDate, wordNumber,
  MAX_INFER_DAYS, MAX_ITEMS, MAX_SOURCE, PAST_RE, MASK, NOT_A_NAME, SURNAMES,
} from './notes.js';

const WEEKDAYS = '일월화수목금토'; // index = Date#getUTCDay()
const nfkc = (v) => String(v ?? '').normalize('NFKC');
const squash = (s) => String(s ?? '').replace(/\s+/g, '');
const pad2 = (n) => String(n).padStart(2, '0');

/** A date written without a year and without a weekday is believed only this far ahead (days). */
export const PASTE_INFER_DAYS = 120;

// ---------------------------------------------------------------------------------------------
// Scrub: notes.js scrub() plus the names a hospital message carries ("고객님", "환자:", "(1948.03.02)")
// ---------------------------------------------------------------------------------------------

// labels that may be followed by a name without a colon ("성명 홍길동") ...
const NAME_LABEL = /((?:환자\s*)?(?:성명|이름|환자명|수신자|성함|수진자명|고객명|회원명|보호자명)\s*[:：]?\s*)([가-힣]{2,4})(?![가-힣])/g;
// ... and bare role words that need the colon ("환자: 홍길동"; "환자 진료 예약" masks nothing)
const NAME_LABEL_COLON = /((?:환자|수진자|고객|회원|보호자)\s*[:：]\s*)([가-힣]{2,4})(?![가-힣])/g;
// "홍길동 고객님": a name-shaped word (family name first) in front of a customer title
const NAME_TITLE = new RegExp(`(?<![가-힣])([${SURNAMES}][가-힣]{1,3})(\\s*)(고객님|환자님|회원님|보호자님|수진자님)`, 'g');
// "홍길동(남/78세)", "홍길동(1948.03.02)": a name with its sex/age or birth date in brackets
const NAME_PAREN = /(?<![가-힣])([가-힣]{2,4})(\s*\(\s*(?:(?:남|여|M|F)\s*[/,·]?\s*\d{1,3}\s*세?|\d{1,3}\s*세|(?:19\d{2}|20[01]\d)\s*[.\-/년]\s*\d{1,2}\s*[.\-/월]\s*\d{1,2}\s*일?\s*(?:생)?)\s*\))/g;
// a 19xx date is a birth date, never a visit
const BIRTH_DATE = /(?<![\d.])19\d{2}\s*[.\-/]\s*\d{1,2}\s*[.\-/]\s*\d{1,2}(?!\d)/g;

const dots = (name) => '○'.repeat(name.length);

/** scrub() for paper text: also masks labelled names, names before customer titles and birth dates. */
export function scrubPaper(text) {
  let s = String(text ?? '');
  s = s.replace(NAME_LABEL, (m, lead, name) => `${lead}${dots(name)}`);
  s = s.replace(NAME_LABEL_COLON, (m, lead, name) => `${lead}${dots(name)}`);
  s = s.replace(NAME_TITLE, (m, name, sp, title) => (NOT_A_NAME.test(name) ? m : `${dots(name)}${sp}${title}`));
  s = s.replace(NAME_PAREN, (m, name, rest) => `${dots(name)}${rest}`);
  s = s.replace(BIRTH_DATE, MASK);
  return scrub(s);
}

// ---------------------------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------------------------

function weekdayOf(y, m, d) {
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

function daysBetween(today, y, m, d) {
  const t = parseIsoDate(today);
  if (!t) return null;
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(t.y, t.m - 1, t.d)) / 86400000);
}

/** Finds the n-th occurrence of each literal in turn, so a literal written twice keeps two positions. */
function positioner(s) {
  const from = new Map();
  return (literal) => {
    const at = s.indexOf(literal, from.get(literal) ?? 0);
    if (at >= 0) from.set(literal, at + 1);
    return at;
  };
}

// A stamp of when the message was sent ("문자발송 11/24 14:15", "수신 14:15") is not a visit date or time.
const SENT_WORD = /발송|발신|수신|전송|보낸|보냄|송신/;
function isSentStamp(s, pos) {
  if (SENT_WORD.test(s.slice(Math.max(0, pos - 14), pos))) return true;
  return /문자\s*[(（][^)）]{0,12}$/.test(s.slice(Math.max(0, pos - 24), pos));
}

/**
 * Dates literally written in a text: [{y|null, m, d, weekday|null, literal, pos}]. Forms:
 * "2027년 3월 2일(화)", "2027.03.02", "3월 2일", "3/2(화)". A bare "3/2" counts only with a
 * weekday in brackets or a clock time right behind it ("1/2정" is half a tablet, not a date).
 * `literal` includes the bracketed weekday when there is one. A date that is the send stamp of the
 * message is left out.
 */
export function paperDates(text) {
  const s = nfkc(text);
  const out = [];
  const seen = new Set();
  const add = (o) => {
    const key = `${o.y}|${o.m}|${o.d}|${o.pos}`;
    if (!seen.has(key)) { seen.add(key); out.push(o); }
  };
  const where = positioner(s);
  for (const d of datesIn(s)) {
    const pos = where(d.literal);
    if (pos < 0) continue;
    const tail = s.slice(pos + d.literal.length).match(/^\s*\(\s*([월화수목금토일])\s*\)/);
    // a digit run glued to the date ("20210907-62367") is a number, not a date
    if (/\d/.test(s[pos - 1] ?? '') || /^\d/.test(s.slice(pos + d.literal.length))) continue;
    add({ y: d.y, m: d.m, d: d.d, weekday: tail ? tail[1] : null, literal: tail ? d.literal + tail[0] : d.literal, pos });
  }
  const slash = /(?<![\d/.])(\d{1,2})\/(\d{1,2})(?![\d/])(\s*\(\s*([월화수목금토일])\s*\))?/g;
  for (const m of s.matchAll(slash)) {
    const after = s.slice(m.index + m[0].length);
    const ok = m[4] || /^\s*(?:(?:오전|오후|아침|저녁|낮|밤|새벽)\s*)?\d{1,2}:\d{2}/.test(after);
    const mo = Number(m[1]);
    const dd = Number(m[2]);
    if (!ok || mo < 1 || mo > 12 || dd < 1 || dd > 31) continue;
    add({ y: null, m: mo, d: dd, weekday: m[4] || null, literal: m[0].trim(), pos: m.index });
  }
  return out.filter((d) => !isSentStamp(s, d.pos)).sort((a, b) => a.pos - b.pos);
}

/**
 * The calendar day a written date means, as 'YYYY-MM-DD', or null. No year: the next such day on
 * or after `today`; a date with a fitting weekday may be MAX_INFER_DAYS ahead, one without a weekday
 * only PASTE_INFER_DAYS (a misread month would otherwise slip a year ahead unnoticed). A weekday
 * that does not fit the day (a misread digit) gives null.
 */
export function resolveDate(d, today) {
  const y = d.y ?? inferYear(d.m, d.d, today);
  if (!y) return null;
  const iso = `${y}-${pad2(d.m)}-${pad2(d.d)}`;
  if (!parseIsoDate(iso)) return null;
  if (d.y === null) {
    const gap = daysBetween(today, y, d.m, d.d);
    if (gap === null || gap > (d.weekday ? MAX_INFER_DAYS : PASTE_INFER_DAYS)) return null;
  }
  if (d.weekday && weekdayOf(y, d.m, d.d) !== d.weekday) return null;
  return iso;
}

// ---------------------------------------------------------------------------------------------
// Times
// ---------------------------------------------------------------------------------------------

const MERID = '오전|오후|아침|저녁|낮|밤|새벽';
// a time right behind these is a phone desk's hours, a deadline or a lunch break, not the visit
const NOT_VISIT_TIME_BEFORE = /문의|전화|연락|상담|콜센터|운영|접수\s*시간|점심|마감|○○○○/;
// a time with one of these behind it is a deadline or a range start
const RANGE_AFTER = /^\s*(?:까지|이전|이후|부터|~|–|-)/;

function hourWithMeridiem(h, mer) {
  if (h > 24) return null;
  if (mer === '오후' || mer === '저녁' || mer === '밤') return h < 12 ? h + 12 : h;
  if (mer === '오전' || mer === '아침' || mer === '새벽') return h === 12 ? 0 : h;
  if (mer === '낮') return h >= 1 && h <= 6 ? h + 12 : h;
  return null;
}

/**
 * Clock times in a text: [{hhmm: 'HH:MM'|null, literal, pos}]. hhmm is null when the time is
 * ambiguous: "2:30" or "2시" with no am/pm, a deadline ("10:30까지") or a phone desk's hours.
 * "10:30", "14:30" and "09:00" are 24-hour style and accepted; "오전 10:30", "오후 2시 30분",
 * "02:30 PM" carry their own am/pm. A colon time stuck to a letter or followed by ")" and digits is a
 * piece of a phone number, not a time. The send stamp of a message is left out.
 */
export function clockTimes(text) {
  const s = nfkc(text);
  const out = [];
  const taken = [];
  const push = (o) => {
    if (taken.some(([a, b]) => o.pos < b && o.pos + o.literal.length > a)) return;
    taken.push([o.pos, o.pos + o.literal.length]);
    const end = o.pos + o.literal.length;
    const before = s.slice(Math.max(0, o.pos - 12), o.pos);
    const vague = RANGE_AFTER.test(s.slice(end, end + 6)) || NOT_VISIT_TIME_BEFORE.test(before);
    out.push(vague ? { ...o, hhmm: null } : o);
  };
  for (const m of s.matchAll(/(?<![A-Za-z0-9가-힣:.])(\d{1,2}):(\d{2})\s*(AM|PM)(?![A-Za-z])/gi)) {
    const h = Number(m[1]);
    const mm = Number(m[2]);
    const pm = m[3].toUpperCase() === 'PM';
    const ok = h >= 1 && h <= 12 && mm <= 59;
    const h24 = pm ? (h === 12 ? 12 : h + 12) : (h === 12 ? 0 : h);
    push({ hhmm: ok ? `${pad2(h24)}:${m[2]}` : null, literal: m[0], pos: m.index });
  }
  for (const m of s.matchAll(new RegExp(String.raw`(${MERID})\s*(\d{1,2}):(\d{2})(?![\d:])`, 'g'))) {
    const h = hourWithMeridiem(Number(m[2]), m[1]);
    const mm = Number(m[3]);
    push({ hhmm: h !== null && mm <= 59 ? `${pad2(h)}:${m[3]}` : null, literal: m[0], pos: m.index });
  }
  for (const m of s.matchAll(/(?<![A-Za-z0-9가-힣:.])(\d{1,2}):(\d{2})(?![\d:.])(?!\)\s*[\d○])/g)) {
    const h = Number(m[1]);
    const mm = Number(m[2]);
    if (h > 24 || mm > 59) continue;
    const h24 = h >= 10 || h === 0 || m[1].length === 2; // "2:30" alone is the only ambiguous shape
    // a visit at 00:00-05:59 is far more likely a misread than an appointment: left empty, the date stays
    push({ hhmm: h24 && h >= 6 ? `${pad2(h)}:${m[2]}` : null, literal: m[0], pos: m.index });
  }
  const where = positioner(s);
  for (const t of timesIn(s)) {
    if (t.literal.includes(':')) continue;
    const pos = where(t.literal);
    if (pos < 0) continue;
    push({ hhmm: t.ampm && t.hours.length === 1 ? `${pad2(t.hours[0])}:${pad2(t.minute)}` : null, literal: t.literal, pos });
  }
  return out.filter((t) => !isSentStamp(s, t.pos)).sort((a, b) => a.pos - b.pos);
}

// ---------------------------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------------------------

/** Non-empty trimmed lines, with the index of the original line kept for adjacency. */
function linesOf(text) {
  return String(text ?? '').split(/\r?\n/).map((raw, i) => ({ i, t: raw.replace(/\s+/g, ' ').trim() })).filter((l) => l.t);
}

function sentencesOf(line) {
  return line.split(/(?<=[.!?。])\s+/).map((x) => x.trim()).filter(Boolean);
}

const BULLET = /^[■◆●▶▷☞ㆍ·•*\-\s]+/;
const TEST_RE = /([가-힣]{0,6}검사|채혈|CT|MRI|초음파|내시경|엑스레이|심전도)/;
const VISIT_RE = /예약|다음\s*진료|진료\s*일시|방문\s*일시|외래\s*방문|내원|입원\s*일|수술\s*일|진료/;
// a sentence that says "this is a visit", whatever else (a test) it mentions
const VISIT_STRONG = /진료\s*예약|예약\s*진료|다음\s*진료|진료\s*일[시자]?|외래\s*진료|진료\s*시간|진료\s*예정|방문\s*일시|입원|수술|내원/;
// the words a visit sentence may be introduced with, in the order they are tried as the item's head
const LABEL_RE = /(다음\s*진료\s*일시?|진료\s*예약\s*일시?|진료\s*일시|진료\s*일자?|진료\s*예정|예약\s*일시|예약\s*일자?|예약\s*일|예약\s*시간|방문\s*일시|내원\s*일시?)/;
const PLACE_PLAIN = /(?<![가-힣\d])((?:\d{1,2}동\s*)?(?:지하\s*)?(?:\d{1,2}층\s*)?[가-힣]{2,12}(?:센터|검사실|병동|클리닉|외래|원무과|수납창구))/;
const PLACE_FLOOR = /(?<![가-힣\d])(\d{1,2}동\s*(?:지하\s*)?(?:\d{1,2}층\s*)?[가-힣]{2,12})/;

function placeIn(text) {
  const s = nfkc(text);
  const m = s.match(PLACE_PLAIN) || s.match(PLACE_FLOOR);
  return m ? m[1].trim() : null;
}

// ---------------------------------------------------------------------------------------------
// Cancelled or changed messages
// ---------------------------------------------------------------------------------------------

// a visit sentence with one of these and no readable date: the day is relative or written in a form the parser refuses
const UNREAD_WHEN_RE = /내일|모레|다음\s*주|다음\s*달|이번\s*주|\d+\s*(?:주|개월|일)\s*(?:후|뒤)|D-\d+|\d{1,2}\s*\/\s*\d{1,2}|\d{1,2}\s*월|\d{4}\s*[.\-]\s*\d{1,2}/;
// A visit sentence with one of these words, or under a heading with one, is not an appointment to keep.
const CANCEL_RE = /취소|변경|연기|부도|미내원|불가|마감/;
// A message that announces a change anywhere: no date in it can be told from the old one.
const CHANGE_NOTICE_RE = /(?:취소|변경|연기)\s*(?:되었|됐|됨|처리|안내)|(?:변경|기존|이전|취소)\s*(?:전|후|예약|일시?|내용)\s*[:：]|취소\s*안내/;
// a new message starts at a bracketed sender/hospital tag (carrier tags such as [Web발신] do not)
const SECTION_START = /^\[(?!\s*(?:Web|국제|국내)?\s*발신)[^\]\n]{1,30}\]/;

/** The heading text of the message each line belongs to (its first line; a bare tag line adds the next). */
function headingsOf(lines) {
  const out = [];
  let head = '';
  lines.forEach((l, i) => {
    if (i === 0 || SECTION_START.test(l.t)) {
      head = l.t;
      if (!head.replace(/^\[[^\]]*\]\s*/, '') && lines[i + 1]) head = `${head} ${lines[i + 1].t}`;
    }
    out.push(head);
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Candidate items. Each candidate carries a list of texts, easiest wording first; the first text
// that passes validateNotesReply() is kept. A candidate with no passing text is dropped.
// ---------------------------------------------------------------------------------------------

function pickDate(dates, today) {
  const resolved = dates.map((d) => ({ d, iso: resolveDate(d, today) })).filter((x) => x.iso);
  const future = resolved.filter((x) => x.iso > today);
  const days = [...new Set(future.map((x) => x.iso))];
  if (days.length === 1) return future[0];
  if (days.length > 1) return null; // two possible visit days in one stretch: ambiguous
  const same = [...new Set(resolved.map((x) => x.iso))];
  return same.length === 1 && same[0] === today ? resolved[0] : null; // only today is left
}

function pickTime(times, afterPos) {
  const pool = times.filter((t) => t.pos >= afterPos);
  const distinct = [...new Set(pool.map((t) => t.hhmm ?? `?${t.literal}`))];
  if (distinct.length !== 1) return { hhmm: null, literal: null };
  return { hhmm: pool[0].hhmm, literal: pool[0].hhmm ? pool[0].literal : null };
}

const SLOT_WORDS = ['아침', '점심', '저녁', '자기 전'];
const NAME_SRC = String.raw`(?<![가-힣])([가-힣]{2,12}(?:정|캡슐|시럽|연고|패치|약))(?:은|는|이|가|을|를)?(?![가-힣])(?:\s*(\d+(?:\.\d+)?\s*(?:mg|g|ml|mcg|㎎)))?`;
// words that end in 약 (or 정) without naming a medicine
const NOT_A_DRUG = /(?:예약|계약|조약|절약|요약|공약|규약|제약|협약|취약|언약|서약|연약)$|^(?:처방약|조제약|복용약|상비약|알약|물약|가루약|내복약|양약|확정|예정|일정|결정|교정|수정|고정|판정|조정|지정|규정|인정|설정|사정|공정|미정)$/;
const FREQ_SRC = String.raw`(?:1일|하루)(?:에)?\s*(\d{1,2}|한|두|세|네)\s*(?:회|번)`;
const FREQ_RE = new RegExp(FREQ_SRC);

/** All medicine names in a text, in order: [{name: '혈압약', dose: '5mg'|null}]. */
function namesIn(s) {
  const out = [];
  for (const m of nfkc(s).matchAll(new RegExp(NAME_SRC, 'gi'))) {
    if (!NOT_A_DRUG.test(m[1])) out.push({ name: m[1], dose: m[2] ? m[2].replace(/\s+/g, '') : null });
  }
  return out;
}
const nameOf = (s) => namesIn(s)[0] || null;

function numOf(w) {
  return /^\d+$/.test(w) ? Number(w) : wordNumber(w);
}

function freqValues(s) {
  return new Set([...nfkc(s).matchAll(new RegExp(FREQ_SRC, 'g'))].map((m) => numOf(m[1])));
}

function medFacts(block) {
  const s = nfkc(block);
  const freq = s.match(FREQ_RE);
  const timesPerDay = freq ? numOf(freq[1]) : null;
  const dayMatch = s.match(/(\d{1,3})\s*일\s*분/) || s.match(/총\s*투(?:약|여)일수\s*[:：]?\s*(\d{1,3})/) || s.match(/(\d{1,3})\s*일치/);
  const days = dayMatch ? Number(dayMatch[1]) : null;
  const slots = SLOT_WORDS.filter((w) => squash(s).includes(squash(w)));
  const meal = s.match(/식후\s*(\d{1,3})\s*분/);
  return {
    timesPerDay: Number.isInteger(timesPerDay) && timesPerDay >= 1 && timesPerDay <= 12 ? timesPerDay : null,
    days: Number.isInteger(days) && days >= 1 && days <= 365 ? days : null,
    slots,
    mealMin: meal ? Number(meal[1]) : null,
    mealNow: /식후\s*즉시/.test(s),
    sameTime: /같은\s*시간/.test(s),
    haru: /하루/.test(s),
  };
}

// Dosing that is not "every day, as many times as written": any of these in a chunk drops the chunk.
const NON_DAILY_RE = /주\s*\d+(?:\s*[~\-]\s*\d+)?\s*(?:회|번)|주\s*(?:한|두|세|네)\s*번|매주|격일|(?<!\d)(?:[2-9]|\d{2,})\s*일\s*(?:에|마다|간격)|\d+\s*주\s*(?:에|마다|간격)|한\s*주에|일주일에|이틀에|사흘에|하루\s*걸러|[월화수목금토일]요일|월수금|화목토|[월화수목금토]{2,}|주말|주중|평일|짝수|홀수|\d+\s*개월에/;
const AS_NEEDED_RE = /필요\s*시|필요하면|필요할\s*때|통증\s*시|증상\s*시|아플\s*때|아프면|열이\s*날\s*때|경우|최대|(?:회|번)\s*까지/;
const STEP_RE = /이후|그다음|그\s*다음|그\s*후|줄이|늘리|증량|감량|증상이\s*좋아지면|호전되면|단계|일째|점차|서서히/;
const medRisky = (s) => { const n = nfkc(s); return NON_DAILY_RE.test(n) || AS_NEEDED_RE.test(n) || STEP_RE.test(n); };
// words of a dose instruction (a mere mention of a medicine has none of them)
const hasDosing = (s) => /\d+\s*(?:회|번|일\s*분|일치|알|정|포|캡슐)|식후|식전|취침|자기\s*전|아침|점심|저녁|하루|1일/.test(nfkc(s));

function medTexts(name, f) {
  const lead = name ? `${name}: ` : '';
  const freq = f.timesPerDay ? `${f.haru ? '하루' : '1일'} ${f.timesPerDay}번` : null;
  const slots = f.slots.length ? `(${f.slots.join('·')})` : null;
  const meal = f.mealMin ? `밥 먹고 ${f.mealMin}분 뒤에` : (f.mealNow ? '식후 즉시' : null);
  const when = [f.sameTime ? '같은 시간에' : null, meal].filter(Boolean).join(' ');
  const head = [freq, slots].filter(Boolean).join(' ');
  const body = [head, when ? `${head ? ', ' : ''}${when} 드세요.` : (head ? ' 드세요.' : '')].join('');
  const days = f.days ? ` 총 ${f.days}일.` : '';
  const texts = [];
  if (body.trim()) {
    texts.push(`${lead}${body}${days}`.replace(/\s+/g, ' ').trim());
    texts.push(`${lead}${body}`.replace(/\s+/g, ' ').trim());
  }
  if (freq) texts.push(`${lead}${freq}.`.trim());
  if (!freq && f.days) texts.push(`${lead}총 ${f.days}일치.`.trim());
  return [...new Set(texts)];
}

/**
 * One drug's group of text -> {cand} | {drop: true} | {skip: true}. Refused (and counted): dosing that
 * is not daily, as-needed or stepwise, two drugs or two different frequencies in one group, a time of
 * day without a frequency number, more time-of-day words than doses.
 */
function medFromGroup(g, order) {
  if (!hasDosing(g)) return { skip: true }; // the medicine is only mentioned
  const names = namesIn(g);
  const distinct = new Set(names.map((n) => n.name));
  if (medRisky(g) || distinct.size >= 2 || freqValues(g).size >= 2) return { drop: true };
  const f = medFacts(g);
  if (f.timesPerDay === null && f.days === null) return { drop: true };
  if (f.timesPerDay === null) f.slots = [];
  else if (f.slots.length > f.timesPerDay) return { drop: true };
  if (squash(g).length > MAX_SOURCE) return { drop: true };
  const first = names[0];
  const name = first ? `${first.name}${first.dose ? ` ${first.dose}` : ''}` : null;
  return {
    cand: {
      raw: { kind: 'med', med: { name, timesPerDay: f.timesPerDay, slots: f.slots, days: f.days }, source: g },
      texts: medTexts(name, f),
      order,
    },
  };
}

/** Splits a block (lines joined by \n) into one group per drug, keeping every group a verbatim slice. */
function medGroups(block) {
  const cuts = [];
  let last = 0;
  for (const m of block.matchAll(/(?<=[.!?。])\s+|\s*[,，/／;；]\s*|\n/g)) {
    cuts.push([last, m.index]);
    last = m.index + m[0].length;
  }
  cuts.push([last, block.length]);
  const groups = [];
  for (const [a, b] of cuts) {
    if (a >= b) continue;
    if (nameOf(block.slice(a, b))) groups.push({ a: groups.length ? a : 0, b });
    else if (groups.length) groups[groups.length - 1].b = b;
  }
  return groups.map(({ a, b }) => block.slice(a, b).trim()).filter(Boolean);
}

function cautionTexts(sentence) {
  const base = sentence.replace(/^[※*•·\-\s]+/, '').replace(/^주의\s*[:：]?\s*/, '').trim();
  if (!base) return [];
  const easy = base
    .replace(/있습니다\.?$/, '있어요.')
    .replace(/됩니다\.?$/, '돼요.')
    .replace(/합니다\.?$/, '해요.')
    .replace(/하십시오\.?$/, '하세요.')
    .replace(/마십시오\.?$/, '마세요.')
    .replace(/십시오\.?$/, '세요.');
  return [...new Set([easy, base])];
}

// A sentence is a caution when it starts like one or says "do not" / "forbidden"; after a "주의:" head the
// next two sentences count too, but only when they read like cautions and are not paperwork or a date.
const CAUTION_START = /^(?:주의|유의|※|금식|금주|졸음|복용\s*전|복용\s*중|복용\s*후|공복|운전|음주|삼가)/;
const CAUTION_STRONG = /하지\s*마(?:세요|십시오)|지\s*마(?:세요|십시오)|금지|삼가|조심|주의하|금식|금주|졸음|복용\s*중단/;
const CAUTION_LIKE = /마세요|마십시오|조심|삼가|금지|금식|금주|졸음|어지러|멈추|중단|상의|피하|피해|주의/;
const CAUTION_RELIEF = /않으셔도|않아도|괜찮|상관\s*없|안\s*해도|필요\s*없/;
const PAPERWORK_RE = /진료비|영수증|원무과|수납|주차|접수|예약|서류|발급|증명|다음\s*진료|문의|전화|연락처|\d+\s*월|\d+\/\d+/;
const ENDING_RE = /(?:다|요|오|라|니다)[.!]?$/;

function sentencesWithLines(lines) {
  const out = [];
  for (const l of lines) for (const sentence of sentencesOf(l.t)) out.push({ sentence, i: l.i });
  return out;
}

function candidatesFrom(text, today) {
  const lines = linesOf(text);
  const heads = headingsOf(lines);
  const changeNotice = CHANGE_NOTICE_RE.test(nfkc(text));
  const cands = [];
  let dropped = 0;
  const usedMed = new Set();

  // --- prescription table: header with 투약량 / 투여횟수 / 일수, then one drug per row ---------
  lines.forEach((hl, hi) => {
    if (!(/투약량/.test(hl.t) && /횟수/.test(hl.t) && /일수/.test(hl.t))) return;
    const timesLabel = (hl.t.match(/1일\s*투(?:약|여)\s*횟수/) || [null])[0];
    const daysLabel = (hl.t.match(/총\s*투(?:약|여)\s*일수/) || [null])[0];
    if (!timesLabel || !daysLabel) return;
    const rows = [];
    for (let k = hi + 1; k < lines.length; k += 1) {
      const m = lines[k].t.match(/^(?:[가-힣]{2,12}(?:정|캡슐|시럽|연고|패치))\s*(?:\d+(?:\.\d+)?\s*(?:mg|g|ml|mcg|㎎))?\s+\d+(?:\.\d+)?\s*(?:정|set|캡슐|T|C|개|포)?\s+(\d{1,2})\s+(\d{1,3})\s*(?:일)?$/i);
      if (!m) break;
      const nm = nameOf(lines[k].t);
      rows.push({ k, name: `${nm.name}${nm.dose ? ` ${nm.dose}` : ''}`, times: Number(m[1]), days: Number(m[2]) });
    }
    rows.forEach((r, ri) => {
      usedMed.add(r.k);
      const source = lines.slice(hi, r.k + 1).map((l) => l.t).join('\n');
      cands.push({
        raw: { kind: 'med', med: { name: r.name, timesPerDay: r.times, slots: [], days: r.days }, source },
        texts: [`${r.name}: ${timesLabel} ${r.times}, ${daysLabel} ${r.days}.`],
        order: hl.i + ri,
      });
    });
  });

  // --- drug blocks written as sentences ("1회 1정, 1일 3회 / 식후 30분 / 3일분"): one item per drug --
  let bareEnd = -9; // last line of a block that only names a medicine (no dose words)
  lines.forEach((l, li) => {
    if (usedMed.has(li) || !nameOf(l.t)) return;
    let end = li;
    while (end + 1 < lines.length && end - li < 5 && !nameOf(lines[end + 1].t) && !/^주의|※/.test(lines[end + 1].t)
      && !usedMed.has(end + 1)) end += 1;
    const block = lines.slice(li, end + 1).map((x) => x.t).join('\n');
    for (let k = li; k <= end; k += 1) usedMed.add(k);
    if (!hasDosing(block)) { bareEnd = end; return; }
    if (li === bareEnd + 1) { dropped += 1; bareEnd = -9; return; } // "A정 / B정 / 1일 2회": whose dose is it?
    for (const g of medGroups(block)) {
      const r = medFromGroup(g, l.i);
      if (r.cand) cands.push(r.cand);
      else if (r.drop) dropped += 1;
    }
  });

  // --- a dosing sentence with no drug name ("1일 3회 식후 30분에 복용하십시오") --------------------
  lines.forEach((l, li) => {
    if (usedMed.has(li)) return;
    const n = nfkc(l.t);
    if (!FREQ_RE.test(n)) return;
    const f = medFacts(l.t);
    if (!/복용|드시|드세요|먹/.test(l.t) || medRisky(l.t) || freqValues(n).size >= 2 || f.timesPerDay === null
      || f.slots.length > f.timesPerDay) {
      dropped += 1; // a dose that cannot be taken safely is counted, not lost
      return;
    }
    cands.push({
      raw: { kind: 'med', med: { name: null, timesPerDay: f.timesPerDay, slots: f.slots, days: f.days }, source: l.t },
      texts: medTexts(null, f),
      order: l.i,
    });
  });

  // --- visits and tests: a sentence with a visit/test word and a date --------------------------
  lines.forEach((l, li) => {
    const units = [];
    for (const sentence of sentencesOf(l.t)) {
      // "visit 3/2 10:30, blood draw 3/2 9:00": one unit per clause when several clauses carry a date
      const parts = sentence.split(/\s*[,，;；]\s*/).filter(Boolean);
      units.push(...(parts.length > 1 && parts.filter((p) => paperDates(p).length).length > 1 ? parts : [sentence]));
    }
    // a label line ("외래검사 예약일시") with its value on the next line
    const following = lines[li + 1];
    if (following && !paperDates(l.t).length && l.t.length <= 40 && (TEST_RE.test(l.t) || VISIT_RE.test(l.t))
      && paperDates(following.t).length && paperDates(following.t)[0].pos <= 3) units.push(`${l.t}\n${following.t}`);
    for (const sentence of units) {
      const dates = paperDates(sentence);
      if (!dates.length) {
        // a visit sentence whose day cannot be read ("내일", "2주 후", "3/2~3/4"): counted, never guessed
        if (VISIT_RE.test(sentence) && UNREAD_WHEN_RE.test(nfkc(sentence))) dropped += 1;
        continue;
      }
      // a message that cancels or changes a visit (in its heading or anywhere): no date in it may stay a visit
      if (changeNotice || CANCEL_RE.test(nfkc(heads[li]))) { dropped += 1; continue; }
      const testHit = sentence.match(TEST_RE);
      if (!testHit && !VISIT_RE.test(sentence)) continue;
      if (PAST_RE.test(nfkc(sentence))) { dropped += 1; continue; }
      if (CANCEL_RE.test(nfkc(sentence))) { dropped += 1; continue; } // cancelled, changed, closed in the sentence itself
      const pick = pickDate(dates, today);
      if (!pick) { dropped += 1; continue; }
      // one more line may complete the picture: a time that carries its own label, or a place
      const nextLine = lines[li + 1];
      const extra = nextLine && !paperDates(nextLine.t).length && nextLine.t.length <= 40
        && (/^[■◆●▶▷☞ㆍ·•*\-\s]*(?:예약\s*시간|진료\s*시간|시간)\s*[:：]?\s*\d|^[■◆●▶▷☞ㆍ·•*\-\s]*(?:예약\s*시간|진료\s*시간|시간)\s*[:：]?\s*(?:오전|오후)/.test(nextLine.t)
          || /^[■◆●▶▷☞ㆍ·•*\-\s]*(?:장소|위치)/.test(nextLine.t) || placeIn(nextLine.t))
        ? nextLine.t : null;
      const window = extra ? `${sentence}\n${extra}` : sentence;
      const t = pickTime(clockTimes(window), pick.d.pos);
      const when = [pick.d.literal, t.literal].filter(Boolean).join(' ');
      const isTest = testHit && !VISIT_STRONG.test(sentence);
      if (isTest) {
        const before = [...sentence.matchAll(new RegExp(TEST_RE.source, 'g'))].filter((x) => x.index < pick.d.pos);
        const name = (before.length ? before[before.length - 1] : testHit)[1];
        cands.push({ raw: { kind: 'test', source: sentence }, texts: [`${name}: ${when}`], order: l.i });
      } else {
        const place = placeIn(window);
        const sq = squash(sentence);
        const needExtra = Boolean(extra) && ((place && !sq.includes(squash(place))) || (t.literal && !sq.includes(squash(t.literal))));
        const label = (sentence.match(LABEL_RE) || [null])[1];
        const heads2 = ['진료 예약', '진료 일시'];
        if (label) heads2.push(label.replace(/\s+/g, ' ').trim());
        const texts = [];
        for (const head of heads2) {
          if (place) texts.push(`${head}: ${when}. 장소: ${place}`);
          texts.push(`${head}: ${when}.`);
        }
        cands.push({
          raw: { kind: 'next', next: { date: pick.iso, time: t.hhmm, place, said: null }, source: needExtra ? window : sentence },
          texts,
          order: l.i,
          // a date written without a year: the confirm sentence shows the year the app inferred
          inferred: pick.d.y === null ? { literal: pick.d.literal, shown: shownDate(pick) } : null,
        });
      }
    }
  });

  // --- cautions --------------------------------------------------------------------------------
  let carry = 0;
  for (const { sentence, i } of sentencesWithLines(lines)) {
    const body = sentence.replace(BULLET, '');
    const isHead = /^(?:주의|유의)/.test(body);
    const own = CAUTION_START.test(body) || CAUTION_STRONG.test(body);
    let hit = (own || (carry > 0 && CAUTION_LIKE.test(body))) && ENDING_RE.test(body) && squash(body).length >= 8;
    if (hit && (PAPERWORK_RE.test(nfkc(body)) || paperDates(body).length)) hit = false; // a date or paperwork is no caution
    if (hit && CAUTION_RELIEF.test(body)) { dropped += 1; hit = false; } // "no need to avoid" is the opposite of a caution
    if (hit) cands.push({ raw: { kind: 'caution', source: sentence }, texts: cautionTexts(sentence), order: i });
    carry = isHead ? 2 : (hit ? Math.max(0, carry - 1) : 0);
  }

  return { cands, dropped };
}

/** "2027년 3월 2일(화)" for a date picked without a year. */
function shownDate(pick) {
  const [y, m, d] = pick.iso.split('-').map(Number);
  return `${y}년 ${m}월 ${d}일${pick.d.weekday ? `(${pick.d.weekday})` : ''}`;
}

/**
 * validateNotesReply() proves a date only in the spoken forms of notes.js and a time only with a
 * word for am/pm or a 24-hour hour; it empties "3/2(화)" and "10:30". Both are re-derived here
 * from the kept quote alone (never from the candidate), with the stricter rules of this module.
 */
function restoreWhen(item, today) {
  if (!item.next) return;
  const dates = paperDates(item.source);
  const pick = dates.length ? pickDate(dates, today) : null;
  if (pick && item.next.date === null) item.next.date = pick.iso;
  if (pick && item.next.time === null) item.next.time = pickTime(clockTimes(item.source), pick.d.pos).hhmm;
}

/**
 * Items from the text of a hospital paper or message.
 * @param {string} text  pasted text or text read from a photo
 * @param {{today: string}} opts  `today` as 'YYYY-MM-DD'; needed to place a date written without a year
 * @returns {{ok: boolean, items: object[], dropped: number, reason: string|null, text: string}}
 *   `text` is the scrubbed text the items quote. Same item shape as validateNotesReply().
 */
export function parseHospitalText(text, { today = null } = {}) {
  const clean = scrubPaper(nfkc(text));
  if (!parseIsoDate(today)) return { ok: false, items: [], dropped: 0, reason: 'no_today', text: clean };
  const { cands, dropped: early } = candidatesFrom(clean, today);
  let dropped = early;
  const items = [];
  const seen = new Set();
  for (const c of cands.sort((a, b) => a.order - b.order)) {
    let kept = null;
    for (const t of c.texts) {
      const r = validateNotesReply({ items: [{ ...c.raw, text: t }] }, clean, { today });
      if (r.ok && r.items.length === 1) { kept = r.items[0]; break; }
    }
    if (!kept) { dropped += 1; continue; }
    if (kept.kind === 'next') {
      restoreWhen(kept, today);
      // the year was inferred, not written: say it, so the user sees the day the calendar will get
      if (c.inferred && kept.next.date && kept.text.includes(c.inferred.literal)) kept.text = kept.text.replace(c.inferred.literal, c.inferred.shown);
    }
    const key = `${kept.kind}|${kept.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(kept);
  }
  return { ok: true, items: items.slice(0, MAX_ITEMS), dropped: dropped + Math.max(0, items.length - MAX_ITEMS), reason: null, text: clean };
}
