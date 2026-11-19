// Simulation mode: a labelled schematic (not to scale), a heading slider and the arrow geometry.
// The pure part is importable in Node. Axis convention: sim x is east, sim y is NORTH (up on the
// mini map). The sim values in the route data are a schematic, never real positions.
import { schematicBearingDeg, arrowAngle } from './compass.js';
import { OUTDOOR_STAGES } from './route.js';

export const BANNER_TEXT = '시뮬레이션 · 모식도';
export const MAP_NOTE = '모식도예요. 실제 거리와 방향이 아니에요.';
export const HEADING_MIN = 0;
export const HEADING_MAX = 359;

export function clampHeading(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return HEADING_MIN;
  return Math.min(HEADING_MAX, Math.max(HEADING_MIN, n));
}

export function initialSim() {
  return { heading: 0 };
}

export function simReducer(state, action) {
  if (action && action.type === 'SET_HEADING') return { ...state, heading: clampHeading(action.value) };
  return state;
}

/**
 * Arrow for the point at `index`, or null. Only an outdoor point (travel or return) whose next
 * point is also outdoor gets an arrow: the last outdoor point of a stage and every indoor point
 * show the sign panel only. Returns {bearing, angle}; `bearing` is from sim positions, `angle`
 * is relative to the heading.
 */
export function simArrow(route, index, heading) {
  const cur = route.points[index];
  const next = route.points[index + 1];
  if (!cur || !next || !OUTDOOR_STAGES.includes(cur.stage) || cur.stage !== next.stage) return null;
  if (!cur.sim || !next.sim) return null;
  const bearing = schematicBearingDeg(cur.sim, next.sim);
  return { bearing, angle: arrowAngle(bearing, heading) };
}

/** Maps sim points to SVG coordinates (y flipped so +y is up). Returns {width, height, points}. */
export function mapLayout(points, width = 280, height = 160, pad = 16) {
  const xs = points.map((p) => p.sim.x);
  const ys = points.map((p) => p.sim.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const sx = (width - 2 * pad) / Math.max(maxX - minX, 1);
  const sy = (height - 2 * pad) / Math.max(maxY - minY, 1);
  const s = Math.min(sx, sy);
  return {
    width,
    height,
    points: points.map((p) => ({
      id: p.id,
      x: pad + (p.sim.x - minX) * s,
      y: height - pad - (p.sim.y - minY) * s,
    })),
  };
}

/** Browser only: small SVG mini map with the current point highlighted. */
export function renderMiniMap(route, index) {
  const NS = 'http://www.w3.org/2000/svg';
  const mk = (tag, attrs) => {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    return el;
  };
  const lay = mapLayout(route.points);
  const svg = mk('svg', { viewBox: `0 0 ${lay.width} ${lay.height}`, class: 'mini-map', role: 'img',
    'aria-label': '시뮬레이션 모식도. 현재 위치가 강조되어 있어요.' });
  svg.append(mk('rect', { x: 1, y: 1, width: lay.width - 2, height: lay.height - 2, fill: '#fff',
    stroke: '#1e293b', 'stroke-width': 2, rx: 8 }));
  svg.append(mk('polyline', { points: lay.points.map((p) => `${p.x},${p.y}`).join(' '), fill: 'none',
    stroke: '#94a3b8', 'stroke-width': 2, 'stroke-dasharray': '4 3' }));
  lay.points.forEach((p, i) => {
    const cur = i === index;
    svg.append(mk('circle', { cx: p.x, cy: p.y, r: cur ? 9 : 5, fill: cur ? '#ef4444' : '#e2e8f0',
      stroke: '#111827', 'stroke-width': cur ? 3 : 1.5, 'data-id': p.id, 'data-current': cur ? '1' : '0' }));
  });
  const n = mk('text', { x: lay.width - 14, y: 20, 'text-anchor': 'middle', 'font-size': 14,
    'font-weight': 700, fill: '#111827' });
  n.textContent = '북';
  svg.append(n, mk('path', { d: `M${lay.width - 14} 24 v10 m-4 -6 l4 -5 l4 5`, fill: 'none',
    stroke: '#111827', 'stroke-width': 2 }));
  return svg;
}
