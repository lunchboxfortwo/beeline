import React from 'react';
import { AccessibilityInfo } from 'react-native';
import { Separator, Spinner, XStack, YStack } from 'tamagui';
import { RefreshCw } from 'lucide-react-native';
import { readUsageRefreshOutcome, type AgentUsage, type UsageRefreshOutcome } from '@beeline/api-contract/phone';
import { usageProvider } from '@/buzz/agent-usage';
import { USAGE_REFRESH_CLIENT_TIMEOUT_MS, usageCell } from './usage-cell';
import { Btn, Copy, Glyph, Section, T } from '@/ui/grammar';

/**
 * Owner-only Usage: one column per window (or allowance, or spend), the note
 * and stamp under it, and today's Refresh, which is the only provider read.
 */
export function AgentUsage({ usage, harness, onRefresh }: { usage?: AgentUsage; harness?: string; onRefresh?: () => Promise<unknown> }) {
    const [refreshing, setRefreshing] = React.useState(false);
    const [answer, setAnswer] = React.useState<{ outcome: UsageRefreshOutcome; about?: number }>();
    const attempt = React.useRef(0);
    const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const updatedAt = React.useRef(usage?.updatedAt);
    updatedAt.current = usage?.updatedAt;
    React.useEffect(() => () => clearTimeout(timer.current), []);
    const { columns, note, shared, stamp, refreshable, muted } = usageCell(
        usage ?? { updatedAt: 0, windows: [] }, harness, undefined,
        answer && answer.about === usage?.updatedAt ? answer.outcome : undefined,
    );
    const refresh = () => {
        if (!onRefresh || timer.current !== undefined) return;
        const current = ++attempt.current;
        setRefreshing(true);
        AccessibilityInfo.announceForAccessibility?.('Refreshing usage');
        const settle = (outcome: UsageRefreshOutcome) => {
            if (current !== attempt.current) return;
            clearTimeout(timer.current);
            timer.current = undefined;
            setRefreshing(false);
            setAnswer(outcome.status === 'fresh' ? undefined : { outcome, about: updatedAt.current });
        };
        // Longer than the server's own wait for the helper, so its answer arrives first.
        timer.current = setTimeout(() => settle({ status: 'no_answer' }), USAGE_REFRESH_CLIENT_TIMEOUT_MS);
        let reply: Promise<unknown>;
        try { reply = onRefresh(); } catch { settle({ status: 'failed', reason: "Beeline didn't answer" }); return; }
        void Promise.resolve(reply).then(
            (value) => settle(readUsageRefreshOutcome(value) ?? { status: 'fresh' }),
            () => { if (timer.current !== undefined) settle({ status: 'failed', reason: "Beeline didn't answer" }); },
        );
    };
    const machine = usage?.machine;
    const reading = `Refreshing · reading ${usageProvider(harness, Boolean(usage?.spend))}${machine ? ` on ${machine}` : ''}`;
    return (
        <Section title="Usage" testID="agent-usage">
            {columns.length ? (
                <>
                    <XStack paddingVertical="3" gap="3" flexWrap="wrap">
                        {columns.map((column) => (
                            <YStack key={column.label} minWidth={96} flex={1} gap="1" testID={`agent-usage-${column.label}`}
                                aria-label={`${column.label}: ${column.value}${column.foot ? `, ${column.foot}` : ''}`}>
                                <Copy small quiet numberOfLines={1}>{column.label}</Copy>
                                <T v="heading" numberOfLines={1} color={column.tone === 'danger' ? 'removed' : column.tone === 'warning' ? 'needsYou' : muted ? 'secondary' : 'ink'}>{column.value}</T>
                                {column.foot ? <T v="meta" numberOfLines={1} color={column.tone === 'danger' ? 'removed' : 'secondary'}>{column.foot}</T> : null}
                            </YStack>
                        ))}
                    </XStack>
                    <Separator borderColor="stroke" />
                </>
            ) : null}
            <XStack paddingVertical="3" gap="3" alignItems="flex-start">
                <YStack flex={1} minWidth={0} gap="1">
                    <Copy testID="agent-usage-note">{note}</Copy>
                    {shared ? <Copy small quiet testID="agent-usage-shared">{shared}</Copy> : null}
                    {refreshing ? <Copy small quiet testID="agent-usage-stamp">{reading}</Copy>
                        : stamp ? <T v="meta" color={muted ? 'needsYou' : 'secondary'} testID="agent-usage-stamp">{stamp}</T> : null}
                </YStack>
                {refreshable && onRefresh ? (
                    refreshing ? <Spinner testID="agent-usage-refreshing" />
                        : <Btn kind="icon" label="Refresh usage" onPress={refresh} testID="agent-usage-refresh"><Glyph icon={RefreshCw} size={16} /></Btn>
                ) : null}
            </XStack>
        </Section>
    );
}
