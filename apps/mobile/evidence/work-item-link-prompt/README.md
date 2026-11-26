# Work-item link prompt, invalid-link alert, and Beeline link routing — Visual Evidence

## Scope & Limits

1. **Live `web.usebeeline.app` check:** Opened `https://web.usebeeline.app` via Trusty Squire (`session_id: cf718e6f-e938-485b-8f22-03dfa68f2daf`, closed after inspection) in the existing signed-in `Methoxine's team` session and navigated to Tasks (`/beeline/tray`). That live deployment runs production (`d481038e`) rather than this unmerged PR branch, and Connectors confirmed `beeline-reviewer-bypass` / `play-review-login-link` is a sealed login-link credential with no sealed-link navigation tool (no raw secret was fetched, and no live production data was mutated). Post-deploy reviewer-bypass verification on live `web.usebeeline.app` remains pending until release.
2. **Built-PR web verification (attached screenshots):** Exported the PR branch's production Expo web bundle (`npx expo export --platform web`) and ran it at `https://web.usebeeline.app/beeline/tray` in headless Google Chrome (`1280×800`, `@2x`) in both Light Stone and Dark Stone with a local WebSocket responder implementing the `PhoneOperationMap` contract (`listWorkspaces`, `readWorkBoard`, `attachToWorkItem`, `resolveChatLinks`, `readRoom`).
3. **Real stacking bug caught and fixed by this check:** On first run, `SheetFrame` (`apps/mobile/sources/ui/grammar.tsx`) rendered via Tamagui's `<Sheet modal>` portal at `z-index: 10001`, covering React Native Web's `<Modal>` (`z-index: 9999`) used by `Modal.actionSheet`, `Modal.prompt`, and `Modal.alert`. Setting `zIndex={5000}` and `portalProps={{ zIndex: 5000 }}` on `<Sheet>` (with `<Sheet.Overlay zIndex={4999}>`) keeps sheets above in-page chrome (`<= 2000`) and below modal dialogs (`9999`), allowing natural pointer interaction with `Add attachment` -> `Link`, `Add link`, and `Invalid link`.

## Captures

- `web-add-link-prompt-light.png` — Light Stone: `Add link` modal dialog stacked in front of `WorkSheet`, showing the updated `https:// or Beeline link` placeholder.
- `web-invalid-link-alert-light.png` — Light Stone: `Invalid link` refusal alert (`Enter an http(s) URL or a Beeline place or message link.`) after submitting `not a link`.
- `web-beeline-link-attached-light.png` — Light Stone: Saved `#phone-api-errors` attachment chip after submitting `#beeline/phone-api-errors` via `attachToWorkItem`; clicking the chip resolves `↳phone-api-errors` via `resolveChatLinks` and navigates to `/beeline/chat/bb5098ac-f35a-4621-a1cc-bea9ac87dc71?parent=c512f7d2-b7c7-4086-a989-49a8766d88e5&title=phone-api-errors`.
- `web-add-link-prompt-dark.png` — Dark Stone: `Add link` modal dialog stacked in front of `WorkSheet`.
- `web-invalid-link-alert-dark.png` — Dark Stone: `Invalid link` refusal alert in Dark Stone.
