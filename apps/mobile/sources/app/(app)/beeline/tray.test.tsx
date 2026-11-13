import { describe, expect, it } from 'vitest';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act } from 'react-test-renderer';
import {
  byTestId,
  calls,
  hasTestId,
  layout,
  navigation,
  need,
  openExternal,
  press,
  renderTags,
  serve,
  textOf,
  viewer,
} from '@/test/fixtures/tray.test-support';

const nowSeconds = () => Math.floor(Date.now() / 1000);

const merge = (): any => need({
  messageId: 'merge-1',
  roomId: 'corner-1',
  roomKind: 'corner',
  roomName: 'reconnect-keeps-place',
  parentRoomName: 'beeline',
  text: 'Approve merge of PR #4181?',
  author: { pubkey: 'agent-1', kind: 'agent', name: 'Jimmy', handle: 'jimmy' },
  approval: {
    kind: 'merge', actor: 'Jimmy', ask: 'asks to merge', literal: false,
    subject: 'Keep the transcript still when the connection returns',
    pullRequest: {
      number: 4181, url: 'https://github.com/o/beeline/pull/4181',
      title: 'Keep the transcript still when the connection returns',
      checks: { status: 'passing', total: 14, failing: 0 },
    },
  },
});

const choice = () => need({
  messageId: 'choice-1',
  approval: {
    kind: 'choice', actor: 'Maya', ask: 'asks you to choose', literal: false,
    subject: 'Which totals should lead the snapshot?',
    actions: [
      { kind: 'choice', choiceId: 'c-1', optionId: 'net', label: 'Net worth first', detail: 'One number at the top, holdings below.' },
      { kind: 'choice', choiceId: 'c-1', optionId: 'cash', label: 'Cash first', detail: 'Cash on hand, then investments.' },
      { kind: 'skip-choice', choiceId: 'c-1', label: 'Skip' },
    ],
  },
});

