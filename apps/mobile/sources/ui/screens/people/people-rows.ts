import type { AgentUsage, RoomViewIdentity, RoomViewMember, WorkspaceAgentView } from '@beeline/api-contract/phone';
import { fallbackMemberHandle } from '@/buzz/member-display';
import { displayModel } from '@/buzz/model-display';

/** A person or agent as the People tab and chat Members list them. */
export type PeopleRow = {
    readonly id: string;
    readonly kind: 'human' | 'agent';
    readonly identity: RoomViewIdentity;
    /** `@handle`, the row's first line. */
    readonly handle: string;
    /** Owner/Admin in brass, Member quiet; agents carry none (or Reviewer in a chat). */
    readonly role?: { readonly label: string; readonly accent: boolean };
    /** The quiet second line. */
    readonly detail?: string;
    /** Brass tail on the second line: an owner's agent at most 20% of its limit. */
    readonly warn?: string;
};

export function handleOf(identity: Pick<RoomViewIdentity, 'handle' | 'pubkey'>): string {
    return `@${identity.handle ?? fallbackMemberHandle(identity.pubkey)}`;
}

const ROLE: Record<RoomViewMember['role'], string> = {
    owner: 'Owner', admin: 'Admin', member: 'Member', spectator: 'Member',
};

/**
 * The share of an owner's agent limit still left, 0–1: the tightest of its
 * free allowance, key spend and plan windows. Absent when there is no limit
 * to read (other viewers never receive usage).
 */
export function limitLeft(usage: AgentUsage | undefined): number | undefined {
    if (!usage) return undefined;
    const lefts: number[] = [];
    if (usage.free) lefts.push(usage.free.paused ? 0 : 1 - usage.free.used / usage.free.limit);
    if (usage.spend) {
        if (usage.spend.rejected) lefts.push(0);
        else if (usage.spend.limit) lefts.push((usage.spend.remaining ?? 0) / usage.spend.limit);
    }
    for (const window of usage.windows) {
        if (window.status === 'rejected') lefts.push(0);
        else if (window.utilization !== undefined) lefts.push(1 - window.utilization);
    }
    if (!lefts.length) return undefined;
    return Math.max(0, Math.min(1, ...lefts));
}

/** “· 8% of limit left”, only when at most 20% is left. */
export function limitWarning(usage: AgentUsage | undefined): string | undefined {
    const left = limitLeft(usage);
    if (left === undefined) return undefined;
    // Whole percent first, so 1 − 0.8 reads as 20, not 19.999….
    const percent = Math.round(left * 100);
    return left <= 0.2 + 1e-9 ? `${percent}% of limit left` : undefined;
}

/** An agent's second line: its owner and model only (“Yours · Claude Opus 5.5”). */
export function agentDetail(
    agent: { readonly owner?: RoomViewIdentity; readonly model?: string },
    viewerPubkey: string | undefined,
): string | undefined {
    const owner = agent.owner
        ? agent.owner.pubkey === viewerPubkey ? 'Yours' : `${handleOf(agent.owner)}’s`
        : undefined;
    const model = agent.model ? displayModel(agent.model) : undefined;
    return [owner, model].filter(Boolean).join(' · ') || undefined;
}

/** A workspace person: the role on the right, “You” on the viewer's own row. */
export function personRow(member: RoomViewMember, viewerPubkey: string | undefined): PeopleRow {
    const label = ROLE[member.role];
    const you = member.identity.pubkey === viewerPubkey;
    const handle = handleOf(member.identity);
    const name = member.identity.name.trim();
    return {
        id: member.identity.pubkey,
        kind: 'human',
        identity: member.identity,
        handle,
        role: { label, accent: member.role === 'owner' || member.role === 'admin' },
        detail: you ? 'You' : name && `@${name}` !== handle ? name : undefined,
    };
}

/** A workspace agent: owner and model, plus the owner-only limit warning. */
export function agentRow(
    agent: RoomViewMember & Partial<Pick<WorkspaceAgentView, 'owner' | 'usage'>>,
    viewerPubkey: string | undefined,
    role?: string,
): PeopleRow {
    return {
        id: agent.identity.pubkey,
        kind: 'agent',
        identity: agent.identity,
        handle: handleOf(agent.identity),
        ...(role ? { role: { label: role, accent: false } } : {}),
        detail: agentDetail(agent, viewerPubkey),
        warn: limitWarning(agent.usage),
    };
}

/** The first workspace agent that was not there when the join line was shown. */
export function newcomer(agents: readonly PeopleRow[], known: ReadonlySet<string> | null): PeopleRow | undefined {
    return known ? agents.find((agent) => !known.has(agent.id)) : undefined;
}
