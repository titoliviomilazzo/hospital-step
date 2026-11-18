// Flat SVG arrow. The angle is degrees clockwise from "up"; 0 points up. Browser only, no animation.
const NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

export function setArrow2dAngle(svg, angle) {
  const g = svg.querySelector('g.arrow-rot');
  if (g) g.setAttribute('transform', `rotate(${angle} 50 50)`);
}

export function renderArrow2d(angle = 0) {
  const svg = svgEl('svg', { viewBox: '0 0 100 100', width: 160, height: 160, role: 'img',
    'aria-label': '가야 할 방향을 가리키는 화살표', class: 'arrow-svg' });
  svg.append(svgEl('circle', { cx: 50, cy: 50, r: 46, fill: '#fff', stroke: '#38bdf8', 'stroke-width': 4 }));
  const g = svgEl('g', { class: 'arrow-rot' });
  g.append(
    svgEl('rect', { x: 43, y: 42, width: 14, height: 38, fill: '#facc15', stroke: '#111827', 'stroke-width': 2 }),
    svgEl('polygon', { points: '50,12 72,44 28,44', fill: '#ef4444', stroke: '#111827', 'stroke-width': 2,
      'stroke-linejoin': 'round' }),
  );
  svg.append(g);
  setArrow2dAngle(svg, angle);
  return svg;
}
