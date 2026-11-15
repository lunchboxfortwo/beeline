import { describe, expect, it } from 'vitest';
import { press, renderTags, serve, state, task, textOf } from '@/test/fixtures/tray.test-support';
describe('Work board filters and assignments', () => {
  it('defaults desktop to columns and toggles to a centered, capped list', async () => {
    state.desktop = true;
    serve([task()]);
    const tree = await renderTags();
    const sections = () =>
      tree.root.find((n: any) => typeof n.type === 'string' && n.props.testID === 'work-sections');
    expect(sections().props.flexDirection).toBe('row');
    await press(tree, 'List view');
    expect(sections().props.maxWidth).toBe(720);
    expect(sections().props.alignSelf).toBe('center');
  });
  it('filters by chats only and removes an active chip', async () => {
    serve([task(), task({ id: 'milo-task', chatId: 'milo', title: 'Wire Milo replies' })]);
    const tree = await renderTags();
    await press(tree, 'Filter');
    await press(tree, 'Filter Chat');
    expect(textOf(tree)).not.toContain('DMs');
    await press(tree, 'Filter chat #Milo');
    expect(textOf(tree)).not.toContain('Measure phone reply latency');
    await press(tree, 'Remove #Milo filter');
    expect(textOf(tree)).toContain('Measure phone reply latency');
  });
  it('assigns to an agent, a human or Unassigned through the same field', async () => {
    serve([task()]);
    const tree = await renderTags();
    for (const [label, id] of [
      ['Assign to Ada', 'person'],
      ['Assign to Jellybean', 'agent'],
      ['Unassigned', null],
    ]) {
      await press(tree, 'Assign Measure phone reply latency');
      await press(tree, label!);
      expect(state.operation).toHaveBeenLastCalledWith('updateWorkItem', {
        id: 'thread',
        roomId: 'thread',
        assigneeId: id,
      });
    }
  });
});
