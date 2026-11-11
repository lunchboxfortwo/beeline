import type { AcpClient } from './acp.js';
import { agentBehavior } from './agent-command.js';
import { repairRoomAgentCredentialLinks, watchRoomClaudeLogin } from './agent-home.js';
import type { MonolithRoomTurnLoop } from './monolith-room-turn.js';
import type { MonolithCornerTurnLoop } from './monolith-corner-turn.js';

type Session = MonolithRoomTurnLoop | MonolithCornerTurnLoop;

export function sessionHasCurrentContext(ctx: Session): boolean {
  return Boolean(ctx.client?.isAlive && ctx.sessionContextPath === ctx.commandContext.path);
}

/** Reuse a live conversation; failed cold starts still own their process cleanup. */
export async function activateAgentSession(ctx: Session, start: () => Promise<string>): Promise<string> {
  if (sessionHasCurrentContext(ctx) && ctx.sessionId) {
    if (ctx.options.config.agentHomeRoot) {
      await repairRoomAgentCredentialLinks({
        root: ctx.options.config.agentHomeRoot,
        operatorHome: ctx.options.config.operatorHome,
        writeBackNewerClaudeLogin: agentBehavior(ctx.options.config.agentKind).sharedLoginWriteBack === true,
      });
    }
    return ctx.sessionId;
  }
  if (ctx.client) await ctx.discardSession(true);
  try {
    return await start();
  } catch (error) {
    await ctx.discardSession(true).catch(cleanupError =>
      console.error('[body] failed to stop harness after activation failure:', cleanupError),
    );
    throw error;
  }
}

/** Clear session ownership before stopping or retaining the detached process. */
export async function discardAgentSession(
  ctx: Session,
  preserveConversation: boolean,
  clearSurfaceState: () => void,
  retire: (client: AcpClient) => Promise<void>,
): Promise<void> {
  if (!preserveConversation) ctx.warmTranscript.forgetSession();
  const client = ctx.client;
  ctx.stopClaudeLoginWatch();
  ctx.client = undefined;
  ctx.sessionId = undefined;
  ctx.sessionContextPath = undefined;
  clearSurfaceState();
  ctx.sessionFingerprint = undefined;
  ctx.sessionCodegraphReady = false;
  ctx.pinnedProviderOverride = undefined;
  if (client) await retire(client);
}

export function watchSessionClaudeLogin(ctx: Session): void {
  ctx.stopClaudeLoginWatch();
  if (!agentBehavior(ctx.options.config.agentKind).sharedLoginWriteBack || !ctx.options.config.agentHomeRoot) return;
  ctx.claudeLoginWatch = watchRoomClaudeLogin({
    root: ctx.options.config.agentHomeRoot,
    operatorHome: ctx.options.config.operatorHome,
  });
}
