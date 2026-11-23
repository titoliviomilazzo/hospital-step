// Pinch-to-zoom and pan for the two built-in maps (outdoor map, floor plan).
//
// The math is pure (no DOM) so it can be tested. The view is {scale, tx, ty}: the map is drawn with
// `transform: translate(tx px, ty px) scale(scale)` from its top-left corner inside a frame of w x h
// pixels, so a content point c (in frame pixels at 1x) appears at screen point c * scale + t.

export const ZOOM_MIN = 1;
export const ZOOM_MAX = 4;
export const ZOOM_STEP = 1.5; // factor of one [크게] / [작게] press
export const IDENTITY = Object.freeze({ scale: 1, tx: 0, ty: 0 });

const finite = (n, fallback) => (Number.isFinite(n) ? n : fallback);

/** Clamps a scale into [min, max]; anything that is not a number counts as 1x. */
export function clampScale(scale, min = ZOOM_MIN, max = ZOOM_MAX) {
  return Math.min(max, Math.max(min, finite(scale, 1)));
}

/** Keeps the map covering its frame: tx in [w*(1-scale), 0], ty in [h*(1-scale), 0]. */
export function clampPan(view, w, h) {
  const scale = finite(view.scale, 1);
  const lo = (size) => Math.min(0, size * (1 - scale));
  const clamp = (v, size) => Math.min(0, Math.max(lo(size), finite(v, 0)));
  return { scale, tx: clamp(view.tx, w), ty: clamp(view.ty, h) };
}

/** Sets a new scale so the content point under (fx, fy) stays under (fx, fy). */
export function zoomAround(view, newScale, fx, fy, w, h, min = ZOOM_MIN, max = ZOOM_MAX) {
  const scale = clampScale(newScale, min, max);
  const cx = (fx - view.tx) / view.scale;
  const cy = (fy - view.ty) / view.scale;
  return clampPan({ scale, tx: fx - cx * scale, ty: fy - cy * scale }, w, h);
}

/**
 * Two-finger gesture. `start` is the view when the second finger landed, `startMid`/`startDist`
 * the midpoint and finger distance then, `mid`/`dist` the current ones. The content point that was
 * under the start midpoint follows the current midpoint, so the pinch both zooms and pans.
 */
export function pinchView(start, startMid, startDist, mid, dist, w, h, min = ZOOM_MIN, max = ZOOM_MAX) {
  const ratio = startDist > 0 ? dist / startDist : 1;
  const scale = clampScale(start.scale * ratio, min, max);
  const cx = (startMid.x - start.tx) / start.scale;
  const cy = (startMid.y - start.ty) / start.scale;
  return clampPan({ scale, tx: mid.x - cx * scale, ty: mid.y - cy * scale }, w, h);
}

/** One-finger drag by (dx, dy) pixels; a 1x map does not pan. */
export function panView(view, dx, dy, w, h) {
  return clampPan({ scale: view.scale, tx: view.tx + dx, ty: view.ty + dy }, w, h);
}

/** One button press: zoom by `factor` (or its inverse) around the centre of the frame. */
export function stepView(view, factor, w, h, min = ZOOM_MIN, max = ZOOM_MAX) {
  return zoomAround(view, view.scale * factor, w / 2, h / 2, w, h, min, max);
}

export const viewTransform = (v) => `translate(${v.tx}px, ${v.ty}px) scale(${v.scale})`;

// ------------------------------------------------------------------ DOM controller

const DOUBLE_TAP_MS = 350;
const TAP_SLOP_PX = 12;

/**
 * Makes the map inside `host` zoomable. The host survives redraws (they replace its children), so
 * listeners live on it and `reapply()` re-wraps and re-transforms the fresh svg after each redraw.
 * An optional persistent `bar` node (the zoom buttons) is kept right after the frame, above any caption,
 * so the map and its buttons are on screen together; the same node survives every redraw.
 * Returns {zoomIn, zoomOut, reset, reapply, view}.
 */
