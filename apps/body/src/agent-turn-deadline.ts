/** A six-hour hard ceiling permits long coding turns while freeing a message
 * whose model never returns. This clock never starts another model request. */
export const AGENT_TURN_DEADLINE_MS = 6 * 60 * 60 * 1000;

export class AgentTurnDeadline {
  async run<T>(work: () => Promise<T>, stop: () => void): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error('The model call timed out after six hours.'));
        try { stop(); } catch { /* The timeout still releases intake if stopping fails. */ }
      }, AGENT_TURN_DEADLINE_MS);
      timer.unref?.();
    });
    try { return await Promise.race([Promise.resolve().then(work), expired]); }
    finally { clearTimeout(timer); }
  }
}
