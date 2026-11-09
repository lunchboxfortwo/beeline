# Reply preserves the reading position

Reproduction swipe-reply-1: Android, `#thinking-line-79`, long message beginning
“Reproduction swipe-reply-1” with (45) reading markers; scroll into its middle,
then swipe left. The installed app jumped from the reading markers to its newest
messages and opened the reply composer. The installed APK's bundled source is
unknown; its version is recorded in [source-manifest.json](source-manifest.json).
The original installed-app recording accompanies the corner report.

The paired native replay measures that same event using the shipped
`SwipeToReply`, `useChatMessageActions`, `useChatCornerActions`, `RoomSendList`,
scroll controller and keyboard layout policy. It renders a long native text row
about three screens tall and an actual Android text input/keyboard. It starts at
an offset of (1200 dp), or (3150 physical px). Before uses the reply handler from
commit `f461c5f32c69f60471a702b5854af182f75d52cc`; after removes its request for
the newest message. Both runs use the same APK and harness. Source and APK
hashes are in the manifest.

| Native path | Offset change | Reading marker change relative to composer |
| --- | --- | --- |
| Before: left swipe through keyboard open | −3150 px | −3150 px |
| After: left swipe through keyboard open | 0 px | 0 px |
| After: tap reply through keyboard open | 0 px | 0 px |
| After: right swipe through corner callback | 0 px | 0 px |
| After: reply while already at newest end | 0 px | 0 px |

[measurements.json](measurements.json) retains the unrounded measurements. The
history reading marker stayed approximately (119 px) above the composer; its
post-fix numerical difference is less than (0.001 px). The native scroll event
stream reports only the starting history offset throughout the after swipe,
keyboard, tap and corner sequence. The glyph remains visible during the middle
swipe, without any change to its appearance or gesture thresholds. At the tail,
the newest message remains visible above the focused composer.

## Proof boundary

The installed release APK runs its installed bundle rather than worktree source.
To keep its signed-in session intact, paired changed-source verification uses a
separate locally built Android app (`app.usebeeline.swipeproof`). This is a native
component-and-handler replay, not a patched signed-in production Room. Reply
installation, the gesture, list and keyboard are real; roster/network inputs are
inert fixtures. The right swipe calls the real begin-corner handler and observes
its prompt setter; the confirmation sheet is represented by a visible receipt,
and no corner is created.

The temporary native project uses a distinct application id and push provider
authority, and omits the Google Services Gradle plugin for that distinct id.
Native dependency source is unchanged. A private writable dependency copy is
needed because Gradle writes into native packages; a private daemon registry
avoids shared stop commands. The proof was built for Android API (35), at
(1080 × 2340 px), density (420 dpi), with React Native (0.83.1). No iOS simulator
proof was run: this Linux host has no `xcrun`.

## Repeat

Use an approved existing emulator; never start one for this proof. In a private
mobile copy at the same directory depth as `apps/mobile`, build a debug APK with
the package/provider changes above. Copy [native-proof.tsx.txt](native-proof.tsx.txt)
to the mobile copy's `swipe-proof.tsx`, and make its temporary entry import that
file. Use the ordinary Metro configuration, excluding only that copy's native
Android build directory from its watcher. Serve Metro at port (18889) and reverse
that port through the approved adb server.

Load the baseline handler into the private source tree for the before run, and
the changed handler for after. Cold-start the proof app with its development
client URL and dismiss the development menu. Check that the fixture is visible
before capturing; warm re-entry after Android Back can leave a blank dev surface.
Copy [capture.py](capture.py) to `/tmp/swipe-reply-1/capture.py`, then run it with
`before` or `after`. The script's adb endpoint/device must match the current
grant. The `tail` mode records the tail case separately after a fresh cold start.
The script saves native receipts, screenshots and videos. Compare each
`before-reply` receipt with `keyboard-open`, and `before-corner` with
`after-corner`. Offset must stay equal and the anchor difference must round to
zero physical pixels after the fix.

## Regression and checks

The new reply-handler test uses the real reply target and scroll controller with
the native event's history offset. It fails before the change by resetting that
offset to zero, then passes after removal of the jump. The parameterized tail
case also verifies that the existing keyboard layout policy keeps tail follow.
See [test-before.txt](test-before.txt) and [test-after.txt](test-after.txt).

Root typecheck, the mobile UI scanner, architecture checks and the scoped reply,
message-row and transcript tests passed (17 tests). The full mobile suite was
left to CI; local validation targeted the changed action and its transcript
neighbors. iOS proof was skipped for the host limitation above.
