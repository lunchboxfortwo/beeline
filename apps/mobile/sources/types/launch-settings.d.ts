// The blocking web head hands over the stored value used for first paint.
interface Window {
  __beelineLaunchSettings?: { raw: string | null };
  // The web head's live socket, adopted by LiveConnection.
  __beelineLaunchLive?: {
    url: string;
    token: string;
    socket: WebSocket;
    release(): MessageEvent[];
  };
}
