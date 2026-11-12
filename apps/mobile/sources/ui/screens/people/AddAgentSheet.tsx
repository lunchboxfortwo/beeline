import type { AgentInvitationPickerGuide } from '@beeline/api-contract/phone';
import React, { useEffect, useState } from 'react';
import { Image, Separator, Spinner, XStack, YStack } from 'tamagui';
import { Globe, Terminal } from 'lucide-react-native';
import { Btn, Copy, CopyLine, Glyph, SheetFrame, SheetRow } from '@/ui/grammar';
import { appErrorCopy } from '@/buzz/app-error-copy';
import { agentPairingCommand } from '@/buzz/agent-pairing-command';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import { HARNESSES } from './harnesses';
import { Face, copyText } from './PeopleParts';
import { newcomer, type PeopleRow } from './people-rows';

type Step = 'root' | 'external' | 'create' | { harness: string };

function Waiting({ joined, where }: { joined: PeopleRow | undefined; where: string }) {
    return joined ? (
        <XStack gap="3" alignItems="center" role="status" testID="external-joined">
            <Face row={joined} />
            <YStack flex={1} minWidth={0}>
                <Copy strong>{`${joined.handle} joined ${where}`}</Copy>
                {joined.detail ? <Copy small quiet>{joined.detail}</Copy> : null}
            </YStack>
        </XStack>
    ) : (
        <XStack gap="2" alignItems="center" role="status" testID="external-waiting">
            <Spinner size="small" color="needsYou" />
            <Copy small quiet>Waiting for the agent to join. You can close this; it appears when it joins.</Copy>
        </XStack>
    );
}

/**
 * People tab Agents +: Invite an external agent (today's harness list, each
 * with its join line) or Create a new agent (`npx usebeeline connect …` from
 * `createAgentPairingCode`). The joined line comes from the live roster.
 */
export function AddAgentSheet({ open, close, workspaceId, workspaceName, agents }: {
    open: boolean; close: () => void; workspaceId: string; workspaceName: string; agents: readonly PeopleRow[];
}) {
    const [step, setStep] = useState<Step>('root');
    const [known, setKnown] = useState<ReadonlySet<string> | null>(null);
    const [invitationGuide, setInvitationGuide] = useState<AgentInvitationPickerGuide | null>(null);
    const [command, setCommand] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const harness = typeof step === 'object' ? HARNESSES.find((h) => h.id === step.harness) : undefined;
    const waiting = step === 'create' || Boolean(harness);

    useEffect(() => {
        if (!waiting) { setKnown(null); return; }
        setKnown((current) => current ?? new Set(agents.map((agent) => agent.id)));
    }, [waiting, agents]);

    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        setCommand(null);
        setInvitationGuide(null);
        setError(null);
        void monolithPhoneOperation('createAgentPairingCode', { workspaceId })
            .then((pairing) => { if (!cancelled) { setCommand(agentPairingCommand(pairing.code)); setInvitationGuide(pairing.invitationGuide ?? null); } })
            .catch((reason) => { if (!cancelled) setError(appErrorCopy(reason, 'Could not create agent invite.')); });
        return () => { cancelled = true; };
    }, [open, workspaceId]);

    const shut = () => { setStep('root'); setKnown(null); setCommand(null); setError(null); close(); };
    const joined = newcomer(agents, known);
    const title = step === 'root' ? 'Add an agent'
        : step === 'external' ? 'Invite an external agent'
            : step === 'create' ? 'Create a new agent'
                : `Invite ${harness?.name ?? ''}`;
    const back = step === 'root' ? undefined : harness ? () => setStep('external') : () => setStep('root');

    return (
        <SheetFrame open={open} close={shut} title={title} back={back} testID={`sheet-add-agent-${harness ? 'harness' : step}`}>
            {step === 'root' ? (
                <>
                    <SheetRow testID="agent-external" icon={<Glyph icon={Globe} />} label="Invite an external agent" detail="Claude, Codex, Gemini and others you already use" onPress={() => setStep('external')} chevron />
                    <Separator borderColor="stroke" />
                    <SheetRow testID="agent-create" icon={<Glyph icon={Terminal} />} label="Create a new agent" detail="Run one command where the agent will work" onPress={() => setStep('create')} chevron />
                </>
            ) : step === 'external' ? (
                <YStack>
                    {HARNESSES.map((h, index) => (
                        <React.Fragment key={h.id}>
                            <SheetRow
                                testID={`harness-${h.id}`}
                                icon={<Image source={h.logo} width={24} height={24} borderRadius="sm" aria-label={`${h.name} logo`} />}
                                label={h.name}
                                onPress={() => setStep({ harness: h.id })}
                                chevron
                            />
                            {index < HARNESSES.length - 1 ? <Separator borderColor="stroke" /> : null}
                        </React.Fragment>
                    ))}
                </YStack>
            ) : harness ? (
                <YStack gap="3">
                    <Copy>{`Follow these steps for ${harness.name}.`}</Copy>
                    {invitationGuide?.lines[harness.id] ? <CopyLine line={invitationGuide.lines[harness.id]} label={`Copy ${harness.name} join line`} onCopy={copyText} /> : <Copy>Ask a Beeline agent for current setup steps.</Copy>}
                    <Waiting joined={joined} where={workspaceName} />
                    <Btn kind="primary" label="Done" onPress={shut}>Done</Btn>
                </YStack>
            ) : (
                <YStack gap="3">
                    <Copy>{`Run this on your computer with a signed-in agent CLI (Claude Code, Cursor or Goose). It sets the agent up and adds it to ${workspaceName}.`}</Copy>
                    {command ? <CopyLine line={command} label="Copy connect command" onCopy={copyText} /> : null}
                    {error ? <Copy small quiet role="alert">{error}</Copy> : <Waiting joined={joined} where={workspaceName} />}
                    <Btn kind="primary" label="Done" onPress={shut}>Done</Btn>
                </YStack>
            )}
        </SheetFrame>
    );
}
