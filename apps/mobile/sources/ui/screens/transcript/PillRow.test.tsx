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
        // A lone pill opens exactly like a run of one: the run list's face → face row in the transcript column.
        const open = tree.root.find((node: any) => typeof node.type === 'string' && node.props.testID === 'pill-open');
        const entry = open.find((node: any) => node.type === 'YStack' && node.props.testID === 'pill-run-entry-a2a');
        expect(entry.findAll((node: any) => node.type === 'IdentityMark').map((face: any) => face.props.seed)).toEqual(['alan', 'jimmy']);
        expect(entry.findAll((node: any) => node.type === 'Icon.ArrowRight')).toHaveLength(1);
        expect(entry.findByProps({ testID: 'a2a-body' }).props.children).toBe('@jimmy Keep it visible');
        expect(text(entry)).toContain('· 10:00');
        expect(pill().props['aria-expanded']).toBe(true);
        act(() => pill().props.onPress());
        expect(tree.root.findAll((node: any) => typeof node.type === 'string' && node.props.testID === 'pill-open')).toHaveLength(0);
    });
    it('draws a lone agent message as its plain face → face row, with no pill above it', () => {
        let tree: any;
        act(() => { tree = create(<PillRow items={[items[1]!]} />); });
        expect(tree.root.findAll((node: any) => node.type === 'Button')).toHaveLength(0);
        const entry = tree.root.find((node: any) => node.type === 'YStack' && node.props.testID === 'pill-run-entry-a2a');
        expect(entry.findAll((node: any) => node.type === 'IdentityMark').map((face: any) => face.props.seed)).toEqual(['alan', 'jimmy']);
        expect(entry.findAll((node: any) => node.type === 'Icon.ArrowRight')).toHaveLength(1);
        expect(text(entry)).toContain('· 10:00');
        expect(entry.findByProps({ testID: 'a2a-body' }).props.children).toBe('@jimmy Keep it visible');
        // The faces appear once: only in the row's heading.
        expect(tree.root.findAll((node: any) => node.type === 'IdentityMark')).toHaveLength(2);
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
        expect(pill.props['aria-label']).toBe('Read 3 messages between Ruby, Claude and owner, 2 from Beeline, 10:02');
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
        ], [SYSTEM_IDENTITY_PUBKEY, 'owner', 'ruby']],
    ] as const)('folds a system stack with %s to the ringed logo first and keeps the stopper', (_name, run, seeds) => {
        let tree: any;
        const stack: PillItem = { id: run[0]!.id, system: true, from: run[0]!.from, to: run[0]!.to, time: '09:43', body: null, run };
        act(() => { tree = create(<PillRow items={[stack]} />); });
        const pill = tree.root.find((node: any) => node.type === 'Button' && node.props.testID === 'run-pill');
        expect(pill.findAll((node: any) => node.type === 'YStack' && node.props.testID === 'pill-system-face')).toHaveLength(1);
        expect(pill.findAll((node: any) => node.type === 'IdentityMark').map((face: any) => face.props.seed)).toEqual(seeds);
        expect(text(pill)).toEqual([`${run.length} messages`]);
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
            id, from: github, time: '21:02', event: { verb: 'Merged', number: String(number), title, mark: 'merged',
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

        it('opens messages and events in send order, back-to-back events under one GitHub heading in body type', () => {
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
            // Every event reads in body type: verb in ink, #number in brass, title in secondary. No heading or strong role.
            const line = group.find((node: any) => node.type === T && node.props.testID === 'pill-event-text-e1');
            expect(line.props).toMatchObject({ v: 'body', color: 'secondary' });
            const parts = line.findAll((node: any) => node.type === T).filter((node: any) => node !== line);
            expect(parts.map((node: any) => [node.props.v, node.props.color, node.props.children])).toEqual([
                ['body', 'ink', 'Merged '], ['body', 'needsYou', '#74 ']]);
            expect(open.findAll((node: any) => node.type === T && ['heading', 'metaStrong'].includes(node.props.v))).toHaveLength(0);
            // A tap opens the event's destination.
            const target = open.find((node: any) => node.props.testID === 'pill-event-open-e1' && typeof node.type === 'string');
            expect(target.props.accessibilityLabel).toBe('Merged PR #74 Stop ends a stale working line. Opens GitHub');
            act(() => target.props.onPress());
            expect(mixed.run![0]!.event!.open!.onPress).toHaveBeenCalled();
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
});
