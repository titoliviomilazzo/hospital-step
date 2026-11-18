// WCAG 2.x contrast helpers and the colour palette the UI uses. Pure, importable in Node.
// style.css repeats these hex values; tests/contrast.test.mjs checks that both agree and that
// every text/background pair listed in TEXT_PAIRS reaches 4.5:1.

export const PALETTE = Object.freeze({
  ink: '#111827',
  bg: '#ffffff',
  card: '#f8fafc',
  muted: '#475569',
  accentPrepare: '#93c5fd',
  accentTravel: '#6ee7b7',
  accentIndoor: '#fde047',
});

/** Every foreground/background pair that carries text in the UI. */
export const TEXT_PAIRS = Object.freeze([
  { name: 'body text on page', fg: 'ink', bg: 'bg' },
  { name: 'body text on card', fg: 'ink', bg: 'card' },
  { name: 'muted text on page', fg: 'muted', bg: 'bg' },
  { name: 'muted text on card', fg: 'muted', bg: 'card' },
  { name: 'header and primary button, prepare', fg: 'ink', bg: 'accentPrepare' },
  { name: 'header and primary button, travel', fg: 'ink', bg: 'accentTravel' },
  { name: 'header and primary button, indoor', fg: 'ink', bg: 'accentIndoor' },
  { name: 'simulation banner', fg: 'ink', bg: 'accentIndoor' },
]);

function channel(v) {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance of a `#rrggbb` colour. */
export function luminance(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`bad colour: ${hex}`);
  const n = parseInt(m[1], 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

/** WCAG contrast ratio between two `#rrggbb` colours, always >= 1. */
export function contrastRatio(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
