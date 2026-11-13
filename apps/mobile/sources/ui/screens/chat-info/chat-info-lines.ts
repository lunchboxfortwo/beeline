import { cornerShortTitle, type RoomScheduleView, type RoomSubscriptionView } from '@beeline/api-contract/phone';
import { scheduleTitle, scheduleTrigger, subscriptionTitle, subscriptionWhen } from '@/buzz/scheduled-work';
import { workflowDisplayName } from '@/buzz/workflow-graph';

/** The quiet line under the chat's name. */
export function chatKindLine(visibility: 'public' | 'invite-only' | undefined, workspaceName: string, members: number): string {
    const count = `${members} ${members === 1 ? 'member' : 'members'}`;
    if (visibility === 'public') return `Public · anyone in ${workspaceName} can join · ${count}`;
    if (visibility === 'invite-only') return `Private · ${count}`;
    return count;
}

/** Who or what each firing runs: the workflow by name, otherwise the agent. */
function runs(work: { readonly workflowSlug?: string; readonly agentId: string }, agentNames: ReadonlyMap<string, string>): string {
    return work.workflowSlug
        ? `runs the workflow ${workflowDisplayName(work.workflowSlug)}`
        : `@${agentNames.get(work.agentId) ?? 'agent'}`;
}

function where(work: { readonly corner?: { readonly id: string; readonly name: string } }, roomName: string | null): string {
    return work.corner ? `thread ${cornerShortTitle(roomName, work.corner.name, work.corner.id)}` : 'this chat';
}

type ScheduledRow = { readonly id: string; readonly kind: 'schedule' | 'subscription'; readonly label: string; readonly detail: string };

/** Schedules first (by next run), then subscriptions; each names the workflow it runs. */
export function scheduledRows(work: {
    readonly roomName: string | null;
    readonly agentNames: ReadonlyMap<string, string>;
    readonly schedules: readonly RoomScheduleView[];
    readonly subscriptions: readonly RoomSubscriptionView[];
}): ScheduledRow[] {
    const schedules = [...work.schedules].sort((a, b) => a.nextRunAt - b.nextRunAt).map((schedule) => ({
        id: schedule.id,
        kind: 'schedule' as const,
        label: scheduleTitle(schedule),
        detail: [scheduleTrigger(schedule), runs(schedule, work.agentNames), where(schedule, work.roomName)].join(' · '),
    }));
    const subscriptions = work.subscriptions.map((subscription) => ({
        id: subscription.id,
        kind: 'subscription' as const,
        label: subscriptionTitle(subscription),
        detail: ['Subscription', runs(subscription, work.agentNames), subscriptionWhen(subscription)].join(' · '),
    }));
    return [...schedules, ...subscriptions];
}

/** “done · Today”, “done · Yesterday”, else the date. */
export function finishedWhen(closedAt: number | undefined, now = new Date()): string {
    if (!closedAt) return 'done';
    const at = new Date(closedAt * 1000);
    const day = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const label = day(at) === day(now) ? 'Today'
        : day(at) === day(yesterday) ? 'Yesterday'
            : new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(at);
    return `done · ${label}`;
}
