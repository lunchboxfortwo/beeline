# Welcome language

Reproduction WELCOME-LANGUAGE-1: create a Workspace as a new Spanish-locale person, enter #general, and read Beebee’s welcome. Before the fix, the Room returned “Hi Charles” in English. The same happened with a Korean first message before playback. The new integrated Room-read regressions failed on the original implementation for both locale cases and both first-message cases.

Real production signup is replaced by isolated PGlite and local starter provisioning to avoid creating production identities or Fly Machines. `packages/scripts/prove-welcome-language.mts` exercises the built PhoneService, Workspace creation, onboarding playback and Room reads. It writes the actual welcome text to `.beeline-proof/welcome-language/result.json`.

Review regressions under the same Reproduction WELCOME-LANGUAGE-1: an English first message, “Can you translate hola for me?”, incorrectly produced Spanish; “Olá!” incorrectly produced English. Both integrated Room-read cases failed before the repair. The built-service proof also reproduced the English sentence returning Spanish. The proof now covers both messages: the English sentence retains the English welcome and the Portuguese greeting receives Portuguese. Latin greetings must lead the message, and their endings use Unicode letter boundaries, so a greeting embedded in a sentence is not treated as its language and accented greetings are recognized.

The follow-up review caught a regression for “¿Podemos hablar en español?” with an English device locale: it returned the English welcome. The added integrated Room-read case and the extended built-service proof both failed before repair. Spanish requests to speak, respond or write in Spanish can now appear within a sentence, independently of a leading greeting. The same proof verifies that this request receives “Hola Charles” while the earlier English-mention and Portuguese cases keep passing. No new visual captures are needed because the displayed English and Spanish welcome text is unchanged.

Run from the repository root after `npm run corner:prepare`:

```sh
npm run build --workspace=@beeline/server
mkdir -p .beeline-proof/welcome-language
node --import tsx packages/scripts/prove-welcome-language.mts
```

The fixed greeting has translations for English, Spanish, French, German, Portuguese, Italian, Korean, Japanese, Chinese, Russian and Arabic. Unsupported or malformed locales and conflicting first-message signals fall back to English. A clear first-message signal overrides the locale when the message precedes the greeting. Generated banter receives the same language instruction. Manual welcome runs retain the person's locale.

Visual proof: `phone-{en,es}-{bone,obsidian}.png` and `web-{en,es}-{bone,obsidian}.png` show the actual built Room-read text in the shared production `LedgerEntry` transcript component, with the app fonts and themes. Android captures use the existing booted emulator; web captures use Chromium at desktop width. The small harness exposes language/theme controls; it does not replace production signup or prove the surrounding full Room screen. Native UI hierarchy captures assert the expected greeting is visible in each case.

`result.json` is the built-service output. To repeat the visual stand-in, create a temporary `apps/mobile/welcome-language-proof/` directory, copy `render-entry.jsx` there as `index.js` and copy `result.json` beside it. Temporarily set the mobile package main to `welcome-language-proof/index.js`, run Expo from `apps/mobile`, and open it in the existing Beeline development client and Chromium. Select each language and theme. Restore the package main after capture. No proof controls ship in the app.

Completed follow-up validation: mobile transport tests (9) and the full root `npm run typecheck`, including mobile and scripts, pass after the managed mobile dependency mount.

Validation so far: server build/typecheck, built Room proof, all free-agent tests (40), banter tests (16), architecture, phone network channels, referenced paths and diff whitespace pass. The first full test attempt hit the existing 10-second initial migration hook timeout while builds ran concurrently; the suite passes with a 30-second hook budget. An earlier overlapping API-contract clean/build invalidated a test collection; rerunning after the build passed.
