import React, { useState } from 'react';
import { XStack } from 'tamagui';
import { T } from '@/ui/grammar';
import type { ChatDisplayMessage } from '@/buzz/room-view-presentation';
import { lifecycleSummary, type NotificationLifecycleRun } from '@/buzz/pr-lifecycle';
import { TranscriptNavigationRow } from './IndexRow';
import { LedgerDisclosure, LedgerLogGroup } from './LedgerDisclosure';
import { CornerGlyph, CORNER_META_SIZE } from './CornerGlyph';

interface NotificationLifecycleCardProps {
  message: ChatDisplayMessage;
  testID?: string;
  cornerId?: string;
  /** Hang corner rows beneath their source message. */
  anchored?: boolean;
  onOpenCorner(cornerId: string): void;
  onOpenUrl(url: string): void;
}
/** One collapsed steps-style row; expansion preserves every posted event. */
export const NotificationLifecycleCard = React.memo(function NotificationLifecycleCard({
  message,
  testID,
  cornerId,
  anchored = false,
  onOpenCorner,
  onOpenUrl,
}: NotificationLifecycleCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [showAll, setShowAll] = useState(false);
  // Inside a corner a check's corner target is the corner already open, so the
  // whole check row opens the check instead.
  const items = message.notificationLifecycleRun!.items.map((item) => ({
    ...item,
    cornerId:
      item.kind === 'check'
        ? item.cornerId === cornerId ? undefined : item.cornerId
        : item.cornerId ?? (item.kind === 'pull-request' ? cornerId : undefined),
  }));
  const summary = lifecycleSummary(items);
  return (
    <LedgerLogGroup
      testID={testID ?? `notification-run-${message.id}`}>
      {items.length > 1 ? <LedgerDisclosure expanded={expanded}
        onPress={() => { if (expanded) setShowAll(false); setExpanded(value => !value); }} accessibilityLabel={summary}
        accessibilityState={{ expanded }} rowTestID={`notification-run-expand-${message.id}`}>
        {summary.split(' · ').map((part, index) => <T v="meta" key={index} color={/fail/i.test(part) ? 'needsYou' : 'secondary'}>
          {index ? ' · ' : ''}{part}
        </T>)}
      </LedgerDisclosure> : null}
      {items.length === 1 || expanded ? <>
        {(showAll || items.length <= 3 ? items : items.slice(0, 2)).map((item, index) => (
          <RepositoryLifecycleRow key={item.id} item={item} divider={index > 0}
            testID={anchored ? `corner-opened-marker-${item.cornerId}` : undefined}
            onOpenCorner={onOpenCorner} onOpenUrl={onOpenUrl} />
        ))}
        {!showAll && items.length > 3 ? <LedgerDisclosure expanded={false} accessibilityState={{ expanded: false }}
          accessibilityLabel={`${items.length - 2} more events`} onPress={() => setShowAll(true)}
          rowTestID={`notification-run-more-${message.id}`}>{items.length - 2} more</LedgerDisclosure> : null}
      </> : null}
    </LedgerLogGroup>
  );
});
type RepositoryItem = NotificationLifecycleRun['items'][number];
export function isRepositoryLifecycleItem(item: RepositoryItem) {
  return (
    ['pull-request', 'issue', 'corner'].includes(item.kind) && !item.state.startsWith('Checks ')
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
        leading={item.cornerId ? <CornerGlyph size={CORNER_META_SIZE} /> : undefined}
        trailing={
          item.cornerId
            ? {
                accessibilityLabel: `Open thread ${item.title}`,
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
      <T v={isRepositoryLifecycleItem(item) ? 'heading' : 'metaStrong'} color={/fail/i.test(state) ? 'needsYou' : 'ink'}>{verb} </T>
      {number && item.url ? <><T v="heading" color="needsYou" textDecorationLine="underline">#{number}</T>{' '}</> : null}
      {item.title}
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
              accessibilityLabel: item.cornerId ? `Open thread ${item.title}` : `Open ${item.kindLine}`,
              onPress: () => item.cornerId ? onOpenCorner(item.cornerId) : onOpenUrl(item.url!),
              testID: `notification-run-cell-url-${item.id}`,
            }
          : undefined
      }
      trailing={
        item.cornerId
          ? {
              accessibilityLabel: `Open thread ${item.title}`,
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
