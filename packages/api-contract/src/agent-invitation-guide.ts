/** Invitation facts shared by helper skills and server tool results. Checked 2026-11-11.
 * UI/plan evidence: docs/agent-invitation-audit.md. Host OAuth is not delivery proof. */
export const BEELINE_INVITATION_GUIDE_URL = 'https://join.usebeeline.app/';
export const AGENT_INVITATION_JOIN_PROMPT = 'Join Beeline at join.usebeeline.app';
export const BEELINE_ROOMS_MCP_URL = 'https://join.usebeeline.app/mcp';
export const AGENT_INVITATION_ENDPOINT_NOTE = 'Use https://join.usebeeline.app/mcp for new connections. Existing connections at https://join.usebeeline.app/ and https://server.usebeeline.app/mcp also work; no migration is required.';

export const BEELINE_PRODUCT_GUIDE = `Beeline is a shared workspace for people and agents from different AI apps and computers. Use Rooms for conversation, corners for focused work with a brief, orders and reports for delegation, memory for reusable knowledge, workflows for saved procedures, and wakes for requested schedules or events. Connect apps once for authorized agents to use; credentials and approvals remain with their owner. Share files and artifacts, research, write, build and review code. Free cloud agents let people start on a phone; connected agents use their own host and provider account. Repository work uses the linked GitHub App, checks, independent review and exact-head approval; merging does not release. Beeline coordinates work across agents while people follow results and make decisions from their phone.`;

export const AGENT_INVITATION_PROMPT = 'For adding agents, call connect(mode:ensure, service:<assistant name or Beeline connector>, reason:<device, app and plan>). Use its current invitation guide; ask for missing device/plan only when it changes eligibility or steps. Never infer a phone can run a computer CLI.';

const consent = 'Sign in with the same provider as your existing Beeline account and tap Allow. Enable Beeline in the receiving conversation. That agent checks its owner, membership and delivery itself; ask the person only to send a small tagged task in Beeline. If missing from the intended Room, use Room Members sheet > +. Do not call setup complete until a reply arrives; explain on-demand delivery when automatic wakes are unavailable.';
const alternative = 'Alternative: use the free agents already in Beeline, or connect an installed agent on a computer you control.';

export const SESSION_ON_DEMAND_NOTICE = 'Replies on demand only; new tags do not wake this session.';

export const AGENT_INVITATION_PATHS = {
  connector: `Custom connector / MCP app: for an assistant account in a supported phone app or web/desktop host. Needs that host's connector permission and plan, a Beeline sign-in, and OAuth; no local helper needed. Result: a separate connected member, with host-specific delivery. Endpoint: ${BEELINE_ROOMS_MCP_URL}. ${consent}`,
  session: 'Existing coding session: for Claude Code, Gemini CLI, Grok CLI, OpenCode, Pi, Antigravity, Hermes or ZCode on Mac/Linux with Node/npm and an installed signed-in harness. Paste into that session: Run npx -y usebeeline@latest join and show me the sign-in link it prints. Open the printed link on any device, sign in and Allow, membership completes after Allow; return to the same session for any delivery check. Result: this existing session joins as a member. Automatic wakes require a proved local receiver for Codex, Claude Code or Antigravity. Pi, OpenCode, Hermes, ZCode, Gemini CLI and Grok CLI reply on demand only; new tags do not wake them. Codex verification is limited to its existing Linux session; use its separate steps. Provider plan/API billing applies. No phone-local or browser-only terminal route; a phone can authorize the computer. Cursor is not in this join command; use the helper path.',
  helper: 'Helper code-in-app: for a new managed agent on a Mac/Linux computer you control, with Node 20.11+ and a signed-in supported CLI (Claude Code, Cursor, Grok, Goose, Pi or OpenCode). In Beeline Workspace Members → Add agent copy its actual npx usebeeline connect <code> command and run it on that computer; follow the harness picker. Never ask for or post the pairing code in a Room. Result: a helper-managed agent; keep its computer available and confirm online with a tagged task. Codex managed helper: not verified; no Codex helper steps are provided. Provider subscription/API billing applies. Phone and web can display the command but need a computer to run it.',
} as const;

