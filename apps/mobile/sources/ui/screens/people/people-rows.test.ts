import { describe, expect, it } from 'vitest';
import type { AgentUsage } from '@beeline/api-contract/phone';
import { agentDetail, agentRow, limitLeft, limitWarning, newcomer, personRow } from './people-rows';

const VIEWER = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const AGENT = 'd'.repeat(64);
const usage = (patch: Partial<AgentUsage>): AgentUsage => ({ updatedAt: 1, windows: [], ...patch });

describe('agent rows', () => {
    it('names the owner and the model only', () => {
        expect(agentDetail({ owner: { pubkey: VIEWER, kind: 'human', name: 'Dan' }, model: 'claude-opus-4-5' }, VIEWER))
            .toMatch(/^Yours · /);
        expect(agentDetail({ owner: { pubkey: OTHER, kind: 'human', name: 'B', handle: 'bananaman614305' } }, VIEWER))
            .toBe('@bananaman614305’s');
        expect(agentDetail({}, VIEWER)).toBeUndefined();
    });

    it('warns in brass only when under 20% of the limit is left', () => {
        expect(limitWarning(usage({ windows: [{ rateLimitType: 'five_hour', status: 'allowed_warning', utilization: 0.92, updatedAt: 1 }] })))
            .toBe('8% of limit left');
        expect(limitWarning(usage({ windows: [{ rateLimitType: 'five_hour', status: 'allowed', utilization: 0.8, updatedAt: 1 }] })))
            .toBeUndefined();
        expect(limitWarning(usage({ free: { used: 95, limit: 100, resetsAt: 0 } }))).toBe('5% of limit left');
        expect(limitWarning(usage({ spend: { limit: 10, remaining: 1 } }))).toBe('10% of limit left');
        expect(limitWarning(usage({ spend: { rejected: true } }))).toBe('0% of limit left');
        expect(limitWarning(undefined)).toBeUndefined();
    });

    it('takes the tightest limit', () => {
        expect(limitLeft(usage({
            free: { used: 10, limit: 100, resetsAt: 0 },
            windows: [{ rateLimitType: 'seven_day', status: 'allowed', utilization: 0.95, updatedAt: 1 }],
        }))).toBeCloseTo(0.05);
    });

    it('builds an agent row with its role and warning', () => {
        const row = agentRow({
            identity: { pubkey: AGENT, kind: 'agent', name: 'Jimmy', handle: 'jimmy' }, role: 'member',
            owner: { pubkey: VIEWER, kind: 'human', name: 'Dan' },
            usage: usage({ windows: [{ rateLimitType: 'five_hour', status: 'allowed', utilization: 0.92, updatedAt: 1 }] }),
        }, VIEWER, 'Reviewer');
        expect(row).toMatchObject({ handle: '@jimmy', role: { label: 'Reviewer', accent: false }, detail: 'Yours', warn: '8% of limit left' });
    });
});

describe('person rows', () => {
    it('shows Owner and Admin in brass, Member quiet, and You on the viewer', () => {
        const me = personRow({ identity: { pubkey: VIEWER, kind: 'human', name: 'Dan', handle: 'lunchboxfortwo' }, role: 'owner' }, VIEWER);
        expect(me).toMatchObject({ handle: '@lunchboxfortwo', role: { label: 'Owner', accent: true }, detail: 'You' });
        const admin = personRow({ identity: { pubkey: OTHER, kind: 'human', name: 'bananaman614305', handle: 'bananaman614305' }, role: 'admin' }, VIEWER);
        expect(admin).toMatchObject({ role: { label: 'Admin', accent: true }, detail: undefined });
        const member = personRow({ identity: { pubkey: OTHER, kind: 'human', name: 'Kai Lee', handle: 'kai' }, role: 'member' }, VIEWER);
        expect(member).toMatchObject({ role: { label: 'Member', accent: false }, detail: 'Kai Lee' });
    });
});

describe('newcomer', () => {
    it('is the first agent that was not on the roster when the join line was shown', () => {
        const row = (id: string) => ({ id, kind: 'agent' as const, identity: { pubkey: id, kind: 'agent' as const, name: id }, handle: `@${id}` });
        expect(newcomer([row('a'), row('b')], new Set(['a', 'b']))).toBeUndefined();
        expect(newcomer([row('a'), row('c')], new Set(['a', 'b']))?.id).toBe('c');
        expect(newcomer([row('a')], null)).toBeUndefined();
    });
});
