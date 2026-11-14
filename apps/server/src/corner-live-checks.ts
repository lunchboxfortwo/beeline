/**
 * The live GitHub checks read for one corner. The server's GitHubOperations
 * sets it. A wake decision outside a webhook (reconcile) reads GitHub through
 * it first, so a stored green never wakes a reviewer by itself.
 */
import { CornerAccessDatabase } from './corner-access-database.js';
import type { SqlDatabase } from './database.js';

const readers = new WeakMap<SqlDatabase, (cornerId: string) => Promise<unknown>>();

export function setLiveCornerChecksReader(database: SqlDatabase, read: (cornerId: string) => Promise<unknown>): void {
  readers.set(CornerAccessDatabase.physical(database), read);
}
