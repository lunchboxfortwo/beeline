import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'web' }, Text: 'Text', View: 'View', Pressable: 'Pressable' }));
vi.mock('tamagui', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts());
vi.mock('lucide-react-native', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).lucideHosts());
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('./RoomMessageVariants-attachment-card', () => ({ ConnectorReceiptCard: () => null }));
vi.mock('./RoomMessageVariants-ordinary-ledger-message', () => ({ OrdinaryLedgerMessage: () => null }));
vi.mock('@/components/buzz/PrLifecycleCard', () => ({ NotificationLifecycleCard: () => null }));
vi.mock('@/components/buzz/LifecycleCard', () => ({ GitHubEventCard: () => null, DaemonFactCard: () => null }));
vi.mock('@/components/buzz/GrantRequestCard', () => ({ GrantRequestCard: () => null }));
vi.mock('@/components/buzz/AppMark', () => ({ AppMark: () => null }));
vi.mock('@/components/buzz/IdentityMark', () => ({ IdentityMark: () => null }));
vi.mock('@/components/buzz/ErrorBanner', () => ({ ErrorBanner: () => null }));
vi.mock('@/ui/screens/transcript/cards/RequestMedia', () => ({ RequestMedia: () => null }));
vi.mock('@/utils/open-external-url', () => ({ openExternalUrl: vi.fn(async () => undefined) }));

import { ConnectorOfferCard, SquireApprovalCard, WritePermissionCard } from './RoomMessageVariants';
import { openExternalUrl } from '@/utils/open-external-url';

const VIEWER = 'a'.repeat(64);
const AGENT = { pubkey: 'b'.repeat(64), kind: 'agent', name: 'Jimmy', handle: 'jimmy' } as const;
const buttons = (tree: any) => tree.root.findAll((node: any) => node.type === 'Button');
const render = (element: React.ReactElement) => { let tree: any; act(() => { tree = create(element); }); return tree; };

beforeEach(() => vi.clearAllMocks());

describe('request cards in the transcript', () => {
    it('Squire approvals open Squire’s own approval page, never decide in the app', () => {
        const message = { id: 'sq', text: '', isUser: false, timestamp: 1793700000, squireApproval: {
            agent: AGENT, owner: { pubkey: VIEWER, kind: 'human', name: 'Dan' }, tool: 'inject_card',
            detail: 'Pay · at Fly.io · $12.00', approvalUrl: 'https://squire.test/approve/1', linkKind: 'passkey',
        } } as never;
        const tree = render(<SquireApprovalCard message={message} viewerPubkey={VIEWER} />);
        expect(tree.root.find((node: any) => node.type === 'Card').props.backgroundColor).toBe('raised');
        const approve = buttons(tree).find((node: any) => node.props.testID === 'squire-approval-open');
        expect(approve.props['aria-label']).toBe('Approve');
        expect(approve.props.accessibilityRole).toBe('link');
        act(() => { approve.props.onPress(); });
        expect(openExternalUrl).toHaveBeenCalledWith('https://squire.test/approve/1');
        expect(tree.root.findAll((node: any) => node.type === 'Icon.ExternalLink')).toHaveLength(1);
    });

    it('write requests are Approve / Deny on today’s permission decision', () => {
        const onDecision = vi.fn();
        const message = { id: 'wp', text: '', isUser: false, timestamp: 1793700000, writePermission: {
            permissionId: 'p1', requestId: 'r1', agentPubkey: AGENT.pubkey, requesterPubkey: VIEWER,
            tool: 'git', repository: 'beeline', status: 'pending',
        } } as never;
        const tree = render(<WritePermissionCard message={message} viewerIsAgent={false} viewerPubkey={VIEWER}
            actionId={null} onDecision={onDecision} onOpenCorner={() => undefined} />);
        expect(buttons(tree).map((node: any) => node.props['aria-label'])).toEqual(['Approve', 'Deny']);
        act(() => { buttons(tree)[0].props.onPress(); });
        act(() => { buttons(tree)[1].props.onPress(); });
        expect(onDecision.mock.calls.map((call) => call[1])).toEqual(['allow', 'deny']);
        expect(tree.root.findAll((node: any) => node.type === 'Text' && node.props.children === 'Can')).toHaveLength(0);
    });

    it('a connector offer is Approve / Deny on accept and decline', () => {
        const onAccept = vi.fn();
        const onDecline = vi.fn();
        const message = { id: 'co', text: '', isUser: false, timestamp: 1793700000, connectorOffer: {
            offerId: 'o1', agent: AGENT, addressee: { pubkey: VIEWER, kind: 'human', name: 'Dan' }, connectorType: 'figma',
            connectorName: 'Figma', status: 'pending', intent: 'add',
        } } as never;
        const tree = render(<ConnectorOfferCard message={message} viewerIsAgent={false} viewerPubkey={VIEWER} actionId={null}
            onAccept={onAccept} onDecline={onDecline} onOpenWorkbench={() => undefined} onOpenReplacement={() => undefined} />);
        expect(buttons(tree).map((node: any) => node.props['aria-label'])).toEqual(['Approve', 'Deny']);
        act(() => { buttons(tree)[0].props.onPress(); });
        act(() => { buttons(tree)[1].props.onPress(); });
        expect(onAccept).toHaveBeenCalledWith('o1', 'figma');
        expect(onDecline).toHaveBeenCalledWith('o1');
    });
});
