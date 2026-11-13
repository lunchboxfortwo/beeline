import React from 'react';
import { Separator, XStack, YStack } from 'tamagui';
import { Btn, HEIGHT, Inked, T } from '@/ui/grammar';
import { CHEVRON_BACK_SIZE, ChevronGlyph } from './ChevronGlyph';

/** Shared title text for headers whose surrounding controls own the layout. */
export function PageHeaderTitle(props: React.ComponentProps<typeof T>) {
  return <T v="heading" {...props} />;
}

export interface PageHeaderProps {
  /** The section's one title. */
  title: string;
  /** Optional second line under the title. */
  meta?: string;
  /** Workspace context above the section title. */
  eyebrow?: string;
  /** Uses the large page-title treatment shared by profile-shaped surfaces. */
  prominent?: boolean;
  /** Count aligned with the title block's trailing edge. */
  trailing?: string;
  /** What a screen reader says for `trailing`, when the bare text is not enough. */
  trailingAccessibilityLabel?: string;
  /** One control after the trailing text, such as a page's add button. */
  action?: React.ReactNode;
  /** Renders the back control when provided. */
  onBack?: () => void;
  backAccessibilityLabel?: string;
  backTestID?: string;
  titleTestID?: string;
  testID?: string;
}

/**
 * The one page header for a full-bleed section on desktop: title, optional
 * meta line, optional back control, left-aligned at the content pane's own
 * inset. The navigation stack header centers a legacy max-width column on
 * desktop, so a section that draws its own header uses this instead.
 */
export function PageHeader({
  title,
  meta,
  eyebrow,
  prominent = false,
  trailing,
  trailingAccessibilityLabel,
  action,
  onBack,
  backAccessibilityLabel = 'Back',
  backTestID,
  titleTestID,
  testID,
}: PageHeaderProps) {
  return (
    <YStack testID={testID}>
      {/* The Corners page's inset, which every section page now shares. */}
      <XStack minHeight={HEIGHT.sheetRow} paddingVertical="1" paddingHorizontal="2" alignItems="center">
        {onBack ? (
          <Btn kind="icon" label={backAccessibilityLabel} accessibilityRole="button" onPress={onBack} testID={backTestID}>
            <Inked color="ink" glyph={ChevronGlyph} direction="left" size={CHEVRON_BACK_SIZE} />
          </Btn>
        ) : null}
        <YStack flex={1} minWidth={0}>
          {eyebrow ? <T v="meta" color="secondary" numberOfLines={1}>{eyebrow}</T> : null}
          <PageHeaderTitle v={prominent ? 'title' : 'heading'} accessibilityRole="header" testID={titleTestID}>
            {title}
          </PageHeaderTitle>
          {meta ? <T v="meta" color="secondary" marginTop="1">{meta}</T> : null}
        </YStack>
        {/* Reserved and right-aligned so a count ends at the same x for 9 and for 10. */}
        {trailing ? (
          <T v="meta" color="secondary" minWidth={24} paddingHorizontal="2" textAlign="right" accessibilityLabel={trailingAccessibilityLabel}>
            {trailing}
          </T>
        ) : null}
        {action}
      </XStack>
      <Separator borderColor="stroke" />
    </YStack>
  );
}
