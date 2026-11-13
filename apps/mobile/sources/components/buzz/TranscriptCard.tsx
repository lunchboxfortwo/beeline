import React, { useState, type ReactNode } from 'react';
import { Card, Input, ListItem, Separator, Spinner, XStack, YStack } from 'tamagui';
import { Check, ChevronDown, ChevronRight, ExternalLink, X } from 'lucide-react-native';
import { Btn, Copy, Glyph, HEIGHT, T } from '@/ui/grammar';
import { SettledLine } from '@/ui/screens/transcript/cards/RequestCard';
import { ChoiceOption } from '@/ui/screens/transcript/cards/ChoiceOption';
import { ErrorBanner } from './ErrorBanner';
import type { ButtonDestination } from './Button';
import type { TranscriptCardChoice } from './ChoicePlate';

export type { TranscriptCardChoice };
export type TranscriptCardTier = 'record' | 'ask';
export type TranscriptCardRowTone = 'settled' | 'waiting' | 'failed';

export type TranscriptCardRow = {
  id: string;
  state: string;
  title: string;
  kindLine: string;
  tone?: TranscriptCardRowTone;
  onPress?(): void;
};

export type TranscriptCardAction = {
  label: string;
  onPress(): void;
  primary?: boolean;
  secondary?: boolean;
  dismiss?: boolean;
  labelTone?: 'quiet';
  disabled?: boolean;
  loading?: boolean;
  testID?: string;
  accessibilityRole?: 'button' | 'link';
  /** Where the action goes, drawn after its label. */
  destination?: ButtonDestination;
};

/** An optional one-line text field above the choices (a workflow gate's note). */
type TranscriptCardNoteInput = {
  value: string;
  onChangeText(text: string): void;
  placeholder: string;
  maxLength: number;
  editable?: boolean;
  testID?: string;
};

export type TranscriptCardProps = {
  tier: TranscriptCardTier;
  title: ReactNode;
  wrapTitle?: boolean;
  subline?: ReactNode;
  /** Cut the subline to this many lines (a collapsed record's first line). */
  sublineLines?: number;
  sublineTestID?: string;
  stamp?: string;
  identity?: ReactNode;
  body?: ReactNode;
  quietBody?: boolean;
  compactBody?: boolean;
  primaryBody?: boolean;
  /** The asking message's attached image, full width under the ask. */
  media?: ReactNode;
  inlineError?: { title: string; description?: string };
  /** Retained for callers; the grammar card has no footer rule. */
  footerDivider?: boolean;
  balancedFooterInset?: boolean;
  /** Controls an ask needs beyond rows and choices (a field, a step list). */
  children?: ReactNode;
  rows?: readonly TranscriptCardRow[];
  choices?: readonly TranscriptCardChoice[];
  noteInput?: TranscriptCardNoteInput;
  code?: ReactNode;
  codeTestID?: string;
  codePath?: string;
  foldCode?: boolean;
  codeLabel?: string;
  facts?: readonly { label: string; value: string }[];
  footerNote?: ReactNode;
  footerNoteTestID?: string;
  footerNoteTone?: 'quiet' | 'failed';
  decisionNote?: boolean;
  decisionScope?: 'Once' | 'Always';
  actions?: readonly TranscriptCardAction[];
  onHeaderPress?(): void;
  headerExpanded?: boolean;
  headerTestID?: string;
  /** An X at the end of the title line that closes the card for good. */
  onDismiss?(): void;
  dismissLabel?: string;
  testID?: string;
};

/**
 * The one transcript card (build spec → Card, chat-milo-cards): a raised card
 * with a strong title and a quiet line under it. Facts, code, rows and choices
 * stack under it; Approve / Deny (primary first) close a request waiting on you.
 */
