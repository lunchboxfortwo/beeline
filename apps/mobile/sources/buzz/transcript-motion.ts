
export type TranscriptArrivalState = {
  surfaceId: string | null;
  initialized: boolean;
  seenIds: ReadonlySet<string>;
};

export type TranscriptArrivalObservation = {
  state: TranscriptArrivalState;
  arrivingIds: ReadonlySet<string>;
};

export const EMPTY_TRANSCRIPT_ARRIVAL_STATE: TranscriptArrivalState = {
  surfaceId: null,
  initialized: false,
  seenIds: new Set(),
};

/**
 * Compare transcript ids at the Room boundary. The first hydrated frame is
 * history and only seeds the registry; later ids are genuine live arrivals.
 */
export function observeTranscriptArrivals(
  previous: TranscriptArrivalState,
  input: { surfaceId: string; hydrated: boolean; ids: readonly string[] },
): TranscriptArrivalObservation {
  if (previous.surfaceId !== input.surfaceId) {
    if (!input.hydrated) {
      return {
        state: { surfaceId: input.surfaceId, initialized: false, seenIds: new Set() },
        arrivingIds: new Set(),
      };
    }
    return {
      state: { surfaceId: input.surfaceId, initialized: true, seenIds: new Set(input.ids) },
      arrivingIds: new Set(),
    };
  }
  if (!input.hydrated) return { state: previous, arrivingIds: new Set() };
  if (!previous.initialized) {
    return {
      state: { surfaceId: input.surfaceId, initialized: true, seenIds: new Set(input.ids) },
      arrivingIds: new Set(),
    };
  }

  // Ids ahead of the oldest id already seen are an older page paging in above
  // the reader: history, not arrivals.
  const firstSeen = input.ids.findIndex((id) => previous.seenIds.has(id));
  const arrivingIds = new Set(
    input.ids.filter((id, index) => index > firstSeen && !previous.seenIds.has(id)),
  );
  return {
    state: {
      surfaceId: input.surfaceId,
      initialized: true,
      seenIds: new Set([...previous.seenIds, ...input.ids]),
    },
    arrivingIds,
  };
}

