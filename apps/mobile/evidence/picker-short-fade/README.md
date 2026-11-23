# Command picker: fade only lists that scroll

Reproduction R1: in a thread, type `@niglet /restar`. Before, the picker shows one row,
/restart, with "Restart this agent" faded by the bottom edge. After, the description is at
full contrast. A list longer than the card (eight commands) still fades its bottom edge.

- `android-picker-fade.png`: Android emulator (API 36, 1080x2400), Bone and Obsidian.
  Columns: one command before, one command after, eight commands after.
- `web-picker-one-after.png`: web (Chrome, 390x844), one command after, Bone and Obsidian.
  Web never drew the fade (`fadingEdgeLength` is Android-only), so it is unchanged.

How it was run: a throwaway Expo Go entry rendered the production `SlashVerbPicker`
(and, for "before", the file from main) above a focused text field with the keyboard open.
Expo Go's native Reanimated and keyboard controller are older than the app's, so the
fixture swapped those two for JavaScript stand-ins; neither affects the picker's
ScrollView or its fade. The top buttons are fixture controls, not product UI. The
fixture was not committed.
