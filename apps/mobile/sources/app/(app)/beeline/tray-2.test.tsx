// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import {
  badge,
  byTestId,
  calls,
  deliver,
  hasTestId,
  navigation,
  need,
  phoneOperation,
  prefetchRoom,
  press,
  renderTags,
  route,
  serve,
  textOf,
} from '@/test/fixtures/tray.test-support';

const merge = () => need({
  messageId: 'merge-1', roomId: 'corner-1', roomKind: 'corner', roomName: 'reconnect-keeps-place',
  parentRoomName: 'beeline', text: 'Approve merge of PR #4181?',
  approval: {
    kind: 'merge', actor: 'Jimmy', ask: 'asks to merge', subject: 'Keep it still', literal: false,
    pullRequest: { number: 4181, url: 'https://github.com/o/beeline/pull/4181', title: 'Keep it still' },
  },
});
const grant = () => need({
  messageId: 'grant-1',
  approval: {
    kind: 'grant', actor: 'Hoots', ask: 'wants to run a command', subject: 'npm test', literal: true,
    actions: [
      { kind: 'grant', grantId: 'g-1', decision: 'once', label: 'Once' },
      { kind: 'grant', grantId: 'g-1', decision: 'always', label: 'Always' },
      { kind: 'grant', grantId: 'g-1', decision: 'deny', label: 'No' },
    ],
  },
});
const cards = (tree: any) => tree.root
  .findAll((node: any) => typeof node.type === 'string' && /^tag-card-/.test(String(node.props.testID ?? '')))
  .map((node: any) => node.props.testID.slice('tag-card-'.length));

describe('Opening a Tags card', () => {
  it('reads a tag: it leaves Tags and the chat opens at that message', async () => {
    serve({ needs: [need()] });
    const tree = await renderTags(true);
    expect(badge(tree)).toBe(1);
    await press(tree, 'tag-card-ask-1');
    expect(calls('clearNeedsYou')).toEqual([['clearNeedsYou', { workspaceId: 'ws', messageId: 'ask-1' }]]);
    expect(prefetchRoom).toHaveBeenCalledWith('needs-you:ask-1', 'room-1');
    expect(navigation.push).toHaveBeenCalledWith({
      pathname: '/beeline/chat/[channelId]',
      params: { channelId: 'room-1', notificationMessageId: 'ask-1', notificationResponseId: 'needs-you:ask-1', communityId: 'ws' },
    });
    expect(cards(tree)).toEqual([]);
    expect(badge(tree)).toBe(0);
  });

  it('opens a request where it was sent without deciding or dismissing it', async () => {
    serve({ needs: [merge()] });
    const tree = await renderTags();
    await press(tree, 'tag-card-merge-1');
    expect(calls('clearNeedsYou')).toEqual([]);
    expect(calls('approveCornerMerge')).toEqual([]);
    expect(navigation.push).toHaveBeenCalledTimes(1);
    expect(cards(tree)).toEqual(['merge-1']);
  });
});

