# Compact composer and chat mentions

Approval: lunchboxfortwo approved mock revision (3) in message `9ea5fd76cdc52eb6884d5e66cdb2206456e6594a749f2eb2e9786fe1e763ed5a`.

The comparison images place the previous production components, changed production components, and approved mock next to each other. There are separate comparisons for the # menu, one attachment with reply, and six attachments with reply; Bone and Obsidian; phone and web. `before/` and `after/` contain the full original captures.

The browser harness bundles the real ConversationComposer, ComposerChrome, ChannelSuggestionMenu, SuggestionCard/Row, themes, fonts, icons, and close controls. It replaces speech, network data, navigation and native services with idle fixtures. The phone captures are Chromium phone viewports with an explicitly labelled keyboard placeholder, not native screenshots. Fixture images are synthetic. The surrounding transcript and header are fixtures, not visual changes to the app. The unchanged microphone is hidden when the fixture reports speech unavailable.

## Measured behavior

`measurements.json` records the whole composer including staged content. On the phone, the previous composer grows from (227 px) with one file to (394 px) with six. The changed composer stays at (196 px) with either count, in both themes. The web composer likewise stays the same height for both counts.

`kit/capture.mjs` asserts equal height, thumbnail dimensions (48 px), remove targets (44 px), attachment and reply removal, one menu title, the overflow footer, and text scrolling after four lines (92 px). A synthesized Chromium touch swipe at a narrow phone width moves the thumbnail row while retaining input focus. The list window remains three rows of (56 px) when the keyboard is open.

## Reproduce web captures

From the repository root:

```sh
node apps/mobile/evidence/composer-tray/kit/build.mjs apps/mobile /tmp/composer-tray-before da5ea329b^
node apps/mobile/evidence/composer-tray/kit/build.mjs apps/mobile /tmp/composer-tray-after
python3 -m http.server 19372 --directory /tmp/composer-tray-before
python3 -m http.server 19371 --directory /tmp/composer-tray-after
node apps/mobile/evidence/composer-tray/kit/capture.mjs
```

Run the servers in separate terminals. Chromium uses `/usr/bin/google-chrome`. The build's optional revision argument retrieves the original production source directly from Git, without changing the checkout.
