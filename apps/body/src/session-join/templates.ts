import { ownedCommandModule } from '../wait.js';
// Plugin sources written into apps that load code, not hooks. Ported from Reason Network (src/opencode-plugin.ts,
// src/pi-extension.ts, integrations/hermes), Copyright 2026 Reason Machines, Inc., MIT OR Apache-2.0.
// See ./NOTICE and ./UPSTREAM.json for the copied commit. `__NODE__` and `__BUNDLE__` are filled in on install.

/** opencode 1.x and 2.x: reports busy/idle, and puts Beeline messages into idle sessions within seconds. */
export const OPENCODE_PLUGIN = `// Beeline for opencode: written by \`usebeeline join\`, removed by \`usebeeline session leave\`.
import { runOwned, watchChanges } from __OWNED__
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

const NODE = "__NODE__"
const BUNDLE = "__BUNDLE__"

const run = async (args: string[], cwd: string) => {
  try {
    const result = await runOwned({ step: "opencode hook", file: NODE, args: [BUNDLE, "session", "hook", "opencode", ...args], cwd, machineRead: true })
    return result.code === 0 ? result.stdout.trim() : ""
  } catch { return "" }
}

const network = (prompt: (id: string, text: string) => Promise<unknown>) => {
  const idle = new Set<string>()
  const subagents = new Set<string>()
  const delivering = new Set<string>()
  const dirs = new Map<string, string>()
  // A wake during a delivery runs one more poll after it, so none is lost.
  const again = new Set<string>()
  const deliver = async (id: string): Promise<void> => {
    if (subagents.has(id)) return
    if (delivering.has(id)) { again.add(id); return }
    delivering.add(id)
    try {
      const text = await run(["poll", "--session", id], dirs.get(id)!)
      if (!text) return
      idle.delete(id)
      await prompt(id, text)
    } finally {
      delivering.delete(id)
      if (again.delete(id) && idle.has(id)) void deliver(id)
    }
  }
  // A delivery is written under deliveries/ (older helpers wrote inbox/); a
  // change without a name is any change. If the watcher fails, deliveries
  // still arrive on each session's next idle status.
  const sessions=join(process.env.XDG_STATE_HOME||join(process.env.HOME||homedir(),".local/state"),"beeline-sessions")
  mkdirSync(sessions,{recursive:true})
  const stopWatching=watchChanges(sessions,(name: string | null)=>{
    if(name===null||/^(?:deliveries|inbox)(?:\\/|$)/.test(name)) idle.forEach((id)=>void deliver(id))
  },{recursive:true,onError:()=>{}})
  return {
    subagent: (id: string) => subagents.add(id),
    status: async (id: string, state: string, dir: string) => {
      if (subagents.has(id)) return
      dirs.set(id, dir)
      void run(["status", "--session", id, "--state", state], dir)
      if (state === "idle") {
        idle.add(id)
        await deliver(id)
      } else idle.delete(id)
    },
    stop: () => stopWatching(),
    end: (id?: string) => {
      for (const [s, dir] of [...dirs]) {
        if (id && s !== id) continue
        idle.delete(s)
        dirs.delete(s)
        void run(["session-end", "--session", s], dir)
      }
    },
  }
}

const Beeline = async ({ client, directory }: any) => {
  const last = new Map<string, any>()
  const net = network((id, text) =>
    client.session.promptAsync({ path: { id }, body: { ...(last.get(id) ?? {}), parts: [{ type: "text", text }] } }),
  )
  return {
    event: async ({ event }: any) => {
      const e = event as any
      if (e.type === "session.created" && e.properties?.info?.parentID) net.subagent(e.properties.info.id)
      if (e.type === "message.updated" && e.properties?.info?.role === "user") {
        const m = e.properties.info
        last.set(m.sessionID, { agent: m.agent, model: m.model })
      }
      if (e.type === "session.status") await net.status(e.properties.sessionID, e.properties.status.type, directory)
    },
    dispose: async () => net.stop(),
  }
}

const STATE: Record<string, string> = {
  "session.execution.started": "busy",
  "session.execution.succeeded": "idle",
  "session.execution.failed": "idle",
  "session.execution.interrupted": "idle",
}

export default {
  id: "beeline",
  server: Beeline,
  setup: (ctx: any) => {
    if (!ctx.event) return
    const abort = new AbortController()
    const net = network((sessionID, text) => ctx.session.prompt({ sessionID, text }))
    void (async () => {
      for await (const e of ctx.event.subscribe({ signal: abort.signal })) {
        const d = e.data ?? {}
        const dir = e.location?.directory ?? ctx.location.directory
        if (e.type === "session.created" && d.parentID) net.subagent(d.sessionID)
        if (STATE[e.type]) void net.status(d.sessionID, STATE[e.type], dir)
        if (e.type === "session.deleted") net.end(d.sessionID)
      }
    })().catch(() => {})
    return () => {
      abort.abort()
      net.stop()
      net.end()
    }
  },
}
`;