describe('Deciding on Tags', () => {
  it('Approve on a merge ask is the phone’s merge yes; the server’s projection removes the card and the count', async () => {
    const server = serve({ needs: [merge()] });
    const tree = await renderTags(true);
    expect(badge(tree)).toBe(1);
    phoneOperation.mockImplementationOnce(async (name: string) => {
      expect(name).toBe('approveCornerMerge');
      server.needs = [];
      return { status: 'merge-requested', pullRequestUrl: 'https://github.com/o/beeline/pull/4181' };
    });
    await press(tree, 'tag-approve-merge-1');
    expect(phoneOperation.mock.calls.find(([name]) => name === 'approveCornerMerge')?.[1]).toEqual({ cornerId: 'corner-1' });
    expect(calls('readNeedsYou').length).toBeGreaterThan(0);
    expect(cards(tree)).toEqual([]);
    expect(badge(tree)).toBe(0);
    expect(textOf(tree)).toContain('Nothing needs you');
  });

  it('Deny on a merge ask dismisses it from Tags and approves nothing', async () => {
    serve({ needs: [merge()] });
    const tree = await renderTags();
    await press(tree, 'tag-deny-merge-1');
    expect(calls('approveCornerMerge')).toEqual([]);
    expect(calls('clearNeedsYou')).toEqual([
      ['clearNeedsYou', { workspaceId: 'ws', messageId: 'merge-1', dismissReminder: true }],
    ]);
    expect(cards(tree)).toEqual([]);
  });

  it('Approve on a grant allows it once; Deny denies it', async () => {
    serve({ needs: [grant()] });
    const tree = await renderTags();
    expect(byTestId(tree, 'tag-literal-grant-1').props.children).toBe('npm test');
    await press(tree, 'tag-approve-grant-1');
    await press(tree, 'tag-deny-grant-1');
    expect(calls('decideAgentGrant')).toEqual([
      ['decideAgentGrant', { grantId: 'g-1', decision: 'once' }],
      ['decideAgentGrant', { grantId: 'g-1', decision: 'deny' }],
    ]);
  });

  it('keeps a refused decision’s card and says why', async () => {
    serve({ needs: [grant()], refuse: 'decideAgentGrant' });
    const tree = await renderTags();
    await press(tree, 'tag-approve-grant-1');
    expect(cards(tree)).toEqual(['grant-1']);
    expect(hasTestId(tree, 'tray-error')).toBe(true);
  });

  it('puts a tag back when the server refuses to read it', async () => {
    serve({ needs: [need()], refuse: 'clearNeedsYou' });
    const tree = await renderTags();
    await press(tree, 'tag-card-ask-1');
    expect(cards(tree)).toEqual(['ask-1']);
  });
});

describe('Tags is live', () => {
  it('a delta adds a card and the count with no read', async () => {
    serve({ needs: [] });
    const tree = await renderTags(true);
    const reads = phoneOperation.mock.calls.length;
    await act(async () => deliver({
      type: 'needs-you-delta', roomId: '', workspaceId: 'ws', sourceRoomId: 'room-1', count: 1,
      items: [need({ messageId: 'live-1', createdAt: Math.floor(Date.now() / 1000) })],
    }));
    expect(cards(tree)).toEqual(['live-1']);
    expect(badge(tree)).toBe(1);
    expect(byTestId(tree, 'tag-card-live-1').props.borderColor).toBe('needsYou');
    expect(phoneOperation.mock.calls.slice(reads).filter(([name]) => /^read/.test(name))).toEqual([]);
  });

  it('a socket gap asks for one covering read', async () => {
    const server = serve({ needs: [] });
    const tree = await renderTags();
    server.needs = [need()];
    await act(async () => deliver({ type: 'invalidate', roomId: '', reason: 'needs-you-gap' }));
    await act(async () => undefined);
    expect(calls('readNeedsYou')).toHaveLength(1);
    expect(cards(tree)).toEqual(['ask-1']);
  });

  it('acknowledges only painted, unseen questions; requests and running clocks are left alone', async () => {
    serve({ needs: [merge(), need(), need({ messageId: 'seen-1', expiresAt: 1_700_090_000 })] });
    await renderTags();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
    expect(calls('markNeedsYouSeen')).toEqual([['markNeedsYouSeen', { workspaceId: 'ws', messageIds: ['ask-1'] }]]);
  });
});

describe('Tags without a Workspace', () => {
  it('says so when the link names none and none is open', async () => {
    route.params = {};
    const tree = await renderTags();
    expect(textOf(tree)).toContain('No Workspace to show');
    expect(textOf(tree)).toContain('This link did not name a Workspace, and none is open.');
  });

  it('shows no stale cards once the person has left the Workspace', async () => {
    phoneOperation.mockImplementation(async () => {
      throw Object.assign(new Error('workspace membership required'), { code: 'workspace membership required' });
    });
    const tree = await renderTags();
    expect(textOf(tree)).toContain('You are no longer a member of this Workspace.');
    expect(cards(tree)).toEqual([]);
  });
});
