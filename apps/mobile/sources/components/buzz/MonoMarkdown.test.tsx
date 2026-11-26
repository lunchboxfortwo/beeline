import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('tamagui', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts());
vi.mock('lucide-react-native', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).lucideHosts());
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('@/components/buzz/CodeBlock', () => ({ CodeBlock: () => null }));
vi.mock('@/buzz/message-link', () => ({ messageLinkId: () => undefined, openMessageLink: vi.fn() }));
vi.mock('@/utils/open-external-url', () => ({ openExternalUrl: vi.fn() }));
import { STEP } from '@/ui/grammar';
import { MonoMarkdown } from './MonoMarkdown';
import { parseMarkdown } from '@/components/markdown/parseMarkdown';

beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });

it.each([false, true])('parses transcript quotes and task items with document=%s', document => {
    const blocks = parseMarkdown('> Quoted **words**\n> second line\n\n- [x] Finished\n- [ ] Pending\n  - [X] Nested\n- ordinary', document);
    expect(blocks[0]).toMatchObject({ type: 'quote', content: [{ text: 'Quoted ' }, { text: 'words' }, { text: '\nsecond line' }] });
    expect(blocks[1]).toMatchObject({ type: 'list', items: [
        { depth: 0, checked: true, spans: [{ text: 'Finished' }] },
        { depth: 0, checked: false, spans: [{ text: 'Pending' }] },
        { depth: 1, checked: true, spans: [{ text: 'Nested' }] },
        { depth: 0, spans: [{ text: 'ordinary' }] },
    ] });
});

it('reads an empty code fence as its typed text, not an empty code frame', () => {
    expect(parseMarkdown('```ts', false)).toMatchObject([{ type: 'text', content: [{ text: '```ts' }] }]);
    expect(parseMarkdown('```ts\nconst a = 1;\n```', false)).toMatchObject([{ type: 'code-block', language: 'ts', content: 'const a = 1;' }]);
});

it.each([false, true])('preserves closed empty and whitespace fences with document=%s', document => {
    for (const language of ['', 'ts', 'mermaid']) {
        for (const content of ['', '  \n\t']) {
            const markdown = `\`\`\`${language}\n${content}\n\`\`\``;
            expect(parseMarkdown(markdown, document)).toEqual([
                language === 'mermaid'
                    ? { type: 'mermaid', content }
                    : { type: 'code-block', language: language || null, content },
            ]);
        }
        expect(parseMarkdown(`\`\`\`${language}\n  \n`, document)).toEqual([
            { type: 'text', content: [{ styles: [], text: `\`\`\`${language}`, url: null }] },
        ]);
    }
});

it('keeps slash commands joined in rendered prose without changing paths or inline code', () => {
    let tree: any;
    act(() => { tree = create(<MonoMarkdown textStyle={{}} markdown={'Try /draw-avatar now. **/draw-avatar** remains joined. /tmp/file and `echo /draw-avatar` stay literal.'} />); });
    const strings = (node: any): string => typeof node === 'string' ? node
        : Array.isArray(node) ? node.map(strings).join('') : strings(node?.children ?? []);
    const leaves = strings(tree.toJSON());
    expect(leaves.split('/\u2060draw\u2060-\u2060avatar')).toHaveLength(3);
    expect(leaves).toContain('/tmp/file');
    expect(leaves).toContain('echo /draw-avatar');
    act(() => tree.unmount());
});

it('keeps every nested list level 16 deeper than the one above, past depth two', () => {
    let tree: any;
    act(() => { tree = create(<MonoMarkdown textStyle={{}} markdown={'- one\n  - two\n    - three\n      - four'} />); });
    const indents = tree.root.findAll((node: any) => node.type === 'YStack' && node.props.paddingLeft !== undefined)
        .map((node: any) => node.props.paddingLeft);
    expect(indents).toEqual([0, 1, 2, 3].map((depth) => depth * STEP['4']));
});

