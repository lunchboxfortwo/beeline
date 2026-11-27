import { readdir, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { DaemonOperationMap } from '@beeline/api-contract/daemon';
import { writePrivateFileAtomically } from './atomic-private-file.js';

/** An answer the agent produced, kept on disk until the server has it. */
export interface StoredAnswer {
  readonly itemId: string;
  /** Other items covered by this one durable answer. */
  readonly queuedRequestIds?: readonly string[];
  readonly roomId: string;
  readonly requestId: string;
  readonly resetId?: string;
  /** Empty text alone does not acknowledge an unanswered queue item. */
  readonly text: string;
  readonly failureReason?: string;
  /** The harness ended; unanswered requests remain owed. */
  readonly harnessEnded?: boolean;
  /** A successful empty return can acknowledge a scheduled wake on replay. */
  readonly silentCompletion?: boolean;
  /** The item left the queue after a committed reply, before the harness returned. */
  readonly finishesAnsweredItem?: true;
  readonly invocation?: import('@beeline/api-contract/daemon').AgentInvocation;
  readonly steps?: DaemonOperationMap['postRoomMessage']['input']['steps'];
}

/**
 * Answers are written before they are sent. A reconnect or a restarted
 * helper sends the stored answer again; it never asks the agent again.
 */
export class AnswerStore {
  constructor(private readonly directory: string) {}

  private path(answer: Pick<StoredAnswer, 'itemId' | 'resetId'>): string {
    const id = answer.itemId.replace(/[^A-Za-z0-9_-]/g, '_');
    const suffix = answer.resetId ? `.${answer.resetId.replace(/[^A-Za-z0-9_-]/g, '_')}` : '';
    return resolve(this.directory, `${id}${suffix}.json`);
  }

  async save(answer: StoredAnswer): Promise<void> {
    await writePrivateFileAtomically(this.path(answer), JSON.stringify(answer));
  }

  async remove(answer: Pick<StoredAnswer, 'itemId' | 'resetId'>): Promise<void> {
    await rm(this.path(answer), { force: true });
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
