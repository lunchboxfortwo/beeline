import { IndexRow } from '@/components/buzz/IndexRow';
import { ErrorBanner } from '@/components/buzz/ErrorBanner';
import React from 'react';
import { Platform, type TextInput } from 'react-native';
import { XStack, YStack } from 'tamagui';
import { BuzzRigTransport } from '@/sync/transport';
import { type GitHubInstallationAccess } from '@beeline/buzz-client';
import { type ChannelSuggestion } from '@/buzz/channel-suggestions';
import { CORNER_LABEL, ROOM_LABEL } from '@/buzz/vocabulary';
import { type ComposerAckPresentation } from '@/buzz/room-indicators';
import { TurnBandSlot, TurnSettledLine } from '@/components/buzz/TurnProgressLine';
import { desktopComposerKeyAction } from '@/buzz/desktop-workbench-state';
import { resolveAgentDisplayIdentity } from '@/buzz/agent-display';
import { type RepoCandidate } from '@/buzz/room-repo-picker';
import { type OwnerGrantNeeded } from '@/components/buzz/OwnerGrantNeededCard';
import { formatAttachmentSize, type PickedChatAttachment } from '@/buzz/chat-attachment';
import { type BuiltInSlashVerbId } from '@/buzz/slash-verbs';
import { type MessageReplyTarget } from '@/buzz/message-reply';
import { splitComposerTags } from '@/buzz/composer-tags';
import { mentionKeyboardAction } from '@/buzz/composer-keyboard';
import { TurnProgressLine } from '@/components/buzz/TurnProgressLine';
import { ChannelSuggestionMenu, MentionSuggestionMenu } from '@/components/buzz/MentionSuggestionMenu';
import { type RoomRosterParticipant } from '@/buzz/room-participants';
import { RepoPicker } from '@/components/buzz/RepoPicker';
import { SlashVerbPicker } from '@/components/buzz/SlashVerbPicker';
import { Button } from '@/components/buzz/Button';
import { ConversationComposer, type DictatedSend } from '@/components/buzz/ConversationComposer';
import { RoomMemberOption, MessageShortcut, COMPOSER_MAX_HEIGHT, COMPOSER_MIN_HEIGHT } from './chat-surface-values';
import { TURN_LINE_BOX_HEIGHT } from '@/buzz/room-bottom-chrome';
import { Motion, T, type MotionStyle } from '@/ui/grammar';

