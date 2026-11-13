import React from 'react';
import { Spinner, XStack } from 'tamagui';
import { Check } from 'lucide-react-native';
import { Btn, Glyph, T } from '@/ui/grammar';

/**
 * Approve / Deny everywhere a request waits on you (build spec decision 17):
 * the primary Approve with a check, then the secondary Deny, wrapping on a
 * narrow column. `extra` sits between them for a request that today offers a
 * second allow option (a grant's “Once”).
 */
export function ApproveDeny({
    title,
    onApprove,
    onDeny,
    approveLabel = 'Approve',
    busy = false,
    disabled = false,
    approveTestID,
    denyTestID,
    extra,
}: {
    title: string;
    onApprove(): void;
    onDeny?(): void;
    approveLabel?: string;
    busy?: boolean;
    disabled?: boolean;
    approveTestID?: string;
    denyTestID?: string;
    extra?: React.ReactNode;
}) {
    return (
        <XStack gap="2" flexWrap="wrap" alignItems="center">
            <Btn
                kind="primary"
                label={`${approveLabel}: ${title}`}
                disabled={disabled || busy}
                aria-busy={busy}
                onPress={onApprove}
                testID={approveTestID}
            >
                <XStack gap="2" alignItems="center">
                    {busy ? <Spinner size="small" color="primaryInk" /> : <Glyph icon={Check} size={16} color="primaryInk" />}
                    <T v="heading" color="primaryInk">{approveLabel}</T>
                </XStack>
            </Btn>
            {extra}
            {onDeny ? (
                <Btn kind="secondary" label={`Deny: ${title}`} disabled={disabled || busy} onPress={onDeny} testID={denyTestID}>
                    Deny
                </Btn>
            ) : null}
        </XStack>
    );
}
