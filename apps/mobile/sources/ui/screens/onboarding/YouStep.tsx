import React, { useEffect, useState } from 'react';
import { Input, ListItem, XStack, YStack } from 'tamagui';
import { normalizeManagedHandle } from '@beeline/buzz-client';
import type { ManagedIdentityResult } from '@beeline/api-contract/phone';
import { Btn, T } from '@/ui/grammar';
import { IdentityMark } from '@/components/buzz/IdentityMark';
import { appErrorCopy } from '@/buzz/app-error-copy';
import { pickAndUploadAvatar } from '@/buzz/avatar-upload';
import { publishManagedIdentity, readManagedIdentity } from '@/buzz/managed-identity-surface';
import { clearPersonNameOnboardingPending, savePreferredPersonName } from '@/buzz/person-name';
import { loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { BuzzRigTransport } from '@/sync/transport';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import { OnboardingFrame, Primary, Problem } from './OnboardingFrame';
import { Rise } from './Rise';

const HANDLE_RULE = 'Use 3–30 lowercase letters, numbers, or dashes.';
const PROVIDER_LABEL = { github: 'GitHub', google: 'Google' } as const;

/**
 * "You are @handle": the name, managed handle and picture a person enters
 * Beeline with, prefilled from the account they signed in with. The handle
 * goes through today's managed claim; name and picture through
 * `updatePersonProfile`. The picture is the generated first-initial mark
 * unless the account's photo or an uploaded one is kept.
 */
export function YouStep({ onDone, back }: { onDone: () => void; back?: () => void }) {
    const [current, setCurrent] = useState<ManagedIdentityResult | null>(null);
    const [handle, setHandle] = useState('');
    const [name, setName] = useState('');
    const [avatar, setAvatar] = useState('');
    const [busy, setBusy] = useState<'save' | 'picture' | null>(null);
    const [problem, setProblem] = useState<{ title?: string; message: string } | null>(null);

    useEffect(() => {
        let cancelled = false;
        void readManagedIdentity().then((identity) => {
            if (cancelled) return;
            setCurrent(identity);
            setHandle(identity.handle ?? '');
            setName(identity.name);
            setAvatar(identity.avatar ?? '');
        }).catch(() => undefined);
        return () => { cancelled = true; };
    }, []);

    const normalized = normalizeManagedHandle(handle);
    const provider = current?.providers?.[0]?.provider;
    const showRule = handle.length > 0 && !normalized;

    const choosePicture = async () => {
        if (busy) return;
        setBusy('picture');
        setProblem(null);
        try {
            const identity = await loadBuzzIdentity();
            if (!identity) return;
            const url = await pickAndUploadAvatar(await new BuzzRigTransport(identity).ensureClient());
            if (url) setAvatar(url);
        } catch (error) {
            setProblem({ message: appErrorCopy(error) });
        } finally {
            setBusy(null);
        }
    };

    const save = async () => {
        if (busy) return;
        if (!normalized) {
            setProblem({ title: 'HANDLE NOT AVAILABLE', message: HANDLE_RULE });
            return;
        }
        setBusy('save');
        setProblem(null);
        try {
            let base = current;
            if (normalized !== base?.handle) {
                try {
                    base = await monolithPhoneOperation('claimManagedHandle', { handle: normalized });
                } catch (error) {
                    const taken = error instanceof Error && /already claimed/i.test(error.message);
                    setProblem(taken
                        ? { title: 'HANDLE ALREADY CLAIMED', message: `@${normalized} belongs to someone else. Choose another handle.` }
                        : { title: 'HANDLE NOT CLAIMED', message: appErrorCopy(error) });
                    return;
                }
                // The claim answers the whole identity: it is the new baseline.
                setCurrent(base);
                await publishManagedIdentity(base).catch(() => undefined);
            }
            const trimmed = name.trim();
            const profile = {
                ...(trimmed && trimmed !== base?.name ? { name: trimmed } : {}),
                // An empty picture clears a kept photo back to the generated mark.
                ...(avatar !== (base?.avatar ?? '') ? { avatar } : {}),
            };
            if (Object.keys(profile).length > 0) {
                await monolithPhoneOperation('updatePersonProfile', profile);
                await monolithPhoneOperation('getManagedIdentity', {}).then(publishManagedIdentity).catch(() => undefined);
            }
            const identity = await loadBuzzIdentity().catch(() => null);
            if (identity && trimmed) await savePreferredPersonName(identity.publicKey, trimmed).catch(() => undefined);
            await clearPersonNameOnboardingPending().catch(() => undefined);
            onDone();
        } catch (error) {
            setProblem({ message: appErrorCopy(error) });
        } finally {
            setBusy(null);
        }
    };

    return (
        <OnboardingFrame
            stage={1}
            back={back}
            testID="onboarding-you"
            footer={<Primary label="Continue" disabled={!normalized} busy={busy === 'save'} onPress={() => void save()} testID="you-continue" />}
        >
            <Rise order={1}>
                <YStack alignItems="center" gap="3" paddingTop="4">
                    <T v="metaStrong" color="secondary">You are</T>
                    <ListItem
                        padding="1" borderRadius="md" borderWidth={2} borderColor="needsYou" backgroundColor="transparent"
                        onPress={() => void choosePicture()} accessibilityRole="button"
                        aria-label={avatar ? 'Your photo. Tap to change it' : 'Your generated mark. Tap to upload a photo'}
                        testID="you-picture"
                    >
                        <IdentityMark kind="human" seed={normalized ?? current?.personId ?? 'you'} name={name.trim() || normalized || 'you'} avatarUrl={avatar || undefined} size={104} />
                    </ListItem>
                    {avatar
                        ? <Btn kind="quiet" label="Use generated mark" onPress={() => setAvatar('')} testID="you-generated-mark"><T v="metaStrong" color="secondary">Use generated mark</T></Btn>
                        : <Btn kind="quiet" label="Upload photo" onPress={() => void choosePicture()} testID="you-upload"><T v="metaStrong" color="secondary">Upload photo</T></Btn>}
                </YStack>
            </Rise>
            <Rise order={2}>
                <YStack gap="4">
                    <YStack gap="2">
                        <XStack alignItems="center" gap="2">
                            <T v="title" color="secondary">@</T>
                            <Input
                                flex={1} minWidth={0} borderColor={showRule ? 'removed' : 'strongStroke'}
                                aria-label="Your handle" accessibilityLabel="Your handle" testID="you-handle"
                                value={handle} onChangeText={(value: string) => setHandle(value.toLowerCase())}
                                autoCapitalize="none" autoCorrect={false} maxLength={30}
                                onSubmitEditing={() => void save()} returnKeyType="done"
                            />
                        </XStack>
                        <T v="meta" color={showRule ? 'removed' : 'secondary'}>
                            {showRule ? HANDLE_RULE : provider
                                ? `From your ${PROVIDER_LABEL[provider]} account. Tap to change it; it becomes your verified Beeline identity.`
                                : 'This name is bound to your key. It becomes your verified Beeline identity everywhere.'}
                        </T>
                    </YStack>
                    <YStack gap="2">
                        <T v="metaStrong" color="secondary">Name</T>
                        <Input
                            borderColor="strongStroke" aria-label="Your name" accessibilityLabel="Your name" testID="you-name"
                            value={name} onChangeText={setName} maxLength={60}
                        />
                    </YStack>
                    {problem ? <Problem title={problem.title} message={problem.message} testID="you-problem" /> : null}
                </YStack>
            </Rise>
        </OnboardingFrame>
    );
}
