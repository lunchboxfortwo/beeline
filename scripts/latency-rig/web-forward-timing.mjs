/** Runs in the page before the unchanged action start. Never drives the app. */
export function armForwardTiming({ messageText } = {}) {
  const picker = document.querySelector('[data-testid="forward-room-picker"]');
  if (!picker?.isConnected) throw new Error('Forward picker is not mounted');
  window.__forwardTiming?.cleanup();
  const timing = { events: {}, complete: false };
  window.__forwardTiming = timing;
  const mark = (name) => {
    timing.events[name] ??= performance.now();
  };
  const click = (event) => {
    if (picker.contains(event.target)) mark('click');
  };
  const animation = (event) => {
    if (timing.events.reply !== undefined && event.target.contains(picker)) {
      mark(event.type);
      if (event.type === 'animationend') timing.animationDurationMs = event.elapsedTime * 1000;
    }
  };
  const send = WebSocket.prototype.send;
  let socket, reply;
  function observeSend(data) {
    let frame;
    try {
      frame = JSON.parse(data);
    } catch {
      /* Non-JSON frames are irrelevant. */
    }
    if (frame?.op === 'sendRoomMessage') {
      mark('send');
      socket = this;
      reply = (event) => {
        let response;
        try {
          response = JSON.parse(event.data);
        } catch {
          return;
        }
        if (response.id === frame.id) mark('reply');
      };
      socket.addEventListener('message', reply);
    }
    return send.call(this, data);
  }
  WebSocket.prototype.send = observeSend;
  document.addEventListener('click', click, { capture: true, passive: true });
  document.addEventListener('animationstart', animation, true);
  document.addEventListener('animationend', animation, true);
  const observer = new MutationObserver(() => {
    if (picker.isConnected || document.querySelector('[data-testid="forward-room-picker"]')) return;
    mark('removed');
    observer.disconnect();
    const sourceVisible = () => {
      if (!messageText) return;
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (node.textContent.trim() !== messageText) continue;
        const element = node.parentElement,
          rect = element.getBoundingClientRect();
        const x = rect.left + rect.width / 2,
          y = rect.top + rect.height / 2;
        const hit = document.elementFromPoint(x, y);
        if (rect.width && rect.height && hit && (element.contains(hit) || hit.contains(element)))
          mark('sourceMessageVisible');
      }
    };
    requestAnimationFrame(() => {
      sourceVisible();
      requestAnimationFrame(() => {
        sourceVisible();
        mark('resultFrame');
        timing.complete = true;
        timing.cleanup();
      });
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });
  timing.cleanup = () => {
    observer.disconnect();
    if (WebSocket.prototype.send === observeSend) WebSocket.prototype.send = send;
    if (socket && reply) socket.removeEventListener('message', reply);
    document.removeEventListener('click', click, true);
    document.removeEventListener('animationstart', animation, true);
    document.removeEventListener('animationend', animation, true);
  };
}

/** Driver timing remains separate; both clocks start at the original page mark. */
export function readForwardTiming() {
  const timing = window.__forwardTiming;
  if (!timing?.complete) throw new Error('Forward removal frame was not observed');
  const e = timing.events,
    start = window.__latencyStart;
  const required = [
    'click',
    'send',
    'reply',
    'animationstart',
    'animationend',
    'removed',
    'resultFrame',
  ];
  if (!Number.isFinite(start) || required.some((name) => !Number.isFinite(e[name])))
    throw new Error('Forward profile is incomplete');
  return {
    durationMs: e.resultFrame - start,
    removalMs: e.removed - start,
    dispatchMs: e.click - start,
    clickToSendMs: e.send - e.click,
    sendToReplyMs: e.reply - e.send,
    replyToAnimationMs: e.animationstart - e.reply,
    animationMs: e.animationend - e.animationstart,
    configuredAnimationMs: timing.animationDurationMs,
    closeStartMs: e.animationstart - start,
    animationEndMs: e.animationend - start,
    tapToGoneMs: e.removed - e.click,
    closeToGoneMs: e.removed - e.animationstart,
    sourceMessageVisibleMs:
      e.sourceMessageVisible === undefined ? null : e.sourceMessageVisible - start,
    animationEndToRemovalMs: e.removed - e.animationend,
    removalToFrameMs: e.resultFrame - e.removed,
  };
}
