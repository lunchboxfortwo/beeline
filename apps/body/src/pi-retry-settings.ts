/** Let Pi retry a model request that fails with a temporary error (a dropped stream, a 5xx, overload) at most twice. */
export function piRetrySettings() {
  return { retry: { enabled: true, maxRetries: 2, provider: { maxRetries: 2 } } } as const;
}
