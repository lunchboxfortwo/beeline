// The blocking web head hands over the stored value used for first paint.
interface Window {
  __beelineLaunchSettings?: { raw: string | null };
  // The web head's live socket and first read, adopted by LiveConnection.
  __beelineLaunchLive?: {
    url: string;
    token: string;
    path: string;
    socket: WebSocket;
    reads: { id: string; op: string; args: unknown }[];
    release(): MessageEvent[];
  };
}
