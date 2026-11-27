// A warm visit can draw a new boundary once the server's cursor advances.
const spent = new Map<string, string>();

export function unreadLineSpent(roomId: string, boundary: string | null): boolean {
  return boundary !== null && spent.get(roomId) === boundary;
}

export function spendUnreadLine(roomId: string, boundary: string): void {
  spent.set(roomId, boundary);
}

export function issueUnreadLine(roomId: string): void {
  spent.delete(roomId);
}
