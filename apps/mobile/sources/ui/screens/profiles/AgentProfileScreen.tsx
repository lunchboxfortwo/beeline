import React, { useState } from 'react';
import { router } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { Card, Input, ScrollView, Separator, Switch, TextArea, XStack, YStack } from 'tamagui';
import { MessagesSquare, Pencil, Check } from 'lucide-react-native';
import { AGENT_NAME_MAX_LENGTH, type AgentDetailView } from '@beeline/buzz-client';
import { MCP_STARTER_ROUTINE, roomTitle, modelChoiceLabel, modelPickerChoiceLabel, type AgentModelConfigOption } from '@beeline/api-contract/phone';
import { IdentityMark } from '@/components/buzz/IdentityMark';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';
import { displayModel } from '@/buzz/model-display';
import { appErrorCopy } from '@/buzz/app-error-copy';
import { filterAgentModelOptions } from '@/buzz/agent-model-picker';
import { scheduleTitle, scheduleTrigger } from '@/buzz/scheduled-work';
import { useActiveCommunityId } from '@/buzz/use-active-community';
import { Btn, Copy, Glyph, HEIGHT, Row, Screen, Section, SheetFrame, SheetRow, T } from '@/ui/grammar';
import { useAgentProfile, type AgentProfile } from './useAgentProfile';
import { AgentUsage } from './AgentUsage';
import { AgentVoice } from './AgentVoice';
import { ChatRows, ProfileHead, accessCaption, yoloCaption, yoloSetByLine } from './ProfileParts';

type Axis = 'model' | 'effort';
const axisValue = (detail: AgentDetailView, kind: Axis, axis: AgentModelConfigOption | undefined) => kind === 'model'
    ? detail.runtimeSelection?.model ?? axis?.currentValue
    : detail.runtimeSelection?.effort ?? axis?.currentValue;

/** An agent's profile: face, owner, Message and Edit; soul, model, usage, voice, access, schedules and chats. */
export function AgentProfileScreen({ agentId, workspaceId, close, roomId }: { agentId: string; workspaceId?: string; close: () => void; roomId?: string }) {
    const active = useActiveCommunityId();
    const p = useAgentProfile(agentId, workspaceId ?? active ?? undefined, close, roomId);
    const detail = p.detail;
    return (
        <Screen title="Profile" back={p.close} testID="agent-profile">
            {p.loading ? <SurfaceGlyphLoader testID="agent-profile-loader" /> : null}
            {p.error ? <T v="meta" color="removed" testID="agent-profile-error">{p.error}</T> : null}
            {detail ? <AgentProfileBody p={p} detail={detail} /> : null}
        </Screen>
    );
}