describe('Tags cards', () => {
  it('TAGS-1: groups addressed decisions separately and never labels them as tags', async () => {
    serve({ needs: [need(), need({ messageId: 'decision', addressedReport: true,
      text: 'Run the proof on your laptop?', author: { pubkey: 'ruby', kind: 'agent', name: 'Ruby' } })] });
    const tree = await renderTags();
    const text = textOf(tree);
    const decisionText = textOf({ root: byTestId(tree, 'tag-card-decision') } as any);
    expect(decisionText).toContain('Ruby needs your decision:');
    expect(decisionText).not.toContain('tagged you');
    expect(text).toContain('Maya tagged you:');
    expect(byTestId(tree, 'tray-decisions-heading').props.children).toBe('DECISIONS');
    expect(byTestId(tree, 'tray-tags-heading').props.children).toBe('TAGS');
    expect(text.indexOf('Run the proof on your laptop?')).toBeLessThan(text.indexOf('Maya tagged you:'));
  });

  it('draws a plain tag as "<who> tagged you:" in its chat, outlined in brass while it is fresh', async () => {
    serve({ needs: [need({ createdAt: nowSeconds() })] });
    const tree = await renderTags();
    const text = textOf(tree);
    expect(text).toContain('Maya tagged you:');
    expect(text).toContain('@Dan, can you check the snapshot labels?');
    expect(text).toContain('#paperband');
    expect(text).toContain('· in the chat');
    expect(byTestId(tree, 'tag-age-ask-1').props.children).toBe('just now');
    expect(byTestId(tree, 'tag-card-ask-1').props.borderColor).toBe('needsYou');
    // A tag has no decision to make.
    expect(hasTestId(tree, 'tag-approve-ask-1')).toBe(false);
  });

  it('keeps an older tag unoutlined, with its age in brass', async () => {
    serve({ needs: [need({ createdAt: nowSeconds() - 3 * 3600 })] });
    const tree = await renderTags();
    expect(byTestId(tree, 'tag-card-ask-1').props.borderColor).toBe('stroke');
    expect(byTestId(tree, 'tag-age-ask-1').props.children).toBe('3h');
    expect(byTestId(tree, 'tag-age-ask-1').props.color).toBe('needsYou');
  });

  it('shows a merge ask with its thread, the pull request evidence and Approve / Deny', async () => {
    serve({ needs: [merge()] });
    const tree = await renderTags();
    const text = textOf(tree);
    expect(text).toContain('#beeline');
    expect(text).toContain('reconnect-keeps-place');
    expect(text).toContain('Jimmy asks:');
    expect(text).toContain('Approve merge of PR #4181?');
    expect(text).toContain('Pull request #4181 · All 14 checks passed');
    expect(text).toContain('Keep the transcript still when the connection returns');
    expect(byTestId(tree, 'tag-approve-merge-1').props.disabled).toBe(false);
    expect(hasTestId(tree, 'tag-deny-merge-1')).toBe(true);
  });

  it('shows added and removed lines and files only when the corner recorded them', async () => {
    const item = merge();
    (item.approval as any).pullRequest = { ...(item.approval as any).pullRequest, additions: 128, deletions: 41, files: 3 };
    serve({ needs: [item] });
    const tree = await renderTags();
    const added = tree.root.find((node: any) => node.type === 'Text' && node.props.children === '+128');
    const removed = tree.root.find((node: any) => node.type === 'Text' && node.props.children === '−41');
    expect(added.props.color).toBe('added');
    expect(removed.props.color).toBe('removed');
    expect(textOf(tree)).toContain('3 files');
  });

  it('shows a Trusty Squire payment with its card, merchant and amount; both buttons open Squire', async () => {
    serve({ needs: [need({
      messageId: 'squire-1', roomKind: 'direct', roomName: 'System',
      approval: {
        kind: 'squire', actor: 'Jimmy', ask: 'wants to', subject: 'pay Fly.io $12.40', literal: false,
        detail: 'One hour of a performance-2x machine for the routing test',
        facts: [{ label: 'Card', value: 'Card ending 4242' }, { label: 'Merchant', value: 'Fly.io · $12.40' }],
        actions: [{ kind: 'external', url: 'https://squire.example/approve/p-1', label: 'Approve' }],
      },
    })] });
    const tree = await renderTags();
    const text = textOf(tree);
    expect(text).toContain('Jimmy asks:');
    expect(text).toContain('Pay Fly.io $12.40');
    expect(text).toContain('Trusty Squire · Card ending 4242');
    expect(text).toContain('Fly.io · $12.40');
    expect(text).not.toContain('· in the chat');
    expect(text).toContain('One hour of a performance-2x machine for the routing test');
    await press(tree, 'tag-approve-squire-1');
    await press(tree, 'tag-deny-squire-1');
    expect(openExternal.mock.calls).toEqual([
      ['https://squire.example/approve/p-1'], ['https://squire.example/approve/p-1'],
    ]);
    // Squire decides on its own page; nothing is sent and the card stays.
    expect(calls('readNeedsYou')).toHaveLength(0);
    expect(hasTestId(tree, 'tag-card-squire-1')).toBe(true);
  });

  it('lists a decision’s options; Approve waits for a pick and sends it, Deny skips', async () => {
    serve({ needs: [choice()] });
    const tree = await renderTags();
    expect(textOf(tree)).toContain('Maya asks:');
    expect(textOf(tree)).toContain('Net worth first');
    expect(textOf(tree)).toContain('Cash on hand, then investments.');
    expect(byTestId(tree, 'tag-approve-choice-1').props.disabled).toBe(true);
    await press(tree, 'tag-option-cash');
    expect(byTestId(tree, 'tag-option-cash').props.backgroundColor).toBe('highlight');
    await press(tree, 'tag-approve-choice-1');
    expect(calls('answerChoice')).toEqual([['answerChoice', { choiceId: 'c-1', optionId: 'cash' }]]);
    await press(tree, 'tag-deny-choice-1');
    expect(calls('skipChoice')).toEqual([['skipChoice', { choiceId: 'c-1' }]]);
  });

  it('shows the asking message’s image full width and opens it in the viewer', async () => {
    const image = { url: 'https://relay.test/media/shot.png', name: 'shot.png', mimeType: 'image/png', size: 9, width: 390, height: 250 };
    const item = merge();
    (item.approval as any).image = image;
    serve({ needs: [item] });
    const tree = await renderTags();
    await press(tree, 'tag-image');
    expect(viewer.open).toHaveBeenCalledWith(image, false, 'corner-1');
    expect(navigation.push).not.toHaveBeenCalled();
  });

  it('offers no Approve / Deny where the decision lives in the chat (connector offers, sign-ins)', async () => {
    serve({ needs: [need({
      messageId: 'offer-1',
      approval: { kind: 'connector', actor: 'Hoots', ask: 'wants to add', subject: 'Gmail', literal: false },
    })] });
    const tree = await renderTags();
    expect(textOf(tree)).toContain('Hoots wants to add');
    expect(hasTestId(tree, 'tag-approve-offer-1')).toBe(false);
    expect(hasTestId(tree, 'tag-deny-offer-1')).toBe(false);
  });
});

