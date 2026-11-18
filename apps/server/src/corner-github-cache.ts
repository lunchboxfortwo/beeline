/** Read-only SQL projection of GitHub facts committed by corner-lifecycle.ts. */
export function cornerLifecycleSql(cornerId: string): string {
  return `(SELECT cache.lifecycle FROM corner_github_cache cache WHERE cache.corner_id=${cornerId})`;
}