function AgentProfileBody({ p, detail }: { p: AgentProfile; detail: AgentDetailView }) {
    const [expanded, setExpanded] = useState(false);
    const identity = detail.agent.identity;
    const handle = identity.handle ?? identity.name;
    const owner = detail.owner?.handle;
    return (
        <>
            <ProfileHead
                mark={<IdentityMark kind="agent" seed={identity.pubkey} name={identity.name} face={identity.face} avatarUrl={identity.avatar} size={72} />}
                title={`@${handle}`}
                line={owner ? `owned by @${owner}` : undefined}
                testID="agent-profile-head"
            />
            <XStack gap="2" flexWrap="wrap">
                <Btn kind="primary" minHeight={HEIGHT.control} label="Message" disabled={p.busy} onPress={p.message} testID="agent-profile-message">
                    <XStack gap="2" alignItems="center"><Glyph icon={MessagesSquare} size={16} color="primaryInk" /><T v="heading" color="primaryInk">Message</T></XStack>
                </Btn>
                {p.canEdit && !p.editing ? (
                    <Btn label="Edit" onPress={p.beginEdit} testID="edit-agent-soul">
                        <XStack gap="2" alignItems="center"><Glyph icon={Pencil} size={16} color="ink" /><T v="heading">Edit</T></XStack>
                    </Btn>
                ) : null}
            </XStack>
            {p.editing ? (
                <YStack gap="2">
                    <Copy small quiet>Agent name</Copy>
                    <Input minHeight={HEIGHT.control} value={p.nameDraft} onChangeText={p.setNameDraft} maxLength={AGENT_NAME_MAX_LENGTH}
                        disabled={p.working === 'save-agent-soul'} aria-label="Agent name" testID="agent-soul-name" />
                </YStack>
            ) : null}
            <Section title="Soul">
                <YStack paddingVertical="3" gap="2">
                    {p.editing ? (
                        <>
                            <Copy small quiet>Persona / instructions</Copy>
                            <TextArea minHeight={HEIGHT.sheetRow} rows={4} maxLength={1000} value={p.soulDraft} onChangeText={p.setSoulDraft}
                                placeholder="How this agent should work" aria-label="Persona / instructions" disabled={p.working === 'save-agent-soul'} testID="agent-soul-instructions" />
                        </>
                    ) : (
                        <>
                            <Copy numberOfLines={expanded ? undefined : 5} testID="agent-profile-soul">{p.soul || 'No soul has been set.'}</Copy>
                            {p.soul ? (
                                <Btn kind="quiet" alignSelf="flex-start" label={expanded ? 'Show less' : 'Read full soul'} onPress={() => setExpanded((value) => !value)}>
                                    <Copy small accent>{expanded ? 'Show less' : 'Read full soul'}</Copy>
                                </Btn>
                            ) : null}
                        </>
                    )}
                </YStack>
            </Section>
            {p.editing ? (
                <XStack gap="2">
                    <Btn label="Cancel" disabled={p.working === 'save-agent-soul'} onPress={p.cancelEdit} testID="cancel-agent-edit">Cancel</Btn>
                    <Btn kind="primary" minHeight={HEIGHT.control} label="Save" disabled={p.working === 'save-agent-soul'} onPress={p.saveEdit} testID="save-agent-soul">
                        {p.working === 'save-agent-soul' ? 'Saving…' : 'Save'}
                    </Btn>
                </XStack>
            ) : null}
            {detail.wake ? <AgentWake p={p} wake={detail.wake} /> : null}
            <ModelSection p={p} detail={detail} />
            {p.canEdit ? <AgentUsage key={identity.pubkey} usage={detail.usage} harness={detail.harness} onRefresh={p.refreshUsage} /> : null}
            <AgentVoice key={`${detail.workspaceId}:${identity.pubkey}:${p.voiceApi?.contextKey ?? ''}`} agentId={identity.pubkey}
                configVersion={detail.configVersion} handle={handle} canEdit={p.canEdit} api={p.voiceApi} />
            <Section title="Access">
                <Row label="Permission mode" value={detail.yolo?.enabled ? 'Yolo' : 'Ask first'} />
                <Row label="Answer scope" value={detail.access?.policy === 'everyone' ? 'Everyone' : 'Owner only'} last />
            </Section>
            {detail.schedules?.length ? (
                <Section title="Routines" testID="agent-schedules">
                    {detail.schedules.map((schedule, index) => {
                        const room = detail.rooms?.find((candidate) => candidate.id === schedule.roomId);
                        return (
                            <Row key={schedule.id} label={scheduleTitle(schedule)}
                                detail={[scheduleTrigger(schedule), room ? `in ${roomTitle(room.name) ?? room.name}` : undefined].filter(Boolean).join(' · ')}
                                onPress={() => router.push({ pathname: '/beeline/settings/schedule', params: { roomId: schedule.roomId, scheduleId: schedule.id } } as never)}
                                testID={`agent-schedule-${schedule.id}`} last={index === detail.schedules!.length - 1} />
                        );
                    })}
                </Section>
            ) : null}
            <ChatRows title="Chats" rooms={detail.rooms ?? []} />
            {p.canRemove && (p.editing || !p.canEdit) ? <AgentManagement p={p} detail={detail} /> : null}
        </>
    );
}

