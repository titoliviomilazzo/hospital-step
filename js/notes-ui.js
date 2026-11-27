// Screens of the visit-notes feature: N0..N4 (the flow, state in notes-flow.js) and the record
// screens V1/V2 (list, one record). Everything here builds DOM through the `h()` that app.js
// passes in, so this module has no import cycle with app.js and loads in Node without a DOM.
//
// A screen is {instruction, node, compact, noReplay}: app.js puts `instruction` in the page heading,
// `node` in #screen, and hides the bar's primary button while a notes screen is up.
import { CARD_ORDER, CARD_TITLES, DISCLAIMER, speechFor, shareText } from './notes.js';
import { listRecords, getRecord, removeRecord, updateRecord } from './notes-store.js';
import { noteSvg } from './pictos.js';
import { NOTES_SENTENCES } from './clips.js';
import { attachZoom } from './zoom.js';
import { createPhotoStore, photoTitle, prepareImages, PHOTO_KINDS } from './photo-store.js';
import {
  SAMPLE_BAND, SAVED_RESULT_BAND, SUMMARY_LATER, CONSENT_AI_LINE, localDate, recordTitle, nextNeedsDate, datePrefill,
  icsFilename, visitIcsFor, medSlotsFor, medIcsFor, medStartDate, medStartNote, highlightSegments, shareOrCopy,
  finalNote, resummarise, PASTED_SUMMARY_LATER, PASTED_BAND, SAMPLE_MESSAGE_BAND, PASTE_PRIVACY_LINE, PASTE_NONE_MSG,
  PASTE_HINT, DROPPED_PASTE_TEXT, isMessageRecord,
} from './notes-flow.js';

const PHONE_VOICE_LINE = '여기서는 휴대폰 목소리로 읽어 드려요';
const SAVE_HINT = '중요한 내용은 달력에 넣거나 가족에게 보내 두세요';
const DROPPED_TEXT = (n) => `${n}개는 근거를 찾지 못해 뺐어요. 원문에서 확인하세요`;
const statusText = (it) => (it.edited ? '직접 고침' : (it.status === 'unconfirmed' ? '확인 전' : ''));
const EMPTY_LIST = '아직 기록이 없어요. 병원에서 온 문자를 넣어 보세요.';
const HEADER = '내 진료 기록'; // the record screens are not a step of the visit: own header, no step counter
const PHOTO_PRIVACY_LINE = '사진에는 이름과 주민등록번호가 보일 수 있어요. 휴대폰을 빌려줄 때 조심하세요.';
const PHOTO_FULL_TEXT = '사진이 20장이에요. 가장 오래된 사진을 지우고 저장할까요?';
const PHOTO_FAIL_TEXT = '사진을 저장하지 못했어요. 다시 한 번 눌러 주세요.';
const PHOTO_UNAVAILABLE_TEXT = '이 휴대폰에서는 사진을 저장할 수 없어요. 종이를 가방에 꼭 넣어 두세요.';
const sequenceNow = () => Math.floor(Date.now() / 1000); // a later export of the same entry carries a higher SEQUENCE

/**
 * ctx: h, svgNode, flow, say(clipId, text), stopSpeaking(), rerender(), online (true when a notes
 * webhook is configured), onContinue() (N4 done: go on to the next point), onBack() (N0 back to the
 * previous point), onSpeakPoint() (say the sentence of the route point on screen). Optional:
 * photoStore (photo-store.js; default is the IndexedDB one) and zoomBar(getCtl, key, label) (the
 * [크게]/[작게] bar app.js builds for the maps), used by the photo view.
 */
