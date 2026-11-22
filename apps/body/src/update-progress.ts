/** CLI observers report their wait without taking ownership of the work. */
export function progress(line: string): void {
  process.stderr.write(`[beeline] ${line}\n`);
}

export function observe<T>(
  step: string,
  work: Promise<T>,
  options: { timeoutMs?: number; intervalMs?: number; report?: (line: string) => void } = {},
): Promise<T> {
  const report = options.report ?? progress;
  report(step);
  return new Promise<T>((resolve, reject) => {
    const heartbeat = setInterval(() => report(`${step}; still waiting`), options.intervalMs ?? 5000);
    const timer = setTimeout(() => {
      clearInterval(heartbeat);
      reject(new Error(`${step}: observer stopped waiting; work remains owned by its original process`));
    }, options.timeoutMs ?? 180_000);
    work.then(resolve, error => reject(new Error(`${step}: ${String(error)}`))).finally(() => {
      clearInterval(heartbeat);
      clearTimeout(timer);
    });
  });
}
