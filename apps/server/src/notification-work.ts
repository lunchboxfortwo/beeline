/** Keep notification fanout from checking out every foreground database slot. */
export class NotificationWork {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly concurrency = 2) {}

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw signal.reason ?? new Error('aborted');
    if (this.active >= this.concurrency) {
      await new Promise<void>((resolve, reject) => {
        const entry = () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        const onAbort = () => {
          const index = this.waiting.indexOf(entry);
          if (index >= 0) this.waiting.splice(index, 1);
          reject(signal?.reason ?? new Error('aborted'));
        };
        this.waiting.push(entry);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    } else {
      this.active++;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.releaseSlot();
    };
  }

  private releaseSlot(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.active--;
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) await new Promise<void>(resolve => this.waiting.push(resolve));
    else this.active++;
    try {
      return await work();
    } finally {
      this.releaseSlot();
    }
  }
}