function ModelSection({ p, detail }: { p: AgentProfile; detail: AgentDetailView }) {
    const editable = p.editing && p.canEdit;
    const catalogAxis = (category: string) => detail.catalog.find((axis) => axis.category === category);
    const modelAxis = p.modelAxes.model ?? catalogAxis('model');
    const effortAxis = p.modelAxes.effort ?? detail.catalog.find((axis) => axis.category === 'thought_level' || axis.category === 'reasoning_effort');
    const model = axisValue(detail, 'model', modelAxis);
    const effort = axisValue(detail, 'effort', effortAxis);
    const modelLabel = model ? displayModel(modelChoiceLabel(modelAxis, model) ?? '') || '—' : 'Not available';
    const effortLabel = p.working === 'model-catalog' ? 'Refreshing…' : effortAxis?.options.find((option) => option.id === effort)?.name ?? effort ?? 'Not available';
    const unavailable = (kind: Axis) => detail.modelUnavailable === kind || detail.modelUnavailable === 'selection'
        ? <T v="metaStrong" color="removed" aria-label={`${kind} unavailable`} testID={`model-unavailable-${kind}`}>!</T> : undefined;
    const open = p.openModelAxis;
    const sheetAxis = open === 'model' ? p.modelAxes.model : open === 'effort' ? p.modelAxes.effort : undefined;
    const current = open && sheetAxis ? axisValue(detail, open, sheetAxis) : undefined;
    const choices = !sheetAxis ? [] : open === 'model' ? filterAgentModelOptions(sheetAxis.options, p.modelSearchQuery) : sheetAxis.options;
    return (
        <Section title="Model / difficulty">
            <Row label="Model" value={modelLabel} right={unavailable('model')} testID="model-axis-model"
                onPress={editable && !p.busy && p.modelAxes.model ? () => void p.toggleModelAxis('model', open === 'model', p.modelAxes.model) : undefined} />
            {p.modelAppliesNote === 'model' ? <Copy small quiet testID="model-applies-model">Applies at the next session</Copy> : null}
            {p.modelAxisError === 'model' ? <T v="meta" color="removed" testID="model-axis-error-model">Could not open these choices. Try again.</T> : null}
            <Row label="Thinking level" value={effortLabel} right={unavailable('effort')} testID="model-axis-effort" last={!p.modelAxes.fast}
                onPress={editable && !p.busy && (!effortAxis || effortAxis.options.some((choice) => choice.id !== 'off')) ? () => void p.toggleModelAxis('effort', open === 'effort', p.modelAxes.effort) : undefined} />
            {p.modelAppliesNote === 'effort' ? <Copy small quiet testID="model-applies-effort">Applies at the next session</Copy> : null}
            {p.modelAxisError === 'effort' ? (
                <T v="meta" color="removed" testID="model-axis-error-effort">
                    {p.modelAxes.effort ? 'Could not open these choices. Try again.'
                        : 'Could not load effort choices for this model. Make sure the agent is online, then try again or choose another model.'}
                </T>
            ) : null}
            {p.modelAxes.fast ? (
                <Row label="Fast mode" detail="Faster responses use more ChatGPT credits where available." testID="fast-mode-setting" last
                    right={<Switch checked={detail.fastMode === true} disabled={!editable || p.busy} aria-label="Fast mode"
                        onCheckedChange={(enabled: boolean) => void p.setFastMode(enabled)}><Switch.Thumb /></Switch>} />
            ) : null}
            <SheetFrame open={Boolean(open && sheetAxis)} close={p.closeModelAxis} title={open === 'model' ? 'Model' : 'Thinking level'} testID={`model-options-${open ?? 'model'}`}>
                {open === 'model' ? (
                    <Input minHeight={HEIGHT.control} value={p.modelSearchQuery} onChangeText={p.setModelSearchQuery} placeholder="Search models"
                        aria-label="Search models" autoCapitalize="none" autoCorrect={false} disabled={p.busy} testID="model-search-model" />
                ) : null}
                <ScrollView maxHeight={392}>
                    {choices.map((choice) => (
                        <SheetRow key={choice.id} icon={choice.id === current ? <Glyph icon={Check} accent /> : null}
                            label={open === 'model' && sheetAxis ? modelPickerChoiceLabel(sheetAxis, choice) : choice.name ?? choice.id}
                            onPress={() => { if (!p.busy && open) void p.setModelOption(open, choice.id); }} testID={`model-option-${open}-${choice.id}`} />
                    ))}
                </ScrollView>
            </SheetFrame>
        </Section>
    );
}

/** Edit mode's agent management (moved from Members): access, Yolo and removal. */
function AgentManagement({ p, detail }: { p: AgentProfile; detail: AgentDetailView }) {
    const name = detail.agent.identity.name;
    const setBy = detail.yolo ? yoloSetByLine(detail.yolo) : null;
    return (
        <YStack gap="3" testID="agent-management">
            {p.ownerByline ? <Copy small quiet testID="agent-owner">{p.ownerByline}</Copy> : null}
            {p.canEdit ? (
                <>
                    <Copy small quiet>Model, access and Yolo changes apply immediately.</Copy>
                    <Card backgroundColor="raised" borderWidth={1} borderColor="stroke" padding="3" gap="3">
                        <YStack gap="2" testID="agent-access">
                            <XStack gap="3" alignItems="center" minHeight={HEIGHT.control}>
                                <YStack flex={1}><Copy strong>Answers everyone</Copy></YStack>
                                <XStack>
                                    <Switch checked={detail.access?.policy === 'everyone'} disabled={!detail.access?.canChange || p.busy} aria-label="Answers everyone"
                                        onCheckedChange={(everyone: boolean) => void p.toggleAnswersEveryone(everyone)} testID="agent-access-switch"><Switch.Thumb /></Switch>
                                </XStack>
                            </XStack>
                            <Copy small quiet testID="agent-access-caption">{accessCaption(detail.access, name)}</Copy>
                            {p.accessError ? <T v="meta" color="removed" testID="agent-access-error">{p.accessError}</T> : null}
                        </YStack>
                        <Separator borderColor="stroke" />
                        <YStack gap="2" testID="agent-yolo">
                            <XStack gap="3" alignItems="center" minHeight={HEIGHT.control}>
                                <YStack flex={1}><T v="heading" color={detail.yolo?.enabled ? 'needsYou' : 'ink'}>Yolo</T></YStack>
                                <XStack>
                                    <Switch checked={detail.yolo?.enabled ?? false} disabled={!detail.yolo?.canChange || detail.yolo?.forcedOff || p.busy} aria-label="Yolo"
                                        onCheckedChange={(enabled: boolean) => void p.toggleYolo(enabled)} testID="agent-yolo-switch"><Switch.Thumb /></Switch>
                                </XStack>
                            </XStack>
                            <Copy small quiet testID="agent-yolo-caption">{yoloCaption(name, detail.yolo?.forcedOff)}</Copy>
                            {setBy ? <Copy small quiet testID="agent-yolo-set-by">{setBy}</Copy> : null}
                            {p.yoloError ? <T v="meta" color="removed" testID="agent-yolo-error">{p.yoloError}</T> : null}
                        </YStack>
                    </Card>
                </>
            ) : null}
            <Btn kind="destructive" label="Remove from Workspace" disabled={p.busy} onPress={() => void p.removeAgent()} testID="remove-agent">
                {p.working === 'remove-agent' ? 'Removing…' : 'Remove from Workspace'}
            </Btn>
        </YStack>
    );
}