type Props = {
  desktopExperience: boolean;
  setTurnChromeTopInset: React.Dispatch<React.SetStateAction<number>>;
  composerAck: ComposerAckPresentation | null;
  stoppingThisTurn: boolean;
  handleStopTurn: (stop: { agentPubkey: string; requestId: string; }) => Promise<boolean>;
  settledTurn: { line: string; } | null;
  transcriptHydrationFailed: boolean;
  transcriptHydrationError: string | null;
  retryHydration: () => void;
  isReadOnlyDirectMessage: boolean;
  readOnlyFooterInset: { marginBottom: number; paddingBottom?: undefined; } | { paddingBottom: number; marginBottom?: undefined; };
  /** The composer's animated foot (keyboard or safe-area inset), as a height under the row. */
  composerBottomInset: MotionStyle;
  slashMenuVisible: boolean;
  mentionSlashAgentPubkey: string | null;
  agentByPubkey: Map<string, import("@/buzz/agent-display").DisplayableAgent>;
  slashVerbs: import("@/buzz/slash-verbs").BuiltInSlashVerb[];
  currentSlashQuery: string | null;
  mentionSlash: import("@/buzz/slash-verbs").AgentMentionSlash | null;
  highlightedSlashVerbIndex: number;
  dismissSlashMenu: () => void;
  runSlashVerb: (verb: BuiltInSlashVerbId) => void;
  mentionAgentCommands: import("@/buzz/slash-verbs").AgentPaletteCommand[];
  mentionAgentLacksCommands: boolean;
  selectAgentCommand: (name: string) => void;
  mentionMenuVisible: boolean;
  highlightedMentionIndex: number;
  keyboardHeight: number;
  mentionSuggestions: { matches: RoomRosterParticipant[]; overflow: number; };
  selectMention: (participant: RoomMemberOption) => void;
  personProfileByPubkey: Map<string, { face?: string | undefined; avatar?: string | undefined; handle?: string | undefined; pubkey: string; name: string; }>;
  channelMenuVisible: boolean;
  channelSuggestions: { matches: ChannelSuggestion[]; overflow: number; };
  selectChannel: (suggestion: ChannelSuggestion) => void;
  activeChannel: import("@/buzz/channel-suggestions").ActiveChannel | null;
  cornerOpenRepoPrompt: boolean;
  roomRepoAccessIssue: { fullName: string; reason: "revoked" | "not_granted"; installationId?: number; } | null;
  handleReconnectRoomRepository: () => Promise<void>;
  setCornerOpenRepoPrompt: React.Dispatch<React.SetStateAction<boolean>>;
  canManageWorkspace: boolean;
  decodedId: string;
  roomRepoBusy: boolean;
  roomRepoCandidates: RepoCandidate[];
  githubInstallations: GitHubInstallationAccess[];
  roomRepoError: string | null;
  roomRepoNotice: string | null;
  ownerGrant: OwnerGrantNeeded | null;
  handleAddGitHubAccount: () => Promise<void>;
  handleAskOwnerGrant: (fullName: string) => Promise<void>;
  handleCreateGitHubRepository: (installationId: number, name: string) => Promise<void>;
  handleManageGitHubInstallation: (installation: Pick<GitHubInstallationAccess, "installationId">) => Promise<void>;
  handleSelectRoomRepoCandidate: (candidate: RepoCandidate) => void;
  desktopDeliveryState: "failed" | "sending" | "delivered" | null;
  isDirectMessage: boolean;
  roomSurface: NonNullable<import("@beeline/api-contract/phone").RoomView | null>;
  isCorner: boolean;
  voice: import("@/buzz/use-voice-call").VoiceCallState;
  composerRef: React.RefObject<TextInput | null>;
  replyTarget: MessageReplyTarget | null;
  setReplyTarget: React.Dispatch<React.SetStateAction<MessageReplyTarget | null>>;
  composerTagHandles: Set<string>;
  pendingAttachments: PickedChatAttachment[];
  attachmentUploader: { state(attachment: PickedChatAttachment): import("@/buzz/chat-attachment").ChatAttachmentUploadState | undefined; subscribe(listener: () => void): () => void; start(client: import("@beeline/buzz-client").BuzzClient, attachments: readonly PickedChatAttachment[]): void; retain(attachments: readonly PickedChatAttachment[]): void; uploadAll(client: import("@beeline/buzz-client").BuzzClient, attachments: readonly PickedChatAttachment[]): Promise<import("@beeline/buzz-client").AttachmentReference[]>; };
  sending: boolean;
  replacePendingAttachments: (update: PickedChatAttachment[] | ((current: PickedChatAttachment[]) => PickedChatAttachment[])) => void;
  transport: BuzzRigTransport | null;
  speechHints: () => string[];
  inputText: string;
  composerInputRevision: number;
  composerInputRevisionRef: React.RefObject<number>;
  composerHeight: number;
  composerFocused: boolean;
  chooseAttachment: () => void;
  handleDesktopDrop: (event: React.DragEvent<HTMLElement>) => void;
  handleDesktopPaste: (event: ClipboardEvent) => void;
  inputTextRef: React.RefObject<string>;
  setInputText: (update: string | ((previous: string) => string)) => void;
  setComposerHeight: React.Dispatch<React.SetStateAction<number>>;
  setComposerFocused: React.Dispatch<React.SetStateAction<boolean>>;
  selectHighlightedPaletteItem: () => void;
  paletteItemCount: number;
  setHighlightedSlashVerbIndex: React.Dispatch<React.SetStateAction<number>>;
  suggestionCount: number;
  handleSend: (shortcut?: MessageShortcut, dictated?: DictatedSend) => Promise<boolean | undefined>;
  setHighlightedMentionIndex: React.Dispatch<React.SetStateAction<number>>;
  setDismissedMentionKey: React.Dispatch<React.SetStateAction<string | null>>;
  mentionMenuKey: string | null;
  channelMenuKey: string | null;
  setInputSelection: React.Dispatch<React.SetStateAction<{ start: number; end: number; }>>;
};

