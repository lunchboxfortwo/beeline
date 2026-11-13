import { expect, it, vi } from 'vitest';
import { chatMessageLinkToken, copyChatMessageLink, openChatMessageLink } from './message-link';

const candy = { handle: 'candy' };

it('names a numbered message as ¶author-N, and nothing else', () => {
  expect(chatMessageLinkToken({ chatSeq: 2773, authorIdentity: candy })).toBe('¶candy-2773');
  expect(chatMessageLinkToken({ chatSeq: 7, authorIdentity: { handle: '@firstmate_2' } })).toBe('¶firstmate_2-7');
  for (const row of [
    { authorIdentity: candy },
    { chatSeq: 1 },
    { chatSeq: 1, authorIdentity: candy, isPendingSend: true },
    { chatSeq: 1, authorIdentity: candy, isAgentActivity: true },
    { chatSeq: 1, authorIdentity: candy, deleted: true },
  ]) expect(chatMessageLinkToken(row)).toBeNull();
});

it('copies the token and confirms it, or says the copy failed', async () => {
  const confirm = { showCopied: vi.fn(), showCopyFailed: vi.fn() };
  const write = vi.fn(async () => undefined);
  await copyChatMessageLink('¶candy-2773', write, confirm);
  expect(write).toHaveBeenCalledWith('¶candy-2773');
  expect(confirm.showCopied).toHaveBeenCalledWith('Copied ¶candy-2773');
  await copyChatMessageLink('¶candy-2773', async () => { throw new Error('denied'); }, confirm);
  expect(confirm.showCopyFailed).toHaveBeenCalledWith('Could not copy the link');
});

it('opens a linked message as a jump to that exact message in its chat or thread', () => {
  const navigate = vi.fn();
  openChatMessageLink({ roomId: 'thread-1', messageId: 'f'.repeat(64), workspaceId: 'w1' }, navigate);
  openChatMessageLink({ roomId: 'thread-1', messageId: 'f'.repeat(64), workspaceId: 'w1' }, navigate);
  const [first, second] = navigate.mock.calls.map(([href]) => href);
  expect(first).toEqual({
    pathname: '/beeline/chat/[channelId]',
    params: { channelId: 'thread-1', notificationMessageId: 'f'.repeat(64),
      notificationResponseId: expect.stringMatching(/^message-link:/), communityId: 'w1' },
  });
  // Each tap is a fresh landing, so tapping the same link twice jumps twice.
  expect(second.params.notificationResponseId).not.toBe(first.params.notificationResponseId);
});
