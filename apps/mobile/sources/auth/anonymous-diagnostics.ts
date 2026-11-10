import type { DiagnosticAck, DiagnosticBatch } from '@beeline/api-contract/diagnostics';

type Sender = (batch: DiagnosticBatch) => Promise<DiagnosticAck>;
let sender: Sender | undefined;

/** The existing funnel owns anonymous HTTP; registering it needs no native metadata. */
export function setAnonymousDiagnosticSender(next: Sender): void { sender=next; }
export async function sendAnonymousDiagnostics(batch: DiagnosticBatch): Promise<DiagnosticAck> {
  if (!sender) await import('./signin-funnel');
  if (!sender) throw new Error('sender_unavailable');
  return sender(batch);
}
