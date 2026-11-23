// Small Korean text helpers (particles and numerals). Pure, importable in Node.

/** Final consonant code of the last Hangul syllable of `word`: -1 when it is not Hangul, 0 when none. */
function finalCode(word) {
  const s = String(word ?? '').trim();
  for (let i = s.length - 1; i >= 0; i -= 1) {
    const c = s.charCodeAt(i);
    if (c >= 0xac00 && c <= 0xd7a3) return (c - 0xac00) % 28;
    if (/[A-Za-z0-9]/.test(s[i])) return -1; // not Hangul: callers use the vowel form
  }
  return -1;
}

/** `word` + 은 or 는. */
export function withTopic(word) {
  return `${word}${finalCode(word) > 0 ? '은' : '는'}`;
}

/** `word` + 을 or 를. */
export function withObject(word) {
  return `${word}${finalCode(word) > 0 ? '을' : '를'}`;
}

/** `word` + 로 or 으로 (a final ㄹ takes 로). */
export function withMeans(word) {
  const f = finalCode(word);
  return `${word}${f > 0 && f !== 8 ? '으로' : '로'}`;
}

const SINO = ['영', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구'];

/** Writes every digit as its Sino-Korean syllable ("1동 1층" becomes "일동 일층"), for spoken text. */
export function digitsToHangul(text) {
  return String(text).replace(/\d/g, (d) => SINO[Number(d)]);
}
