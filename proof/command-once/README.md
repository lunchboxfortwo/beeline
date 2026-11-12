# Command approval choices

Reproduction COMMAND-ONCE-1. The fixture uses `argv: ["bash"]` and harmless stdin `printf check`; no requested command executes and no live grant changes.

The browser build mounts the production GrantRequestCard, AgentApprovalCard, TranscriptCard, grammar controls and Tamagui configuration. It replaces unused media, identity, ledger, keyboard and animation services. The before bundle reads the pre-fix GrantRequestCard from the parent of 23aa526; the after bundle reads the current checkout. All other card components are identical. The script is expanded in the captures.

Run from the repository root after mobile dependencies are prepared:

```sh
node proof/command-once/build.mjs
node proof/command-once/build.mjs --before
node proof/command-once/run.mjs
```

The automated browser path checks the missing/present Once control and presses it to verify the `once` callback. `results.json` records web and phone-width browser cases in Bone and Obsidian. Phone-width browser captures are a responsive web stand-in, not native phone proof.

The isolated built server path is `npm run prove:command-once` after the server build; it checks the offered actions, persisted `once` decision and settled Needs You tray. Historical production persistence remains unverified by this proof.


Native phone captures use the same production card stack in Expo Go on the authorized existing Android emulator. The native fixture disables unused animation and replaces SVG icons with same-footprint text glyphs because the installed Expo Go runtime has incompatible Worklets and SVG modules. A proof-only bootstrap exposes RN's internal pressability hook where this Tamagui version expects its public export. Identity/media services are unused stubs. Card anatomy, fact rows, script disclosure, decision controls, theme tokens and decision callbacks are production components. This is a built native component stand-in, not a production account or installed release proof.

After running the browser build (which also writes the historical native card), start Metro:

```sh
cd proof/command-once/native
ln -s ../../../apps/mobile/node_modules node_modules
EXPO_OFFLINE=1 EXPO_NO_TELEMETRY=1 EXPO_NO_DEPENDENCY_VALIDATION=1 CI=1 ../../../apps/mobile/node_modules/.bin/expo start --go --port 18943 --host lan --max-workers 1
```

Use only an authorized existing emulator. Reverse the Metro port to that device and open `exp://127.0.0.1:18943` in Expo Go. The fixture starts in Bone/Before. Open Script, capture, switch Before/After, reopen Script, capture. Switch Theme and repeat in Obsidian. The fixture's decision callback does not authorize a command.

| Platform/theme | Before | After |
| --- | --- | --- |
| Web Bone | [Before](web-bone-before.png) | [After](web-bone-after.png) |
| Web Obsidian | [Before](web-obsidian-before.png) | [After](web-obsidian-after.png) |
| Native phone Bone | [Before](native-phone-bone-before.png) | [After](native-phone-bone-after.png) |
| Native phone Obsidian | [Before](native-phone-obsidian-before.png) | [After](native-phone-obsidian-after.png) |

Before: Approve always and Deny. After: Always, Once and Deny. All captures expand the harmless stdin script. The after browser path also presses Once and verifies the distinct callback. This proof adds no product UI changes; production sign-in and live execution are intentionally skipped to avoid changing real grants.
