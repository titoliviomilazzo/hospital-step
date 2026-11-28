// SVG arrow built from two 3D images (static dial + rotating pointer). The angle is degrees clockwise from "up"; 0 points up. Browser only, no animation.
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
  const svg = svgEl('svg', { viewBox: '0 0 100 100', width: '100%', height: '100%', role: 'img',
    'aria-label': '가야 할 방향을 가리키는 화살표', class: 'arrow-svg' });
  // Static dial; it never rotates.
  svg.append(svgEl('image', { href: 'img/icons/arrow-base.webp', x: 0, y: 0, width: 100, height: 100,
    preserveAspectRatio: 'xMidYMid meet' }));
  // Pointer drawn at 85% so its corners stay inside the dial's cream disc at every angle.
  const g = svgEl('g', { class: 'arrow-rot' });
  g.append(svgEl('image', { href: 'img/icons/arrow-pointer.webp', x: 7.5, y: 7.5, width: 85, height: 85,
    preserveAspectRatio: 'xMidYMid meet' }));
  svg.append(g);
  setArrow2dAngle(svg, angle);
  return svg;
}
