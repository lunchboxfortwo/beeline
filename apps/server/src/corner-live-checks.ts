/**
 * The live GitHub checks read for one corner. The server's GitHubOperations
 * sets it. A wake decision outside a webhook (reconcile) reads GitHub through
 * it first, so a stored green never wakes a reviewer by itself.
 */
let reader: ((cornerId: string) => Promise<unknown>) | undefined;

export function setLiveCornerChecksReader(read: (cornerId: string) => Promise<unknown>): void {
  reader = read;
}

/** False when GitHub could not be read: the caller must not wake from stored state. */
export async function readLiveCornerChecks(cornerId: string): Promise<boolean> {
  if (!reader) return true;
  try {
    await reader(cornerId);
    return true;
  } catch (error) {
    console.warn(`[github] live checks read failed for ${cornerId}:`, error instanceof Error ? error.message : String(error));
    return false;
  }
}
