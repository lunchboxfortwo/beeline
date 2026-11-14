import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'web' }, Text: 'Text', View: 'View' }));
vi.mock('tamagui', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts());
vi.mock('lucide-react-native', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).lucideHosts());
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('./IdentityMark', () => ({ IdentityMark: () => null }));
vi.mock('./ErrorBanner', () => ({ ErrorBanner: () => null }));
vi.mock('@/ui/screens/transcript/cards/RequestMedia', () => ({ RequestMedia: () => null }));
vi.mock('./Ledger', () => ({ LedgerEntryFrame: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('@/components/buzz/IdentityMark', () => ({ IdentityMark: () => null }));

import { canDecideGrantRequest, GrantRequestCard, GrantRequestPill } from './GrantRequestCard';

const OWNER = 'a'.repeat(64);
const AGENT = { pubkey: 'b'.repeat(64), kind: 'agent', name: 'Alan', handle: 'alan' } as const;
const grant = {
    grantId: 'grant-1', kind: 'command',
    target: JSON.stringify({ argv: ['bash'], stdin: 'printf check' }),
    script: { path: '<stdin>', sha256: 'a'.repeat(64), bytes: 12, contents: 'printf check' },
    reason: 'Run the tests', status: 'pending',
    requestedBy: AGENT, roomId: 'room', createdAt: 1, auto: false,
};
const message = {
    id: 'm1', text: '', isUser: false, timestamp: 1793700000,
    grantRequest: { agent: AGENT, owner: { pubkey: OWNER, kind: 'human', name: 'Dan' }, grants: [grant] },
} as never;

function render(props: Partial<React.ComponentProps<typeof GrantRequestCard>> = {}) {
    let tree: any;
    act(() => {
        tree = create(<GrantRequestCard message={message} viewerIsAgent={false} viewerPubkey={OWNER}
            actionId={null} onDecision={() => undefined} {...props} />);
    });
    return tree;
}
const button = (tree: any, testID: string) => tree.root.find((node: any) => node.type === 'Button' && node.props.testID === testID);

describe('grant request card', () => {
    it('puts the purpose and host in the title, with argv retained in details',()=>{
        const target='["/private/node","/private/deploy.mjs"]';
        const updated={...(message as any),grantRequest:{...(message as any).grantRequest,
            grants:[{...grant,target,purpose:'Deploy the Milo site',machine:'squire'}]}};
        const tree=render({message:updated as any});
        const title=tree.root.find((node:any)=>node.type==='Text'&&node.props.testID==='grant-grant-1-ask');
        expect(title.props.children).toBe('@Alan wants to deploy the Milo site on squire');
        expect(JSON.stringify(tree.toJSON())).toContain('/private/deploy.mjs');
    });
    it('is one raised request card with Always, Once and Deny for bash with stdin', () => {
        const tree = render();
        expect(tree.root.find((node: any) => node.type === 'Card').props.backgroundColor).toBe('raised');
        const labels = tree.root.findAll((node: any) => node.type === 'Button').map((node: any) => node.props['aria-label']);
        expect(labels).toEqual(['Always', 'Once', 'Deny']);
    });

    it('sends distinct Always, Once and Deny decisions', () => {
        const onDecision = vi.fn();
        const tree = render({ onDecision });
        act(() => { button(tree, 'grant-grant-1-always').props.onPress(); });
        act(() => { button(tree, 'grant-grant-1-once').props.onPress(); });
        act(() => { button(tree, 'grant-grant-1-deny').props.onPress(); });
        expect(onDecision.mock.calls).toEqual([['grant-1', 'always'], ['grant-1', 'once'], ['grant-1', 'deny']]);
    });

    it('holds every decision while one is sending', () => {
        const tree = render({ actionId: 'grant-1' });
        expect(tree.root.findAll((node: any) => node.type === 'Button').every((node: any) => node.props.disabled)).toBe(true);
    });

    it('settles into one quiet line naming who decided', () => {
        const settled = { ...message as any, grantRequest: { ...(message as any).grantRequest,
            grants: [{ ...grant, status: 'approved', decidedBy: { pubkey: OWNER, kind: 'human', name: 'Dan' }, decidedAt: 1793700000 }] } };
        const tree = render({ message: settled });
        expect(tree.root.findAll((node: any) => node.type === 'Button')).toHaveLength(0);
        expect(tree.root.find((node: any) => node.type === 'Card').props.backgroundColor).toBe('raised');
        const outcome = tree.root.find((node: any) => node.type === 'Text' && node.props.testID === 'grant-grant-1-outcome');
        expect(String(outcome.props.children)).toMatch(/^Always · Allowed by you · /);
        expect(tree.root.findAll((node: any) => node.type === 'Icon.Check')).toHaveLength(1);
    });

    it('shows another Room member a collapsed pill whose card opens without controls', () => {
        const other = 'c'.repeat(64);
        const request = (message as any).grantRequest;
        expect(canDecideGrantRequest(request, OWNER, false, false)).toBe(true);
        expect(canDecideGrantRequest(request, other, false, true)).toBe(false);
        let tree: any;
        act(() => {
            tree = create(<GrantRequestPill message={message}
                resolve={(id, name, kind) => ({ kind, seed: id, name })}
                card={<GrantRequestCard message={message} viewerIsAgent={false} viewerPubkey={other}
                    actionId={null} onDecision={() => undefined} />} />);
        });
        const pill = () => tree.root.find((node: any) => node.type === 'Button' && node.props.testID === 'system-pill');
        expect(tree.root.findAll((node: any) => node.props.testID === 'grant-grant-1')).toHaveLength(0);
        act(() => pill().props.onPress());
        expect(tree.root.findAll((node: any) => node.type === 'Button' && /^grant-grant-1-(always|once|deny)$/.test(node.props.testID))).toHaveLength(0);
        expect(tree.root.find((node: any) => node.type === 'Text' && node.props.testID === 'grant-grant-1-ask').props.children).toBe('@Alan wants to run a script');
    });
});
