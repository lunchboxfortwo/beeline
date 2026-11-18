import { supportedMcpAgent } from './rooms-mcp-logos.js';

/** These connector hosts receive work through a user-created webhook routine. */
export function mcpJoinRequiresWebhook(name: string, redirect: string): boolean {
  return name === 'Grok Bot' || name === 'Cursor' && new URL(redirect).protocol === 'https:';
}

/** Use registered host identity, never the model's claimed host/surface text. */
export function mcpHostHasInbound(name: string, redirects: readonly string[]): boolean {
  // Match mcpClientName: alternate callbacks do not replace the registered host identity.
  const redirect = redirects[0];
  if (!redirect) return false;
  const agent = supportedMcpAgent(name, redirect);
  const url = new URL(redirect);
  const antigravity = name === 'Antigravity' && url.pathname === '/mcp/oauth/handoff' &&
    ['server.usebeeline.app', '127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  return antigravity || Boolean(agent && (mcpJoinRequiresWebhook(agent.name, redirect) ||
    ['Codex', 'Claude Code'].includes(agent.name)));
}

/** Cursor automation endpoints require their generated bearer token. Other receivers may be public. */
export function mcpWebhookNeedsSecret(value: string): boolean {
  try {
    const url = new URL(value);
    return url.hostname === 'api2.cursor.sh' && url.pathname.startsWith('/automations/webhook/');
  } catch { return false; }
}

// Static code only. The same URL rule drives HTML required validation and the server setter.
export const MCP_WEBHOOK_AUTH_SCRIPT = `
(() => {
  const url = document.getElementById('wake_url');
  const key = document.getElementById('wake_key');
  if (!url || !key) return;
  const needsSecret = ${mcpWebhookNeedsSecret.toString()};
  const update = () => { key.required = needsSecret(url.value); };
  url.addEventListener('input', update);
  update();
})();`;
