// iCalendar (RFC 5545) text for the phone's own calendar (design 6-1). Pure; no DOM, no network.
//
// Time zone: floating local time (DTSTART:20261207T103000, no TZID, no Z). Every use is a visit
// to a hospital in Korea by someone whose phone is in Korea, so "10:30 on the phone's clock" is
// exactly what is meant, and a floating time needs no VTIMEZONE block (a TZID without its
// VTIMEZONE is invalid and some calendar apps then shift the time). DTSTAMP is UTC as the RFC
// requires and is passed in so the output is deterministic.
//
// Privacy: the SUMMARY and the alarm text are shown on a lock screen, so they are fixed phrases.
// The medicine name and the department never appear in them. `place` goes only into LOCATION,
// which the alarm does not show. Slot labels reach DESCRIPTION only when they are a time of day.

export const VISIT_SUMMARY = '병원 가는 날';
export const MED_SUMMARY = '약 드실 시간';
export const DEFAULT_MED_DAYS = 30;
const SAFE_LABELS = ['아침', '점심', '저녁', '자기 전', '식전', '식후', '식사 후', '취침 전'];

const enc = new TextEncoder();
const pad2 = (n) => String(n).padStart(2, '0');

/** Escapes a TEXT value (RFC 5545 3.3.11). */
export function escapeText(s) {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Folds one content line at 75 octets (UTF-8), never inside a character. Continuations start with a space. */
export function foldLine(line) {
  if (enc.encode(line).length <= 75) return line;
  const parts = [];
  let cur = '';
  let bytes = 0;
  let limit = 75;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    if (bytes + b > limit) {
      parts.push(cur);
      cur = '';
      bytes = 0;
      limit = 74; // the leading space of a continuation line counts too
    }
    cur += ch;
    bytes += b;
  }
  parts.push(cur);
  return parts.join('\r\n ');
}

const toText = (lines) => `${lines.map(foldLine).join('\r\n')}\r\n`;

function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? ''));
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? { y, mo, d } : null;
}

function parseTime(s) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(s ?? ''));
  return m ? { h: Number(m[1]), mi: Number(m[2]) } : null;
}

const ymd = (t) => `${t.getUTCFullYear()}${pad2(t.getUTCMonth() + 1)}${pad2(t.getUTCDate())}`;
const hms = (t) => `${pad2(t.getUTCHours())}${pad2(t.getUTCMinutes())}00`;

function stamp(dtstamp) {
  if (typeof dtstamp === 'string' && /^\d{8}T\d{6}Z$/.test(dtstamp)) return dtstamp;
  const d = dtstamp instanceof Date ? dtstamp : dtstamp ? new Date(dtstamp) : new Date();
  const safe = Number.isNaN(d.getTime()) ? new Date() : d;
  return safe.toISOString().replace(/[-:]|\.\d{3}/g, '');
}

function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

const alarm = (trigger, text) => ['BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escapeText(text)}`, `TRIGGER:${trigger}`, 'END:VALARM'];
const header = () => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//hospital-step//notes//KO', 'CALSCALE:GREGORIAN'];

/**
 * One calendar entry for the next visit. `date` 'YYYY-MM-DD' is required (null is returned when
 * it is missing or not a real date); `time` 'HH:MM' optional; `place` optional. Two alarms: one
 * day before and two hours before. Without a time the entry is an all-day event and the alarms
 * fall on 09:00 the day before and 08:00 the same day. `dtstamp` (Date or 'YYYYMMDDTHHMMSSZ')
 * and `uid` are injectable for deterministic output.
 */
export function visitIcs({ date, time = null, place = null, dtstamp = undefined, uid = null } = {}) {
  const d = parseDate(date);
  if (!d) return null;
  const t = parseTime(time);
  const start = new Date(Date.UTC(d.y, d.mo - 1, d.d, t ? t.h : 0, t ? t.mi : 0));
  const id = uid || `visit-${date}${t ? `T${time.replace(':', '')}` : ''}-${hash(`${date}|${time}|${place}`)}@hospital-step`;
  const lines = [...header(), 'BEGIN:VEVENT', `UID:${id}`, `DTSTAMP:${stamp(dtstamp)}`];
  if (t) {
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    lines.push(`DTSTART:${ymd(start)}T${hms(start)}`, `DTEND:${ymd(end)}T${hms(end)}`);
  } else {
    const next = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    lines.push(`DTSTART;VALUE=DATE:${ymd(start)}`, `DTEND;VALUE=DATE:${ymd(next)}`);
  }
  lines.push(`SUMMARY:${escapeText(VISIT_SUMMARY)}`);
  if (place && String(place).trim()) lines.push(`LOCATION:${escapeText(String(place).trim())}`);
  if (t) lines.push(...alarm('-P1D', VISIT_SUMMARY), ...alarm('-PT2H', VISIT_SUMMARY));
  else lines.push(...alarm('-PT15H', VISIT_SUMMARY), ...alarm('PT8H', VISIT_SUMMARY));
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return toText(lines);
}

/**
 * Daily repeating "time to take medicine" entries, one per slot. `slots` is [{label, time}] with
 * `time` 'HH:MM' chosen by the user (the app never suggests one); slots without a valid time are
 * skipped. Repeats for `days` days (default 30, 1..365) via RRULE COUNT. Returns null when
 * `startDate` is missing or no slot has a valid time. The alarm fires at the start time.
 */
export function medIcs({ slots = [], startDate, days = DEFAULT_MED_DAYS, dtstamp = undefined } = {}) {
  const d = parseDate(startDate);
  if (!d) return null;
  const count = Number.isInteger(days) && days >= 1 && days <= 365 ? days : DEFAULT_MED_DAYS;
  const stampText = stamp(dtstamp);
  const events = [];
  (Array.isArray(slots) ? slots : []).forEach((slot, i) => {
    const t = parseTime(slot && slot.time);
    if (!t) return;
    const start = new Date(Date.UTC(d.y, d.mo - 1, d.d, t.h, t.mi));
    const end = new Date(start.getTime() + 15 * 60 * 1000);
    const label = slot && typeof slot.label === 'string' ? slot.label.trim() : '';
    events.push(
      'BEGIN:VEVENT',
      `UID:med-${startDate}-${i}-${hash(`${startDate}|${slot.time}|${label}|${count}`)}@hospital-step`,
      `DTSTAMP:${stampText}`,
      `DTSTART:${ymd(start)}T${hms(start)}`,
      `DTEND:${ymd(end)}T${hms(end)}`,
      `RRULE:FREQ=DAILY;COUNT=${count}`,
      `SUMMARY:${escapeText(MED_SUMMARY)}`,
      ...(SAFE_LABELS.includes(label) ? [`DESCRIPTION:${escapeText(label)}`] : []),
      ...alarm('PT0S', MED_SUMMARY),
      'END:VEVENT',
    );
  });
  if (!events.length) return null;
  return toText([...header(), ...events, 'END:VCALENDAR']);
}
