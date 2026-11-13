import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { removeArchivedCornerData } from './archived-corner-cleanup.js';
import { writePrivateFileAtomically } from './atomic-private-file.js';
import { DaemonApiError, type DaemonApiClient } from './daemon-api-client.js';
import { reclaimHelperStorage, type StorageRoomState } from './helper-storage.js';
import { discoverLegacyStorageOwners, pruneOpenCheckoutObjects, readStorageOwners, reclaimOwnedCheckout, rememberStorageOwner, type StorageOwner } from './storage-owners.js';

/**
 * Local cleanup of archived places. It runs beside delivery and never holds it:
 * a place with a live session is skipped and reconsidered on the next pass.
 */
export class PlaceStorage {
  private readonly refused = new Set<string>();
  private flight?: Promise<void>;
  private next?: readonly StorageRoomState[];

  constructor(private readonly options: {
    supervisorRoot: string;
    runtimeDir: string;
    workspaceId: string;
    agentId: string;
    operatorHome?: string;
    api: DaemonApiClient;
    live(placeId: string): boolean;
  }) {}

  /** Coalesce: one sweep at a time, with the newest facts. */
  sweep(states: readonly StorageRoomState[]): void {
    this.next = states;
    this.flight ??= (async () => {
      while (this.next) {
        const current = this.next;
        this.next = undefined;
        await this.sweepCorners().catch(error => console.warn('[body] corner cleanup deferred:', error));
        await this.sweepRooms(current).catch(error => console.warn('[body] private storage cleanup deferred:', error));
      }
    })().finally(() => { this.flight = undefined; });
  }

  async idle(): Promise<void> { await this.flight; }

  private refusalPath(cornerId: string): string {
    return resolve(this.options.runtimeDir, 'corner-cleanup-refusals', `${createHash('sha256').update(cornerId).digest('hex')}.json`);
  }

  private async wasRefused(cornerId: string): Promise<boolean> {
    if (this.refused.has(cornerId)) return true;
    if (await lstat(this.refusalPath(cornerId)).catch(() => undefined)) {
      this.refused.add(cornerId);
      return true;
    }
    return false;
  }

  private async refuse(cornerId: string, error: DaemonApiError): Promise<void> {
    this.refused.add(cornerId);
    await writePrivateFileAtomically(this.refusalPath(cornerId), `${JSON.stringify({ cornerId, status: error.status, code: error.code })}\n`);
    console.warn(`[body] corner ${cornerId} cleanup refused; local work kept`);
  }

  /** A corner the server reports archived loses its local copies. */
  async reapCorner(cornerId: string): Promise<void> {
    if (this.options.live(cornerId) || await this.wasRefused(cornerId)) return;
    let archived: boolean | undefined;
    try {
      archived = (await this.options.api.execute('getCornerRestoreState', { cornerId })).archived;
    } catch (error) {
      if (error instanceof DaemonApiError && !error.retryable && error.status >= 400 && error.status < 500)
        await this.refuse(cornerId, error);
      return;
    }
    if (archived !== true) return;
    const { supervisorRoot, workspaceId } = this.options;
    const owners = (await readStorageOwners(supervisorRoot)).filter(owner => owner.kind === 'corners' && owner.roomId === cornerId);
    for (const owner of [...owners, { workspaceId, roomId: cornerId, kind: 'corners', itemId: cornerId } as StorageOwner]) {
      const ended: StorageOwner = { ...owner, archived: true, ended: true, endedAt: owner.endedAt ?? Date.now() };
      await rememberStorageOwner(supervisorRoot, ended);
      await reclaimOwnedCheckout(supervisorRoot, ended, {
        log: entry => console.log(`[body] archived corner ${entry.roomId} deleted ${entry.path}; freed ${entry.freedBytes} bytes`),
      });
    }
    await this.reclaim([{ roomId: cornerId, archived: true }]);
  }

  private async sweepCorners(): Promise<void> {
    const root = resolve(this.options.supervisorRoot, 'beeline', 'corners');
    const local = await readdir(root, { withFileTypes: true }).catch(() => []);
    const owners = await readStorageOwners(this.options.supervisorRoot);
    for (const entry of local) {
      if (!entry.isDirectory()) continue;
      const mapped = owners.find(owner => owner.kind === 'corners' && owner.itemId === entry.name);
      const cornerId = mapped?.roomId ?? (!/^[a-f0-9]{64}$/.test(entry.name) ? entry.name : undefined);
      if (cornerId) await this.reapCorner(cornerId);
    }
  }

  private reclaim(states: readonly StorageRoomState[]) {
    const { supervisorRoot, runtimeDir } = this.options;
    return readStorageOwners(supervisorRoot).then(owners => reclaimHelperStorage({
      runtimeDir,
      removeArchived: roomId => removeArchivedCornerData(supervisorRoot, roomId, resolve(supervisorRoot, 'beeline/corners', roomId), {
        runtimeDir, log: entry => console.log(`[body] archived private storage deleted ${entry.path}; freed ${entry.freedBytes} bytes`),
      }),
      readStates: async () => states,
      relatedRoots: roomId => [resolve(supervisorRoot, 'beeline/corners', roomId),
        ...owners.filter(owner => owner.roomId === roomId).map(owner => resolve(supervisorRoot, 'beeline', owner.kind, owner.itemId))],
      operatorHome: this.options.operatorHome,
      withIdleRoom: async (roomId, task) => {
        if (this.options.live(roomId)) return false;
        await task();
        return true;
      },
      log: entry => console.log(`[body] private storage: Room ${entry.roomId} ${entry.kind} deleted ${entry.path}; freed ${entry.freedBytes} bytes`),
    }));
  }

  private async sweepRooms(states: readonly StorageRoomState[]): Promise<void> {
    const { supervisorRoot, workspaceId, agentId } = this.options;
    for (const owner of await discoverLegacyStorageOwners(supervisorRoot, workspaceId, states, async () => undefined))
      await rememberStorageOwner(supervisorRoot, owner);
    await this.reclaim(states);
    await pruneOpenCheckoutObjects(supervisorRoot, states, {
      log: entry => console.log(`[body] open checkout storage deleted ${entry.path}; freed ${entry.freedBytes} bytes`),
    });
    const archived = new Set(states.filter(state => state.archived).map(state => state.roomId));
    for (const owner of await readStorageOwners(supervisorRoot)) {
      if (!archived.has(owner.roomId) || owner.agentId && owner.agentId !== agentId || this.options.live(owner.roomId)) continue;
      const state = states.find(entry => entry.roomId === owner.roomId)!;
      const ended = { ...owner, archived: true, ended: true, endedAt: owner.endedAt ?? Date.now(), landedHeadSha: state.landedHeadSha };
      await rememberStorageOwner(supervisorRoot, ended);
      await reclaimOwnedCheckout(supervisorRoot, ended, {
        landedHeadSha: state.landedHeadSha,
        log: entry => console.log(`[body] Room ${owner.roomId} checkout deleted ${entry.path}; freed ${entry.freedBytes} bytes`),
      });
    }
  }
}
