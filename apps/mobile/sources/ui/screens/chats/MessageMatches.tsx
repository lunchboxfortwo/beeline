import React from 'react';
import { ListItem, XStack, YStack } from 'tamagui';
import { MESSAGE_SEARCH_MIN_CHARS, type MessageSearchResult } from '@beeline/api-contract/phone';
import { compactRelativeTime } from '@/buzz/relative-time';
import type { MessageSearchFailure, MessageSearchState } from '@/buzz/use-message-search';
import { Btn, Copy, HEIGHT, T } from '@/ui/grammar';

const FAILURE_LABELS: Record<MessageSearchFailure, string> = {
  too_broad: 'Too many messages match. Add another word.',
  rate_limited: 'Searching too fast. Wait a moment.',
  error: '',
};

function Note({ children, testID }: { children: React.ReactNode; testID: string }) {
  return <YStack paddingHorizontal="4" paddingVertical="2"><Copy small quiet testID={testID}>{children}</Copy></YStack>;
}

/** Message matches listed under the chats while a search is typed. */
export function MessageMatches({ search, now, onOpen }: {
  search: MessageSearchState;
  now: number;
  onOpen: (result: MessageSearchResult) => void;
}) {
  if (search.status === 'unavailable') return null;
  return <YStack testID="message-search-results"><MatchesBody search={search} now={now} onOpen={onOpen} /></YStack>;
}

function MatchesBody({ search, now, onOpen }: { search: MessageSearchState; now: number; onOpen: (result: MessageSearchResult) => void }) {
  if (search.status === 'error') return null;
  if (search.status === 'short') return <Note testID="message-search-short">Type {MESSAGE_SEARCH_MIN_CHARS} or more letters to search messages.</Note>;
  if (search.status === 'filler') return <Note testID="message-search-filler">Common words aren't searched. Type a more specific word.</Note>;
  if (search.status === 'loading') return <Note testID="message-search-loading">Searching messages…</Note>;
  if (search.status === 'too_broad') return <Note testID="message-search-too-broad">Too many messages match “{search.query}”. Add another word.</Note>;
  if (search.status === 'rate_limited') return <Note testID="message-search-too-fast">{FAILURE_LABELS.rate_limited}</Note>;
  if (!search.results.length) return <Note testID="message-search-empty">No messages match</Note>;
  return (
    <>
      {search.results.map((result) => <MessageMatch key={result.messageId} result={result} now={now} onOpen={onOpen} />)}
      {search.moreFailed && search.moreFailed !== 'error' ? (
        <Note testID="message-search-more-retry">{FAILURE_LABELS[search.moreFailed]}</Note>
      ) : search.hasMore ? (
        <YStack paddingHorizontal="4" paddingVertical="2">
          <Btn kind="quiet" label="Show more" disabled={search.loadingMore} onPress={search.loadMore} testID="message-search-more">
            {search.loadingMore ? 'Loading…' : 'Show more'}
          </Btn>
        </YStack>
      ) : null}
    </>
  );
}

function MessageMatch({ result, now, onOpen }: { result: MessageSearchResult; now: number; onOpen: (result: MessageSearchResult) => void }) {
  const sigil = result.directMessage ? '@' : '#';
  const room = `${sigil}${result.roomName.replace(/^[#@]+/, '')}`;
  const text = result.snippet.map((part) => part.text).join('');
  return (
    <ListItem
      minHeight={HEIGHT.control}
      paddingHorizontal="4"
      paddingVertical="2"
      gap="1"
      flexDirection="column"
      alignItems="stretch"
      backgroundColor="transparent"
      onPress={() => onOpen(result)}
      aria-label={`${result.authorName} in ${room}: ${text}`}
      accessibilityRole="button"
      testID={`message-search-result-${result.messageId}`}
    >
      <XStack gap="2" alignItems="baseline">
        <YStack flex={1} minWidth={0}><Copy small numberOfLines={1}>{room}</Copy></YStack>
        <Copy small quiet>{compactRelativeTime(result.createdAt, now)}</Copy>
      </XStack>
      <Copy small quiet numberOfLines={3}>
        <T v="metaStrong" color="ink">{result.authorName}: </T>
        {result.snippet.map((part, index) =>
          part.match ? <T key={index} v="metaStrong" color="needsYou" testID="message-search-match">{part.text}</T> : part.text,
        )}
      </Copy>
    </ListItem>
  );
}
