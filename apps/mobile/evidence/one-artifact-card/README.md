# Reproduction ONE-SHAPE

A picked image used the small composer upload strip after Send, because the send
hook awaited upload before adding a transcript row. A later history read could
also swap a posted file between pill and card based on optional decoration.

## Real path and controlled boundary

`native-proof.tsx` mounts the production `ChatSurfaceComposer` (including its
Send control), `useChatComposerSend`, `OrdinaryLedgerMessage`, `ArtifactCard`,
`ArtifactMedia`, and immutable image byte owner in an Expo Router web app.
It does not render an artifact card directly. The controlled transport holds
upload completion, signs/enqueues locally, then returns a committed row. Refresh
reads an undecorated history DTO and runs `displayRoomMessage` before rendering
the same production row. Metadata and image download are controlled at the
socket/session transport boundary. `shot.png` is valid PNG data copied from the
repository's store icon; the real byte loader and browser decode it.

`serve.mjs` temporarily selects the proof entry and Tamagui's native image
export through React Native Web, restoring both configurations on exit. That
adapter is necessary because the installed Tamagui web export accepts `src`
instead of the phone's `source` prop. No shipping image component is modified.
No real account, production write, emulator, or second phone connection is used.

## Reproduced

The held-upload send regression fails on reviewed head `71ab52cdb`: no message
row exists before upload completes. `before-light-sending.png` and
`before-dark-sending.png` capture that head's compact composer strip after the
actual Send press using the same controlled upload.

The original decorated/undecorated row regression is retained in
`RoomMessageVariants.test.tsx`. The extended send regression is in
`send-confirmation-path.test.tsx`; the existing composer regression now also
checks that the picked-file strip disappears only while sending and returns
when sending ends.

## Demonstrated

For each theme, press Send with upload held, resolve upload, then refresh history
with artifact decoration omitted. `light-sending.png`, `light-settled.png`,
`light-refreshed.png` and their `dark-` counterparts show the complete card.
`capture.mjs` asserts every card fits the viewport and keeps exactly the same
width and height. It waits for decoded image pixels in the last two states.
`measurements.json` records identical bounds in every state and theme:
x=60, y=199, width=354, height=362 at a 430×1000 viewport.

## Repeat

From the repository root, run:

```sh
node apps/mobile/evidence/one-artifact-card/serve.mjs
# In another terminal after Metro is ready:
node apps/mobile/evidence/one-artifact-card/capture.mjs
```

Stop the server with Ctrl-C to restore the shipping entry and Metro resolver.
For the before capture, use the reviewed head's send hook and composer surface
with this same proof harness, then run `capture.mjs --before`.

## Native limitation accepted by the commander and reviewer

The earlier native attempt found no installed Metro-loading dev build; building
one required writes under the read-only mobile dependency mount. The accepted
stand-in is this built React Native Web path. Native captures are not an
additional blocker, and production/device verification follows release.
