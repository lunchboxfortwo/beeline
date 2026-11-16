# Agent prompt and invitation audit

Jellybean, 11 November 2026. Reproduction `onboarding-prompt-1`.

People asking how to add an agent received a generic connector answer that omitted device, account plan and delivery requirements. The same answer also appeared in the free-agent soul. Ruby reported the abandoned iPhone onboarding conversation; this corner does not claim to replay that person's private account.

## Evidence boundary

Ruby independently verified both public endpoint aliases, resource metadata, PKCE S256 and dynamic registration, plus the published join/connect commands. That establishes the server protocol and command existence, not host UI availability or successful tagged replies. Human sign-in, native phone controls and automatic delivery remain Ruby's validation work. The built isolated HTTP reproduction exercises the real server, command authority, connect handler and serialized response against PGlite with synthetic identities. No production daemon, pairing, account or credential is touched.

## Fanout inventory

| Source | Finding | Result |
| --- | --- | --- |
| `apps/server/src/free-agents.ts`: hello, seeded soul, current-policy replacement | Computer-first helper directions; duplicated connector steps; saved souls retained old restrictions | Compact shared invitation lookup; device/plan question; refresh removes old paragraphs and is idempotent; shared product explanation |
| `apps/server/src/daemon/apps.ts`: connect next | One generic response for different hosts; missing Gemini/Codex/helper; ambiguous listing status | Returns assistant-specific canonical guidance without provisioning an external app |
| `packages/api-contract/src/agent-invitation-guide.ts` | No common invitation vocabulary | Owns endpoint, assistant aliases, prerequisites, device limits, alternatives and connector/session/helper results |
| `apps/body/src/minimal-tool-surface-ordinary-tools.ts`: connect description | No clue that connect can answer invitation/product questions | Advertises the existing ensure route for on-demand guidance; no extra tool/schema |
| `apps/body/src/beeline-skill.ts`: full and free connecting skills | Service setup instructions did not explain product or agent invitation differences | Both use shared product and invitation pointers; free variant retains its actual browser limits |
| `apps/body/src/beeline-skill.ts`: files, corners, wakes, memory, triage, spec, review, onboarding | Mechanics are already separated by task; welcome rerun is not an agent invitation | Retained; connect is the invitation lookup. J6/private checker behavior untouched |
| `apps/body/src/prompt-assembly.ts`: session/turn sections | Adding the entire matrix would exceed session budgets | No new always-on section; tool description and on-demand skills carry lookup. An attempted extra session line exceeded the fixed ceiling and was removed before delivery |
| `apps/body/src/monolith-room-turn-prompt.ts`, `monolith-corner-turn-prompt.ts`, `codex-prompt-delivery.ts`, `pi-session-instructions.ts`, `acp-prepare-prompt-delivery.ts` | Harness wrappers/delivery, not separate product authorities | Continue using canonical assembler; no invitation copy added |
| `apps/body/src/agent-home-provision-agent-skills-and-mcp.ts`, `agent-home-plan-managed-skills.ts` | Installed skills are derived from the managed skill generator | Shared lookup reaches full/free generated skill variants without hand-editing installed files |
| `packages/api-contract/src/mcp-starter-routine.ts` | Correct ownership/delivery checks existed but generic instructions pushed tool names onto people | Explicitly makes first connected agent reply perform checks; person only sends tagged task |
| `packages/api-contract/src/external-agent-rules.ts`, `mcp-delivery.ts`, `mcp-muse-recipe.ts` | External hosts have bounded tools and different inbound capabilities | Retained actual delivery authority and owner-approved Muse task; no new polling/webhook route |
| `apps/server/assets/mcp/join.html`, `apps/site/connect/index.html` | Two advertised server URLs; web instructions used last-handled cursor despite owed-tag semantics | Generate each public assistant/path block from the shared guide; pin its exact copy; correct owed-tag catchup to no cursor |
| `apps/server/src/rooms-mcp-onboarding.test.ts` | Referenced implementation file was retired; surviving test covers published Muse recipe | Retain recipe coverage; new connect integration/snapshot suite covers actual guidance |
| `apps/server/src/starter-onboarding.ts`, `starter-onboarding-run.ts`, `starter-language.ts` | Welcome/game sequence, not authoritative custom-connector steps | Retained; no invitation list copied into fixed welcome |
| `apps/server/src/repository-onboarding.ts`, `packages/api-contract/src/repository-onboarding.ts` | Repository connection/starter tasks differ from agent invitation | Retained repository-intent route and no-repository card behavior |
| `apps/server/src/institutional-skills.ts`, `procedure-tool-vocabulary.ts` | Restricted saved user guidance, not product-release authority | No mutable memory used as invitation source |
| `apps/server/src/free-agent-prompt-budget.ts`, free-agent accounting/proxy | Budget/cache ownership, not an invitation text ceiling | No budget changes; measure added tool descriptor and reduced soul text in PR |
| `packages/scripts/prompt-cases.ts`, saved cases, replay stub | Free-agent replay only injected repository guidance, omitting onboarding policy | Replay now includes current shared onboarding/product guidance; actual tool answers are recorded from canonical output |
| `apps/mobile/sources/ui/screens/people/AddAgentSheet.tsx` | Ruby’s Android walkthrough found generic bare-host copy on every tile and undocumented starts outside the picker | Tile copy uses the shared endpoint/path/assistant guide link; CLI tiles use the actual session join command; ChatGPT Pro limitation and Cursor/Goose helper starts appear in a separate shared copy box |
| Root `README.md` | Installation paths lacked a concise distinction | Explains custom connector, session join and managed helper with phone/computer distinction |

