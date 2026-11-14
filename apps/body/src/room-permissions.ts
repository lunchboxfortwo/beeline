import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { sandboxAllowsWrite, type SandboxMountPlan } from './bwrap-sandbox.js';
import type { AcpPermissionDecision, AcpPermissionRequest } from './acp.js';
import { CODE_OWNED_HOST_MCP_NAMES } from './mcp-route-class.js';
import { isHostMcpPermissionRequest, isMcpShapedPermissionRequest, isMountedMcpToolPermissionRequest, ROOM_MOUNTED_MCP_SERVERS } from './read-only-policy.js';

/**
 * Rooms and corners share one rule for MCP: every tool call from a server the
 * host mounted into the session is approved. A host-classified server is kept
 * out of the isolated harness home until an owner grant rewrites the route in;
 * a call that reaches an ungated host identity stays refused here. Granted
 * names drop out of that host list so every capability on that server crosses.
 */
export function isRoomMcpPermissionRequest(
  request: AcpPermissionRequest,
  mountedServers: readonly string[] = ROOM_MOUNTED_MCP_SERVERS,
  hostServers: readonly string[] = CODE_OWNED_HOST_MCP_NAMES,
): boolean {
  if (isHostMcpPermissionRequest(request, hostServers)) return false;
  return isMountedMcpToolPermissionRequest(request, mountedServers);
}


/**
 * A shell command, read from the only thing that identifies one: the `execute`
 * kind the harness itself declares. claude-agent-acp marks its native `Bash`
 * that way, which is the whole of what a Room shell needs; a title or a command
 * line that happens to contain the word `bash` is prose, not an identity, and
 * classifying on it moved the boundary with the user's wording. An MCP-shaped
 * request is never re-read as a shell: it was already decided above, so a
 * command line wearing an inspection tool's title stays refused instead of
 * crossing as the shell it also is.
 */
export function isRoomShellPermissionRequest(
  request: AcpPermissionRequest,
  hostServers: readonly string[],
): boolean {
  if (request.toolCall?.kind !== 'execute') return false;
  return !isMcpShapedPermissionRequest(request, hostServers);
}


/** Every path a native file request names, or undefined when one is malformed. */
export function nativeRequestPaths(call: AcpPermissionRequest['toolCall']): string[] | undefined {
  const paths: string[] = [];
  if (call?.locations !== undefined) {
    if (!Array.isArray(call.locations)) return undefined;
    for (const location of call.locations) {
      if (!location || typeof location.path !== 'string' || !location.path) return undefined;
      paths.push(location.path);
    }
  }
  const input = call?.rawInput;
  if (input && typeof input === 'object') {
    for (const key of ['file_path', 'notebook_path', 'path'] as const) {
      if (!(key in input)) continue;
      const value = (input as Record<string, unknown>)[key];
      if (typeof value !== 'string' || !value) return undefined;
      paths.push(value);
    }
  }
  return paths;
}


export const strictlyInside = (root: string, path: string): boolean => {
  const suffix = relative(root, path);
  return suffix !== '' && suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
};


/** Allow only existing files named entirely within this session's attachment tree. */
export function isAttachmentRead(request: AcpPermissionRequest, attachmentsDir?: string): boolean {
  const call = request.toolCall;
  if (!attachmentsDir || call?.kind !== 'read') return false;
  const paths = nativeRequestPaths(call);
  if (!paths?.length) return false;
  try {
    const root = resolve(attachmentsDir);
    const realRoot = realpathSync(root);
    return paths.every(path => isAbsolute(path) && strictlyInside(root, resolve(path)) &&
      strictlyInside(realRoot, realpathSync(path)));
  } catch {
    return false;
  }
}


/**
 * A path as the filesystem would resolve it on write: the nearest entry that
 * exists (a dangling symlink counts, and then fails realpath) is realpathed and
 * the not-yet-created remainder is appended, so a new file is judged by the
 * directory it lands in.
 */
export function realWriteTarget(path: string): string {
  let existing = resolve(path);
  const missing: string[] = [];
  for (;;) {
    try {
      lstatSync(existing);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      missing.unshift(basename(existing));
      existing = parent;
    }
  }
  return join(realpathSync(existing), ...missing);
}


/** Allow a native write/edit only when every path it names lands inside the sandbox home. */
export function isSandboxHomeEdit(request: AcpPermissionRequest, sandboxHome?: string): boolean {
  const call = request.toolCall;
  if (!sandboxHome || call?.kind !== 'edit') return false;
  const paths = nativeRequestPaths(call);
  if (!paths?.length) return false;
  try {
    const root = resolve(sandboxHome);
    const realRoot = realpathSync(root);
    // Only an already-normal path: `resolve` folds `..` before symlinks are
    // followed, so `home/link/../x` would be judged by a different directory
    // than the one the filesystem writes through.
    return paths.every(path => isAbsolute(path) && path === resolve(path) &&
      strictlyInside(root, path) && strictlyInside(realRoot, realWriteTarget(path)));
  } catch {
    return false;
  }
}


