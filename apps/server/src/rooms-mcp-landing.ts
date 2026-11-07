import { readFileSync } from 'node:fs';

const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
  );
const asset = (name: string, mime: string) =>
  `data:${mime};base64,${readFileSync(new URL(`../assets/mcp/landing/${name}`, import.meta.url)).toString('base64')}`;
const APP_STORE = asset('app-store.svg', 'image/svg+xml');
const GOOGLE_PLAY = asset('google-play.png', 'image/png');
const ROOM_BONE = asset('room-bone.png', 'image/png');
const ROOM_OBSIDIAN = asset('room-obsidian.png', 'image/png');

export interface McpWorkspaceLanding {
  room_id: string;
  workspace_id: string;
  workspace_name: string;
  client_name: string;
}

/** Only appended to a newly-created Workspace's handoff page; consent and existing accounts keep their styles. */
export const MCP_LANDING_STYLE = `
main.workspace-ready{max-width:800px;padding:32px 24px 24px}.workspace-ready .brand{margin-bottom:24px}.workspace-ready .mark{width:36px;height:36px;border-radius:8px}
.workspace-ready .btn{height:auto;min-height:44px;padding:10px 16px;text-align:center;white-space:normal}
.landing-hero{display:grid;grid-template-columns:minmax(0,1fr);gap:24px;align-items:center}.landing-copy{min-width:0;display:contents}.landing-summary{order:1}.landing-visual{order:2}.landing-install{order:3}.landing-intro{margin:0 0 24px;color:var(--t2)}
.landing-visual{display:flex;justify-content:center}.landing-device{width:196px;max-width:100%;border:3px solid var(--strong);border-radius:24px;background:var(--raised);padding:8px}
.landing-speaker{width:40px;height:4px;background:var(--strong);margin:0 auto 8px;border-radius:3px}.landing-screen{display:block;width:100%;height:auto;border-radius:10px}.landing-screen.dark{display:none}
@media(prefers-color-scheme:dark){.landing-screen.light{display:none}.landing-screen.dark{display:block}}
.landing-install{text-align:center;margin:0}.landing-install h2{font-size:16px;line-height:23px;font-weight:500;margin:0 0 8px}
.landing-badge{display:inline-flex;min-height:48px;align-items:center;justify-content:center;max-width:100%}.landing-badge img{display:block;width:156px;max-width:100%;height:auto}.landing-badge.google img{width:180px}
.landing-download{gap:12px;max-width:280px;margin:auto}.landing-download svg{width:24px;height:24px;flex-shrink:0}
.landing-session{font-size:13px;line-height:19px;color:var(--quiet);text-align:center;margin:24px 0 0}
@media(min-width:700px){main.workspace-ready{padding-top:64px}.landing-hero{grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:48px}.landing-device{width:220px;padding:12px}.landing-copy{display:block}.landing-install{text-align:left;margin-top:32px}.landing-download{margin:0}.landing-session{text-align:left;margin-top:32px}}
`;

/** Server-side UA selection needs no script, tracking, or new network request. */
function installOffer(userAgent: string): string {
  const ios =
    /iPhone|iPad|iPod/i.test(userAgent) ||
    (/Macintosh/i.test(userAgent) && /Mobile\//i.test(userAgent));
  if (ios)
    return `<a class="landing-badge" href="https://apps.apple.com/app/id6803948500"><img src="${APP_STORE}" alt="Download on the App Store"></a>`;
  if (/Android/i.test(userAgent))
    return `<a class="landing-badge google" href="https://play.google.com/store/apps/details?id=app.usebeeline"><img src="${GOOGLE_PLAY}" alt="Get it on Google Play"></a>`;
  const platform = /Mac/i.test(userAgent)
    ? ['Mac', 'Beeline-universal.dmg']
    : /Windows/i.test(userAgent)
      ? ['Windows', 'Beeline-x86_64-setup.exe']
      : /Linux|X11/i.test(userAgent)
        ? ['Linux', 'Beeline-x86_64.AppImage']
        : null;
  const url = platform
    ? `https://github.com/Beeline-Work/beeline/releases/latest/download/${platform[1]}`
    : 'https://usebeeline.app/#download';
  return `<a class="btn landing-download" href="${url}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="3" y="3" width="18" height="13" rx="1"/><path d="M8 21h8m-4-5v5"/></svg>${platform ? `Download for ${platform[0]}` : 'Download Beeline'}</a>`;
}

/** The picture is a bundled example rendered from actual app components, never this person's Room history. */
export function renderMcpWorkspaceLanding(landing: McpWorkspaceLanding, userAgent: string): string {
  const room = `https://web.usebeeline.app/beeline/chat/${encodeURIComponent(landing.room_id)}?communityId=${encodeURIComponent(landing.workspace_id)}`;
  const client = escape(landing.client_name);
  return `<div class="landing-hero"><div class="landing-copy"><div class="landing-summary"><h1>Your team is ready</h1><p class="landing-intro">${escape(landing.workspace_name)} · you and ${client}</p><a class="btn primary" href="${escape(room)}">Open #general on the web</a></div><section class="landing-install"><h2>Faster in the app</h2>${installOffer(userAgent)}</section></div><div class="landing-visual"><div class="landing-device"><div class="landing-speaker" aria-hidden="true"></div><img class="landing-screen light" width="390" height="640" src="${ROOM_BONE}" alt="Example Beeline conversation in #general, with member faces, messages and a composer"><img class="landing-screen dark" width="390" height="640" src="${ROOM_OBSIDIAN}" alt="Example Beeline conversation in #general, with member faces, messages and a composer"></div></div></div><p class="landing-session">Go back to your ${client} session.<br>It finishes joining by itself.</p>`;
}
