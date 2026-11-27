// Photos of papers (a prescription, a paper the doctor or nurse wrote) kept on this phone only,
// in IndexedDB (localStorage is far too small for pictures). Nothing here talks to a network.
//
// The store is injectable: createPhotoStore(backend) takes any object with async
// {getAll(), get(id), put(rec), remove(id), clear()}, so Node tests run a fake. The default backend
// wraps IndexedDB and fails soft: when IndexedDB is missing or blocked (private mode, Node) every call
// resolves to an 'unavailable' result or an empty list and never throws.
//
// Like the visit records, nothing is deleted silently: add() refuses with reason 'full' at 20 photos
// and the caller asks the user, then calls dropOldest() and adds again.

export const MAX_PHOTOS = 20;
export const PHOTO_KINDS = ['rx', 'memo']; // rx: prescription, memo: a paper written for me
export const PHOTO_MAX_PX = 1600; // longest side of the saved picture
export const THUMB_MAX_PX = 200; // longest side of the list thumbnail
export const PHOTO_QUALITY = 0.8; // JPEG quality of the saved picture
export const THUMB_QUALITY = 0.7;

export const PHOTO_DB = 'hospital-step-photos';
export const PHOTO_STORE = 'photos';

const KIND_LABEL = { rx: '처방전 사진', memo: '적어 주신 종이 사진' };

// ------------------------------------------------------------------ pure helpers

/** Size that fits width x height into a max x max box: keeps the aspect ratio, never upscales, whole pixels >= 1. */
export function fitSize(w, h, max) {
  const W = Number.isFinite(w) && w > 0 ? w : 1;
  const H = Number.isFinite(h) && h > 0 ? h : 1;
  const M = Number.isFinite(max) && max > 0 ? max : 1;
  const k = Math.min(1, M / Math.max(W, H));
  return { width: Math.max(1, Math.round(W * k)), height: Math.max(1, Math.round(H * k)) };
}

/** '11월 27일 처방전 사진' from the stored local date (no leading zeros); no date: the kind only. */
export function photoTitle(photo) {
  const label = KIND_LABEL[photo && photo.kind] || '사진';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(photo && typeof photo.date === 'string' ? photo.date : '');
  if (!m) return label;
  return `${Number(m[2])}월 ${Number(m[3])}일 ${label}`;
}

const isObj = (v) => v && typeof v === 'object';
const intOr = (v, d) => (Number.isInteger(v) && v > 0 ? v : d);

/** A clean photo record or null when `raw` cannot be one (unknown kind, no picture, no id). */
export function sanitizePhoto(raw) {
  if (!isObj(raw) || typeof raw.id !== 'string' || !raw.id || raw.id.length > 64) return null;
  if (!PHOTO_KINDS.includes(raw.kind) || !isObj(raw.blob)) return null;
  return {
    id: raw.id,
    kind: raw.kind,
    blob: raw.blob,
    thumb: isObj(raw.thumb) ? raw.thumb : null,
    width: intOr(raw.width, 1),
    height: intOr(raw.height, 1),
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : 0,
    date: typeof raw.date === 'string' ? raw.date.slice(0, 10) : '',
  };
}

// WebKit cannot store a Blob in IndexedDB (private browsing, some versions): the database holds
// ArrayBuffer + MIME type, and the store turns them back into Blobs on the way out.
async function toBuffer(blob) {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  if (typeof Response === 'function') return new Response(blob).arrayBuffer(); // older WebKit
  return new Promise((resolve, reject) => { // last resort
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error || new Error('read failed'));
    r.readAsArrayBuffer(blob);
  });
}

/** The row written to the database: no Blob anywhere in it. */
async function toRow(photo) {
  return {
    id: photo.id,
    kind: photo.kind,
    data: await toBuffer(photo.blob),
    type: photo.blob.type || 'image/jpeg',
    thumbData: photo.thumb ? await toBuffer(photo.thumb) : null,
    thumbType: photo.thumb ? (photo.thumb.type || 'image/jpeg') : null,
    width: photo.width,
    height: photo.height,
    createdAt: photo.createdAt,
    date: photo.date,
  };
}

const isBuf = (v) => v instanceof ArrayBuffer || (isObj(v) && typeof v.byteLength === 'number' && typeof v.slice === 'function');

/** A photo (with Blobs) from a stored row, or null when the row cannot be one. */
function fromRow(raw) {
  if (!isObj(raw) || !isBuf(raw.data)) return null;
  return sanitizePhoto({
    ...raw,
    blob: new Blob([raw.data], { type: typeof raw.type === 'string' ? raw.type : 'image/jpeg' }),
    thumb: isBuf(raw.thumbData) ? new Blob([raw.thumbData], { type: typeof raw.thumbType === 'string' ? raw.thumbType : 'image/jpeg' }) : null,
  });
}

const newestFirst = (a, b) => (b.createdAt - a.createdAt) || (a.id < b.id ? 1 : (a.id > b.id ? -1 : 0));
const meta = (p) => ({ id: p.id, kind: p.kind, thumb: p.thumb, width: p.width, height: p.height, createdAt: p.createdAt, date: p.date });

function newId() {
  const rnd = Math.floor(Math.random() * 0x7fffffff).toString(36);
  return `p-${Date.now().toString(36)}-${rnd}`;
}

// ------------------------------------------------------------------ backend (IndexedDB)

const unavailable = (why) => Object.assign(new Error(why), { unavailable: true });

