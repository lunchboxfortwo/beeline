let restored: { pathname: string; forget: () => void } | null = null;

export function setRestoredPage(page: string | null, forget: () => void = () => {}): void {
  restored = page ? { pathname: page.split('?')[0]!, forget } : null;
}

export function observeRestoredPage(pathname: string): void {
  if (restored?.pathname !== pathname) restored = null;
}

/** The existing authoritative Room read decides availability, without another
 * request or treating an offline read as a deleted page. Only restoration falls back. */
export function finishRestoredRoom(channelId: string, available: boolean): boolean {
  if (restored?.pathname !== `/beeline/chat/${encodeURIComponent(channelId)}`) return false;
  const landing = restored;
  restored = null;
  if (available) return false;
  landing.forget();
  return true;
}