## Third-party documentation checked

Documentation supplies candidate steps. Ruby's actual execution is the acceptance proof. Account, locale and app version must accompany every result.

- [ChatGPT custom MCP](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt): Business/Enterprise/Edu creation permissions and write support; native mobile cannot create custom MCP. Pro read/fetch is insufficient for replying in Beeline. Current Plugins flow and legacy Apps flow are separate UI generations.
- [Claude connectors](https://support.claude.com/en/articles/11176164-use-connectors-to-extend-claude-s-capabilities): custom Web connector creation, one free connector, organization policy and mobile beta. Browser creation does not establish automatic waking.
- [Meta connector help](https://www.meta.com/help/superintelligence/1687253048996149/): ask Muse to create a Custom Connector; manage it in Settings → Connectors. It does not document an exact universal native “Add custom connector” button, so the guide uses the documented chat request instead.
- [Meta subscription availability](https://www.meta.com/help/subscriptions/1021145227643680/): free usage exists; benefits and availability vary, limited testing. No complete current country list is supplied there. Do not replace that gap with an outdated US/Canada-only claim; Ruby must record the account's actual availability.
- [Grok connectors](https://docs.x.ai/grok/connectors), [team management](https://docs.x.ai/grok/connector-management), [mobile launch](https://x.ai/news/grok-connectors): web Custom steps, team admin provision and mobile Settings → Connectors. Native custom creation and host webhook delivery still need execution; do not infer them from directory connector availability.
- [Gemini custom apps](https://support.google.com/gemini/answer/17209137?hl=en-12), [developer mode](https://developers.google.com/connected-apps/mcp/dev-mode/usage): consumer creation in web Connected Apps, mobile use after creation, US/English/adult/personal-account/activity restrictions. These supersede a blanket “Gemini cannot use MCP” answer. OAuth protocol compatibility is not a completed host join.

## Validation

The concordance test checks the free soul refresh, full/free skill pointer, absence of copied URLs in prompt/handler sources, exact per-assistant response snapshots, all invitation paths and canonical URLs. The existing app-connections integration case now compares every assistant alias with the same guide and checks no app/card side effects. The built HTTP script supplies before/after evidence under the same reproduction identifier.

The revised matrix accompanies this artifact. It deliberately distinguishes documented candidate, no route on a particular surface/plan, and live pass. iPhone guidance is docs review only, not tested on a real device, per Ruby’s owner-directed validation change. Documented ChatGPT Pro fresh custom-MCP creation is read/fetch only. Pidoong demonstrated send_message on an owner-reported Pro account; this establishes reply capability for that existing integration, not fresh creation eligibility or automatic delivery. Guidance separates these claims. Remaining native-phone/host tests are not waived by passing unit tests or replay.

## Picker reproduction added from Ruby's walkthrough

Reproduction `onboarding-picker-1`: in Beeline Review on Android app (0.2.24), Members → Add agents → choose any existing-agent tile → Copy returned the same bare-host sentence for different paths; the guide omitted OpenCode, Pi, Hermes and ZCode starts. Ruby recorded the live observation in message efc611227242b66269ee2df25e43c975fd3762c38cae10cc5b50a0d527d7b6c7.

The built production AddAgentSheet browser stand-in follows People → Agents + → Invite an external agent, copies the one join prompt and opens the full list of agents, then copies the Create a new agent command, at phone/desktop widths. It replaces native primitives and shared controls with DOM adapters; it does not claim native sheet geometry or native Clipboard access. Ruby retains native validation; iPhone stays docs-only. Run `npm run prove:agent-invitation-picker`. The earlier baseline failure remains recorded at the pre-integration head; main has since replaced the old component.

## Harness review corrections

Ruby accepted the runtime reviews from Firstmate, Claude Code, Muse and Nerd. Grok chat, hosted Grok Bot, Grok Business and Grok CLI are separate rows; official Grok chat web menu variants and the Business admin console remain live-unverified. The Bot uses Connect apps rather than chat Settings. The Grok CLI headless command includes --host grok --name my-grok, and its session join is on-demand only. The join error message now derives supported hosts from detection's AGENTS list, fixing the omitted Grok label. Muse enters the pre-registered client ID only when asked; DCR requires none. Claude Code/Codex explicitly use the latest package because old installs omit join.

Grok Bot publisher attribution remains unresolved: the documented page is on xAI's domain but describes Cursor's connector backend, matching the Cursor OAuth callback and Firstmate's account evidence. No publisher field was changed by inference. Ruby owns that live check.

The final Muse replay exposed a needless plan question before usable Android steps. The shared pointer and guide now ask for missing device/plan information only when it changes eligibility or steps, while preserving explicit warnings for unverified host paths. The corrected Muse cases are re-run rather than accepting the earlier failed answer.

Codex runtime review (buzzy-codex, codex-cli 0.167.0, Linux, plan unknown; Ruby order 4eb94b3e46a899c729fdd72a7829e185c6e7290d90fc7cdeae6dfda1c5f20061) limits the verified path to an existing running Linux CLI conversation's delivery/reply. Mac, phone app, browser, cloud and managed helper are marked not verified, with no setup steps. Codex tool output and picker copy omit connector URLs and explain that the Codex machine is the host while any device can approve its sign-in link. Fresh sign-in remains unverified.

Selecting Codex also hides the generic managed-helper pairing command and replaces that subheading with “Codex managed helper: not verified,” preventing the adjacent Create new agent section from offering unverified Codex steps. The built picker proof checks that the helper command is absent while Codex is selected.

## Linux terminal validation

Ruby's live run on squire with usebeeline (0.1.201), 11 November 2026, passed sign-in and owner membership for Codex, Claude Code and Pi; the test members were removed. The Room sandbox could not create the local receiver socket directory, so this run does not establish new automatic-delivery proof. Codex retains buzzy-codex's existing-session receipt/reply evidence. OpenCode did not reach Beeline because its model login failed first.

Reproduction `linux-join-validation-1`: Pi reported host_without_live_delivery while guidance omitted on-demand limits; local receiver setup failure exposed a reconnect website that cannot repair a socket-directory problem; join --help started sign-in. The correction uses the actual joinDelivery mechanism: only Codex, Claude Code and Antigravity have local receiver paths, which require a host receipt; Pi, OpenCode, Hermes, ZCode, Gemini CLI and Grok CLI are on demand. MCP failure/list_chats text names retrying join in the same session and checking the local computer, with no delivery-state or reconnect routing changes. Both help flags print usage before discovering the host, touching state or networking.

## Phone network CI correction

The phone network guard rejected importing the invitation guide's deployment origins through the general phone API barrel. The guide now has a server/helper-only package entry. The existing createAgentPairingCode socket operation projects the picker copy as an optional validated DTO; The People tab’s AddAgentSheet passes that server-owned copy through to the picker. The phone bundles no invitation origin constants and opens no extra connection. Older server responses leave guidance unavailable and point to a Beeline agent rather than inventing steps. The network list and scanner remain unchanged. A pairing regression pins the server's guide projection, while the built picker proof uses that projected data. Current main was integrated before regenerating wire codecs and rerunning root typecheck.
