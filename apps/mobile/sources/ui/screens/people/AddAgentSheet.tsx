import type { AgentInvitationPickerGuide } from '@beeline/api-contract/phone';
import { useEffect, useState } from 'react';
import { Image, Separator, Spinner, XStack, YStack } from 'tamagui';
import { Globe, Terminal } from 'lucide-react-native';
import { Btn, Copy, CopyLine, Glyph, SheetFrame, SheetRow, T } from '@/ui/grammar';
import { appErrorCopy } from '@/buzz/app-error-copy';
import { agentPairingCommand } from '@/buzz/agent-pairing-command';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import { openExternalUrl } from '@/utils/open-external-url';
import { HARNESSES } from './harnesses';
import { Face, copyText } from './PeopleParts';
import { newcomer, type PeopleRow } from './people-rows';

type Step = 'root' | 'external' | 'create';

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
 * People tab Agents +: Invite an external agent (the server's one copyable
 * prompt, four marks and its full-list link) or Create a new agent (`npx usebeeline connect …` from
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
    const waiting = step === 'create';

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
            : 'Create a new agent';
    const back = step === 'root' ? undefined : () => setStep('root');
    const listUrl = invitationGuide?.listUrl;

    return (
        <SheetFrame open={open} close={shut} title={title} back={back} testID={`sheet-add-agent-${step}`}>
            {step === 'root' ? (
                <>
                    <SheetRow testID="agent-external" icon={<Glyph icon={Globe} />} label="Invite an external agent" detail="Claude Code, Codex, Gemini CLI and others you already use" onPress={() => setStep('external')} chevron />
                    <Separator borderColor="stroke" />
                    <SheetRow testID="agent-create" icon={<Glyph icon={Terminal} />} label="Create a new agent" detail="Run one command where the agent will work" onPress={() => setStep('create')} chevron />
                </>
            ) : step === 'external' ? (
                <YStack gap="3">
                    {invitationGuide?.prompt ? <CopyLine line={invitationGuide.prompt} label="Copy invite prompt" onCopy={copyText} />
                        : error ? <Copy small quiet role="alert">{error}</Copy> : null}
                    <XStack alignItems="center" justifyContent="space-between" gap="3">
                        <XStack gap="2" alignItems="center">
                            {/* `src`, not the deprecated `source` the web Image drops; it takes a bundled asset though typed as a URL. */}
                            {HARNESSES.map((h) => <Image key={h.id} src={h.logo as unknown as string} width={24} height={24} borderRadius="sm" aria-label={`${h.name} logo`} />)}
                        </XStack>
                        {listUrl ? (
                            <Btn kind="quiet" label="Full list of agents" accessibilityRole="link" testID="agent-full-list" onPress={() => void openExternalUrl(listUrl).catch(() => undefined)}>
                                <T v="metaStrong" color="secondary">Full list of agents</T>
                            </Btn>
                        ) : null}
                    </XStack>
                    <Copy small quiet>Not the regular ChatGPT or Claude chat apps</Copy>
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
