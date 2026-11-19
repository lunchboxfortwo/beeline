import React, { useState } from 'react';
import { XStack, YStack } from 'tamagui';
import { ArrowRight } from 'lucide-react-native';
import { Btn, Copy, Glyph, HEIGHT } from '@/ui/grammar';
import { IdentityMark } from '@/components/buzz/IdentityMark';
import { SYSTEM_IDENTITY_PUBKEY } from '@/buzz/system-identity';

const PILL_FACE_SIZE = 22;

/** One end of a pill: the Beeline account, a person or an agent. */
export type PillFace =
    | { kind: 'system'; name: string }
    | { kind: 'agent' | 'human'; seed: string; name: string; face?: string; avatarUrl?: string };

export type PillItem = {
    id: string;
    from: PillFace;
    to?: PillFace;
    time: string;
    /** A system fact remains readable while its details are collapsed. */
    summary?: string;
    /** The message, read under the row once its pill is opened. */
    body: React.ReactNode;
    system: boolean;
};

function Face({ face }: { face: PillFace }) {
    if (face.kind === 'system') {
        return <IdentityMark kind="human" seed={SYSTEM_IDENTITY_PUBKEY} name={face.name} size={PILL_FACE_SIZE} />;
    }
    return face.kind === 'agent'
        ? <IdentityMark kind="agent" seed={face.seed} face={face.face} avatarUrl={face.avatarUrl} name={face.name} size={PILL_FACE_SIZE} />
        : <IdentityMark kind="human" seed={face.seed} face={face.face} avatarUrl={face.avatarUrl} name={face.name} size={PILL_FACE_SIZE} />;
}

function heading(item: PillItem): string {
    return item.to ? `${item.from.name} → ${item.to.name}` : item.from.name;
}

/**
 * System facts and agent-to-agent messages in one wrapping row. System pills
 * keep their summary visible; a tap opens the full message under the row.
 */
export function PillRow({ items, testID }: { items: readonly PillItem[]; testID?: string }) {
    const [openId, setOpenId] = useState<string | null>(null);
    const open = items.find((item) => item.id === openId);
    return (
        <YStack gap="2" width="100%" minWidth={0} testID={testID ?? 'pill-row'}>
            <XStack gap="2" flexWrap="wrap" alignItems="flex-start">
                {items.map((item) => {
                    const expanded = item.id === openId;
                    return (
                        <Btn
                            key={item.id}
                            kind="secondary"
                            label={`${expanded ? 'Hide' : 'Read'} message from ${heading(item)}, ${item.time}`}
                            minHeight={HEIGHT.control}
                            maxWidth="100%"
                            paddingHorizontal="2"
                            gap="1"
                            borderRadius="full"
                            borderColor={expanded ? 'strongStroke' : 'stroke'}
                            backgroundColor="raised"
                            aria-expanded={expanded}
                            onPress={() => setOpenId(expanded ? null : item.id)}
                            testID={item.system ? 'system-pill' : 'agent-pill'}
                        >
                            <Face face={item.from} />
                            {item.system && item.summary ? <Copy small quiet numberOfLines={1} flexShrink={1}>{item.summary}</Copy> : null}
                            {item.to ? <Glyph icon={ArrowRight} size={14} /> : null}
                            {item.to ? <Face face={item.to} /> : null}
                        </Btn>
                    );
                })}
            </XStack>
            {open ? (
                <YStack paddingLeft="2" borderLeftWidth={2} borderColor="stroke" gap="1" testID="pill-open">
                    <Copy small quiet>{`${heading(open)} · ${open.time}`}</Copy>
                    {open.body}
                </YStack>
            ) : null}
        </YStack>
    );
}