/**
 * The Room ACP client applies this host-owned decision fail-closed: a mounted
 * MCP tool call is approved; shell commands and native read/search requests
 * are approved while the OS sandbox wraps this session, as are native
 * writes/edits whose every path resolves to a writable mount in the effective
 * sandbox plan, including operator HOME and explicit grants. Credential and
 * sibling masks and protected read-only mounts still reject edits. Without the sandbox, only native reads confined to downloaded
 * attachments are approved. Other native writes/edits, deletes, moves and
 * unstructured requests remain refused.
 *
 * Shell is conditioned on the sandbox because the sandbox IS the Room's
 * read-only filesystem: unwrapped, `wrapAgentCommand` spawns the harness bare
 * and masks no credential path, so an approved command would write anywhere the
 * daemon account can. Codex keeps its own offline read-only mode in exactly
 * that case (`harness-capabilities.ts`), so requiring the wrap is what parity
 * means. `ensureBwrapSandbox` installs bubblewrap at daemon start so this is a
 * capability the host gains rather than a refusal it lives with, and the
 * session primer states the outcome either way. The same wrap is why a home
 * write is safe to approve: the native tool runs inside it, so a symlink the
 * agent swaps in after this check still reaches only what the shell could.
 */
export function roomPermissionDecision(
  request: AcpPermissionRequest,
  options: {
    mountedServers?: readonly string[];
    hostServers?: readonly string[];
    /** `config.bwrapPath`, set only when the sandbox self-test passed. */
    shellSandboxed?: boolean;
    /** The attachment subtree under BEELINE_ATTACH_SCRATCH_ROOT. */
    attachmentsDir?: string;
    /** The wrapped session's `$HOME` (`agent-home/user`), writable in the sandbox. */
    sandboxHome?: string;
    sandboxPlan?: SandboxMountPlan;
  } = {},
): AcpPermissionDecision {
  const hostServers = options.hostServers ?? CODE_OWNED_HOST_MCP_NAMES;
  const mountedServers = options.mountedServers ?? ROOM_MOUNTED_MCP_SERVERS;
  if (isRoomMcpPermissionRequest(request, mountedServers, hostServers)) return 'allow';
  if (!isMcpShapedPermissionRequest(request, hostServers)) {
    if (options.shellSandboxed) {
      if (request.toolCall?.kind === 'read' || request.toolCall?.kind === 'search') return 'allow';
      if (options.sandboxPlan && request.toolCall?.kind === 'edit') {
        const paths = nativeRequestPaths(request.toolCall);
        try {
          if (paths?.length && paths.every(path => isAbsolute(path) && path === resolve(path) &&
            sandboxAllowsWrite(options.sandboxPlan!, path) &&
            sandboxAllowsWrite(options.sandboxPlan!, realWriteTarget(path)))) return 'allow';
        } catch { return 'reject'; }
      } else if (isSandboxHomeEdit(request, options.sandboxHome)) return 'allow';
    } else if (isAttachmentRead(request, options.attachmentsDir)) return 'allow';
  }
  if (!options.shellSandboxed) return 'reject';
  return isRoomShellPermissionRequest(request, hostServers) ? 'allow' : 'reject';
}


/** The callback installed for native tools in a non-edit session. */
export function createRoomPermissionHandler(options: Parameters<typeof roomPermissionDecision>[1]) {
  return async (request: AcpPermissionRequest): Promise<AcpPermissionDecision> => roomPermissionDecision(request, options);
}

/**
 * The permission rule when the OS sandbox could not start: reads are allowed,
 * native edits are allowed only inside the place folder, and shell commands are
 * refused because nothing else would keep their writes inside that folder.
 */
export function unsandboxedPermissionDecision(request: AcpPermissionRequest, folder: string,
  options: { mountedServers?: readonly string[]; hostServers?: readonly string[] } = {}): AcpPermissionDecision {
  const hostServers = options.hostServers ?? CODE_OWNED_HOST_MCP_NAMES;
  if (isRoomMcpPermissionRequest(request, options.mountedServers ?? ROOM_MOUNTED_MCP_SERVERS, hostServers)) return 'allow';
  if (isMcpShapedPermissionRequest(request, hostServers)) return 'reject';
  const kind = request.toolCall?.kind;
  if (kind === 'read' || kind === 'search') return 'allow';
  if (kind !== 'edit') return 'reject';
  const paths = nativeRequestPaths(request.toolCall);
  try {
    const root = realpathSync(resolve(folder));
    return paths?.length && paths.every(path => isAbsolute(path) && path === resolve(path) &&
      strictlyInside(root, realWriteTarget(path))) ? 'allow' : 'reject';
  } catch { return 'reject'; }
}
