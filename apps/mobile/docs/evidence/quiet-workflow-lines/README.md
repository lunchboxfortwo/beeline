# Quiet workflow lines: before and after

Captured on 2026-11-28 from two Expo web exports of this branch: one with the previous `transcript-pills.ts` (before) and one with this change (after). A temporary route, not committed, fed the same transcript rows through the real `readRoomViewMessage`, `displayRoomMessage`, `foldTranscriptRows` and `useChatTranscriptRenderer`. Headless Chrome took the shots. "Phone" is a 390×844 mobile viewport at 2× scale. "Web" is 1280×800. Bone and Obsidian are the app's light and dark themes.

Rows in the transcript, oldest first:

1. Person message.
2. Run start: "Ruby started workflow morning-card-2026-11-28 · run 215b8d09".
3. Answered gate card: "Start both of today's Backlog fixes?".
4. Gate answer: "lunchboxfortwo picked start_all · at choose so run 215b8d09 went to fix_all".
5. Person message.
6. Normal finish: "Ruby handed off done · run 215b8d09 of morning-card-2026-11-28".
7. Agent message.
8. Failed run: "Ruby handed off blocked · run 9a41c2e0 went to failed".
9. Cancelled run, a System notice. It sits inside the existing system pill in both builds.

After the change, rows 2, 4 and 6 are gone. The gate card, the failed-run line and the cancelled-run notice still show. Nothing else changes.

- [Contact sheet](before-after.png)
- Before: [phone Bone](before-phone-bone.png), [phone Obsidian](before-phone-obsidian.png), [web Bone](before-web-bone.png), [web Obsidian](before-web-obsidian.png)
- After: [phone Bone](after-phone-bone.png), [phone Obsidian](after-phone-obsidian.png), [web Bone](after-web-bone.png), [web Obsidian](after-web-obsidian.png)

These are not native Android captures. After release, the live #beeline reproduction from the brief (28 Nov around 09:08 ET) is the device check.
