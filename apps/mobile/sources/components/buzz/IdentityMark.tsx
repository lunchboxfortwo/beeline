import React, { useEffect, useState } from 'react';
import { Image, Platform } from 'react-native';
import { YStack, useTheme, useThemeName } from 'tamagui';
import Svg, { G, Path, Rect, SvgUri, Text as SvgText } from 'react-native-svg';
import { isConnectorLogoUrl } from '@beeline/api-contract/phone';
import {
  ALIVE_RING_PAD,
  CYPHER_MIN_SIZE,
  identityKindLabel,
  identityMarkGeometry,
  identityPalette,
  isGeneratedAgentAvatarUrl,
  type CypherCell,
  type IdentityKind,
  type IdentityPalette,
} from '@/buzz/identity-mark';
import { resolveFace } from '@/buzz/faces';
import { agentFaceLayers, personMarkInks } from '@/buzz/faces/face-tile';
import { SYSTEM_IDENTITY_PUBKEY } from '@/buzz/system-identity';
import beelineMark from '@/buzz/beeline-mark.json';
import brand from '@/buzz/brand.json';
import { DrawnType, Filled } from '@/ui/grammar';
import { HullLivePulse } from './MonoHull';

type IdentityMarkBaseProps = {
  /** The identity's stable seed: a pubkey for an agent or a person, the
   *  community id for a Workspace. Same seed, same mark, forever. */
  seed: string;
  size?: number;
  /** Workspace-rail selection: the mark's own heavier frame (`DESIGN.md`,
   *  "Index rows" — selection reads three redundant ways, none a box). */
  selected?: boolean;
  name?: string;
  /** A person's handle: the initial's source when there is no display name. */
  handle?: string;
  avatarUrl?: string;
  testID?: string;
};

type FaceProps = {
  /** The creature this identity chose (`RoomViewIdentity.face`). Absent or
   *  unknown → `defaultFaceForSeed(seed)`, so every reader draws the same one. */
  face?: string;
};

// Gold means ONE thing product-wide: an agent WORKING right now — its own
// fresh working receipt (`selectWorkingAgents`, the proof the thinking line
// reads). It is never delivery availability: a daemon can be
// online before it has claimed work, and a ring that meant "process alive"
// would not say the agent is working (C77). The discriminated union is
// that rule enforced at the type level — no human or Workspace mark can carry
// `alive`, so a future boolean pass cannot redefine gold without a type error.
export type AgentIdentityMarkProps = IdentityMarkBaseProps &
  FaceProps & {
    kind: 'agent';
    /** An agent working right now (turn or corner). Draws the gold ring;
     * never touches colour. Callers must not feed presence here. */
    alive?: boolean;
  };
export type HumanIdentityMarkProps = IdentityMarkBaseProps & FaceProps & { kind: 'human' };
export type WorkspaceIdentityMarkProps = IdentityMarkBaseProps & {
  kind: Exclude<IdentityKind, 'agent' | 'human'>;
};
export type NonAgentIdentityMarkProps = HumanIdentityMarkProps | WorkspaceIdentityMarkProps;
export type IdentityMarkProps = AgentIdentityMarkProps | NonAgentIdentityMarkProps;

// ── The face tile ────────────────────────────────────────────────────────────
//
// Agents are Speakeasy's twelve creatures (`buzz/faces`) on a plate in their
// hue. A person is their first initial in their hue on the person plate the
// animals use, framed the same way (build spec → Identity marks). The gold
// alive ring is drawn around the plate.

/** The one box radius in the product (`groknight.radius`). */
const FACE_PLATE_RADIUS = 3;

// The alive ring sits `ALIVE_RING_PAD` (`buzz/identity-mark.ts`) outside the
// plate: the mark's layout box stays `size` so tiles of both classes share one
// column edge, and the ring is the one thing that paints past it.

// ── The Workspace plate ──────────────────────────────────────────────────────

/** The plate fills its seat the way a Workspace picture does: inset only far
 *  enough that the selected frame's stroke is not clipped, with corners that
 *  follow the rail seat's curve (8px on a 36px picture ≈ 22%). */
const PLATE_INSET = 3;
const PLATE_SIDE = 100 - PLATE_INSET * 2;
const PLATE_RADIUS = 22 - PLATE_INSET;

/** The workspace cypher: speakeasy's 3×3 primitive plate — block, slot, cut,
 *  void — in our tones. A machined plate, never a QR code. The grid keeps the
 *  proportion it had inside the old square frame, and its cells carry a small
 *  radius so they sit with the rounded frame. */
const PLATE_GRID = 69;
const PLATE_ORIGIN = (100 - PLATE_GRID) / 2;
const PLATE_CELL = PLATE_GRID / 3;
const CELL_RADIUS = 2.4;