/** The default backend. It opens the database on first use and never throws synchronously. */
export function defaultBackend() {
  let opening = null;
  const open = () => {
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      let idb = null;
      try {
        idb = typeof indexedDB !== 'undefined' ? indexedDB : null;
      } catch {
        idb = null; // access itself can throw when storage is blocked
      }
      if (!idb) { reject(unavailable('no indexedDB')); return; }
      let req;
      try {
        req = idb.open(PHOTO_DB, 1);
      } catch (e) {
        reject(unavailable(String(e && e.message))); return;
      }
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(PHOTO_STORE)) req.result.createObjectStore(PHOTO_STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(unavailable('open failed'));
      req.onblocked = () => reject(unavailable('open blocked'));
    });
    opening.catch(() => { opening = null; }); // a later call may try again
    return opening;
  };
  const run = (mode, fn) => open().then((db) => new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(PHOTO_STORE, mode);
    } catch (e) {
      reject(e); return;
    }
    const st = tx.objectStore(PHOTO_STORE);
    let result;
    const req = fn(st);
    if (req) req.onsuccess = () => { result = req.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error || new Error('transaction failed')); // tx.error can be null (WebKit)
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
  }));
  return {
    getAll: () => run('readonly', (s) => s.getAll()),
    get: (id) => run('readonly', (s) => s.get(id)),
    put: (rec) => run('readwrite', (s) => s.put(rec)),
    remove: (id) => run('readwrite', (s) => s.delete(id)),
    clear: () => run('readwrite', (s) => s.clear()),
  };
}

// ------------------------------------------------------------------ store

const failure = (e) => ({ ok: false, reason: e && e.unavailable ? 'unavailable' : 'error' });

export function createPhotoStore(backend = defaultBackend()) {
  async function readAll() {
    const raw = await backend.getAll();
    return (Array.isArray(raw) ? raw : []).map(fromRow).filter(Boolean).sort(newestFirst);
  }

  return {
    /**
     * Saves one photo: {kind, blob, thumb, width, height, createdAt, date}. Resolves
     * {ok: true, photo} (the stored record, with its picture) or {ok: false, reason}, reason being
     * 'full' (20 photos), 'unavailable' (no storage here) or 'error'.
     */
    async add(input) {
      try {
        const all = await readAll();
        if (all.length >= MAX_PHOTOS) return { ok: false, reason: 'full' };
        const photo = sanitizePhoto({ ...(isObj(input) ? input : {}), id: newId() });
        if (!photo) return { ok: false, reason: 'error' };
        await backend.put(await toRow(photo));
        return { ok: true, photo };
      } catch (e) {
        return failure(e);
      }
    },
    /** Newest first, each with its thumbnail but without the full picture. Empty when storage is unavailable. */
    async list() {
      try {
        return (await readAll()).map(meta);
      } catch {
        return [];
      }
    },
    /** One photo with its full picture, or null. */
    async get(id) {
      try {
        return fromRow(await backend.get(id));
      } catch {
        return null;
      }
    },
    /** True when the photo existed and was removed. */
    async remove(id) {
      try {
        const there = fromRow(await backend.get(id));
        if (!there) return false;
        await backend.remove(id);
        return true;
      } catch {
        return false;
      }
    },
    /** Removes the oldest photo and returns its metadata, or null when there is none. */
    async dropOldest() {
      try {
        const all = await readAll();
        if (!all.length) return null;
        const gone = all[all.length - 1];
        await backend.remove(gone.id);
        return meta(gone);
      } catch {
        return null;
      }
    },
    /** Deletes every photo (settings). True when storage accepted it (nothing to clear counts). */
    async clear() {
      try {
        await backend.clear();
        return true;
      } catch (e) {
        return Boolean(e && e.unavailable); // no storage here means no photos either
      }
    },
    async count() {
      try {
        return (await readAll()).length;
      } catch {
        return 0;
      }
    },
  };
}

// ------------------------------------------------------------------ browser-only: resize

/** Decodes a picture file, honouring its EXIF orientation. Returns {source, width, height, close()}. */
async function decode(file) {
  if (typeof createImageBitmap === 'function') {
    let bmp = null;
    try {
      bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      try { bmp = await createImageBitmap(file); } catch { bmp = null; }
    }
    if (bmp) return { source: bmp, width: bmp.width, height: bmp.height, close: () => { if (bmp.close) bmp.close(); } };
  }
  // Fallback: <img>; current browsers apply the EXIF orientation to it by themselves.
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    if (typeof img.decode === 'function') await img.decode();
    else await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('image load failed')); });
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}

/** Shrinks a picture file to at most max px on the longest side and returns {blob (JPEG), width, height}. */
export async function resizeImage(file, max = PHOTO_MAX_PX, quality = PHOTO_QUALITY) {
  const img = await decode(file);
  try {
    const { width, height } = fitSize(img.width, img.height, max);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext('2d');
    g.fillStyle = '#fff'; // a transparent picture must not turn black in JPEG
    g.fillRect(0, 0, width, height);
    g.drawImage(img.source, 0, 0, width, height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (!blob) throw new Error('could not encode the picture');
    return { blob, width, height };
  } finally {
    img.close();
  }
}

/** What add() needs from a chosen file: the saved picture and its list thumbnail. */
export async function prepareImages(file) {
  const main = await resizeImage(file, PHOTO_MAX_PX, PHOTO_QUALITY);
  const small = await resizeImage(main.blob, THUMB_MAX_PX, THUMB_QUALITY);
  return { blob: main.blob, width: main.width, height: main.height, thumb: small.blob };
}
