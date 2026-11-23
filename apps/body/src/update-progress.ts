export function progress(line: string): void {
  process.stderr.write(`[beeline] ${line}\n`);
}
