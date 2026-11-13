import React, { useMemo } from 'react';
import { Card, Spinner, XStack, YStack } from 'tamagui';
import { Check, Workflow, X } from 'lucide-react-native';
import { identityHandle, type WorkflowRunDetailView } from '@beeline/api-contract/phone';
import { Copy, Glyph, T } from '@/ui/grammar';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import { observeRoomResource, useObservedResource } from '@/buzz/use-observed-resource';
import { useRoomWorkflowRun } from '@/buzz/use-room-workflow-run';
import { workflowDisplayName, workflowRunLine, workflowStateLabel, type WorkflowLineStatus, type WorkflowLineStep } from '@/buzz/workflow-graph';
import { workflowRunHeadline, workflowStarterLine, workflowStepAssignee, workflowStepMeta } from '@/buzz/workflow-run-copy';

/**
 * A live saved-workflow run in a thread (build spec decision 20): one card on
 * one rail. The run is today's `readWorkflowRun` read of the thread's live
 * run, refreshed by the Room's live events; it renders nothing when no run is
 * live.
 */
export function WorkflowRunCard({ roomId }: { roomId: string | undefined }) {
    const { workflow } = useRoomWorkflowRun(roomId);
    const { data: detail } = useObservedResource<WorkflowRunDetailView>(
        workflow ? `workflow-run:${workflow.roomId}:${workflow.runId}` : undefined,
        {
            load: () => monolithPhoneOperation('readWorkflowRun', { roomId: workflow!.roomId, runId: workflow!.runId }),
            subscribe: workflow ? observeRoomResource(workflow.roomId) : undefined,
        },
    );
    if (!workflow || !detail || detail.run.runId !== workflow.runId) return null;
    return <WorkflowRunCardView detail={detail} />;
}

type RailStep = { key: string; name: string; who?: string; note?: string; status: WorkflowLineStatus };

/** The rail's rows from the run: name, who holds it, and the note done and current steps carry. */
export function workflowRailSteps(detail: WorkflowRunDetailView): RailStep[] {
    const line: WorkflowLineStep[] = workflowRunLine(detail.contract, detail.history, detail.run.status);
    return line.map((step, index) => {
        const visit = step.visits[0];
        const assignee = workflowStepAssignee(step, detail);
        const meta = workflowStepMeta(step, { contract: detail.contract, run: detail.run, history: detail.history });
        const savedDoes = detail.contract.handoffs[step.state]?.does;
        const does = savedDoes?.includes('describe what this step does') ? undefined : savedDoes;
        const gate = visit?.gate;
        const gateLine = step.kind === 'gate'
            ? gate?.answer !== undefined
                ? `${gate.answer}${gate.answeredBy ? ` · ${gate.answeredBy.name}` : ''}`
                : step.status === 'current'
                    ? `Waiting on ${detail.run.viewerHolds ? 'you' : `a person in ${detail.run.roomName}`}`
                    : undefined
            : undefined;
        const note = step.status === 'pending'
            ? undefined
            : step.status === 'current'
                ? gateLine ?? visit?.liveOutput?.replace(/\s+/g, ' ').trim() ?? does
                : gateLine ?? visit?.finalReply?.text ?? does;
        return {
            key: step.visitId ?? `${step.state}-${index}`,
            name: workflowStateLabel(step.state),
            who: assignee ? `@${identityHandle(assignee)}` : meta || undefined,
            note: note || undefined,
            status: step.status,
        };
    });
}

/** One run on one rail: done is a brass check, current a brass ring, not yet a hollow ring. */
export function WorkflowRunCardView({ detail }: { detail: WorkflowRunDetailView }) {
    const steps = useMemo(() => workflowRailSteps(detail), [detail]);
    const active = detail.run.status === 'live';
    const headline = workflowRunHeadline(detail.run);
    const starter = workflowStarterLine(detail.run);
    const name = workflowDisplayName(detail.run.workflowSlug);
    return (
        <Card backgroundColor="raised" borderWidth={1} borderColor="stroke" borderRadius="md" padding="3" gap="3"
            testID="workflow-run" aria-label={`Workflow ${name}: ${headline}`}>
            <XStack gap="2" alignItems="flex-start">
                <YStack paddingTop="0.5"><Glyph icon={Workflow} size={16} accent={active} /></YStack>
                <YStack flex={1} minWidth={0}>
                    <Copy strong>{name}</Copy>
                    <Copy small quiet testID="workflow-run-headline">{starter ? `${headline} · ${starter}` : headline}</Copy>
                </YStack>
                {active && headline === 'Running' ? <Spinner size="small" color="needsYou" /> : null}
            </XStack>
            <YStack>
                {steps.map((step, index) => {
                    const last = index === steps.length - 1;
                    return (
                        <XStack key={step.key} gap="3" alignItems="stretch" testID={`workflow-step-${step.status}`}>
                            <YStack width={20} alignItems="center">
                                <StepCircle status={step.status} />
                                {last ? null : (
                                    <YStack flex={1} width={2} backgroundColor={step.status === 'done' ? 'needsYou' : 'strongStroke'} />
                                )}
                            </YStack>
                            <YStack flex={1} minWidth={0} paddingBottom={last ? '0' : '3'}>
                                <T v={step.status === 'current' ? 'metaStrong' : 'meta'} color={step.status === 'pending' ? 'secondary' : 'ink'}>
                                    {step.name}
                                    {step.who ? <T v="meta" color="secondary">{` · ${step.who}`}</T> : null}
                                </T>
                                {step.note ? (
                                    <T v="meta" color={step.status === 'current' ? 'needsYou' : 'secondary'} numberOfLines={2}>{step.note}</T>
                                ) : null}
                            </YStack>
                        </XStack>
                    );
                })}
            </YStack>
        </Card>
    );
}

function StepCircle({ status }: { status: WorkflowLineStatus }) {
    if (status === 'done') {
        return (
            <YStack width={20} height={20} borderRadius="full" backgroundColor="needsYou" alignItems="center" justifyContent="center" testID="step-done">
                <Glyph icon={Check} size={14} color="primaryInk" />
            </YStack>
        );
    }
    if (status === 'current') {
        return (
            <YStack width={20} height={20} borderRadius="full" borderWidth={2} borderColor="needsYou" alignItems="center" justifyContent="center" testID="step-current">
                <YStack width={8} height={8} borderRadius="full" backgroundColor="needsYou" />
            </YStack>
        );
    }
    if (status === 'failed') {
        return (
            <YStack width={20} height={20} borderRadius="full" borderWidth={2} borderColor="removed" alignItems="center" justifyContent="center" testID="step-failed">
                <Glyph icon={X} size={14} color="removed" />
            </YStack>
        );
    }
    return <YStack width={20} height={20} borderRadius="full" borderWidth={2} borderColor="strongStroke" testID="step-pending" />;
}
