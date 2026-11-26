import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ useWindowDimensions: () => ({ height: 844, width: 390 }) }));
vi.mock('tamagui', async () => (await import('./grammar-hosts.test-support')).tamaguiHosts());
vi.mock('lucide-react-native', async () => (await import('./grammar-hosts.test-support')).lucideHosts());
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('@/components/buzz/IdentityMark', () => ({ IdentityMark: (props: any) => React.createElement('IdentityMark', props) }));

import { PillRow, type PillEvent, type PillItem, type PillRunEntry } from './PillRow';
import { Copy, T } from '@/ui/grammar';
import { SYSTEM_IDENTITY_PUBKEY } from '@/buzz/system-identity';

const items: PillItem[] = [
    { id: 'joined', system: true, from: { kind: 'system', name: 'Beeline' }, to: { kind: 'agent', seed: 'jimmy', name: 'Jimmy' }, time: '09:45', body: React.createElement('Text', { testID: 'joined-body' }, '@jimmy joined') },
    { id: 'a2a', system: false, from: { kind: 'agent', seed: 'alan', name: 'Alan' }, to: { kind: 'agent', seed: 'jimmy', name: 'Jimmy' }, time: '10:00', body: React.createElement('Text', { testID: 'a2a-body' }, '@jimmy Keep it visible') },
];

