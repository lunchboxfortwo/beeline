# Thread working label only during active turns (`thread-working-idle`)

Before and after screenshots render the production `ThreadBar`, `ThreadTitleBlock`, and `ThreadLine` components on Tamagui Bone (`light_brass`) and Obsidian (`dark_brass`) themes at phone (`411x880`) and web (`1100x900`) viewports with Space Grotesk and IBM Plex Mono fonts.

- `before-*` uses the pre-fix component sources at `66193ab1` with an in-progress thread whose server row still populated `workingAgentName` without a running turn.
- `after-*` uses the updated sources where `workingAgentName` is emitted only while the named agent has a live `agent_turns` row (`status = 'working'`), `useChatThreadHeader` gates `workingAgentName` on `roomSurface.latestAgentTurns` (`isAgentTurnActive`), and `threadListLabel` renders plain `in progress` when `state === 'working'` without an active turn.

## Intentional visual changes
- When no turn runs on an in-progress thread, `ThreadBar` omits `"<agent> is working"` and `ThreadLine` displays `"in progress"` instead of `"<agent> is working"`.
- When a turn is actively running, both `ThreadBar` and `ThreadLine` continue to display `"<agent> is working"` unchanged.
- No other visual, color, typography, or layout changes.
