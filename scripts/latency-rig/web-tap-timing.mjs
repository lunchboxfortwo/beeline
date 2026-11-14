/** Observe the same visible result as the driver, on the browser's own clock. */
export function tapFeedback(name, fixture, token) {
  const input = '[data-testid="chat-input"]';
  const room = `/beeline/chat/${fixture.roomId}`;
  switch (name) {
    case 'open-room':
      return { path: room, selector: input, text: fixture.text };
    case 'open-corner':
      return {
        path: `/beeline/chat/${fixture.cornerId}`,
        selector: input,
        required: '[data-testid="thread-title-block"]',
        text: fixture.text,
      };
    case 'create-corner':
      return {
        pathPrefix: '/beeline/chat/',
        notPath: room,
        selector: input,
        required: '[data-testid="thread-title-block"]',
        hidden: '[data-testid="forward-corner-sheet"]',
      };
    case 'create-dm':
      return { pathPrefix: '/beeline/chat/', selector: input };
    case 'close-corner':
      return {
        path: room,
        selector: input,
        text: fixture.text,
        hidden: '[data-testid="thread-title-block"]',
      };
    case 'leave-room':
      return { hidden: '[data-testid="leave-chat"]' };
    case 'answer-approval':
      return { buttonRemovedPrefix: 'Approve: ' };
    case 'send-attachment':
      return {
        text: 'Local Beeline latency attachment',
        hidden: '[data-testid="pending-chat-attachment-0"]',
      };
    case 'send-text':
      return { text: token };
    case 'react-message':
      return { selector: `[data-testid="reaction-chip-${fixture.messageId}-👍"]` };
    case 'bookmark-message':
      return { selector: '[data-testid="chat-bookmark-marker"]' };
    case 'report-message':
      return { selector: '[data-testid="chat-reported-marker"]' };
    case 'delete-message':
      return { absentText: fixture.text };
    case 'rename-room':
      return {
        selector: '[data-testid="chat-name"]',
        text: token,
        scope: 'body',
        hidden: '[data-testid="chat-name-editor"]',
      };
    case 'choose-model':
      return { selector: '[data-testid="model-applies-model"]' };
    case 'change-yolo':
      return { text: 'Ask first', scope: 'body' };
    case 'stop-turn':
      return { hidden: '[aria-label="Stop this turn"]' };
    default:
      return null;
  }
}

// Runs inside Chromium. Mutation delivery observes DOM commits without a
// driver round trip or selector polling between the commit and its frame.
export function armTapTiming(config) {
  const visible = (node) =>
    Boolean(
      node &&
      node.getBoundingClientRect().width > 0 &&
      node.getBoundingClientRect().height > 0 &&
      getComputedStyle(node).visibility !== 'hidden',
    );
  const button = config.buttonRemovedPrefix
    ? [...document.querySelectorAll('[role="button"],button')].find(
        (node) =>
          visible(node) &&
          (node.getAttribute('aria-label') ?? '').startsWith(config.buttonRemovedPrefix),
      )
    : null;
  const timing = (window.__latencyTapTiming = {
    startMs: config.navigation ? 0 : null,
    operations: [],
  });
  const replies = new Map();
  const send = typeof WebSocket === 'undefined' ? null : WebSocket.prototype.send;
  const sockets = new Set();
  const receive = (event) => {
    let response;
    try {
      response = JSON.parse(event.data);
    } catch {
      return;
    }
    const operation = replies.get(response.id);
    if (operation) operation.replyMs = performance.now();
  };
  function observeSend(data) {
    if (timing.startMs !== null) {
      try {
        const frame = JSON.parse(data);
        if (frame.op) {
          const operation = { op: frame.op, sendMs: performance.now() };
          timing.operations.push(operation);
          replies.set(frame.id, operation);
          if (!sockets.has(this)) {
            sockets.add(this);
            this.addEventListener('message', receive);
          }
        }
      } catch {
        /* Non-JSON frames are not phone operations. */
      }
    }
    return send.call(this, data);
  }
  if (send) WebSocket.prototype.send = observeSend;
  let observed = false;
  const shown = (selector) => [...document.querySelectorAll(selector)].some(visible);
  const check = () => {
    if (observed || timing.startMs === null) return;
    if (config.path && location.pathname !== config.path) return;
    if (config.notPath && location.pathname === config.notPath) return;
    if (config.pathPrefix && !location.pathname.startsWith(config.pathPrefix)) return;
    if (config.selector && !shown(config.selector)) return;
    if (config.required && !shown(config.required)) return;
    if (config.hidden && shown(config.hidden)) return;
    if (config.buttonRemovedPrefix && (!button || visible(button))) return;
    if (config.text || config.absentText) {
      const transcripts = document.querySelectorAll(
        config.scope ?? '[data-testid="chat-messages"]',
      );
      if (!transcripts.length) return;
      let found = false;
      for (const transcript of transcripts) {
        const walker = document.createTreeWalker(transcript, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          if (
            node.textContent.trim() === (config.text ?? config.absentText) &&
            visible(node.parentElement)
          ) {
            found = true;
            break;
          }
        }
      }
      if (config.absentText ? found : !found) return;
    }
    observed = true;
    observer.disconnect();
    timing.domMs = performance.now();
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        timing.frameMs = performance.now();
        timing.durationMs = timing.frameMs - timing.startMs;
        if (send && WebSocket.prototype.send === observeSend) WebSocket.prototype.send = send;
        for (const socket of sockets) socket.removeEventListener('message', receive);
      }),
    );
  };
  const observer = new MutationObserver(check);
  observer.observe(document, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
  });
  if (!config.navigation) {
    const start = () => {
      document.removeEventListener('pointerdown', start, true);
      document.removeEventListener('keydown', start, true);
      timing.startMs = performance.now();
    };
    document.addEventListener('pointerdown', start, { once: true, capture: true });
    document.addEventListener('keydown', start, { once: true, capture: true });
  }
}

export function readTapTiming() {
  const timing = window.__latencyTapTiming;
  if (!Number.isFinite(timing?.durationMs) || timing.durationMs <= 0)
    throw new Error('Tap result frame was not observed');
  return timing;
}
