import { describe, expect, it, vi } from 'vitest';

// The row copy helpers sit beside the schedules read hook; only the helpers run here.
vi.mock('react-native', () => ({ AppState: { currentState: 'active' }, Platform: { OS: 'ios' } }));
vi.mock('@/sync/transport/live-connection', () => ({ sharedLiveConnection: () => ({}) }));
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: vi.fn(), MonolithPhoneOperationError: class extends Error {} }));
vi.mock('@/auth/buzz-identity-storage', () => ({ getEffectiveRelayUrl: vi.fn(), loadBuzzIdentity: vi.fn() }));
vi.mock('@/buzz/use-shared-surface', () => ({ useSharedSurface: vi.fn() }));
vi.mock('@/buzz/surface-storage', () => ({ mobileSurfaceCache: {}, surfaceAddress: vi.fn() }));
vi.mock('@/buzz/use-surface-focus', () => ({ useSurfaceFocus: () => true }));
import type { RoomScheduleView, RoomSubscriptionView } from '@beeline/api-contract/phone';
import { chatKindLine, finishedWhen, scheduledRows } from './chat-info-lines';

const ROOM = '22222222-2222-4222-8222-222222222222';
const schedule = (patch: Partial<RoomScheduleView>): RoomScheduleView => ({
    id: 's1', workspaceId: 'w', roomId: ROOM, agentId: 'alan-id', creatorId: 'c',
    cadence: { kind: 'interval', everyMinutes: 60 }, message: 'Check the dependencies.', nextRunAt: 2_000_000_000,
    createdAt: 1, runCount: 0, ...patch,
});
const subscription = (patch: Partial<RoomSubscriptionView>): RoomSubscriptionView => ({
    id: 'sub1', agentId: 'jimmy-id', event: 'joined', ...patch,
} as RoomSubscriptionView);

describe('Chat info lines', () => {
    it('says whether the chat is public or private', () => {
        expect(chatKindLine('public', 'Beeline Work', 5)).toBe('Public · anyone in Beeline Work can join · 5 members');
        expect(chatKindLine('invite-only', 'Beeline Work', 1)).toBe('Private · 1 member');
    });

    it('names the workflow each schedule or subscription runs, else its agent', () => {
        const rows = scheduledRows({
            roomName: 'beeline',
            agentNames: new Map([['alan-id', 'alan'], ['jimmy-id', 'jimmy']]),
            schedules: [schedule({ id: 'later', nextRunAt: 2_000_000_100 }), schedule({ id: 'wf', workflowSlug: 'nightly-release-check' })],
            subscriptions: [subscription({ workflowSlug: 'review-then-merge' }), subscription({ id: 'sub2' })],
        });
        expect(rows.map((row) => row.id)).toEqual(['wf', 'later', 'sub1', 'sub2']);
        expect(rows[0]!.detail).toMatch(/runs the workflow .+ · this chat$/);
        expect(rows[1]!.detail).toMatch(/ · @alan · this chat$/);
        expect(rows[2]!.detail).toMatch(/^Subscription · runs the workflow /);
        expect(rows[3]!.detail).toMatch(/^Subscription · @jimmy · /);
    });

    it('dates finished threads plainly', () => {
        const now = new Date(2026, 10, 11, 12);
        expect(finishedWhen(Math.floor(new Date(2026, 10, 11, 9).getTime() / 1000), now)).toBe('done · Today');
        expect(finishedWhen(Math.floor(new Date(2026, 10, 10, 9).getTime() / 1000), now)).toBe('done · Yesterday');
        expect(finishedWhen(undefined, now)).toBe('done');
    });
});
