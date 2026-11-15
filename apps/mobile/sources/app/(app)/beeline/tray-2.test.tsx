import { describe, expect, it } from 'vitest';
import { byLabel, press, renderTags, serve, state, task, textOf } from '@/test/fixtures/tray.test-support';
describe('Tasks filters', () => {
  it('puts Filter at the top right of the phone header', async () => {
    serve([task()]);
    const tree = await renderTags();
    const header = tree.root.find((n: any) => n.type === 'Header');
    expect(header.props.workspaceName).toBe('Tubing Crew');
    expect(header.findAll((n: any) => n.props?.['aria-label'] === 'Filter')).toHaveLength(1);
  });
  it('draws Filter as a bare filter glyph', async () => {
    serve([task()]);
    const tree = await renderTags();
    const filter = byLabel(tree, 'Filter');
    expect(filter.props.kind).toBe('icon');
    expect(filter.findByType('Glyph' as never).props.icon.displayName).toBe('Icon.Filter');
    expect(textOf(tree)).not.toContain('Filter');
  });
  it('keeps desktop columns open, with Filter at the right', async () => {
    state.desktop = true;
    serve([task(), task({ id: 'later', state: 'backlog', title: 'Expand Milo routing' })]);
    const tree = await renderTags();
    const sections = tree.root.find(
      (n: any) => typeof n.type === 'string' && n.props.testID === 'work-sections',
    );
    expect(sections.type).toBe('XStack');
    for (const label of ['In progress 1', 'Backlog 1', 'Done 0'])
      expect(byLabel(tree, label).props['aria-expanded']).toBeUndefined();
    expect(textOf(tree)).toContain('Measure phone reply latency');
    expect(textOf(tree)).toContain('Expand Milo routing');
    expect(byLabel(tree, 'Filter')).toBeDefined();
  });
  it('filters by chats or assignee only and removes an active chip', async () => {
    serve([task(), task({ id: 'milo-task', chatId: 'milo', title: 'Wire Milo replies' })]);
    const tree = await renderTags();
    await press(tree, 'Filter');
    expect(textOf(tree)).not.toContain('Priority');
    await press(tree, 'Filter Chat');
    expect(textOf(tree)).not.toContain('DMs');
    await press(tree, 'In progress 2');
    await press(tree, 'Filter chat #Milo');
    expect(textOf(tree)).not.toContain('Measure phone reply latency');
    await press(tree, 'Remove #Milo filter');
    expect(textOf(tree)).toContain('Measure phone reply latency');
  });
});
