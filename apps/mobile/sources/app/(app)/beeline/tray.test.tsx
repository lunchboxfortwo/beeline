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
describe('Work board in the Tags tab', () => {
  it('shows one question, with active work expanded and Backlog and Done collapsed', async () => {
    serve([
      ask(),
      task(),
      task({ id: 'backlog', state: 'backlog', title: 'Expand Milo routing' }),
      task({ id: 'done', state: 'done', title: 'Restore saved sessions' }),
    ]);
    const tree = await renderTags();
    expect(textOf(tree)).toContain('Which surface should Jellybean measure next?');
    expect(textOf(tree)).toContain('Measure phone reply latency');
    expect(textOf(tree)).not.toContain('Expand Milo routing');
    expect(textOf(tree)).toContain('Last 7 days');
    await press(tree, 'Backlog 1');
    expect(textOf(tree)).toContain('Expand Milo routing');
    await press(tree, 'Done 1');
    expect(textOf(tree)).toContain('Restore saved sessions');
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
  it('keeps an answered DM task as an agent source without inventing a thread', async () => {
    const original = ask();
    serve([
      {
        ...original,
        ask: undefined,
        roomKind: 'direct',
        openedBy: original.ask!.author!,
        assignee: original.ask!.author!,
        roomId: 'dm',
        chatId: 'dm',
        state: 'in-progress',
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
  it('opens the exact asking message, and uses Merge for a waiting PR', async () => {
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
    await press(tree, 'Open source Which surface should Jellybean measure next?');
    expect(state.push).toHaveBeenCalledWith({ roomId: 'thread', messageId: 'ask' });
    await press(tree, 'Merge');
    expect(state.operation).toHaveBeenCalledWith('approveCornerMerge', { cornerId: 'thread' });
  });
});
