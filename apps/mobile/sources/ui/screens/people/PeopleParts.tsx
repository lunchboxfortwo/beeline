import * as Clipboard from 'expo-clipboard';
import React from 'react';
import { Card, ListItem, Separator, XStack, YStack } from 'tamagui';
import { ChevronRight, Plus } from 'lucide-react-native';
import { Btn, Copy, Glyph, HEIGHT, T } from '@/ui/grammar';
import { IdentityMark } from '@/components/buzz/IdentityMark';
import type { PeopleRow } from './people-rows';

export async function copyText(value: string): Promise<void> {
    await Clipboard.setStringAsync(value);
}

/** A person's or agent's mark at list size. */
export function Face({ row }: { row: Pick<PeopleRow, 'kind' | 'identity'> }) {
    const { identity } = row;
    return row.kind === 'agent'
        ? <IdentityMark kind="agent" seed={identity.pubkey} face={identity.face} name={identity.name} handle={identity.handle} avatarUrl={identity.avatar} size={28} />
        : <IdentityMark kind="human" seed={identity.pubkey} face={identity.face} name={identity.name} handle={identity.handle} avatarUrl={identity.avatar} size={28} />;
}

/** A section label with its own brass + (People · N, Agents · N). */
export function SectionHead({ title, onAdd, addLabel, testID }: { title: string; onAdd?: () => void; addLabel: string; testID: string }) {
    return (
        <XStack alignItems="center" justifyContent="space-between" minHeight={HEIGHT.control}>
            <T v="metaStrong" color="secondary">{title}</T>
            {onAdd ? (
                <Btn kind="accent" circular minWidth={HEIGHT.control} label={addLabel} onPress={onAdd} testID={testID}>
                    <Glyph icon={Plus} size={18} accent />
                </Btn>
            ) : null}
        </XStack>
    );
}

/** One list row: a face, the handle, a role, and one quiet line. */
function MemberRow({ row, onPress, last, roleAtEnd = false }: {
    row: PeopleRow; onPress?: () => void; last: boolean; roleAtEnd?: boolean;
}) {
    const role = row.role ? <T v="metaStrong" color={row.role.accent ? 'needsYou' : 'secondary'}>{row.role.label}</T> : null;
    const body = (
        <XStack paddingVertical="3" gap="3" alignItems="center" flex={1} minWidth={0}>
            <Face row={row} />
            <YStack flex={1} minWidth={0} gap="1">
                <XStack gap="2" alignItems="baseline" flexWrap="wrap">
                    <Copy numberOfLines={1}>{row.handle}</Copy>
                    {roleAtEnd ? null : role}
                </XStack>
                {row.detail || row.warn ? (
                    <T v="meta" color="secondary" testID="member-sub">
                        {row.detail ?? ''}
                        {row.warn ? <T v="metaStrong" color="needsYou">{`${row.detail ? ' · ' : ''}${row.warn}`}</T> : null}
                    </T>
                ) : null}
            </YStack>
            {roleAtEnd ? role : null}
            {onPress && !roleAtEnd ? <Glyph icon={ChevronRight} size={16} /> : null}
        </XStack>
    );
    return (
        <>
            {onPress
                ? <ListItem padding="0" minHeight={HEIGHT.control} backgroundColor="raised" onPress={onPress} aria-label={`Open profile ${row.handle}`} accessibilityRole="button" testID={`member-${row.id}`}>{body}</ListItem>
                : <XStack testID={`member-${row.id}`}>{body}</XStack>}
            {last ? null : <Separator borderColor="stroke" />}
        </>
    );
}

/** A card of member rows. */
export function MemberCard({ rows, open, roleAtEnd }: { rows: readonly PeopleRow[]; open: (row: PeopleRow) => (() => void) | undefined; roleAtEnd?: boolean }) {
    if (!rows.length) return null;
    return (
        <Card backgroundColor="raised" borderWidth={1} borderColor="stroke" paddingHorizontal="3" paddingVertical="1">
            {rows.map((row, index) => (
                <MemberRow key={row.id} row={row} onPress={open(row)} last={index === rows.length - 1} roleAtEnd={roleAtEnd} />
            ))}
        </Card>
    );
}
