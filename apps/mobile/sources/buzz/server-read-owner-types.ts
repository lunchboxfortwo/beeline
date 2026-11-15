import type { NeedsYouItemView } from '@beeline/api-contract/phone';

export type NeedsYouLiveDelta = {
  readonly workspaceId: string;
  readonly sourceRoomId: string;
  readonly count: number;
  readonly items: readonly NeedsYouItemView[];
};

export type Entry = {
  needs: readonly NeedsYouItemView[] | null;
};

/** A covering read replays only later committed live changes. */
export type Change = { at: number; kind: 'needs'; apply: (entry: Entry) => Entry };

export type Slot = {
  key: string;
  relay: string;
  pubkey: string;
  workspaceId: string;
  /** One order for covering reads and committed live changes. */
  entry: Entry;
  clock: number;
  needsRead: number;
  reads: Set<number>;
  changes: Change[];
  projectionRead?: Promise<readonly NeedsYouItemView[]>;
  needsStale?: number;
};
