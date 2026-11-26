/** Trimmed, deduplicated and sorted, so a retry compares equal to the first open. */
export function normalizedThreadWorkItems(itemIds: readonly string[] | undefined): string[] {
  return [...new Set((itemIds ?? []).map(id => String(id).trim()).filter(Boolean))].sort();
}