export function TranscriptCard({
  tier,
  title,
  wrapTitle = false,
  subline,
  sublineLines,
  sublineTestID,
  stamp,
  identity,
  children,
  body,
  quietBody = false,
  compactBody = false,
  primaryBody = false,
  media,
  inlineError,
  rows = [],
  choices = [],
  noteInput,
  code,
  codeTestID,
  codePath,
  foldCode = false,
  codeLabel,
  facts = [],
  footerNote,
  footerNoteTestID,
  footerNoteTone = 'quiet',
  decisionNote = false,
  decisionScope,
  actions = [],
  onHeaderPress,
  headerExpanded,
  headerTestID,
  onDismiss,
  dismissLabel = 'Dismiss',
  testID,
}: TranscriptCardProps) {
  const [codeOpen, setCodeOpen] = useState(false);
  const links = actions.filter((action) => action.accessibilityRole === 'link');
  // Approve leads, as in the mock's ApproveDeny; the rest keep their order.
  const decisions = actions
    .filter((action) => action.accessibilityRole !== 'link')
    .sort((a, b) => Number(Boolean(b.primary)) - Number(Boolean(a.primary)));
  const titleTestID = testID ? `${testID}-title` : undefined;
  const titleLine = (
    <XStack gap="2" alignItems="flex-start">
      {identity ? <YStack>{identity}</YStack> : null}
      <YStack flex={1} minWidth={0}>
        <T v="heading" numberOfLines={wrapTitle ? undefined : 1} testID={titleTestID}>{title}</T>
      </YStack>
    </XStack>
  );
  const head = (
    <XStack gap="2" alignItems="flex-start" flex={1} minWidth={0}>
      <YStack flex={1} minWidth={0} gap="1">
        {titleLine}
        {subline ? (
          <T v="meta" color="secondary" numberOfLines={sublineLines} testID={sublineTestID}>{subline}</T>
        ) : null}
      </YStack>
      {stamp ? <T v="meta" color="secondary">{stamp}</T> : null}
      {onHeaderPress ? <Glyph icon={headerExpanded ? ChevronDown : ChevronRight} size={16} /> : null}
      {onDismiss ? (
        <Btn kind="icon" label={dismissLabel} onPress={onDismiss} testID={testID ? `${testID}-dismiss` : undefined}>
          <Glyph icon={X} size={16} />
        </Btn>
      ) : null}
    </XStack>
  );
  const note = footerNote === undefined ? null
    : decisionScope && typeof footerNote === 'string' ? `${decisionScope} · ${footerNote}` : footerNote;
  return (
    <Card
      backgroundColor="raised"
      borderWidth={1}
      borderColor="stroke"
      borderRadius="md"
      padding="3"
      gap="3"
      testID={testID}
    >
      {onHeaderPress ? (
        <ListItem padding="0" minHeight={HEIGHT.control} backgroundColor="transparent" onPress={onHeaderPress}
          accessibilityRole="button" aria-expanded={headerExpanded} testID={headerTestID}>
          {head}
        </ListItem>
      ) : (
        <XStack testID={headerTestID}>{head}</XStack>
      )}
      {body ? (
        <T v={compactBody ? 'meta' : 'body'} color={quietBody && !primaryBody ? 'secondary' : 'ink'}>{body}</T>
      ) : null}
      {media}
      {inlineError ? <ErrorBanner inline title={inlineError.title} description={inlineError.description} /> : null}
      {facts.length ? (
        <YStack gap="2">
          {facts.map((fact) => (
            <XStack key={fact.label} gap="3" alignItems="flex-start">
              <YStack width={92}><Copy small quiet>{fact.label}</Copy></YStack>
              <YStack flex={1} minWidth={0}><Copy small>{fact.value}</Copy></YStack>
            </XStack>
          ))}
        </YStack>
      ) : null}
      {children}
      {foldCode && code !== undefined ? (
        <ListItem padding="0" gap="2" minHeight={HEIGHT.control} backgroundColor="transparent"
          onPress={() => setCodeOpen((open) => !open)} accessibilityRole="button"
          aria-label={codeLabel ?? 'Script'} aria-expanded={codeOpen}
          testID={codeTestID ? `${codeTestID}-toggle` : undefined}>
          <Glyph icon={codeOpen ? ChevronDown : ChevronRight} size={16} />
          <YStack flex={1} minWidth={0}>
            <Copy small quiet>{`${codeLabel ?? 'Script'} · ${String(code).replace(/\r?\n$/, '').split('\n').length} lines`}</Copy>
          </YStack>
        </ListItem>
      ) : null}
      {code !== undefined && (!foldCode || codeOpen) ? (
        <YStack padding="3" gap="1" borderRadius="md" borderWidth={1} borderColor="stroke" backgroundColor="canvas" testID={codeTestID}>
          {codePath ? <T v="code" color="secondary">{codePath}</T> : null}
          <T v="code" userSelect="text">{code}</T>
        </YStack>
      ) : null}
      {rows.length ? (
        <YStack>
          {rows.map((row, index) => (
            <React.Fragment key={row.id}>
              {index > 0 ? <Separator borderColor="stroke" /> : null}
              <CardRow row={row} wrapTitle={wrapTitle} />
            </React.Fragment>
          ))}
        </YStack>
      ) : null}
      {choices.length ? (
        <YStack gap="2" testID={testID ? `${testID}-choices` : undefined}>
          {noteInput ? (
            <Input
              size="md"
              minHeight={HEIGHT.control}
              aria-label={noteInput.placeholder}
              disabled={noteInput.editable === false}
              maxLength={noteInput.maxLength}
              onChangeText={noteInput.onChangeText}
              placeholder={noteInput.placeholder}
              testID={noteInput.testID}
              value={noteInput.value}
            />
          ) : null}
          {choices.map((choice) => (
            <ChoiceOption key={choice.id} choice={choice} closed={tier === 'record'} />
          ))}
        </YStack>
      ) : null}
      {note !== null ? (
        decisionNote ? (
          <SettledLine failed={footerNoteTone === 'failed'} testID={footerNoteTestID}>{note}</SettledLine>
        ) : (
          <T v="meta" color={footerNoteTone === 'failed' ? 'removed' : 'secondary'} testID={footerNoteTestID}>{note}</T>
        )
      ) : null}
      {decisions.length || links.length ? (
        <XStack gap="2" flexWrap="wrap" alignItems="center">
          {decisions.map((action) => <ActionButton key={action.testID ?? action.label} action={action} />)}
          {links.map((action) => <ActionButton key={action.testID ?? action.label} action={action} />)}
        </XStack>
      ) : null}
    </Card>
  );
}

