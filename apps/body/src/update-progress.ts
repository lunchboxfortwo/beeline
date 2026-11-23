/** CLI progress lines name the step and the peer being waited on. */
export function progress(line: string): void {
  process.stderr.write(`[beeline] ${line}\n`);
}
