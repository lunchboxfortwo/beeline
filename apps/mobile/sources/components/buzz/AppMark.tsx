import React, { useState } from 'react';
import { Image, YStack, useTheme, useThemeName } from 'tamagui';
import Svg, { Circle, Ellipse, Path } from 'react-native-svg';
import type { CompanyLogo } from '@beeline/api-contract/workbench';
import { DECORATIVE_GLYPH_PROPS } from './decorative-glyph';
import { T } from '@/ui/grammar';
import linearMark from '../../../assets/app-logos/linear.png';
import gmailMark from '../../../assets/app-logos/gmail.png';
import calendarMark from '../../../assets/app-logos/calendar.png';
import driveMark from '../../../assets/app-logos/drive.png';
import docsMark from '../../../assets/app-logos/docs.png';
import sheetsMark from '../../../assets/app-logos/sheets.png';
import slackMark from '../../../assets/app-logos/slack.png';
import notionMark from '../../../assets/app-logos/notion.png';
import hubspotMark from '../../../assets/app-logos/hubspot.png';
import airtableMark from '../../../assets/app-logos/airtable.png';
import asanaMark from '../../../assets/app-logos/asana.png';
import jiraMark from '../../../assets/app-logos/jira.png';
import supabaseMark from '../../../assets/app-logos/supabase.png';
import neonMark from '../../../assets/app-logos/neon.png';
import youtubeMark from '../../../assets/app-logos/youtube.png';
import runwayMark from '../../../assets/app-logos/runway.png';

const BUNDLED_MARKS: Record<string, number> = {
  linear: linearMark,
  gmail: gmailMark,
  'google calendar': calendarMark,
  'google drive': driveMark,
  'google docs': docsMark,
  'google sheets': sheetsMark,
  slack: slackMark,
  notion: notionMark,
  hubspot: hubspotMark,
  airtable: airtableMark,
  asana: asanaMark,
  jira: jiraMark,
  supabase: supabaseMark,
  neon: neonMark,
  youtube: youtubeMark,
  runway: runwayMark,
};

/** Bundled or server-provided mark; missing marks use the existing local glyph. */
export function AppMark({
  name,
  mark,
  domain,
  logo,
  size = 36,
  white = false,
  testID,
}: {
  name: string;
  /** Authoritative server logo; disables every legacy name/domain lookup. */
  mark?: CompanyLogo;
  domain?: string;
  logo?: string;
  size?: number;
  white?: boolean;
  testID?: string;
}) {
  const [failedUris, setFailedUris] = useState<string[]>([]);
  const imageSize = Math.round(size * 0.56);
  const bundled = mark ? undefined : BUNDLED_MARKS[name.toLowerCase()];
  const uri = mark ? (mark.kind === 'image' ? mark.uri : undefined) : bundled
    ? undefined
    : logo && !failedUris.includes(logo)
      ? logo
      : undefined;
  const showImage = uri && !failedUris.includes(uri);
  const dark = useThemeName().startsWith('dark');
  const ink = (useTheme() as Record<string, { val: string } | undefined>).ink?.val;
  const plate = showImage && mark?.kind === 'image' ? mark.plate : undefined;
  // A light plate stays light and a dark plate stays dark in either mode.
  const lightPlate = white || plate === 'light';
  return (
    <YStack
      testID={testID}
      width={size}
      height={size}
      borderRadius={size <= 28 ? 'sm' : 'md'}
      alignItems="center"
      justifyContent="center"
      overflow="hidden"
      backgroundColor={lightPlate ? (dark ? 'ink' : 'canvas') : plate === 'dark' ? (dark ? 'canvas' : 'ink') : 'raised'}
    >
      {!showImage && !bundled ? (
        domain || (mark && mark.kind !== 'monogram') ? (
          <Svg width={imageSize} height={imageSize} viewBox="0 0 24 24" fill="none" stroke={ink} strokeWidth={1.4} {...DECORATIVE_GLYPH_PROPS}>
            <Circle cx={12} cy={12} r={9} /><Ellipse cx={12} cy={12} rx={4} ry={9} /><Path d="M3 12h18M5 7h14M5 17h14" />
          </Svg>
        ) : <T v="heading">{name.slice(0, 1).toUpperCase()}</T>
      ) : null}
      {bundled ? (
        <Image
          accessibilityIgnoresInvertColors
          source={bundled}
          width={imageSize}
          height={imageSize}
        />
      ) : null}
      {showImage ? (
        <Image
          testID={testID ? `${testID}-icon` : undefined}
          accessibilityIgnoresInvertColors
          source={{ uri }}
          onError={() => setFailedUris((current) => [...current, uri])}
          width={imageSize}
          height={imageSize}
        />
      ) : null}
    </YStack>
  );
}