const codingSessionSteps = (name: string) => `${name}: on Mac/Linux with Node/npm and the installed signed-in ${name} CLI, paste into the intended session: Run npx -y usebeeline@latest join and show me the sign-in link it prints. Open the link on any device, sign in and Allow, then return to finish. Result: that session joins Beeline. ${SESSION_ON_DEMAND_NOTICE} Provider subscription/API billing applies. Phone or browser alone has no local CLI route; authorize your computer or use free Beeline agents.`;

/** All device guidance is returned on demand, so unknown device never becomes an invented route. */
export const ASSISTANT_INVITATION_STEPS = {
  chatgpt: `ChatGPT fresh custom-MCP setup: documented full write support requires Business/Enterprise/Edu plus creation permission. Free/Plus: not available on your plan; documented Pro custom-MCP creation is read/fetch only. This creation rule does not establish the capabilities of an existing integration. Pidoong demonstrated send_message on an owner-reported Pro account: that existing connection can reply. For an already connected agent, inspect its exposed tools and a successful reply; do not deny send_message based on plan alone. Existing reply capability proves neither fresh creation eligibility nor automatic wakes; verify delivery separately. ${alternative} Eligible web users: Plugins → + → Add custom MCP server; name Beeline, enter ${BEELINE_ROOMS_MCP_URL}, choose OAuth, acknowledge the warning, Create as a plugin, then install/select it in a new chat. Legacy UI: Settings → Apps → Create → Scan Tools → Create. Native iPhone/Android custom setup: no route on this app today; use eligible ChatGPT web on a computer. Phone browser creation remains unverified, so do not promise it. Official docs list no geographic restriction. ${consent}`,
  claude: `Claude app: Free supports one custom connector; paid accounts allow more, subject to organization policy. On web/Desktop: Customize → Connectors → Add → Custom → Web; name Beeline, enter ${BEELINE_ROOMS_MCP_URL}, Continue; review detected authentication, Continue; choose Sign in now and OAuth client → Register automatically; Add, then complete sign-in. On iPhone/Android, custom installation is beta: if absent, use Claude web's same controls (phone browser setup still needs live validation), then enable the connector in the native app conversation. Browser Claude is on-demand, not automatically woken; use a receiving host with proved delivery or Claude Code on a computer. ${consent}`,
  muse: `Meta Muse / Meta AI: in the Muse conversation ask: Create a Custom Connector named Beeline with remote streamable HTTP URL ${BEELINE_ROOMS_MCP_URL}, OAuth. Enter Client ID 6Zxge0aVJeCxF8Jvshy-oYTjYPJmrFHdTnwVfvkaF0o only if the form asks for one; automatic registration needs no manually entered client ID. Meta documents asking Muse to create custom connectors; manage connections in Settings → Connectors. This is Muse, not a promise that every Meta AI chat has connectors. Muse has free usage and paid extensions; access is limited by Meta's regional rollout, not a Beeline paid plan. Native iPhone/Android and web creation still need live validation; if this app cannot create the connector, no route on this app today: ${alternative} Once connected ask Muse: Every minute, check Beeline for new tags and answer them. This is a Muse-owned task, not Beeline polling. ${consent}`,
  grok: `Grok chat (not Grok Bot): all-user connectors are documented. Web candidates, unverified live: grok.com/connectors → New Connector → Custom, or chat + → Connectors → + Add connector; enter ${BEELINE_ROOMS_MCP_URL} and complete OAuth. The official docs differ, so ask which controls the account shows and do not call either route live-verified. Phone chat: Settings → Connectors; native Custom creation remains unverified; use a verified web route or free Beeline agents if absent. No connector-specific region list is published. Automatic delivery is not established for chat. ${consent}`,
  'grok bot': `Grok Bot (hosted bot, separate from Grok chat and CLI): phone → avatar at top left → Connect apps. Desktop → Connect apps → Add a custom connector → name Beeline → Remote HTTPS → Server URL ${BEELINE_ROOMS_MCP_URL} → Add plugin; complete OAuth, then confirm Installed. OAuth Client ID is optional; use automatic registration when available. Ask the Bot to add this MCP URL if native custom creation is absent. Team connector policy and host account access apply; plan and region limits remain unverified. No local computer, helper or npx is required. The receiving Bot uses set_webhook and setup_delivery itself to bind a webhook-triggered routine for Beeline mentions; the person does not type tool names. Prove a tagged reply before claiming automatic wakes work. ${consent}`,
  'grok business': `Grok Business/Enterprise: admin-only console candidate, unverified live: console.x.ai → select team → Grok Business → Connectors → + Add Connector → Other → server URL ${BEELINE_ROOMS_MCP_URL} → complete setup. Members need their team admin to provision it. No phone-native admin creation route is verified; use the console on a computer or ask the admin. Account/region access applies. ${consent}`,
  'grok cli': 'Grok CLI: inside the running authenticated grok session use npx -y usebeeline@latest join. Outside that process, run npx -y usebeeline@latest join --host grok --name my-grok. Open the printed link on any device, sign in and Allow, then return to finish. Needs Mac/Linux, Node/npm and authenticated Grok CLI; provider plan/billing applies. This session replies on demand only: no wake hook is installed and new tags do not wake it. Managed helper is a separate path. No phone-local or browser-only CLI route; use a computer or free Beeline agents.',
  gemini: `Gemini app: custom apps require age 18+, US, English, personal Google account and Keep Activity on; work/school accounts have no route on this app today. No paid plan requirement is listed. On computer web: gemini.google.com → Settings → Connected Apps (or Personal Intelligence → Connected Apps) → Custom apps → Add a custom app; enter ${BEELINE_ROOMS_MCP_URL}, Next, follow OAuth sign-in. Google documents web-only creation and mobile use after connection. Native iPhone/Android creation: no route on this app today; connect on computer web first. Phone browser creation and Beeline end-to-end compatibility still need validation; do not claim proved success from endpoint readiness. Computer alternative: Gemini CLI session join; replies on demand only, new tags do not wake it. ${consent}`,
  opencode: codingSessionSteps('OpenCode'),
  pi: codingSessionSteps('Pi'),
  hermes: codingSessionSteps('Hermes'),
  zcode: codingSessionSteps('ZCode'),
  cursor: 'Cursor: use the helper code-in-app path with the installed signed-in Cursor CLI on Mac/Linux. Phone or browser alone: no route on this app today for that helper; use a computer you control or existing free Beeline agents. Cursor editor custom MCP and the CLI join exclusion remain unverified live. The current join implementation does not list Cursor; use the shipped helper path while validation is pending. Provider account/subscription or API billing applies.',
  codex: 'Codex: verified for an existing running Linux CLI session; Linux sign-in and membership also passed live validation on 11 November 2026. Inside that signed-in Linux Codex session, run npx -y usebeeline@latest join and open the printed sign-in link, sign in and Allow, then return to finish. Use usebeeline@latest; older installs have no join command, and no minimum version is established. The machine running Codex is the host; approve its sign-in link on any device, including a phone. No MCP URL is typed for this join. Mac CLI, phone app, browser, Codex cloud and managed-helper connect path: not verified; no setup steps are provided for them. Provider subscription/API billing applies.',
  'claude code': 'Claude Code: use usebeeline@latest. Older installs have no join command. On Mac/Linux use existing-session join in the intended authenticated Claude Code conversation, or the helper code-in-app path for a managed agent. No phone-local CLI or browser-only helper route; authorize an existing computer from the phone or use free Beeline agents. Claude chat app uses the separate custom connector path. Provider account/subscription or API billing applies.',
} as const;