describe('PillRow', () => {
    it('draws avatar-only pills, from face to face, in one wrapping row', () => {
        let tree: any;
        act(() => { tree = create(<PillRow items={items} />); });
        const row = tree.root.find((node: any) => node.type === 'XStack' && node.props.flexWrap === 'wrap');
        const pills = row.findAll((node: any) => node.type === 'Button');
        expect(pills.map((pill: any) => pill.props.testID)).toEqual(['system-pill', 'agent-pill']);
        expect(pills[0].props.borderRadius).toBe('full');
        expect(pills[0].props.minHeight).toBe(44);
        const faces = pills[0].findAll((node: any) => node.type === 'IdentityMark');
        expect(faces.map((face: any) => face.props.seed)).toEqual([SYSTEM_IDENTITY_PUBKEY, 'jimmy']);
        expect(tree.root.findAllByProps({ testID: 'pill-open' })).toHaveLength(0);
    });

    it('opens the tapped message under the row and closes it on a second tap', () => {
        let tree: any;
        act(() => { tree = create(<PillRow items={items} />); });
        const pill = () => tree.root.find((node: any) => node.type === 'Button' && node.props.testID === 'agent-pill');
        expect(pill().props['aria-label']).toBe('Read message from Alan → Jimmy, 10:00');
        act(() => pill().props.onPress());
        const open = tree.root.find((node: any) => typeof node.type === 'string' && node.props.testID === 'pill-open');
        expect(text(open)).toEqual(['@jimmy Keep it visible']);
        expect(open.findAll((node: any) => node.type === 'IdentityMark' || node.type === 'Icon.ArrowRight')).toHaveLength(0);
        expect(open.findAllByProps({ testID: 'chat-byline-words' })).toHaveLength(0);
        expect(pill().props['aria-expanded']).toBe(true);
        act(() => pill().props.onPress());
        expect(tree.root.findAll((node: any) => typeof node.type === 'string' && node.props.testID === 'pill-open')).toHaveLength(0);
    });
    it('folds a lone agent-to-agent message into a pill that opens on tap', () => {
        let tree: any;
        act(() => { tree = create(<PillRow items={[items[1]!]} />); });
        const pill = () => tree.root.find((node: any) => node.type === 'Button' && node.props.testID === 'agent-pill');
        expect(tree.root.findAll((node: any) => node.type === 'Button')).toHaveLength(1);
        expect(pill().findAll((node: any) => node.type === 'IdentityMark').map((face: any) => face.props.seed)).toEqual(['alan', 'jimmy']);
        expect(tree.root.findAllByProps({ testID: 'a2a-body' })).toHaveLength(0);
        act(() => pill().props.onPress());
        const entry = tree.root.findByProps({ testID: 'pill-open' });
        expect(entry.findByProps({ testID: 'a2a-body' }).props.children).toBe('@jimmy Keep it visible');
    });

    const ruby = { kind: 'agent', seed: 'ruby', name: 'Ruby' } as const;
    const claude = { kind: 'agent', seed: 'claude', name: 'Claude' } as const;
    const jelly = { kind: 'agent', seed: 'jelly', name: 'Jellybean' } as const;
    const owner = { kind: 'human', seed: 'owner', name: 'Owner' } as const;
    const text = (node: any): string[] => node.findAll((child: any) => child.type === 'Text')
        .flatMap((child: any) => [child.props.children].flat()).filter((part: any) => typeof part === 'string');
    const runItem: PillItem = {
        id: 'e1', system: false, from: ruby, to: claude, time: '09:41', body: null,
        run: [
            { id: 'm1', from: ruby, to: claude, time: '09:36', body: React.createElement('Text', { testID: 'm1-body' }, 'Stop your worker') },
            { id: 's1', from: ruby, to: claude, time: '09:37', stop: true, body: React.createElement('Text', { testID: 's1-body' }, '@ruby stopped @claude') },
            { id: 'm2', from: claude, to: ruby, time: '09:38', body: React.createElement('Text', { testID: 'm2-body' }, 'Stopped') },
            { id: 'm3', from: ruby, to: jelly, time: '09:39', body: React.createElement('Text', { testID: 'm3-body' }, 'Send timings') },
        ],
    };

    it('folds an agent run into one pill of faces and a count, with no names on it', () => {
        let tree: any;
        act(() => { tree = create(<PillRow items={[runItem]} />); });
        const pill = tree.root.find((node: any) => node.type === 'Button' && node.props.testID === 'run-pill');
        expect(pill.findAll((node: any) => node.type === 'IdentityMark').map((face: any) => face.props.seed)).toEqual(['ruby', 'claude', 'jelly']);
        expect(text(pill)).toEqual(['4 messages']);
        for (const name of ['Ruby', 'Claude', 'Jellybean']) expect(text(pill).join(' ')).not.toContain(name);
        expect(pill.props['aria-label']).toBe('Read 4 messages between Ruby, Claude and Jellybean, 09:41');
    });

    it('shows at most three faces on a folded run and names everyone in its label', () => {
        let tree: any;
        const many = ['a', 'b', 'c', 'd', 'e'].map((seed) => ({ kind: 'agent', seed, name: seed.toUpperCase() } as const));
        const fan: PillItem = { id: 'fan', system: false, from: ruby, to: many[0], time: '10:00', body: null,
            run: many.map((to, index) => ({ id: `f${index}`, from: ruby, to, time: '10:00', body: null })) };
        act(() => { tree = create(<PillRow items={[fan]} />); });
        const pill = tree.root.find((node: any) => node.type === 'Button' && node.props.testID === 'run-pill');
        expect(pill.findAll((node: any) => node.type === 'IdentityMark').map((face: any) => face.props.seed)).toEqual(['ruby', 'a', 'b']);
        expect(text(pill)).toEqual(['5 messages']);
        expect(pill.props['aria-label']).toBe('Read 5 messages between Ruby, A, B, C, D and E, 10:00');
    });

    it('leads a mixed run with the ringed Beeline logo and the person who stopped a turn', () => {
        let tree: any;
        const beeline = { kind: 'system', name: 'Beeline' } as const;
        const owner = { kind: 'human', seed: 'owner', name: 'owner' } as const;
        const claude = { kind: 'agent', seed: 'claude', name: 'Claude' } as const;
        const mixed: PillItem = { id: 'mix', system: false, from: ruby, to: claude, time: '10:02', body: null, run: [
            { id: 'x1', from: ruby, to: claude, time: '10:00', body: null },
            { id: 'x2', system: true, from: beeline, to: ruby, time: '10:01', body: null },
            { id: 'x3', system: true, stop: true, from: owner, to: claude, time: '10:02', body: null },
        ] };
        act(() => { tree = create(<PillRow items={[mixed]} />); });
        const pill = tree.root.find((node: any) => node.type === 'Button' && node.props.testID === 'run-pill');
        expect(pill.findAll((node: any) => node.type === 'YStack' && node.props.testID === 'pill-system-face')).toHaveLength(1);
        expect(pill.findAll((node: any) => node.type === 'IdentityMark' && node.props.seed !== SYSTEM_IDENTITY_PUBKEY).map((face: any) => face.props.seed))
            .toEqual(['owner', 'ruby']);
        // In a dark theme a person's ink plate would vanish on the pill, so it gets a 1 px edge in the same 22 box.
        const edge = pill.find((node: any) => node.type === 'YStack' && node.props.testID === 'pill-face-edge');
        expect(edge.props).toMatchObject({ width: 22, height: 22, borderWidth: 1, borderColor: 'strongStroke' });
        expect(edge.find((node: any) => node.type === 'IdentityMark').props).toMatchObject({ seed: 'owner', size: 20 });
        expect(text(pill)).toEqual(['3 messages']);
        expect(pill.props['aria-label']).toBe('Read 3 messages between Ruby, Claude and owner, 1 from Beeline, 10:02');
        act(() => pill.props.onPress());
        expect(tree.root.findAll((node: any) => node.type === 'YStack' && node.props.testID?.startsWith?.('pill-run-entry-')).map((node: any) => node.props.testID))
            .toEqual(['pill-run-entry-x1', 'pill-run-entry-x2', 'pill-run-entry-x3']);
    });

    it('opens every run message in send order under a face → face heading, and folds again', () => {
        let tree: any;
        act(() => { tree = create(<PillRow items={[runItem]} />); });
        const pill = () => tree.root.find((node: any) => node.type === 'Button' && node.props.testID === 'run-pill');
        act(() => pill().props.onPress());
        const open = tree.root.find((node: any) => typeof node.type === 'string' && node.props.testID === 'pill-open');
        const entries = open.findAll((node: any) => node.type === 'YStack' && String(node.props.testID).startsWith('pill-run-entry-'));
        expect(entries.map((entry: any) => entry.props.testID)).toEqual(['m1', 's1', 'm2', 'm3'].map(id => `pill-run-entry-${id}`));
        for (const [index, entry] of entries.entries()) {
            expect(text(entry)[0]).toBe(`· ${runItem.run![index]!.time}`);
            expect(entry.findAllByProps({ testID: 'chat-byline-words' })).toHaveLength(0);
        }
        const m2 = entries[2];
        expect(m2.findAll((node: any) => node.type === 'IdentityMark').map((face: any) => face.props.seed)).toEqual(['claude', 'ruby']);
        expect(m2.findAll((node: any) => node.type === 'Icon.ArrowRight')).toHaveLength(1);
        expect(text(m2)).toEqual(['· 09:38', 'Stopped']);
        const stop = entries[1];
        expect(stop.find((node: any) => node.type === 'YStack' && node.props.testID === 'pill-stop-ring')
            .findAll((node: any) => node.props.testID === 'pill-stop-square')).not.toHaveLength(0);
        // Opened, a stop reads its system line, the same as every other system message.
        expect(text(stop)).toEqual(['· 09:37', '@ruby stopped @claude']);
        expect(stop.props['aria-label']).toBe('Ruby stopped Claude');
        act(() => pill().props.onPress());
        expect(tree.root.findAll((node: any) => typeof node.type === 'string' && node.props.testID === 'pill-open')).toHaveLength(0);
    });

    it.each([
        ['a stop after other notices', [
            { id: 'n1', from: { kind: 'system', name: 'Beeline' }, to: ruby, time: '09:40' },
            { id: 'n2', from: { kind: 'system', name: 'Beeline' }, to: jelly, time: '09:41' },
            { id: 's1', from: owner, to: claude, time: '09:42', stop: true },
        ], [SYSTEM_IDENTITY_PUBKEY, 'owner', 'ruby']],
        ['only person stops', [
            { id: 's1', from: owner, to: ruby, time: '09:42', stop: true },
            { id: 's2', from: owner, to: claude, time: '09:43', stop: true },
        ], ['owner', 'ruby', 'claude']],
    ] as const)('folds a system stack with %s, stopper first, the ringed logo only if a heading has it', (_name, run, seeds) => {
        let tree: any;
        const stack: PillItem = { id: run[0]!.id, system: true, from: run[0]!.from, to: run[0]!.to, time: '09:43', body: null, run };
        act(() => { tree = create(<PillRow items={[stack]} />); });
        const pill = tree.root.find((node: any) => node.type === 'Button' && node.props.testID === 'run-pill');
        expect(pill.findAll((node: any) => node.type === 'YStack' && node.props.testID === 'pill-system-face'))
            .toHaveLength(seeds.includes(SYSTEM_IDENTITY_PUBKEY as never) ? 1 : 0);
        expect(pill.findAll((node: any) => node.type === 'IdentityMark').map((face: any) => face.props.seed)).toEqual(seeds);
        expect(text(pill)).toEqual([`${run.length} messages`]);
    });

    const grunt = { kind: 'agent', seed: 'grunt', name: 'Grunt' } as const;
    const nerd = { kind: 'agent', seed: 'nerd', name: 'Nerd' } as const;
    // R1: an agent's message to Ruby, then a person stopping Grunt. Neither entry is Beeline's.
    const personStop: PillItem = { id: 'r1', system: false, from: nerd, to: ruby, time: '23:48', body: null, run: [
        { id: 'r1a', from: nerd, to: ruby, time: '23:47', body: null },
        { id: 'r1b', system: true, stop: true, from: owner, to: grunt, time: '23:48', body: null },
    ] };

    it('folds an agent message and a person stop to the person first, with no Beeline ring', () => {
        let tree: any;
        act(() => { tree = create(<PillRow items={[personStop]} />); });
        const pill = tree.root.find((node: any) => node.type === 'Button' && node.props.testID === 'run-pill');
        expect(pill.findAll((node: any) => node.type === 'YStack' && node.props.testID === 'pill-system-face')).toHaveLength(0);
        expect(pill.findAll((node: any) => node.type === 'IdentityMark').map((face: any) => face.props.seed)).toEqual(['owner', 'nerd', 'ruby']);
        expect(pill.props['aria-label']).toBe('Read 2 messages between Nerd, Ruby, Owner and Grunt, 23:48');
    });

    const beeline = { kind: 'system', name: 'Beeline' } as const;
    const fixtures: PillItem[] = [
        runItem,
        personStop,
        { id: 'mix', system: false, from: ruby, to: claude, time: '10:02', body: null, run: [
            { id: 'x1', from: ruby, to: claude, time: '10:00', body: null },
            { id: 'x2', system: true, from: beeline, to: ruby, time: '10:01', body: null },
            { id: 'x3', system: true, stop: true, from: owner, to: claude, time: '10:02', body: null },
        ] },
        { id: 'n1', system: true, from: beeline, to: ruby, time: '09:42', body: null, run: [
            { id: 'n1', system: true, from: beeline, to: ruby, time: '09:40', body: null },
            { id: 's1', system: true, stop: true, from: owner, to: claude, time: '09:42', body: null },
        ] },
        { id: 's1', system: true, from: owner, to: ruby, time: '09:43', body: null, run: [
            { id: 's1', system: true, stop: true, from: owner, to: ruby, time: '09:42', body: null },
            { id: 's2', system: true, stop: true, from: owner, to: claude, time: '09:43', body: null },
        ] },
        { id: 'as', system: false, from: ruby, to: claude, time: '09:44', body: null, run: [
            { id: 'as1', system: true, stop: true, from: ruby, to: claude, time: '09:43', body: null },
            { id: 'as2', from: claude, to: jelly, time: '09:44', body: null },
        ] },
        { id: 'sys-stack', system: true, from: beeline, time: '09:31', body: null, run: [
            { id: 'removed', system: true, from: beeline, time: '09:30', body: React.createElement('Text', { testID: 'removed-body' }, '@lunchboxfortwo removed @emberus') },
            { id: 'joined', system: true, from: beeline, time: '09:31', body: React.createElement('Text', { testID: 'joined-body' }, '@crayon joined · invited by @lunchboxfortwo') },
        ] },
    ];

    it('renders consecutive plain system notices as one folded pill and opens them in order', () => {
        let tree: any;
        const sysStack = fixtures.find((item) => item.id === 'sys-stack')!;
        act(() => { tree = create(<PillRow items={[sysStack]} />); });
        const pill = () => tree.root.find((node: any) => node.type === 'Button' && node.props.testID === 'run-pill');
        expect(pill().findAll((node: any) => node.type === 'YStack' && node.props.testID === 'pill-system-face')).toHaveLength(1);
        expect(pill().findAll((node: any) => node.type === 'IdentityMark').map((face: any) => face.props.seed)).toEqual([SYSTEM_IDENTITY_PUBKEY]);
        expect(text(pill())).toEqual(['2 messages']);
        expect(pill().props['aria-label']).toBe('Read 2 system messages, 09:31');
        expect(tree.root.findAllByProps({ testID: 'pill-open' })).toHaveLength(0);
        act(() => pill().props.onPress());
        expect(pill().props['aria-label']).toBe('Hide 2 system messages, 09:31');
        const open = tree.root.find((node: any) => typeof node.type === 'string' && node.props.testID === 'pill-open');
        const entries = open.findAll((node: any) => node.type === 'YStack' && String(node.props.testID).startsWith('pill-run-entry-'));
        expect(entries.map((entry: any) => entry.props.testID)).toEqual(['pill-run-entry-removed', 'pill-run-entry-joined']);
        expect(text(entries[0])).toEqual(['· 09:30', '@lunchboxfortwo removed @emberus']);
        expect(text(entries[1])).toEqual(['· 09:31', '@crayon joined · invited by @lunchboxfortwo']);
        act(() => pill().props.onPress());
        expect(tree.root.findAll((node: any) => typeof node.type === 'string' && node.props.testID === 'pill-open')).toHaveLength(0);
    });

    it.each(fixtures.map((item) => [item.id, item] as const))('folds run %s to faces its opened headings draw', (_id, item) => {
        let tree: any;
        act(() => { tree = create(<PillRow items={[item]} />); });
        const pill = () => tree.root.find((node: any) => node.type === 'Button' && node.props.testID === 'run-pill');
        const folded = pill().findAll((node: any) => node.type === 'IdentityMark').map((face: any) => face.props.seed);
        act(() => pill().props.onPress());
        const open = tree.root.find((node: any) => typeof node.type === 'string' && node.props.testID === 'pill-open');
        const opened = new Set(open.findAll((node: any) => node.type === 'IdentityMark').map((face: any) => face.props.seed));
        expect(folded.length).toBeGreaterThan(0);
        for (const seed of folded) expect(opened).toContain(seed);
    });

    it('draws a stop as face, stop glyph, face, with no text', () => {
        let tree: any;
        const stop: PillItem = { id: 'stop', system: true, stop: true, from: owner, to: ruby, time: '09:42',
            body: React.createElement('Text', {}, 'Owner stopped Ruby · turn cancelled') };
        act(() => { tree = create(<PillRow items={[stop]} />); });
        const pill = tree.root.find((node: any) => node.type === 'Button' && node.props.testID === 'stop-pill');
        expect(pill.findAll((node: any) => node.type === 'IdentityMark').map((face: any) => face.props.seed)).toEqual(['owner', 'ruby']);
        // The stop square in a ring, in the arrow's colour.
        const ring = pill.find((node: any) => node.type === 'YStack' && node.props.testID === 'pill-stop-ring');
        expect(ring.props.borderRadius).toBe('full');
        expect(ring.findAll((node: any) => node.props.testID === 'pill-stop-square')).not.toHaveLength(0);
        expect(pill.findAll((node: any) => node.type === 'Icon.ArrowRight')).toHaveLength(0);
        expect(text(pill)).toEqual([]);
        expect(pill.props['aria-label']).toBe('Owner stopped Ruby');
    });

    describe('GitHub events', () => {
        const github = { kind: 'github', name: 'GitHub' } as const;
        const alan = { kind: 'agent', seed: 'alan', name: 'Alan' } as const;
        const jimmy = { kind: 'agent', seed: 'jimmy', name: 'Jimmy' } as const;
        const event = (id: string, number: number, title: string, fields: Partial<PillEvent> = {}): PillRunEntry => ({
            id, from: github, time: '21:02', event: { source: 'github', verb: 'Merged', number: String(number), title, mark: 'merged',
                spoken: `Merged PR #${number} ${title}`, counted: true, open: { label: 'Opens GitHub', onPress: vi.fn() }, ...fields } });
        const message = (id: string): PillRunEntry => ({ id, from: alan, to: jimmy, time: '21:10', body: React.createElement('Text', null, `body ${id}`) });
        const strings = (node: any): string[] => node.findAll((child: any) => child.type === 'Text')
            .flatMap((child: any) => [child.props.children].flat()).filter((part: any) => typeof part === 'string');
        const mixed: PillItem = { id: 'e1', system: false, from: github, time: '21:11', body: null, run: [
            event('e1', 74, 'Stop ends a stale working line'), event('e2', 75, 'Composer tray keeps its draft'),
            message('m1'), event('e3', 77, 'Delete the offline-host line'), message('m2'),
            event('e4', 77, 'Delete the offline-host line', { counted: false }),
            event('e5', 78, 'Publish every release'), event('e6', 79, 'Restore the timer'), event('e7', 80, 'Wake the implementer'),
        ] };

        it('draws a lone event as the GitHub ring and its state mark, with no text', () => {
            let tree: any;
            const lone: PillItem = { ...event('solo', 77, 'Delete the offline-host line'), system: false, body: null };
            act(() => { tree = create(<PillRow items={[lone]} />); });
            const pill = tree.root.find((node: any) => node.type === 'Button' && node.props.testID === 'event-pill');
            expect(pill.findAll((node: any) => node.type === 'YStack' && node.props.testID === 'pill-github-face')).toHaveLength(1);
            expect(pill.findAll((node: any) => node.type === 'YStack' && node.props.testID === 'pill-event-mark-merged')).toHaveLength(1);
            expect(pill.findAll((node: any) => node.type === 'Icon.GitMerge')).toHaveLength(1);
            expect(strings(pill)).toEqual([]);
            expect(pill.props['aria-label']).toBe('Read GitHub event: Merged PR #77 Delete the offline-host line, 21:02');
            act(() => pill.props.onPress());
            expect(tree.root.findAll((node: any) => node.props?.testID === 'pill-event-solo' && typeof node.type === 'string')).not.toHaveLength(0);
        });

        it('folds messages and events into one pill of faces and a count, with no event text in it', () => {
            let tree: any;
            act(() => { tree = create(<PillRow items={[mixed]} />); });
            const pill = tree.root.find((node: any) => node.type === 'Button' && node.props.testID === 'run-pill');
            expect(pill.findAll((node: any) => node.type === 'YStack' && node.props.testID === 'pill-github-face')).toHaveLength(1);
            expect(pill.findAll((node: any) => node.type === 'IdentityMark').map((face: any) => face.props.seed)).toEqual(['alan', 'jimmy']);
            // The repeated #77 merge line counts once.
            expect(strings(pill)).toEqual(['2 messages · 6 events']);
            expect(strings(pill).join(' ')).not.toContain('offline-host');
            // The label is meta at the quiet ink.
            const label = pill.find((node: any) => node.type === Copy);
            expect(label.props).toMatchObject({ small: true, quiet: true });
            expect(pill.props['aria-label']).toBe('Read 2 messages and 6 GitHub events between Alan and Jimmy, 21:11');
        });

        it('opens messages and events in send order, back-to-back events under one GitHub heading as system lines', () => {
            let tree: any;
            act(() => { tree = create(<PillRow items={[mixed]} />); });
            act(() => tree.root.find((node: any) => node.type === 'Button').props.onPress());
            const open = tree.root.find((node: any) => typeof node.type === 'string' && node.props.testID === 'pill-open');
            const blocks = open.findAll((node: any) => node.type === 'YStack' && /^pill-(event-group|run-entry)-/.test(node.props.testID ?? ''))
                .map((node: any) => node.props.testID);
            expect(blocks).toEqual(['pill-event-group-e1', 'pill-run-entry-m1', 'pill-event-group-e3', 'pill-run-entry-m2', 'pill-event-group-e4']);
            const group = open.find((node: any) => node.props.testID === 'pill-event-group-e1' && node.type === 'YStack');
            expect(group.findAll((node: any) => node.type === 'YStack' && node.props.testID === 'pill-github-face')).toHaveLength(1);
            expect(strings(group)).toContain('· 21:02');
            // Every event reads as a system line, the format an opened stop uses: meta at the quiet ink, #number in brass.
            const line = group.find((node: any) => node.type === T && node.props.testID === 'pill-event-text-e1');
            expect(line.props).toMatchObject({ v: 'meta', color: 'secondary' });
            const parts = line.findAll((node: any) => node.type === T).filter((node: any) => node !== line);
            expect(parts.map((node: any) => [node.props.v, node.props.color, node.props.children])).toEqual([['meta', 'needsYou', '#74']]);
            const flat = (node: any): string => typeof node === 'string' ? node : (node.children ?? []).map(flat).join('');
            expect(flat(line)).toBe('Merged #74 Stop ends a stale working line');
            expect(open.findAll((node: any) => node.type === T && ['heading', 'metaStrong'].includes(node.props.v))).toHaveLength(0);
            // A tap opens the event's destination.
            const target = open.find((node: any) => node.props.testID === 'pill-event-open-e1' && typeof node.type === 'string');
            expect(target.props.accessibilityLabel).toBe('Merged PR #74 Stop ends a stale working line. Opens GitHub');
            act(() => target.props.onPress());
            expect(mixed.run![0]!.event!.open!.onPress).toHaveBeenCalled();
        });

        const beeline = { kind: 'system', name: 'Beeline' } as const;
        const thread = (id: string): PillRunEntry => ({ id, from: beeline, time: '20:45', event: { source: 'beeline', verb: 'Opened',
            title: 'thread github-event-pills', mark: 'thread', spoken: 'Opened thread github-event-pills', counted: true,
            open: { label: 'Opens its thread', onPress: vi.fn() } } });

        it('draws a lone thread opening as the Beeline ring and the thread mark, never the GitHub ring', () => {
            let tree: any;
            const lone: PillItem = { ...thread('t1'), system: false, body: null };
            act(() => { tree = create(<PillRow items={[lone]} />); });
            const pill = tree.root.find((node: any) => node.type === 'Button' && node.props.testID === 'event-pill');
            expect(pill.findAll((node: any) => node.type === 'YStack' && node.props.testID === 'pill-system-face')).toHaveLength(1);
            expect(pill.findAll((node: any) => node.type === 'YStack' && node.props.testID === 'pill-github-face')).toHaveLength(0);
            expect(pill.findAll((node: any) => node.type === 'Icon.CornerDownRight')).toHaveLength(1);
            expect(strings(pill)).toEqual([]);
            expect(pill.props['aria-label']).toBe('Read Beeline event: Opened thread github-event-pills, 20:45');
            act(() => pill.props.onPress());
            const open = tree.root.findByProps({ testID: 'pill-open' });
            expect(open.findAllByProps({ testID: 'pill-event-group-t1' })).toHaveLength(0);
            expect(open.findAllByProps({ testID: 'pill-event-text-t1' })).not.toHaveLength(0);
        });

        it('leads a run with both rings, heads a thread opening with Beeline, and counts it as a Beeline event', () => {
            let tree: any;
            const run: PillItem = { id: 'e1', system: false, from: github, time: '20:47', body: null, run: [
                event('e1', 74, 'Stop ends a stale working line'), thread('t1'), event('e2', 77, 'Delete the offline-host line'), message('m1'),
            ] };
            act(() => { tree = create(<PillRow items={[run]} />); });
            const pill = tree.root.find((node: any) => node.type === 'Button' && node.props.testID === 'run-pill');
            const rings = pill.findAll((node: any) => node.type === 'YStack' && ['pill-github-face', 'pill-system-face'].includes(node.props.testID));
            expect(rings.map((node: any) => node.props.testID)).toEqual(['pill-github-face', 'pill-system-face']);
            expect(strings(pill)).toEqual(['1 message · 3 events']);
            expect(pill.props['aria-label']).toBe('Read 1 message, 2 GitHub events and 1 Beeline event between Alan and Jimmy, 20:47');
            act(() => pill.props.onPress());
            const groups = tree.root.findAll((node: any) => node.type === 'YStack' && /^pill-event-group-/.test(node.props.testID ?? ''));
            expect(groups.map((node: any) => [node.props.testID,
                node.findAll((face: any) => face.type === 'YStack' && ['pill-github-face', 'pill-system-face'].includes(face.props.testID))
                    .map((face: any) => face.props.testID)])).toEqual([
                ['pill-event-group-e1', ['pill-github-face']], ['pill-event-group-t1', ['pill-system-face']], ['pill-event-group-e2', ['pill-github-face']]]);
        });

        it('opens a stop and an event in the same system-line format', () => {
            let tree: any;
            const stopLine = React.createElement(T, { v: 'meta', color: 'secondary', testID: 'stop-line' }, 'Claude stopped Jellybean');
            const run: PillItem = { id: 's1', system: false, from: alan, time: '20:48', body: null, run: [
                { id: 's1', from: alan, to: jimmy, stop: true, system: true, time: '20:48', body: stopLine }, event('e1', 77, 'Delete the offline-host line'),
            ] };
            act(() => { tree = create(<PillRow items={[run]} />); });
            act(() => tree.root.find((node: any) => node.type === 'Button').props.onPress());
            const stop = tree.root.find((node: any) => node.type === T && node.props.testID === 'stop-line');
            const merge = tree.root.find((node: any) => node.type === T && node.props.testID === 'pill-event-text-e1');
            expect([merge.props.v, merge.props.color]).toEqual([stop.props.v, stop.props.color]);
        });

        it('shows two events and "N more" when a group holds more than three', () => {
            let tree: any;
            act(() => { tree = create(<PillRow items={[mixed]} />); });
            act(() => tree.root.find((node: any) => node.type === 'Button').props.onPress());
            const shown = () => tree.root.findAll((node: any) => typeof node.type === 'string' && /^pill-event-e\d$/.test(node.props.testID ?? ''))
                .map((node: any) => node.props.testID);
            expect(shown()).toEqual(['pill-event-e1', 'pill-event-e2', 'pill-event-e3', 'pill-event-e4', 'pill-event-e5']);
            const more = tree.root.find((node: any) => typeof node.type === 'string' && node.props.testID === 'pill-event-more-e4');
            expect(more.props.accessibilityLabel).toBe('2 more GitHub events');
            act(() => more.props.onPress());
            expect(shown()).toEqual(['pill-event-e1', 'pill-event-e2', 'pill-event-e3', 'pill-event-e4', 'pill-event-e5', 'pill-event-e6', 'pill-event-e7']);
        });
    });

    it('draws a lone issue event with its opened or closed mark, from the stored line to the pill', async () => {
        const { foldPrLifecycleRuns } = await import('@/buzz/pr-lifecycle');
        const { pillItems } = await import('@/components/buzz/TranscriptPills');
        const issue = (id: string, action: 'opened' | 'closed') => ({ id, text: '', isUser: false, timestamp: 1_800_000_000,
            githubEvent: { type: 'issue', action, title: 'Pills hide merges', url: 'https://github.com/o/r/issues/12', actor: 'owner' } as never });
        for (const [action, mark, icon] of [['opened', 'issueOpened', 'Icon.CircleDot'], ['closed', 'issueClosed', 'Icon.CircleCheck']] as const) {
            const [row] = foldPrLifecycleRuns([issue(`i-${action}`, action)]);
            const items = pillItems([row!], () => ({ kind: 'system', name: 'Beeline' }), {});
            let tree: any;
            act(() => { tree = create(<PillRow items={items} />); });
            const pill = tree.root.find((node: any) => node.type === 'Button' && node.props.testID === 'event-pill');
            expect(pill.findAll((node: any) => node.type === 'YStack' && node.props.testID === `pill-event-mark-${mark}`)).toHaveLength(1);
            expect(pill.findAll((node: any) => node.type === icon)).toHaveLength(1);
            act(() => tree.unmount());
        }
    });
});
