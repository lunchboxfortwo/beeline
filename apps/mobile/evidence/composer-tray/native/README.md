> Historical gesture evidence captured before the document-fill and inset-badge correction. Current appearance is shown in the regenerated web comparisons.

# Android native component evidence

These are genuine Android emulator screenshots of the production ConversationComposer in an isolated Expo Go fixture. They are supplemental component evidence, not authenticated chat or end-to-end upload evidence. The top buttons and gear are fixture/Expo controls, outside the product.

- Bone and Obsidian: six document attachments with a reply and the native keyboard open; Obsidian also includes one attachment. The composer frame occupies the same vertical bounds in each case.
- A leftward swipe through twelve attachments moves the strip to its end (the dimmed second item leaves view), while the text caret and native keyboard remain visible.
- Tapping the first attachment close control removes it (six becomes five); tapping reply close removes the reply. Both preserve the keyboard.

The fixture uses real native TextInput and ScrollView, production fonts/themes, and idle voice/network components. Its outer KeyboardAvoidingView substitutes for chat-screen keyboard coordination. Therefore this verifies the attachment strip gesture with a native keyboard, but does not replace a full ChatSurface integration pass. Expo Go uses SDK-compatible Worklets/Reanimated/SVG versions; repository dependency directories were restored after capture. The fixture’s bulk replacement from twelve files to one retained the old scroll offset until a rightward swipe; that capture is excluded. Native iOS remains untested.

Native iOS sideways scrolling, attachment removal and reply cancellation with the keyboard open are untested; lunchboxfortwo waived this check by choosing “Ship it”, as recorded by Ruby in Beeline message `4faa0374e1e2424f75023294a1936646a62d84ce7e25d078db06be9b7b2a416b`.
