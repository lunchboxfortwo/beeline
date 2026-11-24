import { threadState, type CornerLifecycleView, type CornerState, type CornerStateReason } from '@beeline/api-contract/phone';

export type CornerDisplayItem = {
  readonly state: CornerState;
  readonly stateAt?: number;
  readonly reason?: CornerStateReason;
  readonly itemId?: string;
  readonly blocker?: import('@beeline/api-contract/phone').CornerBlocker;
  /** PR/check narration; never an input to the displayed state. */
  readonly lifecycle: CornerLifecycleView;
};

/**
 * What names a corner is its parent, and the Room header carries that fact on
 * its own: `parentId`. The richer `parent` block is how a reader gets the
 * parent's NAME, so a payload that drops it must still read as a corner.
 */
export function roomViewParentId(view: {
  readonly room: { readonly parentId?: string };
  readonly parent?: { readonly id: string };
}): string | undefined {
  return view.parent?.id ?? view.room.parentId;
}

/**
 * The one archived rule for a Room or corner screen: only the server's
 * `archived: true` is a fact. The composer, the turn stream and the header
 * all read it.
 */
export function roomIsArchived(room: { readonly archived?: boolean } | undefined): boolean {
  return room?.archived === true;
}

/**
 * A corner's header state is its row in the parent Room's corner record, the
 * same row the Corners screen paints. With no row yet, an archived corner
 * shows archived; anything else shows no state until the row lands.
 */
export function cornerHeaderItem(
  row: CornerDisplayItem | undefined,
  archived: boolean,
): CornerDisplayItem | undefined {
  if (row) return row;
  if (archived)
    return { ...threadState({ ended: true }), lifecycle: { lifecycle: 'unknown', checks: 'unknown' } };
  return undefined;
}
