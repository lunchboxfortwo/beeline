import { test } from 'node:test';
import assert from 'node:assert/strict';
import { completeRoomFrame } from './web-room-frame.mjs';
function fixture() {
  const element = (textContent = '') => ({ textContent, parentElement: null, hidden: false,
    getBoundingClientRect: () => ({ left: 10, right: 110, top: 10, bottom: 110, width: 100, height: 100 }),
    getAttribute: () => null, contains: (hit) => hit === answer || hit === composer });
  const answer = element('streamed answer '.repeat(640).trimEnd());
  const composer = element();
  const document = {
    defaultView: { innerWidth: 800, innerHeight: 600,
      getComputedStyle: e => ({ display: 'block', visibility: e.hidden ? 'hidden' : 'visible', opacity: '1' }) },
    elementFromPoint: () => answer,
    querySelectorAll: selector => selector.includes('chat-input') ? [composer] : selector.includes('loader') ? [] : [answer],
  };
  return { document, answer, composer };
}
test('accepts the complete visible fixture only', () => {
  const {document, answer, composer} = fixture();
  assert.equal(completeRoomFrame(document, 'large'), true);
  answer.textContent = 'streamed answer';
  assert.equal(completeRoomFrame(document, 'large'), false);
  answer.textContent = 'streamed answer '.repeat(640).trimEnd();
  answer.hidden = true;
  assert.equal(completeRoomFrame(document, 'large'), false);
  answer.hidden = false; composer.hidden = true;
  assert.equal(completeRoomFrame(document, 'large'), false);
});
test('rejects offscreen, covered and aria-hidden Rooms despite nonzero layout', () => {
  for (const kind of ['offscreen', 'covered', 'hiddenParent']) {
    const {document, answer} = fixture();
    if (kind === 'offscreen') answer.getBoundingClientRect = () => ({left:10,right:110,top:700,bottom:800,width:100,height:100});
    if (kind === 'covered') document.elementFromPoint = () => ({});
    if (kind === 'hiddenParent') answer.parentElement = { parentElement:null, getAttribute: () => 'true' };
    assert.equal(completeRoomFrame(document, 'large'), false, kind);
  }
});
