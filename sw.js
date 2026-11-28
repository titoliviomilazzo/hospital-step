// Service worker: lets a reload open the app with no signal (hospital basements).
// Network-first for same-origin GET requests, so a deploy is always seen online; the cache is only
// the fallback when the network fails. Written by tools/stamp_version.py (VERSION and PRECACHE).
// Audio files are not precached (many files); they are cached the first time they are fetched.
const VERSION = '2026-11-28.0920';
const CACHE = 'hospital-step-' + VERSION;
// PRECACHE-START
const PRECACHE = [
  './',
  'style.css?v=2026-11-28.0920',
  'config.js?v=2026-11-28.0920',
  'manifest.webmanifest',
  './js/alight.js?v=2026-11-28.0920',
  './js/app.js?v=2026-11-28.0920',
  './js/areamap.js?v=2026-11-28.0920',
  './js/arrival.js?v=2026-11-28.0920',
  './js/arrow2d.js?v=2026-11-28.0920',
  './js/arrow3d.js?v=2026-11-28.0920',
  './js/clips.js?v=2026-11-28.0920',
  './js/compass.js?v=2026-11-28.0920',
  './js/contrast.js?v=2026-11-28.0920',
  './js/floor.js?v=2026-11-28.0920',
  './js/help.js?v=2026-11-28.0920',
  './js/ics.js?v=2026-11-28.0920',
  './js/intent.js?v=2026-11-28.0920',
  './js/keyplace.js?v=2026-11-28.0920',
  './js/korean.js?v=2026-11-28.0920',
  './js/listen.js?v=2026-11-28.0920',
  './js/navarrow.js?v=2026-11-28.0920',
  './js/notes-flow.js?v=2026-11-28.0920',
  './js/notes-listen.js?v=2026-11-28.0920',
  './js/notes-store.js?v=2026-11-28.0920',
  './js/notes-ui.js?v=2026-11-28.0920',
  './js/notes.js?v=2026-11-28.0920',
  './js/notices.js?v=2026-11-28.0920',
  './js/paper.js?v=2026-11-28.0920',
  './js/photo-store.js?v=2026-11-28.0920',
  './js/pictos.js?v=2026-11-28.0920',
  './js/route.js?v=2026-11-28.0920',
  './js/sim.js?v=2026-11-28.0920',
  './js/storage.js?v=2026-11-28.0920',
  './js/version.js?v=2026-11-28.0920',
  './js/voice.js?v=2026-11-28.0920',
  './js/zoom.js?v=2026-11-28.0920',
  'data/area.migeum-snubh.json?v=2026-11-28.0920',
  'data/floor.snubh-1dong-1f.json?v=2026-11-28.0920',
  'data/route.migeum-snubh.json?v=2026-11-28.0920',
  'data/sample-message.json?v=2026-11-28.0920',
  'data/sample-visit.json?v=2026-11-28.0920',
  'data/support.json?v=2026-11-28.0920',
  'img/apple-touch-icon.png',
  'img/favicon-32.png',
  'img/icon-192.png',
  'img/icon-512.png',
  'img/icon-96.png',
  'img/wordmark.png',
  'img/icons/arrow-base.webp',
  'img/icons/arrow-pointer.webp',
  'img/icons/hero-dept.webp',
  'img/icons/hero-first-visit.webp',
  'img/icons/hero-hospital.webp',
  'img/icons/hero-reception.webp',
  'img/icons/hero-walker.webp',
  'img/icons/hero-walking.webp',
  'img/icons/hero-wheelchair.webp',
  'img/icons/mark-document.webp',
  'img/icons/mark-done.webp',
  'img/icons/mark-idcard.webp',
  'img/icons/mark-mic.webp',
  'img/icons/note-caution.webp',
  'img/icons/note-med.webp',
  'img/icons/note-next.webp',
  'img/icons/note-note.webp',
  'img/icons/note-test.webp',
  'img/icons/note-todo.webp',
  'img/icons/place-blood.webp',
  'img/icons/place-consult.webp',
  'img/icons/place-medicine.webp',
  'img/icons/place-pay.webp',
  'img/icons/place-prescription.webp',
  'img/icons/place-wait.webp',
  'img/icons/place-xray.webp',
  'vendor/three.min.js?v=2026-11-28.0920',
  'audio/manifest.json?v=2026-11-28.0920',
];
// PRECACHE-END

self.addEventListener('install', (event) => {
  // One missing file must not block the install, so each URL is added on its own.
  event.waitUntil(
    caches.open(CACHE).then((cache) => Promise.all(PRECACHE.map((url) => cache.add(url).catch(() => null))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('hospital-step-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// A weak signal can leave a request hanging for a long time, so when a cached copy exists the network
// gets this long before the cached copy is used (the request keeps running and refreshes the cache).
const NETWORK_WAIT_MS = 2500;

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  const lookup = async () => (await cache.match(request)) || (await cache.match(request, { ignoreSearch: true }));
  const network = fetch(request).then((response) => {
    // Only complete (200) responses are stored; partial audio (206) responses cannot be.
    if (response && response.status === 200 && response.type === 'basic') {
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  });
  network.catch(() => {}); // a late failure after the cache answered is not an error
  try {
    if (!(await lookup())) return await network; // nothing cached yet: wait for the network
    let timer;
    const slow = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('slow network')), NETWORK_WAIT_MS); });
    try {
      return await Promise.race([network, slow]);
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    const hit = await lookup();
    if (hit) return hit;
    if (request.mode === 'navigate') {
      const page = await cache.match('./', { ignoreSearch: true });
      if (page) return page;
    }
    throw err;
  }
}

// Safari plays audio with Range requests and the answer is 206 (partial), which the Cache API cannot
// store. For those requests the full file is fetched without the Range header, stored as a normal 200,
// and the requested slice is built from that body (offline too).
const AUDIO_RE = /\.(mp3|m4a|wav|ogg)$/i;

/** Parses "bytes=a-b", "bytes=a-" or "bytes=-n" against a file size; null when it is not satisfiable. */
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec((header || '').trim());
  if (!m || (m[1] === '' && m[2] === '') || size === 0) return null;
  let start;
  let end;
  if (m[1] === '') {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  return start <= end && start < size ? { start, end } : null;
}

async function audioRange(request) {
  const cache = await caches.open(CACHE);
  const key = new Request(request.url); // no Range header: the stored copy is the whole file
  let full = null;
  try {
    const response = await fetch(key);
    if (response && response.status === 200 && response.type === 'basic') {
      cache.put(key, response.clone()).catch(() => {});
      full = response;
    } else if (response) {
      return response; // 404 and the like pass through unchanged
    }
  } catch (err) {
    full = (await cache.match(key)) || null;
  }
  if (!full) return Response.error();
  const body = await full.arrayBuffer();
  const range = parseRange(request.headers.get('range'), body.byteLength);
  if (!range) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${body.byteLength}` } });
  }
  return new Response(body.slice(range.start, range.end + 1), {
    status: 206,
    headers: {
      'Content-Type': full.headers.get('Content-Type') || 'audio/mpeg',
      'Content-Length': String(range.end - range.start + 1),
      'Content-Range': `bytes ${range.start}-${range.end}/${body.byteLength}`,
      'Accept-Ranges': 'bytes',
    },
  });
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  // Cross-origin requests (bus API, fonts) are never touched: the browser handles them as usual.
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.headers.has('range') && AUDIO_RE.test(url.pathname)) {
    event.respondWith(audioRange(request));
    return;
  }
  event.respondWith(networkFirst(request));
});
