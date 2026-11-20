import React from 'react';
import type { WorkflowRunDetailView } from '@beeline/api-contract/phone';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

vi.mock('tamagui', async () => (await import('../grammar-hosts.test-support')).tamaguiHosts());
vi.mock('lucide-react-native', async () => (await import('../grammar-hosts.test-support')).lucideHosts());
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: vi.fn() }));
vi.mock('@/buzz/use-observed-resource', () => ({ useObservedResource: () => ({ data: null }), observeRoomResource: () => undefined }));
vi.mock('@/buzz/use-room-workflow-run', () => ({ useRoomWorkflowRun: () => ({ workflow: undefined }) }));

import { WorkflowRunCard, WorkflowRunCardView } from './WorkflowRunCard';
import { Spinner } from '@/ui/grammar';

const JIMMY = { id: 'j', kind: 'agent', name: 'Jimmy', handle: 'jimmy' } as const;
const ALAN = { id: 'a', kind: 'agent', name: 'Alan', handle: 'alan' } as const;
const detail = {
    run: { runId: 'run', workflowSlug: 'fix_and_verify', description: '', roomId: 'corner', roomName: 'scrubber', state: 'review',
        status: 'live', viewerHolds: false, holder: ALAN, startedAt: 1, updatedAt: 2, startedBy: JIMMY },
    contract: { handoffs: {
        reproduce: { kind: 'handoff', role: 'fixer', does: 'Reproduce the bug', on: { done: 'fix' } },
        fix: { kind: 'handoff', role: 'fixer', does: 'Fix it', on: { done: 'review' } },
        review: { kind: 'handoff', role: 'reviewer', does: 'Read the change', on: { done: 'merge' } },
        merge: { kind: 'handoff', role: 'fixer', does: 'Merge it', on: { done: 'finished' } },
        finished: { kind: 'terminal', status: 'done' },
    } },
    history: [
        { toState: 'reproduce', at: 1, actor: JIMMY, displayStatus: 'done', finalReply: { messageId: 'm1', text: 'The scrubber moved.' } },
        { fromState: 'reproduce', outcome: 'done', toState: 'fix', at: 2, actor: JIMMY, displayStatus: 'done' },
        { fromState: 'fix', outcome: 'done', toState: 'review', at: 3, actor: JIMMY, displayStatus: 'current', liveOutput: 'Reading the change now.' },
    ],
    roleHolders: { fixer: JIMMY, reviewer: ALAN },
} as unknown as WorkflowRunDetailView;

describe('workflow run card', () => {
    it('draws the run on one rail: done, current, then not yet', () => {
        let tree: any;
        act(() => { tree = create(<WorkflowRunCardView detail={detail} />); });
        const states = tree.root.findAll((node: any) => node.type === 'XStack' && /^workflow-step-/.test(node.props.testID ?? ''))
            .map((node: any) => node.props.testID);
        expect(states.slice(0, 3)).toEqual(['workflow-step-done', 'workflow-step-done', 'workflow-step-current']);
        expect(states.slice(3).every((state: string) => state === 'workflow-step-pending')).toBe(true);
        const completed = tree.root.findAll((node: any) => node.type === 'Svg' && node.props.accessibilityLabel === 'done');
        expect(completed).toHaveLength(2);
        for (const svg of completed) {
            const circles = svg.findAllByType('Circle');
            expect(circles).toHaveLength(2);
            expect(circles[0].props.fill).toBe('none');
            expect(circles[1].props.fill).toBe(circles[0].props.stroke);
            expect(svg.findAllByType('Path')).toHaveLength(0);
        }
        const notes = tree.root.findAll((node: any) => node.type === 'Text' && node.props.color === 'needsYou').map((node: any) => node.props.children);
        expect(notes).toContain('Reading the change now.');
        expect(tree.root.find((node: any) => node.props.testID === 'workflow-run-headline').props.children).toBe('Running · Jimmy');
        expect(tree.root.findAll((node: any) => node.type === Spinner)).toHaveLength(2);
        act(() => tree.unmount());
    });

    it.each([
        { kind: 'gate', viewerHolds: true, human: false, mark: 'needs you' },
        { kind: 'gate', viewerHolds: false, human: false, mark: 'working' },
        { kind: 'waiting', viewerHolds: false, human: false, mark: 'working' },
        { kind: 'handoff', viewerHolds: true, human: true, mark: 'needs you' },
        { kind: 'handoff', viewerHolds: false, human: true, mark: 'working' },
    ] as const)('keeps a $kind step static when viewerHolds=$viewerHolds and human=$human', ({ kind, viewerHolds, human, mark }) => {
        const scenario = {
            ...detail,
            run: { ...detail.run, viewerHolds, holder: human ? { id: 'other', kind: 'human', name: 'Ada' } : ALAN },
            contract: { ...detail.contract, handoffs: { ...detail.contract.handoffs,
                review: { ...detail.contract.handoffs.review, kind },
            } },
        } as WorkflowRunDetailView;
        let tree: any;
        act(() => { tree = create(<WorkflowRunCardView detail={scenario} />); });
        expect(tree.root.findAllByType(Spinner)).toHaveLength(0);
        const current = tree.root.findAll((node: any) => node.type === 'XStack' && node.props.testID === 'workflow-step-current')[0];
        expect(current.findByType('Svg').props.accessibilityLabel).toBe(mark);
        expect(tree.root.findAll((node: any) => node.type === 'Svg' && node.props.accessibilityLabel === mark)).toHaveLength(2);
        act(() => tree.unmount());
    });

    it('renders nothing without a live run', () => {
        let tree: any;
        act(() => { tree = create(<WorkflowRunCard roomId="corner" />); });
        expect(tree.toJSON()).toBeNull();
    });
});