/** One card action on the grammar's buttons: primary, secondary, or quiet. */
function ActionButton({ action }: { action: TranscriptCardAction }) {
  const link = action.accessibilityRole === 'link';
  const kind = action.primary ? 'primary' : action.dismiss || (link && !action.secondary) ? 'quiet' : 'secondary';
  const quiet = action.labelTone === 'quiet' || kind === 'quiet';
  return (
    <Btn
      kind={kind}
      label={action.label}
      disabled={action.disabled || action.loading}
      aria-busy={action.loading === true}
      accessibilityRole={link ? 'link' : 'button'}
      onPress={action.onPress}
      testID={action.testID}
    >
      <XStack gap="2" alignItems="center">
        {action.loading ? <Spinner size="small" color={kind === 'primary' ? 'primaryInk' : 'secondary'} />
          : kind === 'primary' && action.label === 'Approve' ? <Glyph icon={Check} size={16} color="primaryInk" /> : null}
        <T v="heading" color={kind === 'primary' ? 'primaryInk' : quiet ? 'secondary' : 'ink'}>{action.label}</T>
        {action.destination === 'external' ? <Glyph icon={ExternalLink} size={16} />
          : action.destination === 'screen' ? <Glyph icon={ChevronRight} size={16} /> : null}
      </XStack>
    </Btn>
  );
}

function CardRow({ row, wrapTitle }: { row: TranscriptCardRow; wrapTitle: boolean }) {
  const content = (
    <XStack gap="3" alignItems="flex-start" paddingVertical="2" flex={1} minWidth={0}>
      <YStack width={80}>
        <T v="meta" color={row.tone === 'waiting' ? 'needsYou' : row.tone === 'failed' ? 'removed' : 'secondary'}>{row.state}</T>
      </YStack>
      <YStack flex={1} minWidth={0} gap="1">
        <T v="body" numberOfLines={wrapTitle ? undefined : 1}>{row.title}</T>
        <T v="meta" color="secondary" numberOfLines={wrapTitle ? undefined : 1}>{row.kindLine}</T>
      </YStack>
      {row.onPress ? <YStack paddingTop="0.5"><Glyph icon={ChevronRight} size={16} /></YStack> : null}
    </XStack>
  );
  return row.onPress ? (
    <ListItem padding="0" minHeight={HEIGHT.control} backgroundColor="transparent" onPress={row.onPress}
      accessibilityRole="link" aria-label={`${row.state}: ${row.title}. ${row.kindLine}`}
      testID={`transcript-card-row-${row.id}`}>
      {content}
    </ListItem>
  ) : (
    <XStack testID={`transcript-card-row-${row.id}`}>{content}</XStack>
  );
}

/** Brass inline text for handles embedded in a card title or subline. */
export function TranscriptCardHandle({ children, meta = false }: { children: ReactNode; meta?: boolean }) {
  return <T v={meta ? 'metaStrong' : 'heading'} color="needsYou">{children}</T>;
}