export function createNotesUi(ctx) {
  const { h, svgNode, flow, say, stopSpeaking, rerender } = ctx;
  let view = null; // {kind:'list'} | {kind:'record', id, sub, ...}
  let editText = ''; // text of the N4 edit box
  let readToken = 0;

  // Photos (photo-store.js is async): `photos` is the last loaded list (metadata + thumbnail, newest
  // first), refreshed by refreshPhotos() and rendered synchronously. `shot` is the screen after a
  // camera pick: {phase: 'saving'|'saved'|'full'|'error', kind, returnTo, ...}.
  const photoStore = ctx.photoStore || createPhotoStore();
  let photos = [];
  const thumbUrls = new Map(); // photo id -> object URL of its thumbnail
  let shot = null;
  let shotToken = 0; // a newer pick or a close makes an older save finish silently
  let pending = null; // {kind, returnTo, replaceId} remembered when the camera opens
  let photoInput = null;
  let photoZoom = null;

  const pic = (kind, cls = 'note-pic') => svgNode(noteSvg(kind, cls));
  const btn = (label, attrs = {}) => {
    const { class: extra, ...rest } = attrs;
    return h('button', { type: 'button', ...rest, class: `btn notes-btn${extra ? ` ${extra}` : ''}` }, label);
  };
  const disclaimer = () => h('p', { class: 'notes-disclaimer', id: 'notes-disclaimer' }, DISCLAIMER);
  const band = (text) => h('p', { class: 'notes-band', role: 'note' }, text);

  /** Reads sentences one after another with the phone voice; any newer speech stops the chain. */
  async function readAloud(sentences) {
    const mine = ++readToken;
    for (const s of sentences) {
      if (mine !== readToken) return;
      const ok = await say('notes-dyn', s);
      if (!ok) return;
    }
  }
  const stopReading = () => { readToken += 1; stopSpeaking(); };

  // ------------------------------------------------------------------ N0..N4

  function n0() {
    return {
      instruction: NOTES_SENTENCES.ask,
      node: h('div', { class: 'stack notes-tight', id: 'notes-n0' },
        h('div', { class: 'notes-hero' }, pic('note', 'note-svg')),
        h('p', { class: 'note' }, '선생님이 허락하실 때만 적어요.'),
        btn('네, 적어 둘게요', { id: 'btn-n0-yes', class: 'primary lead', onclick: () => {
          flow.answerN0(true);
          ctx.onSpeakPoint();
        } }),
        btn('아니요', { id: 'btn-n0-no', onclick: () => {
          flow.answerN0(false);
          ctx.onSpeakPoint();
        } }),
        h('div', { class: 'bottom-links' },
          h('button', { class: 'btn small ghost', id: 'btn-n0-back', onclick: () => ctx.onBack() }, '이전 지점으로 돌아가기'))),
    };
  }

  function n1() {
    return {
      instruction: '선생님께 보여 주세요',
      compact: true,
      node: h('div', { class: 'stack notes-tight', id: 'notes-n1' },
        h('div', { class: 'card notes-consent' },
          h('p', { class: 'notes-big' }, NOTES_SENTENCES.consent),
          h('ul', { class: 'notes-points' },
            h('li', {}, '소리는 저장하지 않습니다'),
            h('li', {}, '글자만 이 휴대폰에 남습니다'),
            h('li', {}, '받아 적는 동안 음성 인식 서비스를 거칩니다'),
            ctx.online ? h('li', { id: 'notes-ai-line' }, CONSENT_AI_LINE) : null)),
        // The microphone starts only inside this tap, which is the doctor's own.
        h('div', { class: 'notes-duo' },
          btn('아니요', { id: 'btn-n1-no', onclick: () => {
            flow.declineConsent();
            say('notes-declined', NOTES_SENTENCES.declined);
          } }),
          btn('네, 괜찮습니다', { id: 'btn-n1-yes', class: 'primary', onclick: () => {
            stopSpeaking(); // the microphone must not hear the app's own voice
            flow.grantConsent();
          } }))),
    };
  }

  function n1Declined() {
    return {
      instruction: NOTES_SENTENCES.declined,
      node: h('div', { class: 'stack', id: 'notes-n1-no' },
        btn('진료 화면으로', { id: 'btn-n1-close', class: 'primary lead', onclick: () => { flow.closeDeclined(); ctx.onSpeakPoint(); } })),
    };
  }

  function n2() {
    const f = flow.state;
    const live = f.listening;
    const box = h('div', { class: 'notes-text', id: 'notes-text', 'aria-live': 'polite' },
      f.lines.length ? f.lines.map((t) => h('p', {}, t)) : h('p', { class: 'muted' }, live ? '말씀을 기다리고 있어요...' : ''));
    const stopBtn = btn(live || f.typed.trim() || f.lines.length ? '그만 적기' : '이 글로 정리하기', {
      id: 'btn-n2-stop', class: 'stop', onclick: () => {
        flow.stop().then(() => rerender()); // the flow holds the typed text itself
      },
    });
    const typed = f.typedOpen
      ? h('div', { class: 'typed' },
        h('label', { for: 'notes-typed', class: 'note' }, '선생님 말씀을 글로 적어 주세요.'),
        h('textarea', { id: 'notes-typed', rows: 3, oninput: (e) => flow.setTyped(e.target.value) }, f.typed))
      : null;
    // [적지 않고 닫기] is shown while listening too: it stops the microphone, drops the text, saves nothing.
    const cancelBtn = h('button', { class: 'btn small ghost', id: 'btn-n2-cancel', onclick: () => {
      flow.cancelCapture();
      ctx.onSpeakPoint();
    } }, '적지 않고 닫기');
    const typedBtn = !f.typedOpen && !f.sample
      ? h('button', { class: 'btn small ghost', id: 'btn-n2-typed', onclick: () => flow.openTyped() }, '글로 적기') : null;
    const hint = live ? h('p', { class: 'notes-hint', id: 'notes-last-say' }, '선생님, 꼭 지킬 것을 한 번만 더 말씀해 주세요') : null;
    // The two small buttons share a row (and on the example run the hint shares it too) so everything
    // stays above the fixed bar on a 560 px phone.
    const foot = f.sample && hint
      ? [typed, stopBtn, h('div', { class: 'n2-foot-inline' }, hint, cancelBtn)]
      : [hint, typed, stopBtn, h('div', { class: 'n2-links' }, typedBtn, cancelBtn)];
    const kids = [
      h('div', { class: live ? 'rec-bar live' : 'rec-bar', id: 'rec-bar', role: 'status' },
        h('span', { class: 'rec-dot', 'aria-hidden': 'true' }),
        h('span', { class: 'rec-label' }, live ? '받아 적는 중' : (f.typedOpen ? '글로 적는 중' : '멈춤')),
        f.sample ? h('span', { class: 'rec-tag', id: 'rec-sample-tag' }, SAMPLE_BAND) : null),
      box,
      f.msg ? h('p', { class: 'note', id: 'notes-msg', role: 'status' }, f.msg) : null,
      ...foot,
    ];
    return { instruction: '선생님 말씀을 적고 있어요', compact: true, noReplay: live, node: h('div', { class: 'stack notes-tight notes-n2', id: 'notes-n2' }, kids) };
  }

  function n3() {
    return {
      instruction: NOTES_SENTENCES.summarising,
      node: h('div', { class: 'stack', id: 'notes-n3' },
        h('div', { class: 'notes-hero' }, pic('note', 'note-svg')),
        h('p', { class: 'note', role: 'status' }, ctx.online
          ? '이름과 번호를 가린 글자만 인터넷으로 보내 정리해요. 소리는 저장하지 않았어요.'
          : '휴대폰 안에서 글자만 정리해요. 소리는 저장하지 않았어요.')),
    };
  }

  function p0() {
    const f = flow.state;
    const text = h('textarea', {
      id: 'paste-text', class: 'paste-text', rows: 5, 'aria-label': '병원에서 온 문자',
      placeholder: '문자를 길게 눌러 복사한 뒤 여기에 붙여넣어 주세요',
      oninput: (e) => {
        flow.setPasteText(e.target.value);
        const go = document.getElementById('btn-paste-go');
        if (go) go.disabled = !e.target.value.trim();
      },
    }, f.pasteText);
    const sim = typeof ctx.isSim === 'function' && ctx.isSim();
    return {
      instruction: NOTES_SENTENCES.pasteAsk,
      compact: true,
      node: h('div', { class: 'stack notes-tight notes-paste', id: 'notes-paste' },
        f.pasteSample ? band(SAMPLE_MESSAGE_BAND) : null,
        text,
        h('p', { class: 'note', id: 'paste-msg', role: 'status' }, f.pasteMsg || PASTE_HINT), // the way to paste is told at once, not only after a failed [붙여넣기]
        h('div', { class: 'notes-duo' },
          btn('붙여넣기', { id: 'btn-paste-clip', onclick: () => { flow.pasteFromClipboard(); } }),
          btn('정리하기', { id: 'btn-paste-go', class: 'primary', disabled: f.pasteText.trim() ? null : true, onclick: () => { flow.organise(); } })),
        h('p', { class: 'note', id: 'paste-privacy' }, PASTE_PRIVACY_LINE),
        h('div', { class: 'n2-links' },
          sim ? h('button', { type: 'button', class: 'btn small ghost', id: 'btn-paste-sample', onclick: () => flow.fillSampleMessage() }, '예시 문자 넣기') : null,
          h('button', { type: 'button', class: 'btn small ghost', id: 'btn-paste-cancel', onclick: () => flow.leave() }, '그만두기'))),
    };
  }

  function p1() {
    return {
      instruction: NOTES_SENTENCES.pasteNone,
      compact: true,
      node: h('div', { class: 'stack', id: 'notes-paste-none' },
        h('p', { class: 'notes-big', id: 'paste-none-msg' }, PASTE_NONE_MSG),
        flow.state.dropped > 0 ? h('p', { class: 'note', id: 'paste-dropped', role: 'status' }, DROPPED_PASTE_TEXT(flow.state.dropped)) : null,
        btn('다시 넣기', { id: 'btn-paste-again', class: 'primary lead', onclick: () => flow.pasteAgain() }),
        btn('그냥 저장', { id: 'btn-paste-save-only', onclick: () => flow.saveTextOnly() }),
        h('button', { type: 'button', class: 'btn small ghost', id: 'btn-paste-cancel', onclick: () => flow.leave() }, '그만두기')),
    };
  }

  function full() {
    const all = listRecords();
    const oldest = all[all.length - 1];
    return {
      instruction: '저장 공간이 가득 찼어요',
      node: h('div', { class: 'stack', id: 'notes-full' },
        h('p', { class: 'notes-big' }, '진료 기록이 20건이에요. 가장 오래된 기록을 지우고 이 기록을 저장할까요?'),
        oldest ? h('p', { class: 'note' }, `지워질 기록: ${recordTitle(oldest)}`) : null,
        btn('오래된 기록 지우고 저장', { id: 'btn-full-drop', class: 'primary lead', onclick: () => flow.resolveFull('drop') }),
        btn('저장하지 않기', { id: 'btn-full-skip', onclick: () => flow.resolveFull('skip') })),
    };
  }

  function n4() {
    const f = flow.state;
    const pasted = f.origin === 'paste';
    const bandText = [f.sample ? SAMPLE_BAND : null, f.usedSaved ? SAVED_RESULT_BAND : null, pasted ? PASTED_BAND : null].filter(Boolean).join(' · ');
    const bands = [bandText ? band(bandText) : null];
    if (f.idx >= f.items.length) {
      const empty = f.items.length === 0;
      const note = finalNote(f);
      return {
        instruction: empty ? '정리된 내용이 없어요' : '모두 확인했어요',
        compact: true,
        node: h('div', { class: 'stack', id: 'notes-last' },
          ...bands,
          note.lead ? h('p', { class: 'notes-big', id: 'notes-later' }, note.lead) : null,
          note.saved ? h('p', { class: 'note', id: 'notes-saved' }, note.saved) : null,
          f.dropped > 0 ? h('p', { class: 'note', id: 'notes-dropped', role: 'status' }, (pasted ? DROPPED_PASTE_TEXT : DROPPED_TEXT)(f.dropped)) : null,
          f.saveNote ? h('p', { class: 'note', role: 'status' }, f.saveNote) : null,
          h('p', { class: 'notes-big notes-final' }, NOTES_SENTENCES.last),
          btn('확인했어요', { id: 'btn-n4-done', class: 'primary lead', onclick: () => {
            if (!flow.tapOk()) return; // a tap meant for the item screen before
            if (pasted) {
              // A pasted message is not a step of the visit: show the record (or the list) instead of moving the route on.
              const id = flow.finish();
              if (id) openRecord(id); else openList();
              return;
            }
            ctx.onContinue(flow.finish());
          } }),
          f.items.length ? h('button', { class: 'btn small ghost', id: 'btn-n4-prev', onclick: () => flow.prevItem() }, '앞 항목 다시 보기') : null),
      };
    }
    const it = f.items[f.idx];
    if (f.editing) {
      return {
        instruction: '고칠 내용을 적어 주세요',
        compact: true,
        node: h('div', { class: 'stack', id: 'notes-edit' },
          ...bands,
          h('label', { for: 'notes-edit-text', class: 'note' }, `${CARD_TITLES[it.kind]}`),
          h('textarea', { id: 'notes-edit-text', rows: 3, oninput: (e) => { editText = e.target.value; } }, editText),
          btn('저장', { id: 'btn-edit-save', class: 'primary lead', onclick: () => { flow.saveEdit(editText); editText = ''; } }),
          btn('취소', { id: 'btn-edit-cancel', onclick: () => flow.cancelEdit() })),
      };
    }
    return {
      instruction: it.text,
      compact: true,
      node: h('div', { class: 'stack notes-tight notes-item', id: 'notes-item' },
        ...bands,
        h('div', { class: 'note-head' }, pic(it.kind), h('span', { class: 'note-title', id: 'note-title' }, CARD_TITLES[it.kind]),
          h('span', { class: 'note-pos' }, `${f.idx + 1} / ${f.items.length}`)),
        it.source ? h('p', { class: 'note-source', id: 'note-source' }, `${f.origin === 'paste' ? '병원 문자' : '선생님 말씀'}: “${it.source}”`) : null,
        f.idx === 0 && f.dropped > 0 ? h('p', { class: 'note', id: 'notes-dropped', role: 'status' }, (pasted ? DROPPED_PASTE_TEXT : DROPPED_TEXT)(f.dropped)) : null,
        h('div', { class: 'notes-trio' },
          btn('맞아요', { id: 'btn-item-ok', class: 'primary', onclick: () => { editText = ''; flow.itemAction('ok'); } }),
          btn('고칠게요', { id: 'btn-item-edit', onclick: () => { editText = it.text; flow.itemAction('edit'); } }),
          btn('지울게요', { id: 'btn-item-del', onclick: () => flow.itemAction('delete') })),
        f.idx > 0 ? h('button', { class: 'btn small ghost', id: 'btn-n4-prev', onclick: () => flow.prevItem() }, '앞 항목 다시 보기') : null,
        disclaimer()),
    };
  }

  /** What [다시 듣기] on the bar says on a notes screen. */
  function replay() {
    const f = flow.state;
    switch (f.phase) {
      case 'n0': return say('notes-ask', NOTES_SENTENCES.ask);
      case 'n1': return say('notes-consent', NOTES_SENTENCES.consent);
      case 'n1-declined': return say('notes-declined', NOTES_SENTENCES.declined);
      case 'n3': return say('notes-summarising', NOTES_SENTENCES.summarising);
      case 'p0': return say('notes-paste', NOTES_SENTENCES.pasteAsk);
      case 'p1': return say('notes-paste-none', NOTES_SENTENCES.pasteNone);
      case 'n4':
        if (f.idx >= f.items.length) return say('notes-last', NOTES_SENTENCES.last);
        return readAloud([f.items[f.idx].text]);
      case 'n2': return Promise.resolve(false); // never speak into the open microphone
      default: break;
    }
    if (shot || (view && (view.kind === 'photo' || view.kind === 'photo-kind'))) return Promise.resolve(false); // no new spoken sentences for photos
    if (view && view.kind === 'record') {
      const rec = getRecord(view.id);
      return rec ? readAll(rec) : Promise.resolve(false);
    }
    if (view && view.kind === 'list') return readAloud(['내 진료 기록']);
    return Promise.resolve(false);
  }

  // ------------------------------------------------------------------ V1, V2

  const readAll = (rec) => readAloud([PHONE_VOICE_LINE, ...speechFor(rec)]);

  function openList() {
    stopReading();
    dropViewUrl();
    view = { kind: 'list' };
    rerender();
    refreshPhotos();
  }

  function openRecord(id, { read = false } = {}) {
    stopReading();
    dropViewUrl();
    view = { kind: 'record', id, sub: null, msg: null };
    rerender();
    if (read) {
      const rec = getRecord(id);
      if (rec) readAll(rec);
    }
  }

  function closeViews() {
    stopReading();
    dropViewUrl();
    dropShot();
    view = null;
    rerender();
  }

  function v1() {
    const all = listRecords();
    const pasteBtn = btn('병원 문자 넣기', { id: 'btn-paste-open', class: 'primary lead', onclick: () => { flow.openPaste(); } });
    const photoBtn = btn('사진 찍기', { id: 'btn-photo-open', onclick: () => { stopReading(); view = { kind: 'photo-kind' }; rerender(); } });
    if (!all.length) {
      return {
        instruction: '내 진료 기록',
        node: h('div', { class: 'stack', id: 'notes-list' },
          h('p', { class: 'notes-big', id: 'notes-empty' }, EMPTY_LIST),
          pasteBtn,
          photoBtn,
          photoSection(),
          h('button', { class: 'btn wide', id: 'btn-list-close', onclick: () => closeViews() }, '닫기'),
          disclaimer()),
      };
    }
    return {
      instruction: '내 진료 기록',
      node: h('div', { class: 'stack', id: 'notes-list' },
        pasteBtn,
        photoBtn,
        h('p', { class: 'note' }, PHONE_VOICE_LINE),
        h('div', { class: 'answers' }, all.map((r) => h('button', { type: 'button', class: 'btn answer notes-rec', 'data-id': r.id,
          onclick: () => openRecord(r.id) },
        h('span', { class: 'answer-text' }, recordTitle(r)),
        r.source === 'sample' ? h('span', { class: 'badge' }, '예시') : null))),
        photoSection(),
        h('p', { class: 'note' }, SAVE_HINT),
        h('button', { class: 'btn wide', id: 'btn-list-close', onclick: () => closeViews() }, '닫기'),
        disclaimer()),
    };
  }

  const setNextDate = (rec, idx, value) => {
    const items = rec.items.map((it, i) => (i === idx
      ? { ...it, next: { date: null, time: null, place: null, said: null, ...(it.next || {}), date: value || null, userDate: true } }
      : it));
    updateRecord(rec.id, { items });
  };

  /** Date input handlers: store the pick and enable the button in place (a re-render would close the picker). */
  function dateEvents(rec, idx) {
    const apply = (e) => {
      setNextDate(rec, idx, e.target.value);
      const b = document.getElementById(`btn-cal-${idx}`);
      if (b) b.disabled = !e.target.value;
    };
    return { onchange: apply, oninput: apply };
  }

  function download(filename, text) {
    const blob = new Blob([text], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: filename, hidden: true });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function itemRow(rec, it, idx) {
    const st = statusText(it);
    const kids = [h('p', { class: 'rec-item-text' }, it.text, st ? h('span', { class: 'badge' }, st) : null)];
    if (it.kind === 'next') {
      const today = localDate(new Date());
      if (nextNeedsDate(it) || (it.next && it.next.userDate)) {
        // The doctor gave no full date ("3개월 뒤"): the user picks one. Prefilled only from a date
        // the sentence literally says.
        const id = `date-${idx}`;
        const value = (it.next && it.next.date) || datePrefill(it, today);
        kids.push(
          h('label', { for: id, class: 'note' }, it.next && it.next.said ? `“${it.next.said}” 날짜를 골라 주세요` : '날짜를 골라 주세요'),
          h('input', { type: 'date', id, class: 'date-input', value, ...dateEvents(rec, idx) }),
          btn('달력에 넣기', { class: 'cal', id: `btn-cal-${idx}`, disabled: !value, onclick: () => {
            const picked = document.getElementById(id).value;
            if (!picked) return;
            setNextDate(rec, idx, picked);
            const text = visitIcsFor({ ...it, next: { ...it.next, date: picked } }, { dtstamp: new Date(), recordId: rec.id, index: idx, sequence: sequenceNow() });
            if (!text) return;
            download(icsFilename('next'), text);
            view = { ...view, msg: '달력 파일을 받았어요. 열어서 달력에 넣어 주세요.' };
            rerender();
          } }));
      } else {
        kids.push(btn('달력에 넣기', { class: 'cal', id: `btn-cal-${idx}`, onclick: () => {
          const text = visitIcsFor(it, { dtstamp: new Date(), recordId: rec.id, index: idx, sequence: sequenceNow() });
          if (!text) return;
          download(icsFilename('next'), text);
          view = { ...view, msg: '달력 파일을 받았어요. 열어서 달력에 넣어 주세요.' };
          rerender();
        } }));
      }
    } else if (it.kind === 'med' && medSlotsFor(it)) {
      kids.push(btn('약 시간 달력에 넣기', { class: 'cal', id: `btn-medcal-${idx}`, onclick: () => {
        view = { ...view, sub: 'times', itemIdx: idx, times: medSlotsFor(it) };
        rerender();
      } }));
    }
    return h('li', { class: 'rec-item' }, kids);
  }

  function v2() {
    const rec = getRecord(view.id);
    if (!rec) { view = { kind: 'list' }; return v1(); }
    const sub = view.sub;
    if (sub === 'transcript') return v2Transcript(rec);
    if (sub === 'share') return v2Share(rec);
    if (sub === 'delete') return v2Delete(rec);
    if (sub === 'times') return v2Times(rec);
    const cards = CARD_ORDER.map((kind) => ({ kind, entries: rec.items.map((it, i) => ({ it, i })).filter((e) => e.it.kind === kind) }))
      .filter((c) => c.entries.length);
    const kids = [
      rec.source === 'sample' ? band(`${SAMPLE_BAND}: 가상의 내용이에요`) : null,
      isMessageRecord(rec) ? band(PASTED_BAND) : null,
      h('p', { class: 'note' }, PHONE_VOICE_LINE),
      h('div', { class: 'notes-pair' },
        btn('전체 듣기', { id: 'btn-rec-all', onclick: () => readAll(rec) }),
        btn('가족에게 보내기', { id: 'btn-rec-share', onclick: () => { stopReading(); view = { ...view, sub: 'share', msg: null }; rerender(); } })),
      view.msg ? h('p', { class: 'note', id: 'notes-view-msg', role: 'status' }, view.msg) : null,
    ];
    if (!cards.length) {
      const pastedRec = isMessageRecord(rec);
      kids.push(h('p', { class: 'notes-big' }, rec.summary === 'none' ? (pastedRec ? PASTED_SUMMARY_LATER : SUMMARY_LATER)
        : `남은 항목이 없어요. ${pastedRec ? '문자는' : '받아 적은 글은'} [원문 보기]에서 볼 수 있어요.`));
    }
    if ((rec.summary === 'none' || !cards.length) && rec.transcript.trim()) {
      kids.push(btn(view.busy ? '정리하는 중이에요...' : '다시 정리하기', { id: 'btn-rec-resummarise', disabled: view.busy ? true : null, onclick: async () => {
        view = { ...view, busy: true, msg: null };
        rerender();
        const r = await resummarise(rec.id, { url: ctx.notesUrl || '', today: localDate(new Date()) });
        view = { ...view, busy: false, msg: r.ok ? '다시 정리했어요. 항목마다 맞는지 확인해 주세요.' : `이번에도 정리하지 못했어요. ${isMessageRecord(rec) ? '문자는' : '받아 적은 글은'} [원문 보기]에서 볼 수 있어요.` };
        rerender();
      } }));
    }
    for (const c of cards) {
      kids.push(h('section', { class: 'card rec-card', 'data-kind': c.kind },
        h('div', { class: 'note-head' }, pic(c.kind), h('span', { class: 'note-title' }, CARD_TITLES[c.kind])),
        h('ul', { class: 'rec-items' }, c.entries.map((e) => itemRow(rec, e.it, e.i))),
        h('button', { type: 'button', class: 'btn small ghost card-replay', 'data-kind': c.kind,
          onclick: () => readAloud([CARD_TITLES[c.kind], ...c.entries.map((e) => e.it.text)]) }, '다시 듣기')));
    }
    if (rec.dropped > 0) kids.push(h('p', { class: 'note', id: 'notes-rec-dropped' }, (isMessageRecord(rec) ? DROPPED_PASTE_TEXT : DROPPED_TEXT)(rec.dropped)));
    kids.push(
      h('p', { class: 'note', id: 'notes-save-hint' }, SAVE_HINT),
      btn('원문 보기', { id: 'btn-rec-transcript', onclick: () => { stopReading(); view = { ...view, sub: 'transcript' }; rerender(); } }),
      h('button', { type: 'button', class: 'btn small ghost', id: 'btn-rec-delete', onclick: () => { stopReading(); view = { ...view, sub: 'delete' }; rerender(); } }, '이 기록 지우기'),
      h('button', { class: 'btn wide', id: 'btn-rec-close', onclick: () => { stopReading(); view = { kind: 'list' }; rerender(); } }, '목록으로'),
      disclaimer());
    return { instruction: recordTitle(rec), compact: true, node: h('div', { class: 'stack', id: 'notes-record' }, kids) };
  }

  const backToRecord = () => { view = { ...view, sub: null, msg: view.msg }; rerender(); };

  function v2Transcript(rec) {
    const segs = highlightSegments(rec.transcript, rec.items);
    const pasted = isMessageRecord(rec);
    return {
      instruction: pasted ? '병원에서 온 문자' : '받아 적은 글',
      compact: true,
      node: h('div', { class: 'stack', id: 'notes-transcript' },
        rec.source === 'sample' ? band(`${SAMPLE_BAND}: 가상의 내용이에요`) : null,
        pasted ? band(PASTED_BAND) : null,
        h('p', { class: 'note' }, pasted ? '정리에 쓴 문장은 노란 바탕으로 표시했어요.' : '정리에 쓴 선생님 말씀은 노란 바탕으로 표시했어요.'),
        h('div', { class: 'card notes-transcript' }, segs.length
          ? segs.map((s) => (s.mark ? h('mark', {}, s.text) : s.text))
          : (pasted ? '문자가 없어요.' : '받아 적은 글이 없어요.')),
        btn('돌아가기', { id: 'btn-sub-back', onclick: backToRecord }),
        disclaimer()),
    };
  }

  function v2Share(rec) {
    const text = shareText(rec);
    const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
    return {
      instruction: '가족에게 보낼 글',
      compact: true,
      node: h('div', { class: 'stack', id: 'notes-share' },
        h('pre', { class: 'card share-preview', id: 'share-preview' }, text),
        h('p', { class: 'note' }, '정리한 내용만 보내요. 받아 적은 원문은 보내지 않아요. 받는 사람과 앱은 직접 골라요.'),
        view.msg ? h('p', { class: 'note', id: 'notes-view-msg', role: 'status' }, view.msg) : null,
        btn(canShare ? '보내기' : '글 복사하기', { id: 'btn-share-go', class: 'primary lead', onclick: async () => {
          const r = await shareOrCopy(text);
          const msg = { shared: '보냈어요.', cancelled: '보내지 않았어요.', copied: '복사했어요. 문자나 카카오톡에 붙여 넣어 주세요.',
            unavailable: '이 브라우저에서는 보내지 못했어요. 위 글을 길게 눌러 복사해 주세요.' }[r];
          view = { ...view, msg };
          rerender();
        } }),
        btn('돌아가기', { id: 'btn-sub-back', onclick: () => { view = { ...view, sub: null, msg: null }; rerender(); } }),
        disclaimer()),
    };
  }

  function v2Delete(rec) {
    return {
      instruction: '이 기록을 지울까요?',
      node: h('div', { class: 'stack', id: 'notes-delete' },
        h('p', { class: 'notes-big' }, `${recordTitle(rec)} 기록을 지우면 되돌릴 수 없어요.`),
        view.msg ? h('p', { class: 'note', id: 'notes-view-msg', role: 'alert' }, view.msg) : null,
        btn('지우기', { id: 'btn-delete-yes', class: 'primary lead', onclick: () => {
          const gone = removeRecord(rec.id);
          if (!gone && getRecord(rec.id)) {
            // storage refused the change: the record is still there, say so
            view = { ...view, msg: '지우지 못했어요. 브라우저의 저장 공간을 확인한 뒤 다시 눌러 주세요.' };
          } else {
            view = listRecords().length ? { kind: 'list' } : null;
          }
          rerender();
        } }),
        btn('그만두기', { id: 'btn-delete-no', onclick: () => { view = { ...view, sub: null }; rerender(); } })),
    };
  }

  /** Time input handlers: remember the pick and enable the file button in place. */
  function timeEvents(i) {
    const apply = (e) => {
      view = { ...view, times: view.times.map((x, j) => (j === i ? { ...x, time: e.target.value } : x)) };
      const go = document.getElementById('btn-times-go');
      if (go) go.disabled = !view.times.some((x) => /^\d{2}:\d{2}$/.test(x.time));
    };
    return { onchange: apply, oninput: apply };
  }

  function v2Times(rec) {
    const it = rec.items[view.itemIdx];
    const times = view.times || [];
    const anyTime = times.some((t) => /^\d{2}:\d{2}$/.test(t.time));
    const days = it && it.med && Number.isInteger(it.med.days) ? it.med.days : null;
    const start = medStartDate(rec, it, localDate(new Date()));
    return {
      instruction: '약 드실 시간을 골라 주세요',
      compact: true,
      node: h('div', { class: 'stack', id: 'notes-times' },
        h('p', { class: 'note' }, '몇 시에 드실지는 앱이 정하지 않아요. 직접 골라 주세요.'),
        ...times.map((t, i) => h('div', { class: 'time-row' },
          h('label', { for: `time-${i}`, class: 'time-label' }, t.label),
          h('input', { type: 'time', id: `time-${i}`, class: 'time-input', value: t.time, ...timeEvents(i) }))),
        h('p', { class: 'note', id: 'notes-times-span' }, medStartNote(start, days)),
        view.msg ? h('p', { class: 'note', id: 'notes-view-msg', role: 'status' }, view.msg) : null,
        btn('달력 파일 만들기', { id: 'btn-times-go', class: 'primary lead', disabled: !anyTime, onclick: () => {
          const picked = (view.times || []).filter((t) => /^\d{2}:\d{2}$/.test(t.time));
          const text = medIcsFor(it, picked, start.date, { dtstamp: new Date(), recordId: rec.id, index: view.itemIdx, sequence: sequenceNow() });
          if (!text) return;
          download(icsFilename('med'), text);
          view = { ...view, msg: '달력 파일을 받았어요. 열어서 달력에 넣어 주세요.' };
          rerender();
        } }),
        btn('돌아가기', { id: 'btn-sub-back', onclick: () => { view = { ...view, sub: null, msg: null }; rerender(); } }),
        disclaimer()),
    };
  }

  // ------------------------------------------------------------------ photos

  const objectUrl = (blob) => {
    try {
      return typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function' ? URL.createObjectURL(blob) : null;
    } catch {
      return null;
    }
  };
  const revokeUrl = (url) => {
    try { if (url && typeof URL !== 'undefined') URL.revokeObjectURL(url); } catch { /* nothing to free */ }
  };
  function thumbUrl(p) {
    if (!p.thumb) return null;
    if (!thumbUrls.has(p.id)) thumbUrls.set(p.id, objectUrl(p.thumb));
    return thumbUrls.get(p.id);
  }
  /** Frees the full-size picture of the photo view (when it closes). A re-render keeps the same URL. */
  function dropViewUrl() {
    if (view && view.kind === 'photo' && view.url) revokeUrl(view.url);
  }
  /** Ends the after-camera screen and frees its picture; a save still running finishes silently. */
  function dropShot() {
    shotToken += 1;
    if (shot && shot.url) revokeUrl(shot.url);
    shot = null;
  }

  /** Loads the photo list into `photos` and renders again only when it changed (no render loop). */
  async function refreshPhotos() {
    const list = await photoStore.list();
    if (list.length === photos.length && list.every((p, i) => p.id === photos[i].id)) return photos;
    const keep = new Set(list.map((p) => p.id));
    for (const [id, url] of thumbUrls) {
      if (!keep.has(id)) { revokeUrl(url); thumbUrls.delete(id); }
    }
    photos = list;
    rerender();
    return photos;
  }

  /** Deletes every photo (settings). True when storage accepted it. */
  async function clearPhotos() {
    const ok = await photoStore.clear();
    if (ok) {
      for (const url of thumbUrls.values()) revokeUrl(url);
      thumbUrls.clear();
      photos = [];
    }
    return ok;
  }

  /** The one hidden camera input, created on first use and kept in the page. */
  function ensureInput() {
    if (photoInput) return photoInput;
    if (typeof document === 'undefined' || !document.body) return null;
    photoInput = h('input', {
      type: 'file', accept: 'image/*', capture: 'environment', id: 'photo-input', hidden: true, tabindex: '-1', 'aria-hidden': 'true',
      onchange: (e) => {
        const file = e.target.files && e.target.files[0];
        e.target.value = ''; // the same file can be picked again
        if (file) handleFile(file);
      },
    });
    document.body.append(photoInput);
    return photoInput;
  }

  /**
   * Opens the camera for `kind` ('rx' prescription, 'memo' paper written for me). It must run inside
   * the tap's own handler (iOS only opens the camera from a tap). returnTo: 'route' (back to the
   * route screen after [확인]) or 'list'. replaceId: a photo to remove once the new file is chosen.
   */
  function takePhoto(kind, { returnTo = 'route', replaceId = null } = {}) {
    if (!PHOTO_KINDS.includes(kind)) return false;
    const input = ensureInput();
    if (!input) return false;
    pending = { kind, returnTo: returnTo === 'list' ? 'list' : 'route', replaceId };
    stopReading();
    input.click();
    return true;
  }

  async function handleFile(file) {
    const job = pending || { kind: 'memo', returnTo: 'route', replaceId: null };
    pending = null;
    dropShot();
    const mine = shotToken;
    shot = { phase: 'saving', kind: job.kind, returnTo: job.returnTo };
    rerender();
    let img;
    try {
      img = await prepareImages(file);
    } catch {
      if (mine !== shotToken) return;
      shot = { ...shot, phase: 'error', reason: 'error' };
      rerender();
      return;
    }
    if (mine !== shotToken) return;
    if (job.replaceId) await photoStore.remove(job.replaceId); // the retaken photo is replaced only now that a new one exists
    if (mine !== shotToken) return;
    shot = { ...shot, meta: { kind: job.kind, ...img, createdAt: Date.now(), date: localDate(new Date()) } };
    await commitShot(mine);
  }

  /** Stores shot.meta; asks first when the store is full. */
  async function commitShot(mine) {
    const res = await photoStore.add(shot.meta);
    if (mine !== shotToken) return;
    if (res.ok) {
      shot = { ...shot, phase: 'saved', photo: res.photo, url: objectUrl(res.photo.blob), meta: null };
      refreshPhotos();
    } else if (res.reason === 'full') {
      await refreshPhotos();
      if (mine !== shotToken) return;
      shot = { ...shot, phase: 'full' };
    } else {
      shot = { ...shot, phase: 'error', reason: res.reason };
    }
    rerender();
  }

  /** Leaves the after-camera screen: back to the list or to the route screen. */
  function endShot() {
    const to = shot && shot.returnTo;
    dropShot();
    if (to === 'list') { openList(); return; }
    view = null;
    rerender();
  }

  function shotScreen() {
    const s = shot;
    if (s.phase === 'saving') {
      return { instruction: '사진을 저장하고 있어요', compact: true,
        node: h('div', { class: 'stack', id: 'photo-saving' }, h('p', { class: 'notes-big', role: 'status' }, '잠시만 기다려 주세요.')) };
    }
    if (s.phase === 'saved') {
      return {
        instruction: '사진을 저장했어요.',
        compact: true,
        node: h('div', { class: 'stack notes-tight', id: 'photo-saved' },
          s.url ? h('img', { class: 'photo-img', id: 'photo-saved-img', src: s.url, alt: photoTitle(s.photo) }) : null,
          h('p', { class: 'note', id: 'photo-saved-title' }, photoTitle(s.photo)),
          h('div', { class: 'notes-pair' },
            btn('다시 찍기', { id: 'btn-photo-retake', onclick: () => { takePhoto(s.kind, { returnTo: s.returnTo, replaceId: s.photo.id }); } }),
            btn('확인', { id: 'btn-photo-ok', class: 'primary', onclick: () => endShot() }))),
      };
    }
    if (s.phase === 'full') {
      const oldest = photos[photos.length - 1];
      return {
        instruction: '사진 저장 공간이 가득 찼어요',
        compact: true,
        node: h('div', { class: 'stack', id: 'photo-full' },
          h('p', { class: 'notes-big' }, PHOTO_FULL_TEXT),
          oldest ? h('p', { class: 'note' }, `지워질 사진: ${photoTitle(oldest)}`) : null,
          btn('지우고 저장하기', { id: 'btn-photo-full-drop', class: 'primary lead', onclick: async () => {
            const mine = shotToken;
            await photoStore.dropOldest();
            if (mine !== shotToken) return;
            shot = { ...shot, phase: 'saving' };
            rerender();
            await commitShot(mine);
          } }),
          btn('저장하지 않기', { id: 'btn-photo-full-skip', onclick: () => endShot() })),
      };
    }
    const gone = s.reason === 'unavailable';
    return {
      instruction: '사진을 저장하지 못했어요',
      compact: true,
      node: h('div', { class: 'stack', id: 'photo-error' },
        h('p', { class: 'notes-big', id: 'photo-error-msg', role: 'alert' }, gone ? PHOTO_UNAVAILABLE_TEXT : PHOTO_FAIL_TEXT),
        gone ? null : btn('다시 찍기', { id: 'btn-photo-retake', class: 'primary lead', onclick: () => { takePhoto(s.kind, { returnTo: s.returnTo }); } }),
        btn('닫기', { id: 'btn-photo-error-close', onclick: () => endShot() })),
    };
  }

  /** The list's photo section; null while there is no photo. */
  function photoSection() {
    if (!photos.length) return null;
    return h('section', { class: 'notes-photos', id: 'notes-photos' },
      h('h2', { class: 'notes-section' }, '사진'),
      h('div', { class: 'answers' }, photos.map((p) => {
        const url = thumbUrl(p);
        return h('button', { type: 'button', class: 'btn answer notes-photo-row', 'data-id': p.id, onclick: () => openPhoto(p.id) },
          url ? h('img', { class: 'photo-thumb', src: url, alt: '', width: 64, height: 64 }) : null,
          h('span', { class: 'answer-text' }, photoTitle(p)));
      })),
      h('p', { class: 'note', id: 'notes-photo-note' }, PHOTO_PRIVACY_LINE));
  }

  /** [사진 찍기] on the list: which kind of paper? */
  function vKind() {
    const pick = (kind) => () => { takePhoto(kind, { returnTo: 'list' }); };
    return {
      instruction: '어떤 사진인가요?',
      compact: true,
      node: h('div', { class: 'stack', id: 'photo-kind' },
        btn('처방전', { id: 'btn-photo-kind-rx', class: 'lead', onclick: pick('rx') }),
        btn('적어 주신 종이', { id: 'btn-photo-kind-memo', class: 'lead', onclick: pick('memo') }),
        btn('그만두기', { id: 'btn-photo-kind-cancel', onclick: () => openList() })),
    };
  }

  function openPhoto(id) {
    stopReading();
    dropViewUrl();
    view = { kind: 'photo', id, photo: null, url: null, sub: null, msg: null, missing: false };
    rerender();
    photoStore.get(id).then((p) => {
      if (!view || view.kind !== 'photo' || view.id !== id) return; // the user already went elsewhere
      view = p ? { ...view, photo: p, url: objectUrl(p.blob) } : { ...view, missing: true };
      rerender();
    });
  }

  function vPhoto() {
    if (view.sub === 'delete') return vPhotoDelete();
    const title = view.photo ? photoTitle(view.photo) : '사진';
    let body;
    if (view.missing) {
      body = h('p', { class: 'notes-big', id: 'photo-missing' }, '사진을 찾지 못했어요.');
    } else if (!view.url) {
      body = h('p', { class: 'note', id: 'photo-loading', role: 'status' }, '사진을 불러오고 있어요...');
    } else {
      const { width: w, height: ph } = view.photo;
      const host = h('div', { class: 'photo-host', id: 'photo-host' },
        svgNode(`<svg xmlns="http://www.w3.org/2000/svg" class="photo-svg" viewBox="0 0 ${w} ${ph}" role="img" aria-label="${title}"><image href="${view.url}" width="${w}" height="${ph}"/></svg>`));
      photoZoom = attachZoom(host, { bar: typeof ctx.zoomBar === 'function' ? ctx.zoomBar(() => photoZoom, 'photo', '사진 크기') : null });
      body = host;
    }
    return {
      instruction: title,
      compact: true,
      node: h('div', { class: 'stack notes-tight', id: 'notes-photo' },
        body,
        view.msg ? h('p', { class: 'note', id: 'notes-view-msg', role: 'status' }, view.msg) : null,
        view.photo ? btn('이 사진 지우기', { id: 'btn-photo-delete', onclick: () => { view = { ...view, sub: 'delete', msg: null }; rerender(); } }) : null,
        btn('목록으로', { id: 'btn-photo-close', onclick: () => openList() })),
    };
  }

  function vPhotoDelete() {
    const title = view.photo ? photoTitle(view.photo) : '사진';
    return {
      instruction: '정말 지울까요?',
      compact: true,
      node: h('div', { class: 'stack', id: 'photo-delete' },
        h('p', { class: 'notes-big' }, title),
        h('p', { class: 'note' }, '지우면 되돌릴 수 없어요.'),
        view.msg ? h('p', { class: 'note', id: 'notes-view-msg', role: 'alert' }, view.msg) : null,
        btn('지우기', { id: 'btn-photo-delete-yes', class: 'primary lead', onclick: async () => {
          const id = view.id;
          const gone = await photoStore.remove(id);
          if (!view || view.kind !== 'photo' || view.id !== id) return;
          if (!gone && await photoStore.get(id)) {
            view = { ...view, msg: '지우지 못했어요. 브라우저의 저장 공간을 확인한 뒤 다시 눌러 주세요.' };
            rerender();
            return;
          }
          photos = photos.filter((p) => p.id !== id); // the list must not show it for a moment
          openList();
        } }),
        btn('지우지 않기', { id: 'btn-photo-delete-no', onclick: () => { view = { ...view, sub: null, msg: null }; rerender(); } })),
    };
  }

  // ------------------------------------------------------------------ entry points for app.js

  /** The notes screen to show now, or null when the route screen shows. The flow wins over a record view. */
  function current() {
    const f = flow.state;
    let scr = null;
    let key = '';
    switch (f.phase) {
      case 'n0': scr = n0(); break;
      case 'n1': scr = n1(); break;
      case 'n1-declined': scr = n1Declined(); break;
      case 'n2': scr = n2(); break;
      case 'n3': scr = n3(); break;
      case 'p0': scr = p0(); break;
      case 'p1': scr = p1(); break;
      case 'full': scr = full(); break;
      case 'n4': scr = n4(); key = `${f.idx}|${f.editing}`; break;
      default: break;
    }
    if (scr) {
      // `key` identifies the screen: app.js scrolls to the top when it changes (not on a live update of N2).
      scr.key = `${f.phase}|${key}`;
      if (f.origin === 'paste') scr.header = HEADER; // a pasted message is not a step of the visit
      return scr;
    }
    if (shot) {
      scr = shotScreen();
      scr.header = HEADER;
      scr.key = `shot|${shot.phase}`;
      return scr;
    }
    if (!view) return null;
    scr = view.kind === 'list' ? v1() : (view.kind === 'photo-kind' ? vKind() : (view.kind === 'photo' ? vPhoto() : v2()));
    if (scr) scr.header = HEADER;
    if (scr && view) scr.key = `view|${view.kind}|${view.id || ''}|${view.sub || ''}`;
    return scr;
  }

  /** Keeps the newest line of N2 in view. */
  function afterRender() {
    const box = typeof document !== 'undefined' ? document.getElementById('notes-text') : null;
    if (box) box.scrollTop = box.scrollHeight;
  }

  return {
    current, replay, afterRender, openList, openRecord, closeViews,
    isOpen: () => Boolean(view) || Boolean(shot),
    reset: () => { dropViewUrl(); dropShot(); view = null; editText = ''; stopReading(); },
    // photos
    takePhoto, refreshPhotos, clearPhotos, photoCount: () => photos.length,
  };
}
