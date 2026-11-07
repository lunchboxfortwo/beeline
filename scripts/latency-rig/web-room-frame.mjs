// Browser-only completion for the deterministic busy Room fixture.
export function completeRoomFrame(document, largeId) {
  const visible = (element) => {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    for (let node = element; node; node = node.parentElement) {
      const style = document.defaultView.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0' || node.getAttribute('aria-hidden') === 'true') return false;
    }
    const x = (Math.max(0, rect.left) + Math.min(rect.right, document.defaultView.innerWidth)) / 2;
    const y = (Math.max(0, rect.top) + Math.min(rect.bottom, document.defaultView.innerHeight)) / 2;
    if (x < rect.left || x >= rect.right || y < rect.top || y >= rect.bottom) return false;
    const hit = document.elementFromPoint(x, y);
    return hit === element || element.contains(hit);
  };
  const answer = [...document.querySelectorAll(`[data-testid="chat-message-text-${largeId}"]`)].find(visible);
  const composer = [...document.querySelectorAll('[data-testid="chat-input"]')].find(visible);
  if (!answer || !composer || answer.textContent !== 'streamed answer '.repeat(640).trimEnd()) return false;
  // The answer is the newest and fills the viewport in this fixture. All visible
  // message bodies must have text and layout, with no loading/error placeholder.
  if ([...document.querySelectorAll('[data-testid="room-surface-loader"], [data-testid="room-hydration-error"]')].some(visible)) return false;
  return [...document.querySelectorAll('[data-testid^="chat-message-text-"]')].filter(visible).every(e => e.textContent.length > 0);
}