export const ChatSurfaceComposer = React.memo(function ChatSurfaceComposer({
  desktopExperience,
  setTurnChromeTopInset,
  composerAck,
  stoppingThisTurn,
  handleStopTurn,
  settledTurn,
  transcriptHydrationFailed,
  transcriptHydrationError,
  retryHydration,
  isReadOnlyDirectMessage,
  readOnlyFooterInset,
  composerBottomInset,
  slashMenuVisible,
  mentionSlashAgentPubkey,
  agentByPubkey,
  slashVerbs,
  currentSlashQuery,
  mentionSlash,
  highlightedSlashVerbIndex,
  dismissSlashMenu,
  runSlashVerb,
  mentionAgentCommands,
  mentionAgentLacksCommands,
  selectAgentCommand,
  mentionMenuVisible,
  highlightedMentionIndex,
  keyboardHeight,
  mentionSuggestions,
  selectMention,
  personProfileByPubkey,
  channelMenuVisible,
  channelSuggestions,
  selectChannel,
  activeChannel,
  cornerOpenRepoPrompt,
  roomRepoAccessIssue,
  handleReconnectRoomRepository,
  setCornerOpenRepoPrompt,
  canManageWorkspace,
  decodedId,
  roomRepoBusy,
  roomRepoCandidates,
  githubInstallations,
  roomRepoError,
  roomRepoNotice,
  ownerGrant,
  handleAddGitHubAccount,
  handleAskOwnerGrant,
  handleCreateGitHubRepository,
  handleManageGitHubInstallation,
  handleSelectRoomRepoCandidate,
  desktopDeliveryState,
  isDirectMessage,
  roomSurface,
  isCorner,
  voice,
  composerRef,
  replyTarget,
  setReplyTarget,
  composerTagHandles,
  pendingAttachments,
  attachmentUploader,
  sending,
  replacePendingAttachments,
  transport,
  speechHints,
  inputText,
  composerInputRevision,
  composerInputRevisionRef,
  composerHeight,
  composerFocused,
  chooseAttachment,
  handleDesktopDrop,
  handleDesktopPaste,
  inputTextRef,
  setInputText,
  setComposerHeight,
  setComposerFocused,
  selectHighlightedPaletteItem,
  paletteItemCount,
  setHighlightedSlashVerbIndex,
  suggestionCount,
  handleSend,
  setHighlightedMentionIndex,
  setDismissedMentionKey,
  mentionMenuKey,
  channelMenuKey,
  setInputSelection,
}: Props) {
  // RN-web measures content when its input ref attaches. Keep this callback
  // stable so a height update cannot reattach the ref and measure in a loop.
  const handleContentSizeChange = React.useCallback<
    React.ComponentProps<typeof ConversationComposer>['onContentSizeChange']
  >((event) => {
    const contentHeight = Math.ceil(event.nativeEvent.contentSize.height);
    setComposerHeight(Math.min(COMPOSER_MAX_HEIGHT, Math.max(COMPOSER_MIN_HEIGHT, contentHeight)));
  }, [setComposerHeight]);
  // "Message #beeline" in a chat, "Reply in thread" in a corner; a DM keeps its own hint.
  const roomName = roomSurface?.room?.name?.trim();
  const composerPlaceholder = isCorner
    ? 'Reply in thread'
    : !isDirectMessage && roomName ? `Message #${roomName}` : undefined;
  const mentionPlace = isCorner ? 'this thread' : !isDirectMessage && roomName ? `#${roomName}` : undefined;
  // Keep the hanging line and every gap around the field above the scrolling
  // transcript, on the same opaque canvas (`buzz/room-bottom-chrome.ts`).
  // On the phone, a tall @, # or / list can need more height than the keyboard
  // leaves. The chrome and the composer row may shrink (React Native items do
  // not by default); only the list's scroll inside them gives up height, so the
  // field, attachments and keyboard spacer keep theirs.
  const phoneShrink = desktopExperience ? undefined : { flexShrink: 1, minHeight: 0 };
  return (<YStack
                position="relative"
                zIndex={1}
                {...phoneShrink}
                backgroundColor="canvas"
                width={desktopExperience ? '100%' : undefined}
                maxWidth={desktopExperience ? 720 : undefined}
                alignSelf={desktopExperience ? 'center' : undefined}
                testID="room-bottom-chrome"
              >
                {/* Phone turn chrome overlays the fixed transcript tail.
                Its canvas fits below the whole newest row, including reactions;
                the label balances against the composer's field border rather
                than the stack edge. Desktop keeps its unchanged in-flow slot. */}
                {!desktopExperience && (
                  <TurnBandSlot testID="hanging-turn-chrome" onTopInset={setTurnChromeTopInset}>
                    {composerAck ? (
                      <TurnProgressLine
                        label={composerAck.label}
                        live={composerAck.live}
                        startedAt={composerAck.startedAt}
                        received={composerAck.received}
                        stopping={stoppingThisTurn}
                        onStop={
                          composerAck.stop
                            ? () => void handleStopTurn(composerAck.stop!)
                            : undefined
                        }
                        testID="turn-progress-line"
                      />
                    ) : settledTurn ? (
                      <TurnSettledLine line={settledTurn.line} testID="turn-settled-line" />
                    ) : null}
                  </TurnBandSlot>
                )}
                {/* No pinned corner line lives here. A Room holds many corners at
                once, so one line above the composer could only ever name one of
                them, and it sat between the reader and the field they were
                typing in. The Room's corners door in the header is the one way
                in; the corner's own state is read there, in the corners list,
                and on the Room-list row. */}
                  {transcriptHydrationFailed && !!transcriptHydrationError && <IndexRow title={transcriptHydrationError} testID="room-read-error" />}
                {isReadOnlyDirectMessage ? (
                  <>
                    <YStack
                      paddingHorizontal="4"
                      paddingTop="4"
                      paddingBottom={readOnlyFooterInset.paddingBottom === undefined ? '2' : 0}
                      borderTopWidth={1}
                      borderTopColor="stroke"
                      backgroundColor="canvas"
                      alignItems="center"
                    >
                      <T v="meta" color="secondary">
                        Announcements only · you can't reply here
                      </T>
                      {readOnlyFooterInset.paddingBottom === undefined ? null : <YStack height={readOnlyFooterInset.paddingBottom} />}
                    </YStack>
                    {readOnlyFooterInset.marginBottom === undefined ? null : <YStack height={readOnlyFooterInset.marginBottom} />}
                  </>
                ) : (
                  <YStack
                    position="relative"
                    {...phoneShrink}
                    paddingHorizontal="4"
                    paddingTop="2"
                    // The Room-open geometry's 1px edge, painted as the same opaque canvas.
                    borderTopWidth={1}
                    borderTopColor="canvas"
                    backgroundColor="canvas"
                  >
                    {slashMenuVisible &&
                      (() => {
                        const mentionAgent = mentionSlashAgentPubkey
                          ? agentByPubkey.get(mentionSlashAgentPubkey)
                          : undefined;
                        const mentionAgentName = mentionSlashAgentPubkey
                          ? resolveAgentDisplayIdentity(mentionSlashAgentPubkey, mentionAgent).name
                          : undefined;
                        return (
                          <SlashVerbPicker
                            verbs={slashVerbs}
                            query={currentSlashQuery ?? mentionSlash?.query ?? ''}
                            highlightedIndex={highlightedSlashVerbIndex}
                            onDismiss={dismissSlashMenu}
                            onSelect={runSlashVerb}
                            commands={mentionAgentCommands}
                            agentName={mentionAgentName}
                            agentLacksCommands={mentionAgentLacksCommands}
                            onSelectCommand={selectAgentCommand}
                          />
                        );
                      })()}
                    {mentionMenuVisible && (
                      <MentionSuggestionMenu
                        highlightedIndex={highlightedMentionIndex}
                        keyboardOpen={keyboardHeight > 0}
                        matches={mentionSuggestions.matches}
                        onSelect={selectMention}
                        overflow={mentionSuggestions.overflow}
                        personAvatar={(pubkey) => personProfileByPubkey.get(pubkey)?.avatar}
                        place={mentionPlace}
                      />
                    )}
                    {channelMenuVisible && (
                      <ChannelSuggestionMenu
                        highlightedIndex={Math.min(
                          highlightedMentionIndex,
                          channelSuggestions.matches.length - 1,
                        )}
                        keyboardOpen={keyboardHeight > 0}
                        matches={channelSuggestions.matches}
                        onSelect={selectChannel}
                        overflow={channelSuggestions.overflow}
                        query={activeChannel?.query ?? ''}
                      />
                    )}
                    {cornerOpenRepoPrompt && (roomRepoAccessIssue ? (
                      <ErrorBanner inline title={roomRepoAccessIssue.reason === 'revoked' ? 'Access to this repo was revoked' : 'This repo isn’t in the Beeline installation'}
                        description={`${roomRepoAccessIssue.fullName} must be reconnected before a ${CORNER_LABEL} can open.`}
                        retryLabel={roomRepoAccessIssue.reason === 'not_granted' ? 'Add this repo to the Beeline installation' : `Connect ${roomRepoAccessIssue.fullName.split('/')[0]}`}
                        retryDestination="external"
                        onRetry={() => void handleReconnectRoomRepository()} retryTestID="corner-open-repo-connect"
                        secondaryAction={{ label: 'Dismiss', onPress: () => setCornerOpenRepoPrompt(false), testID: 'corner-open-repo-prompt-dismiss' }} testID="corner-open-repo-prompt" />
                    ) : (
                      <YStack
                        minWidth={0}
                        marginBottom="2"
                        padding="2"
                        borderWidth={1}
                        borderLeftWidth={3}
                        borderColor="strongStroke"
                        backgroundColor="highlight"
                        testID="corner-open-repo-prompt"
                      >
                        <T v="metaStrong" textTransform="uppercase">
                          {`THIS ${ROOM_LABEL.toUpperCase()} ISN’T LINKED TO A REPO`}
                        </T>
                        <T v="meta" color="secondary" marginTop="1">
                          {`Pick one to open a ${CORNER_LABEL}.`}
                        </T>
                        {canManageWorkspace ? (
                          <RepoPicker
                            draftContext={decodedId}
                            busy={roomRepoBusy}
                            candidates={roomRepoCandidates}
                            installations={githubInstallations}
                            currentKey={null}
                            error={roomRepoError}
                            notice={roomRepoNotice}
                            ownerGrant={ownerGrant}
                            onAddAccount={() => void handleAddGitHubAccount()}
                            onAskOwnerGrant={(fullName) => void handleAskOwnerGrant(fullName)}
                            onCreateRepository={handleCreateGitHubRepository}
                            onManageInstallation={(installation) =>
                              void handleManageGitHubInstallation(installation)
                            }
                            onSelect={handleSelectRoomRepoCandidate}
                            testIDPrefix="corner-open-repo-picker"
                          />
                        ) : (
                          <T v="meta" color="secondary" marginTop="1">
                            Ask a {ROOM_LABEL} admin to link one.
                          </T>
                        )}
                        <Button
                          label="Dismiss"
                          variant="quiet"
                          accessibilityLabel="Dismiss"
                          onPress={() => setCornerOpenRepoPrompt(false)}
                          testID="corner-open-repo-prompt-dismiss"
                        />
                      </YStack>
                    ))}
                    {desktopExperience ? (
                      <XStack
                        alignItems="center"
                        accessibilityLiveRegion="polite"
                        testID="desktop-message-status"
                      >
                        {/* The shared thinking line's full box, held while idle so the desktop composer stays still. */}
                        <YStack height={TURN_LINE_BOX_HEIGHT} />
                        <YStack flex={1} minWidth={0} justifyContent="center">
                        {desktopDeliveryState === 'sending' ? (
                          <T v="code" color="secondary" paddingHorizontal="4">SENDING…</T>
                        ) : null}
                        {composerAck ? (
                          <TurnProgressLine
                            inset={false}
                            label={composerAck.label}
                            live={composerAck.live}
                            startedAt={composerAck.startedAt}
                            received={composerAck.received}
                            stopping={stoppingThisTurn}
                            onStop={
                              composerAck.stop
                                ? () => void handleStopTurn(composerAck.stop!)
                                : undefined
                            }
                            testID="turn-progress-line"
                          />
                        ) : desktopDeliveryState && desktopDeliveryState !== 'sending' ? (
                          <T v="code" color={desktopDeliveryState === 'failed' ? 'removed' : 'secondary'} paddingHorizontal="4">
                            {desktopDeliveryState === 'delivered'
                              ? 'DELIVERED'
                              : 'Message failed · retry from the message'}
                          </T>
                        ) : settledTurn ? (
                          <TurnSettledLine line={settledTurn.line} testID="turn-settled-line" />
                        ) : null}
                        </YStack>
                      </XStack>
                    ) : null}
                    <ConversationComposer
                      isDirectMessage={isDirectMessage}
                      placeholder={composerPlaceholder}
                      hasAgentMembers={Boolean(roomSurface?.members.some(member => member.identity.kind === 'agent'))}
                      voice={!isCorner && roomSurface?.members.some(member => member.identity.kind === 'agent') ? voice : undefined}
                      onStop={
                        composerAck?.stop ? () => handleStopTurn(composerAck.stop!) : undefined
                      }
                      inputRef={composerRef}
                      reply={
                        replyTarget
                          ? {
                              handle: replyTarget.authorHandle ?? replyTarget.authorName,
                              preview: replyTarget.preview,
                            }
                          : undefined
                      }
                      onCancelReply={() => setReplyTarget(null)}
                      tagHandles={composerTagHandles}
                      attachments={pendingAttachments.map((attachment) => ({
                        uri: attachment.uri,
                        name: attachment.name,
                        mimeType: attachment.mimeType,
                        sizeLabel: formatAttachmentSize(attachment.size),
                        uploadState: attachmentUploader.state(attachment),
                      }))}
                      attachmentsUploading={sending}
                      onRemoveAttachment={(index) =>
                        replacePendingAttachments((current) =>
                          current.filter((_, attachmentIndex) => attachmentIndex !== index),
                        )
                      }
                      onRetryAttachment={(index) => {
                        const attachment = pendingAttachments[index];
                        if (!transport || !attachment) return;
                        void transport
                          .ensureClient()
                          .then((client) => attachmentUploader.start(client, [attachment]))
                          .catch(() => undefined);
                      }}
                      speechHints={speechHints}
                      value={inputText}
                      inputRevision={composerInputRevision}
                      isInputRevisionCurrent={(inputRevision) =>
                        inputRevision === composerInputRevisionRef.current
                      }
                      height={composerHeight}
                      maxHeight={COMPOSER_MAX_HEIGHT}
                      focused={composerFocused}
                      disabled={sending}
                      canSend={
                        slashMenuVisible
                          ? Boolean(inputText.trim())
                          : Boolean(
                              splitComposerTags(inputText, composerTagHandles).rest.trim() ||
                              pendingAttachments.length,
                            )
                      }
                      onAttach={chooseAttachment}
                      attachDisabled={sending}
                      containerProps={
                        desktopExperience
                          ? ({
                              onDragOver: (event: React.DragEvent<HTMLElement>) =>
                                event.preventDefault(),
                              onDrop: handleDesktopDrop,
                            } as any)
                          : undefined
                      }
                      onDesktopPaste={desktopExperience ? handleDesktopPaste : undefined}
                      onChangeText={(value) => {
                        inputTextRef.current = value;
                        setInputText(value);
                      }}
                      onContentSizeChange={handleContentSizeChange}
                      onFocus={() => setComposerFocused(true)}
                      onBlur={() => setComposerFocused(false)}
                      onKeyPress={(event) => {
                        const action = mentionKeyboardAction(event.nativeEvent.key);
                        // Printable keys must never be prevented by the mention
                        // picker. In particular, `>` is ordinary composer text.
                        if (slashMenuVisible) {
                          if (!action) return;
                          if (action === 'select') {
                            event.preventDefault();
                            selectHighlightedPaletteItem();
                          } else if (
                            (action === 'next' || action === 'previous') &&
                            paletteItemCount
                          ) {
                            event.preventDefault();
                            const direction = action === 'next' ? 1 : -1;
                            setHighlightedSlashVerbIndex(
                              (current) =>
                                (current + direction + paletteItemCount) % paletteItemCount,
                            );
                          } else {
                            event.preventDefault();
                            dismissSlashMenu();
                          }
                          return;
                        }
                        if (!suggestionCount) {
                          const desktopAction = desktopComposerKeyAction(
                            Platform.OS,
                            event.nativeEvent.key,
                            Boolean(
                              (event.nativeEvent as unknown as { shiftKey?: boolean }).shiftKey,
                            ),
                          );
                          if (desktopAction === 'send') {
                            event.preventDefault();
                            void handleSend();
                          }
                          return;
                        }
                        if (!action) return;
                        if (action === 'select') {
                          event.preventDefault();
                          const index = Math.min(highlightedMentionIndex, suggestionCount - 1);
                          if (mentionMenuVisible) {
                            const selected = mentionSuggestions.matches[index];
                            if (selected) selectMention(selected);
                          } else {
                            const selected = channelSuggestions.matches[index];
                            if (selected) selectChannel(selected);
                          }
                        } else if (action === 'next' || action === 'previous') {
                          event.preventDefault();
                          const direction = action === 'next' ? 1 : -1;
                          setHighlightedMentionIndex(
                            (current) =>
                              (Math.min(current, suggestionCount - 1) +
                                direction +
                                suggestionCount) %
                              suggestionCount,
                          );
                        } else {
                          event.preventDefault();
                          setDismissedMentionKey(
                            mentionMenuVisible ? mentionMenuKey : channelMenuKey,
                          );
                        }
                      }}
                      onSelectionChange={(event) => {
                        const nextSelection = event.nativeEvent.selection;
                        setInputSelection((current) =>
                          current.start === nextSelection.start && current.end === nextSelection.end
                            ? current
                            : nextSelection,
                        );
                      }}
                      onSend={
                        slashMenuVisible
                          ? () => {
                              selectHighlightedPaletteItem();
                            }
                          : (dictated?: DictatedSend) => handleSend(undefined, dictated)
                      }
                    />
                    <Motion motion={composerBottomInset} />
                  </YStack>
                )}
              </YStack>);
});