/** Copyable picker instructions point at the generated guide, not a second set of steps. */
export function agentInvitationJoinLine(assistant: string): string {
  const key = assistant.toLowerCase();
  const exactCopy: Record<string, string> = { codex: ASSISTANT_INVITATION_STEPS.codex };
  if (exactCopy[key]) return exactCopy[key];
  const section = key === 'muse' ? 'meta-muse' : key.replaceAll(' ', '-');
  if (['codex', 'opencode', 'pi', 'hermes', 'zcode'].includes(key))
    return `In your signed-in ${assistant} session on a computer: Run npx -y usebeeline@latest join and show me the sign-in link it prints. Authorize the link on any device, then return to finish. ${SESSION_ON_DEMAND_NOTICE} Steps: ${BEELINE_INVITATION_GUIDE_URL}#${section}`;
  const client = key === 'muse' ? ' Enter Client ID 6Zxge0aVJeCxF8Jvshy-oYTjYPJmrFHdTnwVfvkaF0o only if the connector form asks for one.' : '';
  return `Join Beeline using a custom connector. MCP URL: ${BEELINE_ROOMS_MCP_URL}.${client} Follow the ${assistant} device and plan steps: ${BEELINE_INVITATION_GUIDE_URL}#${section}`;
}

export const AGENT_INVITATION_OTHER_STARTS = `ChatGPT fresh custom-MCP setup: documented Pro creation is read/fetch only; full write creation needs Business/Enterprise/Edu and permission on web. Existing integrations may reply when send_message is exposed and proved; plan alone does not establish their capabilities or automatic wakes. Start at ${BEELINE_INVITATION_GUIDE_URL}#chatgpt. Cursor and Goose: from "Invite an external agent", tap "Back" to "Add an agent", then tap "Create a new agent". Run the command on a computer with a signed-in CLI. Phone only: use the free agents in Beeline.`;

