import { readdir, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { DaemonOperationMap } from '@beeline/api-contract/daemon';
import { writePrivateFileAtomically } from './atomic-private-file.js';

/** An answer the agent produced, kept on disk until the server has it. */
export interface StoredAnswer {
  readonly itemId: string;
  readonly roomId: string;
  readonly requestId: string;
  /** Empty text does not acknowledge an unanswered queue item. */
  readonly text: string;
  readonly steps?: DaemonOperationMap['postRoomMessage']['input']['steps'];
}

/**
 * Answers are written before they are sent. A reconnect or a restarted
 * helper sends the stored answer again; it never asks the agent again.
 */
export class AnswerStore {
  constructor(private readonly directory: string) {}

  private path(itemId: string): string {
    return resolve(this.directory, `${itemId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
  }

  async save(answer: StoredAnswer): Promise<void> {
    await writePrivateFileAtomically(this.path(answer.itemId), JSON.stringify(answer));
  }

  async remove(itemId: string): Promise<void> {
    await rm(this.path(itemId), { force: true });
  }

  async all(): Promise<StoredAnswer[]> {
    const names = await readdir(this.directory).catch(() => [] as string[]);
    const answers: StoredAnswer[] = [];
    for (const name of names.filter(entry => entry.endsWith('.json'))) {
      try { answers.push(JSON.parse(await readFile(resolve(this.directory, name), 'utf8')) as StoredAnswer); }
      catch (error) { console.warn(`[body] stored answer ${name} unreadable:`, error); }
    }
    return answers;
  }
}
