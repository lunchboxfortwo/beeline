import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { armTapTiming, readTapTiming, tapFeedback } from './web-tap-timing.mjs';

test('approval timing observes the same Approve action as the redesigned tray', () => {
  let mutation,
    pointerdown,
    shown = true;
  const frames = [];
  const button = {
    textContent: 'Approve',
    getAttribute: () => 'Approve: Allow local fixture access',
    getBoundingClientRect: () => ({ width: shown ? 100 : 0, height: 20 }),
  };
  const sandbox = {
    window: {},
    document: {
      body: {},
      querySelectorAll: () => [button],
      addEventListener: (_, handler) => {
        pointerdown = handler;
      },
      removeEventListener() {},
    },
    performance: { now: () => 100 },
    getComputedStyle: () => ({ visibility: 'visible' }),
    requestAnimationFrame: (handler) => frames.push(handler),
    MutationObserver: class {
      constructor(handler) {
        mutation = handler;
      }
      observe() {}
      disconnect() {}
    },
  };
  runInNewContext(`(${armTapTiming})`, sandbox)(tapFeedback('answer-approval', {}));
  pointerdown();
  mutation();
  assert.equal(frames.length, 0);
  shown = false;
  mutation();
  assert.equal(frames.length, 1, 'removing the actual approval control ends the DOM interval');
});

test('a result needs input and visibility before its two result frames', () => {
  let clock = 100,
    mutation,
    pointerdown,
    shown = false;
  const frames = [];
  const element = { getBoundingClientRect: () => ({ width: shown ? 100 : 0, height: 20 }) };
  const document = {
    body: {},
    querySelector: () => element,
    querySelectorAll: () => [element],
    addEventListener: (_, handler) => {
      pointerdown = handler;
    },
    removeEventListener() {},
    createTreeWalker: () => ({
      nextNode: (() => {
        let read = false;
        return () =>
          read ? null : ((read = true), { textContent: 'Room message', parentElement: element });
      })(),
    }),
  };
  const sandbox = {
    window: {},
    document,
    location: { pathname: '/room' },
    NodeFilter: { SHOW_TEXT: 4 },
    performance: { now: () => clock },
    getComputedStyle: () => ({ visibility: 'visible' }),
    requestAnimationFrame: (handler) => frames.push(handler),
    MutationObserver: class {
      constructor(handler) {
        mutation = handler;
      }
      observe() {}
      disconnect() {
        mutation = () => {};
      }
    },
  };
  const arm = runInNewContext(`(${armTapTiming})`, sandbox);
  const read = runInNewContext(`(${readTapTiming})`, sandbox);
  arm({ path: '/room', selector: '#result', text: 'Room message' });
  mutation();
  assert.throws(read, /not observed/);
  clock = 120;
  pointerdown();
  mutation();
  assert.equal(frames.length, 0, 'a hidden result cannot end the tap');
  clock = 150;
  shown = true;
  mutation();
  frames.shift()();
  assert.throws(read, /not observed/, 'the DOM commit alone is not a painted result');
  clock = 180;
  frames.shift()();
  const timing = read();
  assert.equal(timing.durationMs, 60);
  assert.equal(timing.domMs, 150);
  clock = 250;
  mutation();
  assert.equal(read().frameMs, 180);
});

test('a fresh document uses navigation time origin, including a visible match after a hidden retained screen', () => {
  let clock = 100,
    mutation;
  const frames = [];
  const hidden = { getBoundingClientRect: () => ({ width: 0, height: 0 }) };
  const result = { getBoundingClientRect: () => ({ width: 100, height: 20 }) };
  const sandbox = {
    window: {},
    document: { querySelectorAll: () => [hidden, result] },
    performance: { now: () => clock },
    getComputedStyle: () => ({ visibility: 'visible' }),
    requestAnimationFrame: (handler) => frames.push(handler),
    MutationObserver: class {
      constructor(handler) {
        mutation = handler;
      }
      observe() {}
      disconnect() {}
    },
  };
  runInNewContext(`(${armTapTiming})`, sandbox)({ navigation: true, selector: '#result' });
  const read = runInNewContext(`(${readTapTiming})`, sandbox);
  mutation();
  assert.throws(read, /not observed/);
  clock = 110;
  frames.shift()();
  clock = 120;
  frames.shift()();
  assert.equal(read().startMs, 0);
  assert.equal(read().durationMs, 120);
  clock = 900; // A late driver read must not move the result clock.
  assert.equal(read().durationMs, 120);
});

test('creating a thread cannot finish on the parent Room composer', () => {
  let mutation, input;
  const frames = [];
  const result = { getBoundingClientRect: () => ({ width: 100, height: 20 }) };
  const location = { pathname: '/beeline/chat/parent' };
  const sandbox = {
    window: {},
    location,
    document: {
      querySelectorAll: (selector) => (selector.includes('forward-corner-sheet') ? [] : [result]),
      addEventListener: (_, handler) => {
        input = handler;
      },
      removeEventListener() {},
    },
    performance: { now: () => 100 },
    getComputedStyle: () => ({ visibility: 'visible' }),
    requestAnimationFrame: (handler) => frames.push(handler),
    MutationObserver: class {
      constructor(handler) {
        mutation = handler;
      }
      observe() {}
      disconnect() {}
    },
  };
  runInNewContext(`(${armTapTiming})`, sandbox)(tapFeedback('create-corner', { roomId: 'parent' }));
  input();
  mutation();
  assert.equal(frames.length, 0);
  location.pathname = '/beeline/chat/new-thread';
  mutation();
  assert.equal(frames.length, 1);
});
