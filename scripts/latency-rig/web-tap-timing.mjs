/** Observe the same visible result as the driver, on the browser's own clock. */
export function tapFeedback(name, fixture) {
  const input = '[data-testid="chat-input"]';
  const room = `/beeline/chat/${fixture.roomId}`;
  switch (name) {
    case 'open-room':
      return { path: room, selector: input, text: fixture.text };
    case 'create-dm':
      return { pathPrefix: '/beeline/chat/', selector: input };
    case 'close-corner':
      return { path: room, selector: input, text: fixture.text };
    case 'leave-room':
      return { hidden: '[data-testid="leave-chat"]' };
    case 'answer-approval':
      return { buttonRemovedPrefix: 'Approve: ' };
    case 'send-attachment':
      return {
        text: 'Local Beeline latency attachment',
        hidden: '[data-testid="pending-chat-attachment-0"]',
      };
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
        (node) => visible(node) &&
          (node.getAttribute('aria-label') ?? '').startsWith(config.buttonRemovedPrefix),
      )
    : null;
  const timing = (window.__latencyTapTiming = {
    startMs: null,
  });
  let observed = false;
  const check = () => {
    if (observed || timing.startMs === null) return;
    if (config.path && location.pathname !== config.path) return;
    if (config.pathPrefix && !location.pathname.startsWith(config.pathPrefix)) return;
    if (config.selector && !visible(document.querySelector(config.selector))) return;
    if (config.hidden && visible(document.querySelector(config.hidden))) return;
    if (config.buttonRemovedPrefix && (!button || visible(button))) return;
    if (config.text) {
      const transcript = document.querySelector('[data-testid="chat-messages"]');
      if (!transcript) return;
      const walker = document.createTreeWalker(transcript, NodeFilter.SHOW_TEXT);
      let node,
        found = false;
      while ((node = walker.nextNode())) {
        if (node.textContent.trim() === config.text && visible(node.parentElement)) {
          found = true;
          break;
        }
      }
      if (!found) return;
    }
    observed = true;
    observer.disconnect();
    timing.domMs = performance.now();
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        timing.frameMs = performance.now();
        timing.durationMs = timing.frameMs - timing.startMs;
      }),
    );
  };
  const observer = new MutationObserver(check);
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
  });
  document.addEventListener(
    'pointerdown',
    () => {
      timing.startMs = performance.now();
    },
    { once: true, capture: true },
  );
}

export function readTapTiming() {
  const timing = window.__latencyTapTiming;
  if (!Number.isFinite(timing?.durationMs) || timing.durationMs <= 0)
    throw new Error('Tap result frame was not observed');
  return timing;
}
