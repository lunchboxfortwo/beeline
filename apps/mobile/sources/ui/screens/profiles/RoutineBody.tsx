import React from 'react';
import { router } from 'expo-router';
import { YStack, XStack } from 'tamagui';
import { Workflow, CornerDownRight } from 'lucide-react-native';
import { cornerShortTitle, roomTitle, type RoomScheduleView, type RoomSubscriptionView } from '@beeline/api-contract/phone';
import { scheduleTitle, scheduleTrigger, subscriptionTitle, subscriptionWhen, type ScheduledWork } from '@/buzz/scheduled-work';
import { Copy, Glyph, Row, Section } from '@/ui/grammar';
import { openPlace } from '@/ui/shell/panel';
import { useIsDesktop } from '@/utils/responsive';
import { ProfileHead } from './ProfileParts';

/** The approved profile anatomy, shared by timers and event routines. */
export function RoutineBody({ routine, kind, work, stop }: {
    routine: RoomScheduleView | RoomSubscriptionView;
    kind: 'schedule' | 'subscription';
    work: ScheduledWork;
    stop: React.ReactNode;
}) {
    const desktop = useIsDesktop();
    const schedule = kind === 'schedule' ? routine as RoomScheduleView : undefined;
    const subscription = kind === 'subscription' ? routine as RoomSubscriptionView : undefined;
    const title = schedule ? scheduleTitle(schedule) : subscriptionTitle(subscription!);
    const trigger = schedule ? scheduleTrigger({ ...schedule, paused: false })
        : subscriptionWhen({ ...subscription!, paused: false }, work.isDirectMessage);
    const agent = work.agentNames.get(routine.agentId) ?? 'Agent';
    const chat = work.isDirectMessage ? 'DM' : roomTitle(work.roomName) ?? 'Chat';
    const destination = routine.corner ? cornerShortTitle(work.roomName, routine.corner.name, routine.corner.id) : chat;
    const date = (at: number, next = false) => new Intl.DateTimeFormat('en-US', {
        weekday: next ? 'short' : undefined, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    }).format(new Date(at * 1000));
    const runs = work.recentRuns?.filter(run => run.routineId === routine.id) ?? [];
    return <YStack padding="4" gap="5">
        <ProfileHead mark={<YStack width={72} height={72} borderRadius="sm" backgroundColor="highlight" alignItems="center" justifyContent="center">
            <Glyph icon={Workflow} size={20} />
        </YStack>} title={title}
            line={`@${agent} · ${routine.paused ? 'Paused' : trigger} · posts ${routine.corner ? 'in a thread' : `in ${chat}`}`} testID="routine-identity" />
        <XStack>{stop}</XStack>
        <Section title="What it does">
            <YStack paddingVertical="3"><Copy testID="scheduled-work-prompt">{schedule ? schedule.message : subscription?.prompt ?? 'React to this event.'}</Copy></YStack>
        </Section>
        <Section title="When it runs">
            <Row label={schedule ? 'Schedule' : 'Trigger'} detail={trigger} testID="scheduled-work-facts-when" />
            <Row label="Next run" detail={routine.paused ? 'No next run while paused' : schedule ? date(schedule.nextRunAt, true)
                : `When a matching ${subscription?.event.startsWith('issue.') ? 'issue' : 'event'} arrives`} last={!routine.paused} />
            {routine.paused ? <Row label="Paused while you were away" last testID="routine-paused" /> : null}
        </Section>
        <Section title="Where it posts">
            <Row label={destination} detail={routine.corner ? `Thread in ${chat}` : 'Chat'}
                icon={routine.corner ? CornerDownRight : undefined} last testID="routine-destination"
                onPress={() => router.push({ pathname: '/beeline/chat/[channelId]', params: { channelId: routine.roomId } })} />
        </Section>
        <Section title="Agent">
            <Row label={`@${agent}`} detail="Runs this routine" last testID="routine-agent"
                onPress={() => openPlace({ kind: 'agent', agentId: routine.agentId,
                    workspaceId: schedule?.workspaceId }, desktop)} />
        </Section>
        <Section title="Recent runs">
            {runs.length ? runs.map((run, index) => <Row key={run.messageId} label={run.text} detail={date(run.at)}
                testID={`routine-run-${run.messageId}`} last={index === runs.length - 1}
                onPress={() => router.push({ pathname: '/beeline/chat/[channelId]',
                    params: { channelId: run.roomId, jumpTo: run.messageId } })} />)
                : <Row label="No runs yet" last />}
        </Section>
    </YStack>;
}
