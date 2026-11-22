# Composer and suggestion audit

Scope: the approved reply line, horizontal thumbnail tray, and # menu. The brief and DESIGN.md govern the product language; the audit does not redesign navigation, buttons, transport, or transcript rendering.

## Implementation verdict

The implementation uses the existing composer frame, SuggestionCard/Row, icon set, typography, themes and CloseButton. It adds a house radius token (3 px), retains the transcript radius token (10 px) for the composer, and gives the existing close control an optional thumbnail-corner placement without reducing its target.

## Evidence

- Both themes render at phone and desktop widths with the real production components and fonts. The before/after images sit next to the approved mock.
- Measured whole-composer height stays (196 px) with either one or six attachments. Previously it grew from (227 px) to (394 px).
- The thumbnail row measures (48 px) high. Each remove button measures (44 × 44 px), including the reply cancel control. Each thumbnail has the house radius and no surrounding card, border, count label or gradient. Non-image thumbnails use the raised fill; the dark remove badge is (18 px), inset (2 px), with its original (44 px) target.
- A synthesized Chromium touch swipe at phone width (320 px) scrolls the strip (50 px) and retains text-field focus. This is a browser touch test, not a claim about native keyboard gestures.
- Uploading thumbnails are dimmed and expose a named, accessible, politely announced busy state. No spinner mounts in the attachment tray. Failed uploads retain a separately reachable Retry action alongside the thumbnail without increasing row height.
- Reply content stays on one truncated line. The text field grows through four lines and then scrolls within its (92 px) limit.
- The # menu has one title, the current chat first with “this chat”, then threads. The keyboard window is three (56 px) rows, followed by the remaining count.
- Mobile typecheck, UI component policy, grammar policy, design lint and calm lint pass. Focused component/hook/data tests pass (50 tests). The Impeccable mechanical source detector returned no findings; `detector.json` preserves its result.

## Audit assessment

| Dimension | Score | Evidence or limit |
| --- | --- | --- |
| Accessibility | 3/4 | Named controls, busy announcements, measured targets; native screen-reader traversal needs a device pass. |
| Performance | 3/4 | Fixed thumbnail geometry, no upload animation or per-file vertical cards; no physical-device profiling claim. |
| Appearance and theming | 4/4 | Both product themes, shared tokens/fonts/icons, no new component family. |
| Platform conformance | 3/4 | Existing native controls and scroll semantics retained; native iOS gesture verification remains outstanding. |
| Adaptivity | 3/4 | Phone/web geometry and browser touch checked; native iOS keyboard behavior remains outstanding. |

Total: (16/20), with the remaining uncertainty in native-device verification rather than an invented perfect score.

The house’s approved (44 pt) close targets take precedence over the audit reference’s generic Android (48 dp) recommendation. The approved product font and icon set likewise take precedence over the generic platform font/icon recommendations.

Android component fixture evidence is in `native/`: both themes with the native keyboard, sideways scrolling, attachment removal and reply cancellation. The keyboard remains open during these controls; the outer keyboard coordinator is a fixture, so full chat integration still needs device verification.

## Verification boundaries

The host is Linux and has no `xcrun` command or iOS Simulator. A supplemental WebKit route downloaded successfully but could not launch because host GTK/GStreamer/AVIF libraries are absent; a WebKit browser would not establish native iOS correctness anyway. Native iOS horizontal scrolling with the keyboard open remains a device verification step before release.
