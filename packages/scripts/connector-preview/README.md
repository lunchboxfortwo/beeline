# Connector landing Room artwork

The two `apps/server/assets/mcp/landing/room-*.png` files are product artwork,
not QA screenshots. They show a static example conversation rendered from the
app's `LedgerEntry` (including `IdentityMark`) and `ConversationComposer`
under an inline `#general` title in the theme's hero type, in the actual Bone
and Obsidian themes. No private Room
content or service connection is used. Native services and motion are stubbed;
the UI implementations and theme tokens remain real.

To refresh after changing those components:

1. From the repository root, run `node packages/scripts/connector-preview/build.mjs`.
2. Open `.scratch/room-preview/index.html?theme=bone` with `chrome-devtools-axi`.
3. Resize to 390 × 640 and wait for fonts and faces to render. Capture to
   `apps/server/assets/mcp/landing/room-bone.png`.
4. Repeat with `?theme=obsidian` for `room-obsidian.png`.

The App Store SVG and Google Play PNG are the unmodified English badges from
Apple's `tools.applemediaservices.com/api/badges/download-on-the-app-store/black/en-us`
and Google's `play.google.com/intl/en_us/badges/static/images/badges/en_badge_web_generic.png`.
The landing embeds artwork and badges as data images under the existing CSP;
visiting it does not contact an app store until the person chooses its link.

Keep full-page QA screenshots outside git and attach them to the PR.
