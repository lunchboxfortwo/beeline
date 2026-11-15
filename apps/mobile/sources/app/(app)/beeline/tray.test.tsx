import { describe, expect, it } from 'vitest';
// @ts-expect-error react-test-renderer has no declarations.
import { act } from 'react-test-renderer';
import {
  ask,
  byLabel,
  press,
  renderTags,
  serve,
  state,
  task,
  textOf,
} from '@/test/fixtures/tray.test-support';
describe('Tasks tab', () => {
  it('opens only Needs you on a phone; the other sections drop down when tapped, names only', async () => {
    serve([
      ask(),
      task({ objective: 'Measure every reply path on the phone.' }),
      task({ id: 'idle', title: 'release-corner', idle: true }),
      task({ id: 'backlog', state: 'backlog', title: 'Expand Milo routing' }),
      task({ id: 'done', state: 'done', title: 'Restore saved sessions' }),
    ]);
    const tree = await renderTags();
    const text = textOf(tree);
    expect(text).toContain('Which surface should Jellybean measure next?');
    expect(text).toContain('last 7 days');
    for (const hidden of ['Measure phone reply latency', 'Expand Milo routing', 'Restore saved sessions'])
      expect(text).not.toContain(hidden);
    const chevron = (label: string) => byLabel(tree, label).findByType('Glyph' as never).props.icon.displayName;
    for (const [label, row] of [
      ['In progress 2', 'Measure phone reply latency'],
      ['Backlog 1', 'Expand Milo routing'],
      ['Done 1', 'Restore saved sessions'],
    ] as const) {
      expect(byLabel(tree, label).props['aria-expanded']).toBe(false);
      expect(chevron(label)).toBe('Icon.ChevronRight');
      await press(tree, label);
      expect(byLabel(tree, label).props['aria-expanded']).toBe(true);
      expect(chevron(label)).toBe('Icon.ChevronDown');
      expect(textOf(tree)).toContain(row);
    }
    // Rows carry only the name; the objective waits for the tap sheet.
    expect(textOf(tree)).not.toContain('Measure every reply path on the phone.');
    await press(tree, 'In progress 2');
    expect(textOf(tree)).not.toContain('Measure phone reply latency');
  });
  it('draws the status glyph first on each row and the assignee at its right', async () => {
    serve([task(), task({ id: 'idle', title: 'release-corner', idle: true, assignee: null })]);
    const tree = await renderTags();
    await press(tree, 'In progress 2');
    const row = byLabel(tree, 'Measure phone reply latency');
    const children = row.children.filter((n: any) => typeof n !== 'string');
    expect(children[0].props).toMatchObject({ state: 'in-progress' });
    expect(children.at(-1).findAllByType('Avatar')).toHaveLength(1);
    const idle = byLabel(tree, 'release-corner');
    expect(idle.findAllByType('Avatar')).toHaveLength(0);
    expect(idle.children[0].props).toMatchObject({ state: 'in-progress', idle: true });
  });
  it('opens a thread row straight into its thread, with no sheet in between', async () => {
    serve([task({ roomKind: 'corner' })]);
    const tree = await renderTags();
    await press(tree, 'In progress 1');
    await press(tree, 'Measure phone reply latency');
    expect(state.push).toHaveBeenCalledWith({ roomId: 'thread' });
    expect(tree.root.findAll((n: any) => n.type === 'Sheet')).toHaveLength(0);
  });
  it.each(['backlog', 'in-progress', 'in-review', 'done'] as const)('keeps details on the sheet for a stored %s item', async state => {
    serve([task({ id: 'later', roomId: 'thread', state, roomKind: 'corner', objective: 'Measure every reply path on the phone.',
      attachments: [{ id: 'link', kind: 'link', name: 'Plan', url: 'https://example.org', addedBy: { pubkey: 'person', kind: 'human', name: 'Ada' }, createdAt: 1 }],
      entries: [{ id: 'note', kind: 'note', text: 'Hold until approved.', author: { pubkey: 'person', kind: 'human', name: 'Ada' }, createdAt: 1 }],
    })]);
    const tree = await renderTags();
    await press(tree, state === 'backlog' ? 'Backlog 1' : state === 'done' ? 'Done 1' : 'In progress 1');
    await press(tree, 'Measure phone reply latency');
    const sheet = tree.root.find((n: any) => n.type === 'Sheet');
    expect(sheet.props.title).toBe('Measure phone reply latency');
    expect(textOf(tree)).toContain('Measure every reply path on the phone.');
    expect(textOf(tree)).toContain('Attachments');
    expect(textOf(tree)).toContain('Activity');
    expect(textOf(tree)).toContain('Hold until approved.');
    expect(byLabel(tree, 'Plan')).toBeDefined();
  });
  it('sends a human note through the work operation, then clears the composer', async () => {
    serve([task({ state: 'backlog' })]);
    const tree = await renderTags();
    await press(tree, 'Backlog 1');
    await press(tree, 'Measure phone reply latency');
    await act(async () => byLabel(tree, 'Add a note').props.onChangeText('Hold for approval.'));
    await press(tree, 'Send');
    expect(state.operation).toHaveBeenLastCalledWith('addWorkNote', {
      id: 'thread', roomId: 'thread', text: 'Hold for approval.',
    });
    expect(byLabel(tree, 'Add a note').props.value).toBe('');
    expect(state.load).toHaveBeenCalledWith('ws', true);
  });
  it('retains the human draft after a refused note write', async () => {
    serve([task({ state: 'backlog' })]);
    const tree = await renderTags();
    await press(tree, 'Backlog 1');
    await press(tree, 'Measure phone reply latency');
    await act(async () => byLabel(tree, 'Add a note').props.onChangeText('Hold for approval.'));
    state.operation.mockRejectedValueOnce(new Error('room access denied'));
    await press(tree, 'Send');
    expect(byLabel(tree, 'Add a note').props.value).toBe('Hold for approval.');
  });
  it('says nothing needs you when no ask waits', async () => {
    serve([task()]);
    const tree = await renderTags();
    expect(textOf(tree)).toContain('Nothing needs you now');
    expect(textOf(tree)).toContain('Go do something else.');
    expect(tree.root.findAll((n: any) => n.props?.['aria-label'] === 'Clear all')).toHaveLength(0);
  });
  it('shows one Needs you row per thread with its ask count, and clears a row or all', async () => {
    serve([ask({ askIds: ['ask', 'second'] })]);
    const tree = await renderTags();
    expect(textOf(tree)).toContain('#beeline ↳ latency-coverage');
    expect(textOf(tree)).toContain('2 asks');
    await press(tree, 'Clear #beeline ↳ latency-coverage');
    expect(state.operation).toHaveBeenCalledWith('clearNeedsYou', { workspaceId: 'ws', messageId: 'ask' });
    expect(state.operation).toHaveBeenCalledWith('clearNeedsYou', {
      workspaceId: 'ws',
      messageId: 'second',
    });
    await press(tree, 'Clear all');
    expect(state.operation).toHaveBeenCalledWith('clearNeedsYouSection', { workspaceId: 'ws' });
  });
  it('posts an inline answer as an ordinary quote reply to the call site', async () => {
    serve([ask()]);
    const tree = await renderTags();
    await act(async () =>
      byLabel(tree, 'Reply ask').props.onChangeText('Check the phone reply path first.'),
    );
    await press(tree, 'Send ask');
    expect(state.reply).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: 'thread', messageId: 'ask' }),
      'Check the phone reply path first.',
      expect.objectContaining({ pubkey: 'person' }),
    );
  });
  it('uses the existing question-card shape for free-text asks without options', async () => {
    const item = ask();
    serve([
      {
        ...item,
        ask: {
          ...item.ask!,
          approval: {
            kind: 'choice',
            actor: 'Jellybean',
            ask: 'asks',
            subject: item.ask!.text,
            literal: false,
          },
        },
      },
    ]);
    const tree = await renderTags();
    expect(byLabel(tree, 'Reply ask')).toBeDefined();
  });
  it('names a DM ask by its agent without inventing a thread', async () => {
    const original = ask();
    serve([
      {
        ...original,
        ask: { ...original.ask!, roomKind: 'direct', roomId: 'dm' },
        roomKind: 'direct',
        roomId: 'dm',
        chatId: 'dm',
      },
    ]);
    const tree = await renderTags();
    expect(textOf(tree)).toContain('@Jellybean');
    expect(textOf(tree)).not.toContain('↳');
  });
  it('offers choices once, emphasizes the recommendation, and sends the existing answer operation', async () => {
    const item = ask();
    serve([
      {
        ...item,
        recommendedOptionId: 'web',
        ask: {
          ...item.ask!,
          approval: {
            kind: 'choice',
            actor: 'Jellybean',
            ask: 'asks',
            subject: 'Which surface next?',
            literal: false,
            actions: [
              { kind: 'choice', choiceId: 'choice', optionId: 'web', label: 'Web' },
              { kind: 'choice', choiceId: 'choice', optionId: 'phone', label: 'Phone' },
            ],
          },
        },
      },
    ]);
    const tree = await renderTags();
    expect(byLabel(tree, 'Web').props.kind).toBe('primary');
    await press(tree, 'Web');
    expect(state.operation).toHaveBeenCalledWith('answerChoice', {
      choiceId: 'choice',
      optionId: 'web',
    });
    expect(textOf(tree)).not.toContain('Skip');
  });
  it('opens the thread at the asking message, and uses Merge for a waiting PR', async () => {
    const item = ask();
    serve([
      {
        ...item,
        ask: {
          ...item.ask!,
          approval: {
            kind: 'merge',
            actor: 'Jellybean',
            ask: 'asks',
            subject: 'Merge the reply changes?',
            literal: false,
          },
        },
      },
    ]);
    const tree = await renderTags();
    await press(tree, 'Open #beeline ↳ latency-coverage');
    expect(state.push).toHaveBeenCalledWith({ roomId: 'thread', messageId: 'ask' });
    await press(tree, 'Merge');
    expect(state.operation).toHaveBeenCalledWith('approveCornerMerge', { cornerId: 'thread' });
  });
});