/** pi: reports busy/idle and delivers Beeline messages, steering a running turn and starting one when idle. */
export const PI_EXTENSION = `// Beeline for pi: written by \`usebeeline join\`, removed by \`usebeeline session leave\`.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { runOwned, watchChanges } from ${JSON.stringify(ownedCommandModule())}
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

const NODE = "__NODE__"
const BUNDLE = "__BUNDLE__"

export default function (pi: ExtensionAPI) {
  let id = ""
  let cwd = process.cwd()
  let busy = false
  let delivering = false
  let again = false
  let stopWatching: (() => void) | undefined
  const hook = async (args: string[]) => {
    try {
      const result = await runOwned({ step: "pi hook", file: NODE, args: [BUNDLE, "session", "hook", "pi", ...args, "--session", id], cwd, machineRead: true })
      return result.code === 0 ? result.stdout.trim() : ""
    } catch { return "" }
  }
  // A wake during a delivery runs one more poll after it, so none is lost.
  const deliver = async (event: "post-tool-use" | "poll"): Promise<void> => {
    if (!id) return
    if (delivering) { again = true; return }
    delivering = true
    try {
      const text = await hook([event])
      if (text) pi.sendUserMessage(text, busy ? { deliverAs: "steer" } : undefined)
    } finally {
      delivering = false
      if (again) { again = false; void deliver("poll") }
    }
  }
  pi.on("session_start", async (_event, ctx) => {
    id = ctx.sessionManager.getSessionId()
    cwd = ctx.cwd
    // A delivery is written under deliveries/ (older helpers wrote inbox/); a
    // change without a name is any change. If the watcher fails, deliveries
    // still arrive at the next turn end or settle.
    const sessions=join(process.env.XDG_STATE_HOME||join(process.env.HOME||homedir(),".local/state"),"beeline-sessions")
    mkdirSync(sessions,{recursive:true})
    stopWatching??=watchChanges(sessions,(name: string | null)=>{
      if(name===null||/^(?:deliveries|inbox)(?:\\/|$)/.test(name)) void deliver("poll")
    },{recursive:true,onError:()=>{}})
    await hook(["status", "--state", "idle"])
    await deliver("poll")
  })
  pi.on("agent_start", async () => {
    busy = true
    await hook(["status", "--state", "busy"])
  })
  pi.on("turn_end", async () => {
    await deliver("post-tool-use")
  })
  pi.on("agent_settled", async () => {
    busy = false
    await hook(["status", "--state", "idle"])
    await deliver("poll")
  })
  pi.on("session_shutdown", async () => {
    stopWatching?.()
    stopWatching = undefined
    await hook(["session-end"])
  })
}
`;

export const HERMES_MANIFEST = `name: beeline
version: "0.1.0"
description: "Bring Beeline chat tags into each Hermes conversation that joined Beeline."
provides_tools:
  - beeline_check_inbox
provides_hooks:
  - pre_llm_call
  - on_session_end
  - on_session_finalize
`;

/** Hermes: Beeline messages reach a conversation before its next model call, or when it checks its inbox. */
export const HERMES_PLUGIN = `"""Beeline for Hermes: written by usebeeline join, removed by usebeeline session leave."""
import os
import subprocess

NODE = "__NODE__"
BUNDLE = "__BUNDLE__"


def _hook(event, session_id):
    if not session_id:
        return ""
    try:
        done = subprocess.run([NODE, BUNDLE, "session", "hook", "hermes", event, "--session", str(session_id)],
            stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=10, cwd=os.getcwd())
        return done.stdout.strip() if done.returncode == 0 else ""
    except Exception:
        return ""


def register(ctx):
    def before_turn(session_id="", **_):
        text = _hook("poll", session_id)
        return {"context": text} if text else None

    def end_turn(session_id="", **_):
        _hook("stop", session_id)

    def finalize(session_id="", old_session_id="", **_):
        _hook("session-end", old_session_id or session_id)

    for name, callback in (("pre_llm_call", before_turn), ("on_session_end", end_turn), ("on_session_finalize", finalize)):
        ctx.register_hook(name, callback)

    def check_inbox(args, session_id=None, **_):
        return _hook("poll", session_id) or "No Beeline messages are waiting."

    schema = {"name": "beeline_check_inbox", "description": "Read Beeline chat messages waiting for this conversation.",
        "parameters": {"type": "object", "properties": {}, "required": [], "additionalProperties": False}}
    ctx.register_tool(name="beeline_check_inbox", toolset="beeline", schema=schema, handler=check_inbox,
        description=schema["description"])
`;

/**
 * `owned` is where the plugin imports runOwned and watchChanges from: the
 * standalone module as a data URL by default, or a file written beside the
 * bundle. Bun (opencode) cannot import a data URL of this size.
 */
export function fill(
  template: string,
  node: string,
  bundle: string,
  owned: string = ownedCommandModule(),
): string {
  return template
    .replaceAll('__NODE__', node.replace(/\\/g, '\\\\'))
    .replaceAll('__BUNDLE__', bundle.replace(/\\/g, '\\\\'))
    .replaceAll('__OWNED__', JSON.stringify(owned));
}

/** The standalone runOwned/ask/answer/watchChanges module as plain source, for a plugin's own file. */
export function ownedCommandSource(): string {
  return decodeURIComponent(ownedCommandModule().slice('data:text/javascript,'.length));
}
