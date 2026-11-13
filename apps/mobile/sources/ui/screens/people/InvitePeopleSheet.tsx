import React, { useEffect, useState } from 'react';
import { Share } from 'react-native';
import { Input, Separator, XStack, YStack } from 'tamagui';
import { Check, Link as LinkIcon, Mail, Share2 } from 'lucide-react-native';
import { Btn, Copy, Glyph, HEIGHT, SheetFrame, SheetRow } from '@/ui/grammar';
import { appErrorCopy } from '@/buzz/app-error-copy';
import { buildCommunityInviteUrl, resolveCommunityInvitePublicOrigin } from '@/buzz/community-invite';
import { getBuzzRuntimeConfig } from '@/buzz/runtime-config';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import { copyText } from './PeopleParts';

const INVITE_FAILED = 'Could not create person invite.';
const looksLikeEmail = (value: string) => /.+@.+\..+/.test(value.trim());

/**
 * People +: Copy invite link (today's `createInvite`) and Invite by email
 * (the server's `inviteByEmail`). That is all (build spec, decision 6).
 */
export function InvitePeopleSheet({ open, close, workspaceId, workspaceName, roomId, roomTag }: {
    open: boolean; close: () => void; workspaceId: string; workspaceName: string; roomId?: string; roomTag?: string;
}) {
    const [link, setLink] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const [emailOpen, setEmailOpen] = useState(false);
    const [address, setAddress] = useState('');
    const [sending, setSending] = useState(false);
    const [sent, setSent] = useState('');
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        setLink(null);
        void monolithPhoneOperation('createInvite', { workspaceId })
            .then((invite) => {
                if (!cancelled) setLink(buildCommunityInviteUrl(invite.token, resolveCommunityInvitePublicOrigin(getBuzzRuntimeConfig())));
            })
            .catch((reason) => { if (!cancelled) setError(appErrorCopy(reason, INVITE_FAILED)); });
        return () => { cancelled = true; };
    }, [open, workspaceId]);

    const shut = () => {
        setCopied(false); setEmailOpen(false); setAddress(''); setSent(''); setError(null);
        close();
    };
    const copyLink = async () => {
        if (!link) return;
        await copyText(link);
        setCopied(true);
    };
    const send = async () => {
        const email = address.trim();
        if (!looksLikeEmail(email) || sending) return;
        setSending(true);
        setError(null);
        try {
            await monolithPhoneOperation('inviteByEmail', { workspaceId, email, ...(roomId ? { roomId } : {}) });
            setSent(email);
            setAddress('');
        } catch (reason) {
            setError(appErrorCopy(reason, INVITE_FAILED));
        } finally {
            setSending(false);
        }
    };
    const where = roomTag ? ` and ${roomTag}` : '';

    return (
        <SheetFrame open={open} close={shut} title="Invite people" testID="sheet-invite-people">
            <SheetRow
                testID="invite-copy-link"
                icon={copied ? <Glyph icon={Check} accent /> : <Glyph icon={LinkIcon} />}
                label={copied ? 'Link copied' : 'Copy link'}
                detail={`joins ${workspaceName}${where}`}
                onPress={() => void copyLink()}
            />
            <SheetRow testID="invite-share-link" icon={<Glyph icon={Share2} />} label="Share"
                onPress={() => { if (link) void Share.share({ message: link }); }} />
            <Separator borderColor="stroke" />
            {emailOpen ? (
                <YStack gap="2" paddingVertical="2" testID="invite-email-form">
                    <XStack gap="3" alignItems="center">
                        <YStack width={28} alignItems="center"><Glyph icon={Mail} /></YStack>
                        <Copy>Invite by email</Copy>
                    </XStack>
                    <XStack gap="2" paddingLeft="8">
                        <Input
                            flex={1}
                            minHeight={HEIGHT.control}
                            autoFocus
                            autoCapitalize="none"
                            autoCorrect={false}
                            keyboardType="email-address"
                            aria-label="Email address"
                            placeholder="name@example.com"
                            value={address}
                            onChangeText={setAddress}
                            onSubmitEditing={() => void send()}
                            testID="invite-email-input"
                        />
                        <Btn kind="primary" minHeight={HEIGHT.control} label="Send invite" disabled={!looksLikeEmail(address) || sending} onPress={() => void send()} testID="invite-email-send">
                            Send
                        </Btn>
                    </XStack>
                    {sent ? <XStack paddingLeft="8" role="status"><Copy small quiet testID="invite-sent">{`Invite sent to ${sent}.`}</Copy></XStack> : null}
                </YStack>
            ) : (
                <SheetRow testID="invite-email" icon={<Glyph icon={Mail} />} label="Invite by email" detail="They get a link to join" onPress={() => setEmailOpen(true)} />
            )}
            {error ? <Copy small quiet role="alert" testID="invite-error">{error}</Copy> : null}
        </SheetFrame>
    );
}