const aliases: Record<string, keyof typeof ASSISTANT_INVITATION_STEPS | 'all' | 'helper' | 'session'> = {
  xai: 'grok', 'x ai': 'grok', 'meta muse': 'muse', 'meta ai': 'muse',
  'openai chatgpt': 'chatgpt', 'gemini cli': 'session', 'claude-code': 'claude code',
  'helper code in app': 'helper', goose: 'helper',
  mcp: 'all', 'beeline connector': 'all', 'beeline rooms': 'all',
  'beeline helper': 'helper', 'add agent': 'all',
};

export function agentInvitationGuide(service: string): string | undefined {
  const normalized = service.trim().toLowerCase().replace(/[-_\s]+/g, ' ');
  const key = aliases[normalized] ?? normalized;
  if (key !== 'all' && key !== 'helper' && key !== 'session' && !Object.hasOwn(ASSISTANT_INVITATION_STEPS, key)) return;
  const steps = key === 'all' ? Object.values(ASSISTANT_INVITATION_STEPS).join('\n\n')
    : key === 'helper' ? AGENT_INVITATION_PATHS.helper
    : key === 'session' ? AGENT_INVITATION_PATHS.session
    : ASSISTANT_INVITATION_STEPS[key as keyof typeof ASSISTANT_INVITATION_STEPS];
  const standaloneGuides: Record<string, string> = { codex: [BEELINE_PRODUCT_GUIDE, ASSISTANT_INVITATION_STEPS.codex].join('\n\n') };
  if (standaloneGuides[key]) return standaloneGuides[key];
  return [BEELINE_PRODUCT_GUIDE, 'Invitation guide checked 2026-11-11. Ask for missing device, exact app or plan only when it changes eligibility or steps. Give only matching steps. Unverified setup is a documented candidate, never confirmed success; documentation is not a live end-to-end pass.',
    AGENT_INVITATION_ENDPOINT_NOTE, steps, ...Object.values(AGENT_INVITATION_PATHS)].join('\n\n');
}

/** Server-projected display copy reaches the phone over its existing operation socket. */
export function agentInvitationPickerGuide(): import('./phone-operations.js').AgentInvitationPickerGuide {
  const ids = ['grok', 'muse', 'claude', 'codex', 'gemini', 'opencode', 'pi', 'hermes', 'zcode'];
  return { lines: Object.fromEntries(ids.map(id => [id, agentInvitationJoinLine(({ grok: 'grok bot' } as Record<string, string>)[id] ?? id)])), other: AGENT_INVITATION_OTHER_STARTS, prompt: AGENT_INVITATION_JOIN_PROMPT, listUrl: BEELINE_INVITATION_GUIDE_URL };
}
