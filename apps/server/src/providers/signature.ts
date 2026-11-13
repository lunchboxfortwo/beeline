import { timingSafeEqual } from 'node:crypto';
export function sameHexSignature(expected: Buffer, value: unknown): boolean {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)) return false;
  const received = Buffer.from(value, 'hex');
  return received.length === expected.length && timingSafeEqual(received, expected);
}