it('renders plain prose in its paragraph without a redundant styled text span', () => {
    let tree: any;
    act(() => { tree = create(<MonoMarkdown textStyle={{}} markdown="Plain transcript words" />); });
    const texts = tree.root.findAll((node: any) => node.type === 'Text');
    expect(texts).toHaveLength(1);
    expect(texts[0].props.children).toBeDefined();
    act(() => tree.unmount());
});

const collectText = (node: any): string => typeof node === 'string' ? node
    : Array.isArray(node) ? node.map(collectText).join('') : collectText(node?.children ?? []);

it('MATH-32188: renders the #general LaTeX equation as a single stacked-fraction math block', () => {
    const markdown = [
        'China wins on electricity cost only when:',
        '\\[',
        '\\text{Chinese energy penalty}',
        '<',
        '\\frac{\\text{U.S. electricity price}}{\\text{Chinese electricity price}}',
        '\\]',
    ].join('\n');
    let tree: any;
    act(() => { tree = create(<MonoMarkdown textStyle={{}} markdown={markdown} />); });
    const mathBlocks = tree.root.findAll((node: any) => node.type === 'YStack' && node.props.testID === 'math-block');
    expect(mathBlocks).toHaveLength(1);
    expect(mathBlocks[0].props.borderLeftWidth).toBe(2);
    expect(mathBlocks[0].props.borderLeftColor).toBe('strongStroke');
    expect(tree.root.findAll((node: any) => node.type === 'YStack' && node.props.testID === 'math-fraction')).toHaveLength(1);
    expect(tree.root.findAll((node: any) => node.type === 'YStack' && node.props.testID === 'math-fraction-bar')).toHaveLength(1);

    const rendered = collectText(tree.toJSON());
    expect(rendered).toContain('Chinese energy penalty');
    expect(rendered).toContain('<');
    expect(rendered).toContain('U.S. electricity price');
    expect(rendered).toContain('Chinese electricity price');
    expect(rendered).not.toContain('\\[');
    expect(rendered).not.toContain('\\text');
    expect(rendered).not.toContain('\\frac');
    expect(rendered).not.toContain('\\]');
    act(() => tree.unmount());
});

it('renders inline math cleanly in prose while keeping dollar prices and mentions safe', () => {
    const markdown = 'Runs in \\(O(n \\log n)\\) with \\(\\varepsilon \\le 10^{-4}\\), costing $5 to $10 at $0.15/1M and \\(\\frac{\\text{a}}{\\text{b}}\\).';
    let tree: any;
    act(() => {
        tree = create(
            <MonoMarkdown
                textStyle={{}}
                markdown={markdown}
                mentionHandles={['crayon']}
            />,
        );
    });
    const rendered = collectText(tree.toJSON());
    expect(rendered).toContain('O(n log n)');
    expect(rendered).toContain('ε ≤ 10⁻⁴');
    expect(rendered).toContain('$5 to $10 at $0.15/1M');
    expect(rendered).toContain('(a / b)');
    expect(rendered).not.toContain('\\(');
    expect(rendered).not.toContain('\\)');
    act(() => tree.unmount());
});

it('renders exotic LaTeX in a monospace fallback block inside the same math frame', () => {
    const markdown = '\\[\n\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}\n\\]';
    let tree: any;
    act(() => { tree = create(<MonoMarkdown textStyle={{}} markdown={markdown} />); });
    expect(tree.root.findAll((node: any) => node.type === 'YStack' && node.props.testID === 'math-block')).toHaveLength(1);
    const fallbacks = tree.root.findAll((node: any) => node.type === 'Text' && node.props.testID === 'math-fallback');
    expect(fallbacks).toHaveLength(1);
    expect(collectText(tree.toJSON())).toContain('∫₀^∞ e^(−x²) dx = √π / 2');
    act(() => tree.unmount());
});

it('keeps streaming unclosed math delimiters as plain text until closed', () => {
    let tree: any;
    act(() => { tree = create(<MonoMarkdown textStyle={{}} markdown={'\\[\n\\text{Chinese energy penalty}\n<'} />); });
    expect(tree.root.findAll((node: any) => node.props.testID === 'math-block')).toHaveLength(0);
    expect(collectText(tree.toJSON())).toContain('\\[');
    act(() => tree.unmount());
});
