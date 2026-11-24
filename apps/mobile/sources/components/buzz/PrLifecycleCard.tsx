import React from 'react';
import { XStack } from 'tamagui';
import { Inked, T } from '@/ui/grammar';
import { CornerDownRight, type LucideProps } from 'lucide-react-native';
import type { ChatDisplayMessage } from '@/buzz/room-view-presentation';
import { type NotificationLifecycleRun } from '@/buzz/pr-lifecycle';
import { TranscriptNavigationRow } from './IndexRow';
import { LedgerLogGroup } from './LedgerDisclosure';

interface NotificationLifecycleCardProps {
  message: ChatDisplayMessage;
  testID?: string;
  cornerId?: string;
  onOpenCorner(cornerId: string): void;
  onOpenUrl(url: string): void;
}
/** The records inside an opened lifecycle pill. */
export const NotificationLifecycleCard = React.memo(function NotificationLifecycleCard({
  message,
  testID,
  cornerId,
  onOpenCorner,
  onOpenUrl,
}: NotificationLifecycleCardProps) {
  // Inside a corner a check's corner target is the corner already open, so the
  // whole check row opens the check instead.
  const items = message.notificationLifecycleRun!.items.map((item) => ({
    ...item,
    cornerId:
      item.kind === 'check'
        ? item.cornerId === cornerId ? undefined : item.cornerId
        : item.cornerId ?? (item.kind === 'pull-request' ? cornerId : undefined),
  }));
  return (
    <LedgerLogGroup testID={testID ?? `notification-run-${message.id}`}>
      {items.map((item, index) => (
        <RepositoryLifecycleRow key={item.id} item={item} divider={index > 0}
          onOpenCorner={onOpenCorner} onOpenUrl={onOpenUrl} />
      ))}
    </LedgerLogGroup>
  );
});
type RepositoryItem = NotificationLifecycleRun['items'][number];
export function isRepositoryLifecycleItem(item: RepositoryItem) {
  return (
    !item.displayText && ['pull-request', 'issue', 'corner'].includes(item.kind) && !item.state.startsWith('Checks ')
  );
}

/**
 * GitHub and corner destinations are separate; the title keeps the remaining width.
 * Corner rows lead with the corner mark; GitHub rows have no leading glyph.
 */
export function RepositoryLifecycleRow({
  item,
  divider = false,
  testID,
  onOpenCorner,
  onOpenUrl,
}: {
  item: RepositoryItem;
  divider?: boolean;
  /** Replaces the corner target's test id. */
  testID?: string;
  onOpenCorner(id: string): void;
  onOpenUrl(url: string): void;
}) {
  const state = item.state.replace(/^(PR|Checks) /, '');
  const verb = state.charAt(0).toUpperCase() + state.slice(1);
  const number =
    item.url?.match(/\/(?:pull|issues)\/(\d+)/)?.[1] ?? item.kindLine.match(/#(\d+)/)?.[1];
  const cornerTestID = testID ?? `notification-run-cell-corner-${item.id}`;
  if (item.kind === 'corner' && isRepositoryLifecycleItem(item)) {
    return (
      <TranscriptNavigationRow
        testID={`notification-run-cell-${item.id}`}
        divider={divider}
        singleDestination
        leading={item.cornerId ? <Inked<LucideProps> glyph={CornerDownRight} color="secondary" size={13} strokeWidth={1.7} /> : undefined}
        trailing={
          item.cornerId
            ? {
                accessibilityLabel: `Open thread ${item.displayText ?? item.title}`,
                onPress: () => onOpenCorner(item.cornerId!),
                testID: cornerTestID,
              }
            : undefined
        }
      >
        {/* Centre the body line in the 44 copy target without moving either icon
            or changing the row's layout and hit target (approved title-alignment mock). */}
        <XStack alignItems="baseline" y={2.5}>
          <T color="secondary" minWidth={0} numberOfLines={1} ellipsizeMode="tail">
            <T v="heading" color={/fail/i.test(state) ? 'needsYou' : 'ink'}>{verb} </T>
            {item.title}
            {state === 'Merged' && number && item.url ? ' ' : null}
          </T>
          {state === 'Merged' && number && item.url ? (
            <T
              v="heading"
              color="needsYou"
              textDecorationLine="underline"
              flexShrink={0}
              marginLeft="1"
              numberOfLines={1}
              accessibilityRole="link"
              accessibilityLabel={`Open PR ${number}`}
              testID={`notification-run-cell-url-${item.id}`}
              onPress={(event) => {
                event.stopPropagation();
                onOpenUrl(item.url!);
              }}
            >{`PR ${number}`}</T>
          ) : null}
        </XStack>
      </TranscriptNavigationRow>
    );
  }
  const copy = (
    <T
      v={isRepositoryLifecycleItem(item) ? 'body' : 'meta'}
      color="secondary"
      marginVertical={isRepositoryLifecycleItem(item) ? 0 : '1'}
      numberOfLines={2}
      ellipsizeMode="tail"
    >
      {item.displayText ? <T v="meta" color={/fail/i.test(state) ? 'needsYou' : 'secondary'}>{item.displayText}</T> : <>
        <T v={isRepositoryLifecycleItem(item) ? 'heading' : 'metaStrong'} color={/fail/i.test(state) ? 'needsYou' : 'ink'}>{verb} </T>
        {number && item.url && isRepositoryLifecycleItem(item) ? <><T v="heading" color="needsYou" textDecorationLine="underline">#{number}</T>{' '}</> : null}
        {item.title}
      </>}
    </T>
  );
  return (
    <TranscriptNavigationRow
      testID={`notification-run-cell-${item.id}`}
        divider={divider}
      singleDestination={!isRepositoryLifecycleItem(item) && !item.cornerId}
      primary={
        item.url && (isRepositoryLifecycleItem(item) || item.cornerId)
          ? {
              accessibilityLabel: item.cornerId ? `Open thread ${item.displayText ?? item.title}` : `Open ${item.kindLine}`,
              onPress: () => item.cornerId ? onOpenCorner(item.cornerId) : onOpenUrl(item.url!),
              testID: `notification-run-cell-url-${item.id}`,
            }
          : undefined
      }
      trailing={
        item.cornerId
          ? {
              accessibilityLabel: `Open thread ${item.displayText ?? item.title}`,
              onPress: () => onOpenCorner(item.cornerId!),
              testID: cornerTestID,
            }
          : !isRepositoryLifecycleItem(item) && item.url
            ? { accessibilityLabel: `Open ${item.kindLine}`, onPress: () => onOpenUrl(item.url!), testID: `notification-run-cell-url-${item.id}` }
            : undefined
      }
    >
      {copy}
    </TranscriptNavigationRow>
  );
}
