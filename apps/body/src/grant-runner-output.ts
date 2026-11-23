import { StringDecoder } from 'node:string_decoder';

export interface GrantOutputLine {
  stream: 'stdout' | 'stderr';
  text: string;
}

export function grantOutputLines(
  secrets: ReadonlyMap<string, string>,
  emit?: (line: GrantOutputLine) => void,
  sandboxMarker?: string,
) {
  const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
  const pending = { stdout: '', stderr: '' };
  const line = (stream: 'stdout' | 'stderr', text: string) => {
    if (sandboxMarker && text.trimEnd() === sandboxMarker) return;
    if (sandboxMarker) text = text.replace(sandboxMarker, '');
    for (const [name, secret] of secrets) {
      if (secret.length < 4) continue;
      for (const part of secret.split(/\r\n|\r|\n/)) if (part) text = text.split(part).join(`[${name}]`);
    }
    emit?.({ stream, text });
  };
  return {
    chunk(stream: 'stdout' | 'stderr', bytes: Buffer) {
      if (!emit) return;
      pending[stream] += decoders[stream].write(bytes);
      let end: number;
      while ((end = pending[stream].indexOf('\n')) >= 0) {
        line(stream, pending[stream].slice(0, end + 1));
        pending[stream] = pending[stream].slice(end + 1);
      }
    },
    close() {
      if (!emit) return;
      for (const stream of ['stdout', 'stderr'] as const) {
        pending[stream] += decoders[stream].end();
        if (pending[stream]) line(stream, pending[stream]);
      }
    },
  };
}