function plateRects(cell: CypherCell, index: number): Array<[number, number, number, number]> {
  const x = PLATE_ORIGIN + (index % 3) * PLATE_CELL;
  const y = PLATE_ORIGIN + Math.floor(index / 3) * PLATE_CELL;
  const inset = 2;
  const gap = 1.7;
  const span = PLATE_CELL - inset * 2;
  switch (cell.primitive) {
    case 'slot-h':
      return [[x + inset, y + PLATE_CELL / 2 - PLATE_CELL / 6, span, PLATE_CELL / 3]];
    case 'slot-v':
      return [[x + PLATE_CELL / 2 - PLATE_CELL / 6, y + inset, PLATE_CELL / 3, span]];
    case 'cut':
      return [
        [x + inset, y + inset, span, PLATE_CELL / 3 - gap],
        [x + inset, y + PLATE_CELL / 2 + gap, span, PLATE_CELL / 3 - gap],
      ];
    default:
      return [[x + inset, y + inset, span, span]];
  }
}

/** The half fill's left half, rounded on the left to match the frame and
 *  square along the centre line. */
function leftHalfPath(): string {
  const left = PLATE_INSET;
  const top = PLATE_INSET;
  const right = 50;
  const bottom = PLATE_INSET + PLATE_SIDE;
  const r = PLATE_RADIUS;
  return (
    `M${right} ${top}H${left + r}A${r} ${r} 0 0 0 ${left} ${top + r}` +
    `V${bottom - r}A${r} ${r} 0 0 0 ${left + r} ${bottom}H${right}Z`
  );
}