export function attachZoom(host, { min = ZOOM_MIN, max = ZOOM_MAX, bar = null } = {}) {
  let view = { ...IDENTITY };
  const pointers = new Map(); // pointerId -> {x, y} in host coordinates
  let pinch = null; // {view, mid, dist}
  let drag = null; // {x, y} of the single finger
  let moved = false;
  let lastTap = 0;
  let lastTapPos = null;
  host.classList.add('zoom-host');

  const frame = () => host.querySelector('.zoom-frame');
  const svg = () => host.querySelector('.zoom-frame > svg');
  const size = () => {
    const f = frame();
    return f ? { w: f.clientWidth, h: f.clientHeight } : { w: 0, h: 0 };
  };

  function apply() {
    const el = svg();
    if (el) el.style.transform = viewTransform(view);
    host.dataset.zoomed = view.scale > 1.001 ? '1' : '0';
  }

  /** Wraps the current svg in a clipping frame (a no-op when it is already wrapped). */
  function reapply() {
    const el = host.querySelector('svg');
    if (el && !(el.parentElement && el.parentElement.classList.contains('zoom-frame'))) {
      const f = document.createElement('div');
      f.className = 'zoom-frame';
      el.before(f);
      f.append(el);
    }
    const fr = frame();
    if (bar && fr && fr.nextElementSibling !== bar) fr.after(bar);
    const { w, h } = size();
    view = clampPan(view, w, h);
    apply();
  }

  function set(next) {
    view = next;
    apply();
  }

  const local = (e) => {
    const r = (frame() || host).getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const two = () => {
    const [a, b] = [...pointers.values()];
    return { mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, dist: Math.hypot(a.x - b.x, a.y - b.y) };
  };

  function beginPinch() {
    const { mid, dist } = two();
    pinch = { view: { ...view }, mid, dist };
    drag = null;
    moved = true;
  }

  host.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (!svg() || !(e.target.closest && e.target.closest('.zoom-frame'))) return; // the caption is not part of the map
    pointers.set(e.pointerId, local(e));
    try { host.setPointerCapture(e.pointerId); } catch { /* not capturable; events still arrive */ }
    if (pointers.size === 1) {
      drag = { ...pointers.get(e.pointerId) };
      moved = false;
    } else if (pointers.size === 2) {
      beginPinch();
    }
  });

  host.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, local(e));
    const { w, h } = size();
    if (pinch && pointers.size >= 2) {
      const cur = two();
      set(pinchView(pinch.view, pinch.mid, pinch.dist, cur.mid, cur.dist, w, h, min, max));
      e.preventDefault();
    } else if (drag && pointers.size === 1 && view.scale > 1.001) {
      const p = pointers.get(e.pointerId);
      const dx = p.x - drag.x;
      const dy = p.y - drag.y;
      if (Math.hypot(dx, dy) > 1) moved = true;
      drag = { ...p };
      set(panView(view, dx, dy, w, h));
      e.preventDefault();
    } else if (drag) {
      const p = pointers.get(e.pointerId);
      if (Math.hypot(p.x - drag.x, p.y - drag.y) > TAP_SLOP_PX) moved = true;
    }
  });

  function release(e, cancelled) {
    if (!pointers.has(e.pointerId)) return;
    const wasSingle = pointers.size === 1 && !pinch;
    pointers.delete(e.pointerId);
    try { host.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    if (pointers.size >= 2) {
      beginPinch(); // a third finger came or went: restart from the current state
    } else if (pointers.size === 1) {
      pinch = null; // the remaining finger keeps panning from where it is
      drag = { ...[...pointers.values()][0] };
    } else {
      pinch = null;
      drag = null;
    }
    if (cancelled || !wasSingle || moved) return;
    const now = e.timeStamp;
    const pos = local(e);
    const near = lastTapPos && Math.hypot(pos.x - lastTapPos.x, pos.y - lastTapPos.y) < 40;
    if (lastTap && now - lastTap < DOUBLE_TAP_MS && near) {
      lastTap = 0;
      lastTapPos = null;
      reset();
    } else {
      lastTap = now;
      lastTapPos = pos;
    }
  }
  host.addEventListener('pointerup', (e) => release(e, false));
  host.addEventListener('pointercancel', (e) => release(e, true));
  // WebKit would otherwise also zoom the whole page on a two-finger gesture over the map.
  host.addEventListener('gesturestart', (e) => e.preventDefault());

  function step(factor) {
    const { w, h } = size();
    set(stepView(view, factor, w, h, min, max));
  }
  function reset() {
    set({ ...IDENTITY });
  }

  reapply();
  return {
    zoomIn: () => step(ZOOM_STEP),
    zoomOut: () => step(1 / ZOOM_STEP),
    reset,
    reapply,
    view: () => ({ ...view }),
  };
}
