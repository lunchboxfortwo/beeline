# /draw-avatar for an agent with no published commands

Reproduction R2: the composer for an agent whose row has no published commands
showed "/draw-avatar is not a Beeline command". These PNGs render the real
`SlashVerbPicker` with `availableAgentMentionCommands([], '')` and the real
Tamagui config in the Bone theme (`light_brass`), through react-native-web in
Chrome at 390px (phone width) and 1180px (web width). They are browser
captures, not screenshots from a signed-in phone, and the app's own fonts were
not loaded, so text uses a fallback serif.

The menu now lists /restart, /login and /draw-avatar.
