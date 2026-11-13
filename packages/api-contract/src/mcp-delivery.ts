export const LOCAL_RECEIVER_RECOVERY = 'The local Beeline receiver failed to start. Run npx -y usebeeline@latest join again in the same coding session. If it still fails, check that this computer can create and run its local receiver. Opening the join website cannot repair a local receiver failure.';

/** Server-owned delivery facts. Membership and a configured callback alone never imply ready. */
export interface MemberDelivery {
  /** Derived by the server from actual route/credential/lifecycle facts, never elapsed silence. */
  readonly offline?: boolean;
  readonly reconnectUrl?: string;
  readonly state: 'setup_unfinished' | 'proved_ready' | 'failed' | 'host_without_live_delivery';
  readonly mechanism?: 'local' | 'events' | 'webhook' | 'on_demand';
  readonly host?: string;
  readonly surface?: string;
  readonly conversation?: string;
  readonly generation?: string;
  readonly proof?: { readonly generation: string; readonly receivedAt: string };
  readonly failure?: string;
}
export function readMemberDelivery(value: unknown): MemberDelivery | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const item = value as Record<string, unknown>;
  if (
    !['setup_unfinished', 'proved_ready', 'failed', 'host_without_live_delivery'].includes(
      String(item.state),
    )
  )
    return;
  if (
    item.mechanism !== undefined &&
    !['local', 'events', 'webhook', 'on_demand'].includes(String(item.mechanism))
  )
    return;
  const result: Record<string, unknown> = { state: item.state };
  if (item.offline !== undefined) {
    if (typeof item.offline !== 'boolean') return;
    result.offline = item.offline;
  }
  if (item.mechanism !== undefined) result.mechanism = item.mechanism;
  for (const key of ['host', 'surface', 'conversation', 'generation', 'failure', 'reconnectUrl']) {
    if (item[key] !== undefined) {
      if (typeof item[key] !== 'string' || item[key].length > 300) return;
      result[key] = item[key];
    }
  }
  if (item.reconnectUrl !== undefined) {
    try {
      const url = new URL(String(item.reconnectUrl));
      if (url.protocol !== 'https:' || url.username || url.password) return;
    } catch {
      return;
    }
  }
  if (item.proof !== undefined) {
    if (!item.proof || typeof item.proof !== 'object') return;
    const proof = item.proof as Record<string, unknown>;
    if (
      typeof proof.generation !== 'string' ||
      typeof proof.receivedAt !== 'string' ||
      !Number.isFinite(Date.parse(proof.receivedAt))
    )
      return;
    result.proof = { generation: proof.generation, receivedAt: proof.receivedAt };
  }
  return result as unknown as MemberDelivery;
}