/** An outside agent's wake: the starter instructions to paste and its webhook. */
function AgentWake({ p, wake }: { p: AgentProfile; wake: NonNullable<AgentDetailView['wake']> }) {
    const [open, setOpen] = useState(false);
    const [url, setUrl] = useState('');
    const [key, setKey] = useState('');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [copy, setCopy] = useState<'copied' | 'failed' | null>(null);
    const update = async (clear = false) => {
        if (saving) return;
        setSaving(true);
        setError(null);
        try {
            await p.saveWake(clear ? '' : url, clear ? undefined : key || undefined);
            setKey('');
            setOpen(false);
        } catch (caught) {
            setKey('');
            setError(appErrorCopy(caught));
        } finally { setSaving(false); }
    };
    return (
        <>
            <Section title="Starter instructions" testID="mcp-starter-routine">
                <Row label="Starter instructions"
                    detail={copy === 'failed' ? 'Could not copy. Try again or select the text below.' : 'Paste into this agent’s saved instructions or existing routine prompt.'}
                    right={<Btn label="Copy starter instructions" onPress={() => void Clipboard.setStringAsync(MCP_STARTER_ROUTINE).then(() => setCopy('copied'), () => setCopy('failed'))}>{copy === 'copied' ? 'Copied' : 'Copy'}</Btn>} />
                <YStack paddingVertical="3"><T v="code" testID="mcp-starter-routine-text">{MCP_STARTER_ROUTINE}</T></YStack>
            </Section>
            <Section title="Webhook">
                <Row label="Webhook URL" detail={error ?? wake.url ?? 'For bots that only run when called.'}
                    right={<Btn label={wake.url ? 'Replace' : 'Set'} disabled={saving} onPress={() => { setUrl(wake.url ?? ''); setKey(''); setOpen(true); }}>{wake.url ? 'Replace' : 'Set'}</Btn>} />
                <Row label="Auth token" value={wake.keySet ? 'Set' : 'Not set'} last={!open && !wake.url} testID="webhook-auth-token" />
                {open ? (
                    <YStack paddingVertical="3" gap="2">
                        <Input minHeight={HEIGHT.control} aria-label="Webhook URL" value={url} onChangeText={setUrl} autoCapitalize="none" autoCorrect={false} keyboardType="url" maxLength={2048} disabled={saving} />
                        <Input minHeight={HEIGHT.control} aria-label="Auth token" value={key} onChangeText={setKey} secureTextEntry autoCapitalize="none" autoCorrect={false}
                            autoComplete="off" placeholder={wake.keySet ? 'Set — enter a replacement' : 'Not set'} maxLength={512} disabled={saving} />
                        <XStack gap="2" justifyContent="flex-end">
                            <Btn kind="quiet" label="Cancel" disabled={saving} onPress={() => { setKey(''); setOpen(false); }}>Cancel</Btn>
                            <Btn kind="primary" minHeight={HEIGHT.control} label="Save" disabled={saving || !url.trim() || Boolean(wake.keySet && !key)} onPress={() => void update()}>{saving ? 'Saving…' : 'Save'}</Btn>
                        </XStack>
                    </YStack>
                ) : null}
                {open && wake.url ? <Separator borderColor="stroke" /> : null}
                {wake.url ? <Row label="Clear webhook" tone="removed" onPress={saving ? undefined : () => void update(true)} last testID="webhook-clear" /> : null}
            </Section>
        </>
    );
}
