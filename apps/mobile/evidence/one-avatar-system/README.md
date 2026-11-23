# One persisted agent avatar

Human intent: one avatar system, with Claude's real artwork in both the sender chip and message header. Approval: lunchboxfortwo's go-ahead in message `610d48024580425798e51db08324c552ba80c73a032d0f9a45dcce1ef3742c98`, delivered in the thread brief. The supplied Android screenshot is attached to that brief as `claude-avatar-30980.jpg`.

## Authority traced

- `daemon/models.ts:daemonAgentAvatar` stores generated artwork in `agent_avatars`, writes its immutable URL to `identities.avatar`, and removes legacy soul artwork.
- `rooms-mcp-members.ts:replaceMcpMemberAvatar` stores profile pictures in the same table and writes the same identity field.
- `phone/agent-configuration.ts:phoneUpdateAgentSoul` retains stored artwork ahead of any legacy soul URL.
- `phone-identity.ts` projects that identity field; `room-view-presentation.ts:memberAgent` carries it into mobile presentation.
- `agent-display.ts` formerly selected `soulProfile.avatar` whenever a soul existed, even if absent or stale. It now reads only the projected identity avatar. Its fallback seed is the identity pubkey, matching direct identity consumers.
- `IdentityMark` already accepts the shared stored `/v1/agent-avatars/` format. Its missing/failed artwork fallback remains the existing assigned face. No new renderer or URL resolution path is needed.

## Reproduction and proof

Stand-in: canonical persisted profile artwork plus a soul without artwork, passed through the real resolver, PillRow and TranscriptLine. The prior resolver drops the portrait; the corrected resolver retains it. Conflicting soul artwork and a missing canonical portrait are regression cases too.

Live attempts: the shared Android emulator was available and had Beeline installed, but opening the supplied #apm room returned “This request was refused.” The attempted app.usebeeline.com browser URL returned DEPLOYMENT_NOT_FOUND. The actual web.usebeeline.app session showed a different workspace with only #general and System, so it was closed without further access. Live #apm reproduction was not established; screenshots use representative fixtures, not Claude's private artwork or a production session.

Recent-work check: GitHub's avatar search found repository-picture work and the merged default-profile onboarding change (PR 76); neither changes this resolver or its competing soul artwork choice.

Visual scope: replace the incorrect fallback with the canonical portrait. No component geometry, typography, person avatar or workspace avatar changes.

## Rendered evidence

Actual PillRow, TranscriptLine, IdentityMark, grammar and Tamagui theme components, bundled for the browser with native-service adapters. The before frame uses the original resolver from the checkout's base revision; after uses the changed resolver. The representative persisted image is the existing `ai-app-pages/fixture/avatar-assets/00000000-0000-4000-8000-000000000001` fixture, served at the canonical avatar route. Phone frames are a phone-sized web viewport, not a native binary proof.

| Viewport / theme | Before | After |
| --- | --- | --- |
| Phone / Bone | [before](phone-bone-before.png) | [after](phone-bone-after.png) |
| Phone / Obsidian | [before](phone-obsidian-before.png) | [after](phone-obsidian-after.png) |
| Web / Bone | [before](web-bone-before.png) | [after](web-bone-after.png) |
| Web / Obsidian | [before](web-obsidian-before.png) | [after](web-obsidian-after.png) |

## Validation

- The canonical-artwork regression cases fail against the original resolver (four failures), then pass with this fix.
- Focused mobile suites pass: IdentityMark, room-view-presentation and room-indicators.multiple (forty-six tests).
- Mobile typecheck, UI component policy and diff whitespace checks pass.