/** A person's generated mark: the first letter of the display name, else the handle. */
export function personInitial(name?: string, handle?: string): string {
  const source = (name?.trim() || handle?.trim() || '').replace(/^[@#]+/, '').trim();
  return (Array.from(source)[0] ?? '?').toUpperCase();
}

/** An uploaded photo or the sign-in provider photo stored on this identity. */
export function isPersonPictureUrl(avatarUrl?: string): boolean {
  if (!avatarUrl) return false;
  if (/\/v1\/person-avatars\/[0-9a-f-]{36}$/i.test(avatarUrl)) return true;
  try {
    const url = new URL(avatarUrl);
    return url.protocol === 'https:' && (url.hostname === 'avatars.githubusercontent.com' ||
      url.hostname.endsWith('.googleusercontent.com'));
  } catch { return false; }
}

function cellFill(cell: CypherCell, palette: IdentityPalette): string {
  // Hollow already has a deep field, where these pixels merge exactly as they
  // did before the fill axis. Painting them explicitly preserves that same
  // deep-tone cypher when the solid or half field behind it becomes lighter.
  if (cell.tone === 'void') return palette.deep;
  return cell.tone === 'bright' ? palette.bright : palette.mid;
}

function WorkspacePlate({
  seed,
  size,
  selected,
}: {
  seed: string;
  size: number;
  selected: boolean;
}): React.ReactElement {
  const { palette, fillState, cells, rotation } = identityMarkGeometry(seed, 'workspace');
  // Below the cypher floor the colour and the silhouette *are* the identity,
  // so the mark goes solid rather than muddy.
  const detailed = size >= CYPHER_MIN_SIZE;
  // The fill axis needs a coarse field, not another small detail. Solid and
  // hollow use the full silhouette; half overlays its left half. Below the
  // cypher floor the mark keeps the existing solid-size fallback.
  const visibleFillState = detailed ? fillState : 'solid';
  const bodyFill = visibleFillState === 'solid' ? palette.mid : palette.deep;
  const frameStroke = selected ? palette.bright : detailed ? palette.mid : palette.bright;
  const frameWidth = selected ? 6 : 3.5;
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Rect
        x={PLATE_INSET}
        y={PLATE_INSET}
        width={PLATE_SIDE}
        height={PLATE_SIDE}
        rx={PLATE_RADIUS}
        fill={bodyFill}
      />
      {visibleFillState === 'half' && <Path d={leftHalfPath()} fill={palette.mid} />}
      <Rect
        x={PLATE_INSET}
        y={PLATE_INSET}
        width={PLATE_SIDE}
        height={PLATE_SIDE}
        rx={PLATE_RADIUS}
        fill="none"
        stroke={frameStroke}
        strokeWidth={frameWidth}
      />
      {detailed && (
        <G transform={`rotate(${rotation * 90} 50 50)`}>
          {cells.map((cell, index) => {
            const fill = cellFill(cell, palette);
            return plateRects(cell, index).map(([x, y, width, height]) => (
              <Rect
                key={`${index}-${x}-${y}`}
                x={x}
                y={y}
                width={width}
                height={height}
                rx={Math.min(CELL_RADIUS, width / 2, height / 2)}
                fill={fill}
              />
            ));
          })}
        </G>
      )}
    </Svg>
  );
}

/**
 * The one identity mark in the product. Every avatar, handle mark, presence
 * dot, rail tile and corner top-bar renders this — there is no per-surface
 * variant, because "the amber fox" has to mean the same person on every
 * screen or the face is not a memory hook at all.
 *
 * Memoized for the same reason the marks it replaces were: it is rendered once
 * per transcript row inside a `renderItem` that is recreated on every presence
 * tick, and rebuilding a creature per row per tick is exactly the work that
 * froze the transcript. Every prop is a primitive, so a shallow compare bails
 * correctly.
 */
export const IdentityMark = React.memo(function IdentityMark(props: IdentityMarkProps) {
  const { seed, kind, size = 40, selected = false, name, handle, avatarUrl, testID } = props;
  // Defensive, not just typed: even a value smuggled past the union at runtime
  // (an untyped caller, a stale bundle) can only ever light gold on an agent.
  const alive = props.kind === 'agent' ? Boolean(props.alive) : false;
  const live = kind === 'agent' && alive;
  const theme = useTheme();
  const themeName = useThemeName();
  const dark = themeName.startsWith('dark');
  const stone = /^(dark|light)_stone(_|$)/.test(themeName);
  const [failedAvatar, setFailedAvatar] = useState<string | null>(null);
  // Connector speakers use their server-owned SVG marks rather than a person's photo.
  const showConnectorLogo =
    kind === 'human' && isConnectorLogoUrl(avatarUrl) && failedAvatar !== avatarUrl;
  // The server keeps uploaded photos ahead of stored sign-in provider photos.
  // Both fill the same identity tile; a missing or failed image uses the initial.
  const showGeneratedAvatar =
    kind === 'agent' && Boolean(isGeneratedAgentAvatarUrl(avatarUrl) && failedAvatar !== avatarUrl);
  const showPersonPicture =
    kind === 'human' && isPersonPictureUrl(avatarUrl) && failedAvatar !== avatarUrl;
  const showRelayAvatar = kind === 'workspace' && Boolean(avatarUrl && failedAvatar !== avatarUrl);

  useEffect(() => setFailedAvatar(null), [avatarUrl]);

  const label = `${name ?? identityKindLabel(kind)}, ${identityKindLabel(kind)}${live ? ', working' : ''}`;

  if (kind === 'human' && seed === SYSTEM_IDENTITY_PUBKEY) {
    return (
      <YStack
        accessibilityLabel="System, Beeline logo"
        alignItems="center"
        justifyContent="center"
        width={size}
        height={size}
        testID={testID ?? 'identity-system-logo'}
      >
        <Svg
          // `accessible` is a native-only View prop: react-native-svg forwards it
          // to the DOM on web, where React rejects `accessible={true}` as a
          // non-boolean attribute. Web gets the same public contract in DOM
          // terms — one element named as an image; native keeps the prop it
          // actually understands.
          {...(Platform.OS === 'web'
            ? { role: 'img' as const, 'aria-label': 'Beeline logo' }
            : { accessible: true, accessibilityLabel: 'Beeline logo' })}
          width={size}
          height={size}
          viewBox="40 40 160 160"
        >
          <G transform={beelineMark.transform}>
            <Path
              d={beelineMark.path}
              fillRule={beelineMark.fillRule as 'evenodd' | 'nonzero'}
              fill={brand.mark}
            />
          </G>
        </Svg>
      </YStack>
    );
  }

  if (kind === 'workspace') {
    return (
      <YStack accessibilityLabel={label} alignItems="center" justifyContent="center" width={size} height={size} testID={testID}>
        {showRelayAvatar ? (
          <Filled
            view={Image}
            onError={() => setFailedAvatar(avatarUrl ?? null)}
            resizeMode="cover"
            source={{ uri: avatarUrl! }}
          />
        ) : (
          <WorkspacePlate seed={seed} size={size} selected={selected} />
        )}
      </YStack>
    );
  }

  if (showConnectorLogo) {
    return (
      <YStack
        accessibilityLabel={label}
        alignItems="center"
        justifyContent="center"
        borderRadius="sm"
        overflow="hidden"
        width={size}
        height={size}
        testID={testID}
      >
        <SvgUri
          onError={() => setFailedAvatar(avatarUrl ?? null)}
          uri={avatarUrl!}
          width={size}
          height={size}
          testID="identity-connector-logo"
        />
      </YStack>
    );
  }

  const face = resolveFace(props.face, seed);
  const palette = identityPalette(seed, kind);
  const mode = dark ? 'dark' : 'light';
  // Plate polarity IS the class read: ink plate under a coloured person, hue
  // plate under an ink agent.
  const personInks = personMarkInks(mode, stone ? 'stone' : 'brass');
  const plate = kind === 'agent' ? palette.mid : personInks.plate;
  const ringSide = size + ALIVE_RING_PAD * 2;

  if (kind === 'human') {
    // One image named once: the letter is SVG text, so the tile is the image
    // and its label is what a screen reader hears.
    return (
      <YStack
        accessibilityLabel={label}
        accessibilityRole="image"
        accessible
        alignItems="center"
        justifyContent="center"
        width={size}
        height={size}
        testID={testID}
      >
        <YStack position="relative" borderRadius="sm" overflow="hidden" width={size} height={size} testID="identity-face-plate">
          {showPersonPicture ? (
            <>
              <PlateFill size={size} fill={plate} />
              <Filled
                view={Image}
                source={{ uri: avatarUrl! }}
                resizeMode="cover"
                onError={() => setFailedAvatar(avatarUrl ?? null)}
                testID="identity-person-picture"
              />
            </>
          ) : (
            // The initial in the person's hue; on the cream plate it carries
            // the animals' Ink contrast edge, because the hue alone is too faint.
            <Svg width={size} height={size} viewBox="0 0 100 100" testID="identity-person-initial">
              <Rect width={100} height={100} fill={personInks.plate} />
              {mode === 'light' ? (
                <DrawnType view={SvgText} v="heading" size={56} x={50} y={69} textAnchor="middle"
                  fill={personInks.outline} stroke={personInks.outline} strokeWidth={5} strokeLinejoin="round">
                  {personInitial(name, handle)}
                </DrawnType>
              ) : null}
              <DrawnType view={SvgText} v="heading" size={56} x={50} y={69} textAnchor="middle" fill={palette.mid}>
                {personInitial(name, handle)}
              </DrawnType>
            </Svg>
          )}
        </YStack>
      </YStack>
    );
  }

  return (
    <YStack position="relative" accessibilityLabel={label} alignItems="center" justifyContent="center" width={size} height={size} testID={testID}>
      <YStack position="relative" borderRadius="sm" overflow="hidden" width={size} height={size} testID="identity-face-plate">
        {/* The plate in the agent's hue, under its portrait or creature. */}
        {showGeneratedAvatar ? <PlateFill size={size} fill={plate} /> : null}
        {showGeneratedAvatar ? (
          <Filled
            view={Image}
            source={{ uri: avatarUrl! }}
            resizeMode="cover"
            onError={() => setFailedAvatar(avatarUrl ?? null)}
            testID="generated-agent-avatar"
          />
        ) : (
          <Svg width={size} height={size} viewBox="0 0 100 100">
            <Rect width={100} height={100} fill={plate} />
            {agentFaceLayers(face)}
          </Svg>
        )}
      </YStack>

      {/*
        Gold means one thing product-wide: an agent is working. It is drawn
        *around* the plate, never on the creature or its colour, so it can
        never be confused with the identity underneath — who you are and what
        you are doing stay two separate reads. It breathes on the shared live
        clock, and is mounted only when something is genuinely live, so a
        quiet row pays for no animation at all.
      */}
      {live && (
        <YStack
          position="absolute"
          left={-ALIVE_RING_PAD}
          top={-ALIVE_RING_PAD}
          right={-ALIVE_RING_PAD}
          bottom={-ALIVE_RING_PAD}
        >
        <HullLivePulse>
          <Svg width={ringSide} height={ringSide} viewBox={`0 0 ${ringSide} ${ringSide}`}>
            <Rect
              x={2}
              y={2}
              width={ringSide - 4}
              height={ringSide - 4}
              rx={FACE_PLATE_RADIUS + 2}
              fill="none"
              stroke={theme.needsYou?.val}
              strokeWidth={4}
              opacity={0.14}
            />
            <Rect
              x={2}
              y={2}
              width={ringSide - 4}
              height={ringSide - 4}
              rx={FACE_PLATE_RADIUS + 2}
              fill="none"
              stroke={theme.needsYou?.val}
              strokeWidth={1.5}
            />
          </Svg>
        </HullLivePulse>
        </YStack>
      )}
    </YStack>
  );
});

/** The tile's plate colour, drawn as the layer under its picture or creature. */
function PlateFill({ size, fill }: { size: number; fill: string }) {
  return (
    <YStack position="absolute" top={0} left={0}>
      <Svg width={size} height={size} viewBox="0 0 100 100">
        <Rect width={100} height={100} fill={fill} />
      </Svg>
    </YStack>
  );
}
