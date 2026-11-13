# Attachment loading proof

Reproduction ATTACHMENT-LOADING: open an ordinary transcript image attachment with its bytes pending, then resolve the original request. The loading View takes roughly half the row, squeezing metadata; the loaded image returns to its square thumbnail.

The rig extracts the actual AttachmentCard and its styles from their current owners and imports the production ArtifactImage unchanged. It uses React Native Web and the production Bone/Obsidian tokens and fonts. Byte delivery and unrelated navigation/recovery services are controlled stand-ins. The failure IndexRow is a copy-only stub: this rig asserts failure selection, not its layout. Deferred rows use the production glyph branch.

Run from the repository root:

```sh
BEFORE=1 node proof/attachment-loading/build.mjs
BEFORE=1 node proof/attachment-loading/run.mjs
node proof/attachment-loading/build.mjs
node proof/attachment-loading/run.mjs
```

Before mode restores the old growing placeholder style. The runner captures loading/loaded screenshots at phone and desktop widths in both themes, verifies the wrong baseline, then verifies exact equality of thumbnail, copy and row bounds across pending-to-loaded after the fix. It checks filename/type/size, deferred rows and failure selection. Generated screenshots, bundles and JSON results are ignored.

Observed at phone width (393): loading preview before (177.5 × 46), loaded (46 × 46); after both (46 × 46). Metadata space grows from (145.5) to (277). Desktop loading before (341 × 46), after (46 × 46).

Native proof was attempted through the granted existing emulator host/device, local shell, alternate shell and approved host command. No adb executable was available (host route: `spawn adb ENOENT`). No emulator was started. Phone-sized React Native Web rendering is the closest available stand-in; native renderer behavior still needs device confirmation.
