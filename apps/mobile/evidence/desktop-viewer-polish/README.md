# Desktop RHS Viewer Polish — Visual Evidence

Built-PR captures rendered in headless Chromium from the production React Native Web + Tamagui components (`ChatListHeader`, `PlaceHeader`, `DesktopViewerPane`, `DesktopArtifactPane`, `ComputerSessionViewer`, `ViewerHeader`, `BrowserViewerFrame`, and `desktop-layout-state`) alongside the approved Stone mock.

## Files

- `approved-mock-stone.png` — Rendered screenshot of the approved Stone Before & After mock (`Desktop RHS viewer before & after (Stone)`).
- `after-light-stone-1440-artifact.png` — Light Stone (`1440×900`): 3-pane desktop with sandboxed HTML artifact open in `DesktopArtifactPane`, 1px Stone hairline divider, aligned 52px top-bar baseline across Sidebar/Chat/Viewer, and no duplicate desktop `TalkDock`.
- `after-dark-stone-1440-artifact.png` — Dark Stone (`1440×900`): 3-pane desktop with sandboxed HTML artifact open in `DesktopArtifactPane`.
- `after-light-stone-1440-browser.png` — Light Stone (`1440×900`): 3-pane desktop with `ComputerSessionViewer` (`desktop={true}`) streaming a live rendered browser frame inside its iframe, unified 52px Stone header with live status dot, title, `Open in browser`, and close button, and no duplicate `TalkDock`.
- `after-dark-stone-1440-browser.png` — Dark Stone (`1440×900`): 3-pane desktop with `ComputerSessionViewer` (`desktop={true}`) streaming a live rendered browser frame inside its iframe.
- `after-light-stone-1080-narrow-tuck.png` — Light Stone (`1080×800`, `< 1280px`): narrow desktop auto-tucking the left sidebar cleanly without oscillation.
- `after-dark-stone-1080-narrow-tuck.png` — Dark Stone (`1080×800`, `< 1280px`): narrow desktop auto-tucking the left sidebar cleanly without oscillation.
