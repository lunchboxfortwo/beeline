/**
 * The live GitHub checks read for one corner. The server's GitHubOperations
 * sets it. A wake decision outside a webhook (reconcile) reads GitHub through
 * it first, so a stored green never wakes a reviewer by itself.
 */
import type { SqlDatabase } from './database.js';
import { CornerAccessDatabase } from './corner-access-database.js';

const readers = new WeakMap<SqlDatabase, (cornerId: string) => Promise<unknown>>();

export function setLiveCornerChecksReader(database: SqlDatabase, read: (cornerId: string) => Promise<unknown>): void {
  readers.set(CornerAccessDatabase.physical(database), read);
}

/** A failed read rejects the event rather than planning a wake from stored state. */
export async function readLiveCornerChecks(database: SqlDatabase, cornerId: string): Promise<void> {
  try {
    await readers.get(CornerAccessDatabase.physical(database))?.(cornerId);
  } catch (error) {
    console.warn(`[github] live checks read failed for ${cornerId}:`, error instanceof Error ? error.message : String(error));
    throw error;
  }
}
