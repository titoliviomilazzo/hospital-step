// Visit records in localStorage under their own key (design section 4). Every access is guarded
// so Node, private browsing and corrupted stored text all work. The store is injectable.
//
// Stored text: {"records":[...]} with the newest record first. Nothing is ever deleted silently:
// addRecord() refuses with reason 'full' at 20 records and the caller asks the user, then calls
// dropOldest() and adds again.
import { KINDS } from './notes.js';

export const NOTES_KEY = 'hospital-step.notes.v1';
export const MAX_RECORDS = 20;

const SOURCES = ['listen', 'typed', 'sample'];
const SUMMARIES = ['ai', 'rules', 'none']; // none: transcript only, the summary failed
const STATUSES = ['unconfirmed', 'confirmed'];

function getStore(store) {
  if (store) return store;
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

const str = (v, max = 20000) => (typeof v === 'string' ? v.slice(0, max) : null);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);

function sanitizeItem(raw) {
  const r = obj(raw);
  if (!r || !KINDS.includes(r.kind) || typeof r.text !== 'string') return null;
  const item = {
    kind: r.kind,
    text: r.text.slice(0, 400),
    source: str(r.source, 600) ?? '',
    status: STATUSES.includes(r.status) ? r.status : 'unconfirmed',
    edited: r.edited === true,
  };
  if (r.kind === 'med' && obj(r.med)) item.med = { ...r.med };
  if (r.kind === 'next' && obj(r.next)) item.next = { ...r.next };
  return item;
}

/** Returns a clean record or null when `raw` cannot be a record. */
export function sanitizeRecord(raw) {
  const r = obj(raw);
  if (!r || typeof r.id !== 'string' || !r.id || r.id.length > 64) return null;
  const consent = obj(r.consent) || {};
  return {
    id: r.id,
    date: str(r.date, 10) ?? '',
    hospital: str(r.hospital, 60),
    consent: { doctor: consent.doctor === true, at: str(consent.at, 40) },
    source: SOURCES.includes(r.source) ? r.source : 'typed',
    transcript: str(r.transcript) ?? '',
    items: (Array.isArray(r.items) ? r.items : []).map(sanitizeItem).filter(Boolean),
    dropped: Number.isInteger(r.dropped) && r.dropped >= 0 ? r.dropped : 0,
    summary: SUMMARIES.includes(r.summary) ? r.summary : 'none',
  };
}

function readAll(store) {
  const s = getStore(store);
  if (!s) return [];
  try {
    const text = s.getItem(NOTES_KEY);
    if (!text) return [];
    const parsed = JSON.parse(text);
    const list = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.records) ? parsed.records : [];
    return list.map(sanitizeRecord).filter(Boolean);
  } catch {
    return []; // corrupted text: start from an empty list; the next write replaces it
  }
}

function writeAll(records, store) {
  const s = getStore(store);
  if (!s) return false;
  try {
    s.setItem(NOTES_KEY, JSON.stringify({ records }));
    return true;
  } catch {
    return false; // quota or blocked storage
  }
}

/** All records, newest first. */
export function listRecords(store = null) {
  return readAll(store);
}

export function countRecords(store = null) {
  return readAll(store).length;
}

export function isFull(store = null) {
  return countRecords(store) >= MAX_RECORDS;
}

export function getRecord(id, store = null) {
  return readAll(store).find((r) => r.id === id) || null;
}

/**
 * Adds a record at the top. Returns {ok: true, record} or {ok: false, reason} with reason
 * 'invalid' | 'duplicate' | 'full' | 'storage'. At the cap it refuses; see dropOldest().
 */
export function addRecord(record, store = null) {
  const rec = sanitizeRecord(record);
  if (!rec) return { ok: false, reason: 'invalid' };
  const all = readAll(store);
  if (all.some((r) => r.id === rec.id)) return { ok: false, reason: 'duplicate' };
  if (all.length >= MAX_RECORDS) return { ok: false, reason: 'full' };
  return writeAll([rec, ...all], store) ? { ok: true, record: rec } : { ok: false, reason: 'storage' };
}

/** Removes the oldest record and returns it, or null when there is none. */
export function dropOldest(store = null) {
  const all = readAll(store);
  if (!all.length) return null;
  const gone = all[all.length - 1];
  return writeAll(all.slice(0, -1), store) ? gone : null;
}

/** Removes one record. True when it existed and storage accepted the change. */
export function removeRecord(id, store = null) {
  const all = readAll(store);
  const rest = all.filter((r) => r.id !== id);
  if (rest.length === all.length) return false;
  return writeAll(rest, store);
}

/** Merges `patch` (top-level fields, e.g. {items}) into a record. Returns the record or null. */
export function updateRecord(id, patch, store = null) {
  const all = readAll(store);
  const at = all.findIndex((r) => r.id === id);
  if (at < 0) return null;
  const next = sanitizeRecord({ ...all[at], ...(obj(patch) || {}), id });
  if (!next) return null;
  all[at] = next;
  return writeAll(all, store) ? next : null;
}

/** Deletes every record (settings: 진료 기록 모두 지우기). */
export function clearRecords(store = null) {
  const s = getStore(store);
  if (!s) return false;
  try {
    if (typeof s.removeItem === 'function') s.removeItem(NOTES_KEY);
    else s.setItem(NOTES_KEY, JSON.stringify({ records: [] }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Builds a record of the shape in design section 4. `items` come from validateNotesReply; each
 * starts as 'unconfirmed' (확인 전). `id` is generated as v-YYYYMMDD-n unless given; `existingIds`
 * keeps n unique. consentAt null means no doctor consent (typed or sample records).
 */
export function makeRecord({
  date, hospital = null, consentAt = null, source = 'typed', transcript = '', items = [],
  dropped = 0, summary = 'none', id = null, existingIds = [],
}) {
  let rid = id;
  if (!rid) {
    const stem = `v-${String(date || '').replace(/-/g, '')}`;
    let n = 1;
    while (existingIds.includes(`${stem}-${n}`)) n += 1;
    rid = `${stem}-${n}`;
  }
  return {
    id: rid,
    date,
    hospital,
    consent: { doctor: Boolean(consentAt), at: consentAt },
    source,
    transcript,
    items: items.map((it) => ({ ...it, status: it.status || 'unconfirmed', edited: it.edited === true })),
    dropped,
    summary,
  };
}
