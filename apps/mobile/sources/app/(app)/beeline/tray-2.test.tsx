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
  it('centres a capped list on desktop with Filter at the right', async () => {
    state.desktop = true;
    serve([task()]);
    const tree = await renderTags();
    const sections = tree.root.find(
      (n: any) => typeof n.type === 'string' && n.props.testID === 'work-sections',
    );
    expect(sections.props).toMatchObject({ maxWidth: 720, alignSelf: 'center' });
    expect(byLabel(tree, 'Filter')).toBeDefined();
  });
  it('filters by chats or assignee only and removes an active chip', async () => {
    serve([task(), task({ id: 'milo-task', chatId: 'milo', title: 'Wire Milo replies' })]);
    const tree = await renderTags();
    await press(tree, 'Filter');
    expect(textOf(tree)).not.toContain('Priority');
    await press(tree, 'Filter Chat');
    expect(textOf(tree)).not.toContain('DMs');
    await press(tree, 'Filter chat #Milo');
    expect(textOf(tree)).not.toContain('Measure phone reply latency');
    await press(tree, 'Remove #Milo filter');
    expect(textOf(tree)).toContain('Measure phone reply latency');
  });
});
