import { StyleSheet } from 'react-native-unistyles';
import { cornerHeaderAgent } from '@/buzz/corner-display-state';
import { roomBottomChromeStyles, TURN_LINE_BOX_HEIGHT } from '@/buzz/room-bottom-chrome';
import { Typography } from '@/constants/Typography';
import { HULL_SHEET_INSET } from '@/components/buzz/HullActionSheet';



export const styles = StyleSheet.create((theme) => {
  const groknight = theme.buzz;
  const bottomChrome = roomBottomChromeStyles(groknight);
  return {
    container: {
      flex: 1,
      backgroundColor: groknight.bgTerminal,
    },
    keyboardBody: {
      flex: 1,
    },
    starPrompt: { paddingTop: groknight.space.md },
    agentProfilePane: {
      width: 380,
      maxWidth: '50%',
      borderLeftWidth: StyleSheet.hairlineWidth,
      borderLeftColor: groknight.border,
    },
    desktopConversationFrame: {
      flex: 1,
      minWidth: 0,
      flexDirection: 'row',
      position: 'relative',
    },
    desktopStatusSlot: {
      // The shared thinking line is a 24px row plus the fixed 9px gap.
      // Holding that full box while idle keeps the desktop composer still.
      minHeight: TURN_LINE_BOX_HEIGHT,
      justifyContent: 'center',
    },
    desktopStatusText: {
      ...theme.buzz.type.machine,
      paddingHorizontal: groknight.space.md,
      color: groknight.dim,
    },
    desktopStatusFailed: {
      color: groknight.danger,
    },
    center: {
      alignItems: 'center',
      justifyContent: 'center',
    },
    loadingText: {
      ...theme.buzz.type.sectionHead,
      fontFamily: groknight.monoSemibold,
      marginTop: groknight.space.sm,
      color: groknight.textMuted,
    },

    // ── Room / corner actions sheet ──────────────────────────────────
    // The sheet itself, its rows and its trailing vocabulary live in
    // `components/buzz/HullActionSheet.tsx`. What is left here is only what
    // hangs BETWEEN rows: the rename editor and the picker's inset.
    roomRenameEditor: {
      paddingHorizontal: HULL_SHEET_INSET,
      paddingVertical: groknight.space.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: groknight.border,
    },
    roomRenameLabel: {
      ...Typography.default(),
      ...theme.buzz.type.meta,
      color: groknight.textMuted,
    },
    roomRenameInput: {
      ...Typography.default('semiBold'),
      ...theme.buzz.type.body,
      minHeight: 44,
      marginTop: groknight.space.xs,
      paddingHorizontal: 0,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: groknight.borderStrong,
      color: groknight.textPrimary,
    },
    roomRenameControls: {
      marginTop: groknight.space.sm,
      flexDirection: 'row',
      justifyContent: 'flex-end',
      gap: groknight.space.sm,
    },
    // The sheet's one box: a notice the reader must act on, held to the same
    // trailing axis as the rows above it (DESIGN.md → Shape).
    membershipError: {
      marginHorizontal: HULL_SHEET_INSET,
      marginTop: groknight.space.sm,
      padding: groknight.space.sm,
      borderWidth: 1,
      borderColor: groknight.borderStrong,
      backgroundColor: groknight.bgHighlight,
    },

    // ── Message blocks ──────────────────────────────────────────────
    transcriptViewport: {
      flex: 1,
      position: 'relative',
    },
    messageList: {
      flex: 1,
    },
    // Desktop transcript only: a plain scrollable View over real DOM (no
    // FlatList/VirtualizedList) — see `shouldFollowDesktopTail` in
    // `buzz/room-scroll-follow.ts`. Mirrors RN Web's own vertical ScrollView
    // overflow (overflowX hidden, overflowY auto).
    desktopScroll: {
      overflowX: 'hidden',
      overflowY: 'auto',
      overflowAnchor: 'none',
    } as any,
    messageListContent: {
      paddingHorizontal: groknight.space.md,
      paddingVertical: groknight.space.md,
    },
    messageListContentDesktop: {
      width: '100%',
      maxWidth: 720,
      alignSelf: 'center',
      flexGrow: 1,
      justifyContent: 'flex-end',
    },
    messageListContentEmpty: {
      flexGrow: 1,
    },

    // ── Archived notice ─────────────────────────────────────────────
    archivedBubble: {
      paddingVertical: 8,
      marginBottom: groknight.space.md,
      alignSelf: 'center',
      maxWidth: '90%',
    },
    archivedText: {
      ...theme.buzz.type.sectionHead,
      fontFamily: groknight.monoRegular,
      color: groknight.ledgerQuiet,
      textAlign: 'center',
    },

    // ── Composer ────────────────────────────────────────────────────
    emptyState: {
      flexGrow: 1,
    },
    // The stack and the composer row are one measured column —
    // `buzz/room-bottom-chrome.ts` owns both. The turn line is an absolute
    // overlay on the stack's top edge, styled inside `TurnBandSlot`; it takes
    // no height in this column.
    desktopReadingColumn: { width: '100%', maxWidth: 720, alignSelf: 'center' },
    bottomChromeStack: bottomChrome.stack,
    inputBar: bottomChrome.composerRow,
    // No longer drawn. The UI component policy fingerprints the header's
    // `insets.top` through this file's last `top:` style, so removing this
    // entry would read as a changed legacy header.
    tagMenuBackdrop: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
    // Under the composer's tag menu: a tap anywhere else closes the menu.
    repoPromptBanner: {
      minWidth: 0,
      marginBottom: groknight.space.sm,
      padding: groknight.space.sm,
      borderLeftWidth: 3,
      borderWidth: 1,
      borderColor: groknight.borderStrong,
      backgroundColor: groknight.bgHighlight,
    },
    repoPromptTitle: {
      ...theme.buzz.type.sectionHead,
      fontFamily: groknight.monoSemibold,
      color: groknight.textPrimary,
    },
    repoPromptHint: {
      ...theme.buzz.type.meta,
      marginTop: groknight.space.xs,
      color: groknight.textMuted,
    },
    repoPromptConnect: { minHeight: 40, justifyContent: 'center', marginTop: groknight.space.sm },
    repoPromptConnectText: {
      ...theme.buzz.type.meta,
      fontFamily: groknight.proseSemibold,
      color: groknight.accent,
    },
    archivedInputBar: {
      paddingHorizontal: 16,
      paddingTop: groknight.space.md,
      paddingBottom: 8,
      borderTopWidth: 1,
      borderTopColor: groknight.border,
      backgroundColor: groknight.bgBase,
      alignItems: 'center',
    },
    archivedInputText: {
      ...theme.buzz.type.meta,
      color: groknight.muted,
    },
    cornerArchivedInputText: { ...Typography.mono('italic'), color: groknight.textMuted },
  outboxFailure: {
      marginTop: 4,
      marginHorizontal: 8,
      padding: 8,
      borderWidth: 1,
      borderColor: groknight.borderStrong,
      backgroundColor: groknight.bgHighlight,
    },
outboxFailureText: {
      ...theme.buzz.type.sectionHead,
      fontFamily: groknight.monoSemibold,
      color: groknight.textPrimary,
    },
outboxFailureActions: {
      flexDirection: 'row',
      gap: 8,
      marginTop: groknight.space.sm,
    },
replySwipeAction: {
      width: 78,
      marginBottom: 8,
      alignItems: 'center',
      justifyContent: 'center',
      borderLeftWidth: 1,
      borderLeftColor: groknight.borderStrong,
      backgroundColor: groknight.bgHighlight,
    },
replySwipeGlyph: {
      ...theme.buzz.type.body,
      fontFamily: groknight.proseSemibold,
      color: groknight.textPrimary,
    },
replySwipeLabel: {
      ...theme.buzz.type.sectionHead,
      fontFamily: groknight.monoSemibold,
      marginTop: groknight.space.xs,
      color: groknight.textMuted,
    },
replyReference: {
      minWidth: 0,
      marginBottom: groknight.space.xs,
    },
replyReferenceText: {
      ...theme.buzz.type.machine,
      color: groknight.ledgerGhost,
    },
attachmentCard: {
      minWidth: 0,
      width: '100%',
      minHeight: 58,
      marginTop: 8,
      paddingVertical: groknight.space.sm,
      flexDirection: 'row',
      alignItems: 'center',
      gap: groknight.space.sm,
    },
attachmentThumbnail: {
      width: 46,
      height: 46,
      backgroundColor: groknight.bgHighlight,
    },
attachmentFileGlyph: {
      width: 46,
      height: 46,
      alignItems: 'center',
      justifyContent: 'center',
    },
attachmentFileGlyphText: {
      ...theme.buzz.type.hero,
      color: groknight.steel,
    },
attachmentCopy: { flex: 1, minWidth: 0 },
attachmentName: {
      ...theme.buzz.type.body,
      fontSize: groknight.transcriptCard.rowTitleSize,
      color: groknight.textPrimary,
    },
attachmentMeta: {
      ...theme.buzz.type.machine,
      fontSize: groknight.transcriptCard.rowKindSize,
      marginTop: groknight.space.xs,
      color: groknight.textMuted,
    },
attachmentOpenGlyph: {
      ...theme.buzz.type.body,
      width: 22,
      color: groknight.steel,
      textAlign: 'center',
    },
activityGroup: {
      width: '100%',
      minWidth: 0,
      marginBottom: groknight.space.md,
    },
previewLinkRow: {
      marginTop: groknight.space.sm,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      minWidth: 0,
    },
previewLinkLabel: {
      ...theme.buzz.type.machine,
      fontFamily: groknight.monoSemibold,
      color: groknight.textPrimary,
      flexShrink: 0,
    },
previewLinkUrl: {
      ...theme.buzz.type.machine,
      color: groknight.textMuted,
      flexShrink: 1,
      minWidth: 0,
    },
targetBranchCard: {
      minWidth: 0,
      marginBottom: 8,
      paddingHorizontal: groknight.space.md,
      paddingVertical: groknight.space.md,
      borderWidth: 1,
      borderColor: groknight.borderStrong,
      gap: 8,
    },
targetBranchTitle: {
      ...theme.buzz.type.bodyStrong,
      color: groknight.textPrimary,
    },
targetBranchChange: {
      ...theme.buzz.type.machine,
      fontFamily: groknight.monoSemibold,
      color: groknight.textPrimary,
    },
targetBranchBoundary: {
      ...theme.buzz.type.meta,
      color: groknight.textSecondary,
    },
targetBranchActions: { flexDirection: 'row', gap: 8 },
targetBranchButton: { flex: 1, minWidth: 0 },
targetBranchStatus: {
      ...theme.buzz.type.sectionHead,
      fontFamily: groknight.monoSemibold,
      color: groknight.textSecondary,
    },
writePermissionCard: {
      minWidth: 0,
      marginBottom: 8,
      paddingHorizontal: groknight.space.md,
      paddingVertical: groknight.space.md,
      borderWidth: 1,
      borderColor: groknight.borderStrong,
      gap: groknight.space.sm,
    },
githubEventPressable: { marginBottom: 8 },
githubEventCard: {
      minWidth: 0,
      paddingHorizontal: groknight.space.md,
      paddingVertical: groknight.space.md,
      borderWidth: 1,
      borderColor: groknight.borderStrong,
      gap: groknight.space.sm,
    },
githubEventTitle: {
      ...theme.buzz.type.bodyStrong,
      color: groknight.textPrimary,
    },
githubEventLink: {
      ...theme.buzz.type.machine,
      fontFamily: groknight.monoSemibold,
      color: groknight.textSecondary,
    },
writePermissionHeading: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: groknight.space.sm,
    },
writePermissionCopy: { flex: 1, minWidth: 0 },
writePermissionTitle: {
      ...theme.buzz.type.bodyStrong,
      color: groknight.textPrimary,
    },
writePermissionIntent: {
      ...theme.buzz.type.meta,
      color: groknight.textMuted,
      marginTop: groknight.space.xs,
    },
writePermissionRepository: {
      ...theme.buzz.type.machine,
      fontFamily: groknight.monoSemibold,
      color: groknight.textPrimary,
    },
writePermissionBoundary: {
      ...theme.buzz.type.meta,
      color: groknight.textSecondary,
    },
writePermissionFailure: {
      ...theme.buzz.type.machine,
      color: groknight.textSecondary,
    },
writePermissionActions: { flexDirection: 'row', gap: 8 },
writePermissionButton: { flex: 1, minWidth: 0 },
writePermissionStatus: {
      ...theme.buzz.type.sectionHead,
      fontFamily: groknight.monoSemibold,
      color: groknight.textSecondary,
    },
};
});
