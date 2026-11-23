// Sentences said and shown when a spoken answer was not (fully) used. Fixed templates per field and
// value, so the text is deterministic. Pure, importable in Node.
import { FIELDS, optionFor, NOT_HEARD_SENTENCE } from './clips.js';
import { withTopic, withMeans } from './korean.js';

export const NOT_HEARD = NOT_HEARD_SENTENCE;
export const BLOCKED_TAIL = '바꾸시려면 확인 화면에서 [수정]을 눌러 주세요.';

const labelOf = (fieldId) => FIELDS.find((f) => f.id === fieldId).label;

/** An answer to another question was understood and written down. */
export function appliedNotice(fieldId, value) {
  return `${withTopic(labelOf(fieldId))} ${withMeans(optionFor(fieldId, value).label)} 적었어요.`;
}

/** The sentence was understood but a button choice is kept: `value` is the button value. */
export function blockedNotice(fieldId, value) {
  return `${withTopic(labelOf(fieldId))} ${withMeans(optionFor(fieldId, value).label)} 눌러 두셨어요. ${BLOCKED_TAIL}`;
}