describe('Tags screen', () => {
  it('says "Nothing needs you" when empty, and Go to Chats leaves for Chats', async () => {
    const tree = await renderTags();
    const text = textOf(tree);
    expect(text).toContain('Nothing needs you');
    expect(text).toContain('Approvals, decisions and messages that tag you appear here as they arrive.');
    const go = tree.root.find((node: any) => node.type === 'Button' && node.props['aria-label'] === 'Go to Chats');
    go.props.onPress();
    expect(navigation.replace).toHaveBeenCalledWith('/beeline/channels');
  });

  it('on a phone, carries the shared tab header: the name opens the Workspace rail, with no Search or New chat', async () => {
    serve({ needs: [need(), merge()] });
    const tree = await renderTags();
    expect(hasTestId(tree, 'chat-list-header')).toBe(true);
    expect(textOf(tree)).toContain('Beeline Work');
    expect(hasTestId(tree, 'tab-bar')).toBe(false);
    expect(hasTestId(tree, 'room-search-open')).toBe(false);
    expect(hasTestId(tree, 'new-chat')).toBe(false);
    expect(hasTestId(tree, 'community-drawer-overlay')).toBe(false);
    await press(tree, 'workspace-switcher');
    expect(hasTestId(tree, 'community-drawer-overlay')).toBe(true);
  });

  it('on a phone, draws a hairline under the header only once the cards scroll under it', async () => {
    serve({ needs: [need(), merge()] });
    const tree = await renderTags();
    expect(byTestId(tree, 'tab-header-edge').props.borderColor).toBe('transparent');
    await act(async () => byTestId(tree, 'tray-list').props.onScroll({ nativeEvent: { contentOffset: { y: 40 } } }));
    expect(byTestId(tree, 'tab-header-edge').props.borderColor).toBe('stroke');
  });

  it('on desktop, is the middle column alone: no list header, no tab bar', async () => {
    layout.desktop = true;
    serve({ needs: [need()] });
    const tree = await renderTags();
    expect(hasTestId(tree, 'chat-list-header')).toBe(false);
    expect(hasTestId(tree, 'tab-bar')).toBe(false);
    expect(hasTestId(tree, 'tag-card-ask-1')).toBe(true);
  });

  it('lists approvals before questions, in the server’s order', async () => {
    serve({ needs: [merge(), need()] });
    const tree = await renderTags();
    const cards = tree.root
      .findAll((node: any) => typeof node.type === 'string' && /^tag-card-/.test(String(node.props.testID ?? '')))
      .map((node: any) => node.props.testID);
    expect(cards).toEqual(['tag-card-merge-1', 'tag-card-ask-1']);
  });
});
