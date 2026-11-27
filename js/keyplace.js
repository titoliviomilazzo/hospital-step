// Finds the destination place name at the start of an instruction sentence, so the screen can
// draw an orange highlighter underlay beneath it. Pure text work, importable in Node.

const PARTICLES = ['에서 ', '으로 ', '로 ', '에 ', '까지 '];
// '?' and '!' end a sentence; so does a '.' followed by a space or the end (a '.' inside a name, as in
// "미금역.농협", does not). A comma means a clause break, not one place name.
const SENTENCE_END = /[?!,]|\.(\s|$)|\.$/;
// A word that ends like a subject, topic, object or connective ending is part of a sentence, not a place name.
const NOT_PLACE_WORD = /[은는이가을를고면요]$/;
const MIN_KEY = 2;
const MAX_KEY = 20;

/**
 * Splits `text` into { before, key, after } when its first phrase (up to 에서 / 으로 / 로 / 에 / 까지)
 * is a place name at the very start of the sentence. `before` is always ''; the particle stays in
 * `after`, so before + key + after equals `text`. Returns null when there is nothing to highlight.
 */
export function keyPlaceSpan(text) {
  if (typeof text !== 'string' || !text) return null;
  let at = -1;
  for (const p of PARTICLES) {
    const i = text.indexOf(p);
    if (i > 0 && (at === -1 || i < at)) at = i;
  }
  if (at < 0) return null;
  const key = text.slice(0, at);
  if (key.length < MIN_KEY || key.length > MAX_KEY) return null;
  if (SENTENCE_END.test(key)) return null;
  if (key.split(' ').some((w) => NOT_PLACE_WORD.test(w))) return null;
  return { before: '', key, after: text.slice(at) };
}
