import { ToolDefinition, CAPABILITY_ROUTES, invocationTool } from './minimal-tool-surface.js';
import { ORDINARY_TOOLS } from './minimal-tool-surface-ordinary-tools.js';


export const REPOSITORY_TOOLS: ToolDefinition[] = [
  {
    "name": "repository_io",
    "description": "Fallback bounded repository/materialized-skill inspection where native reads are unavailable or unproven. Paths stay under daemon-pinned roots; read-only fixed git operations only.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "action": {"type": "string", "enum": ["files", "read", "skill", "search", "log", "show", "diff", "status"]},
        "path": {"type": "string"},
        "max_depth": {"type": "integer", "minimum": 1, "maximum": 8},
        "limit": {"type": "integer", "minimum": 1, "maximum": 100},
        "start_line": {"type": "integer", "minimum": 1},
        "end_line": {"type": "integer", "minimum": 1},
        "area": {"type": "string", "enum": ["skills"]},
        "query": {"type": "string", "minLength": 1, "maxLength": 256},
        "case_sensitive": {"type": "boolean"},
        "max_results": {"type": "integer", "minimum": 1, "maximum": 200},
        "revision": {"type": "string"},
        "from": {"type": "string"},
        "to": {"type": "string"}
      },
      "required": ["action"],
      "additionalProperties": false,
      "anyOf": [
        {"properties": {"action": {"const": "files"}}, "required": ["action"]},
        {"properties": {"action": {"const": "read"}}, "required": ["action", "path"]},
        {"properties": {"action": {"const": "skill"}}, "required": ["action", "area", "path"]},
        {"properties": {"action": {"const": "search"}}, "required": ["action", "query"]},
        {"properties": {"action": {"const": "log"}}, "required": ["action"]},
        {"properties": {"action": {"const": "show"}}, "required": ["action"]},
        {"properties": {"action": {"const": "diff"}}, "required": ["action"]},
        {"properties": {"action": {"const": "status"}}, "required": ["action"]}
      ]
    }
  }
];

export const SCRATCH_TOOLS: ToolDefinition[] = [
  {
    "name": "scratch_io",
    "description": "Fallback session-file writes and bounded image downloads when native IO is unavailable or unproven; repo-less threads also support quota. Paths stay inside the writable session area.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "action": {"type": "string", "enum": ["write", "image", "quota"]},
        "path": {"type": "string", "maxLength": 1024},
        "content": {"type": "string"},
        "encoding": {"type": "string", "enum": ["utf8", "base64"]},
        "url": {"type": "string", "maxLength": 2048}
      },
      "required": ["action"],
      "additionalProperties": false,
      "anyOf": [
        {"properties": {"action": {"const": "write"}}, "required": ["action", "path", "content"]},
        {"properties": {"action": {"const": "image"}}, "required": ["action", "url"]},
        {"properties": {"action": {"const": "quota"}}, "required": ["action"]}
      ]
    }
  }
];

export const RUNNER_TOOL: ToolDefinition = {
  "name": "run_granted_command",
  "description": "Run a command under an approved command grant, only when an approved grant is a word-for-word prefix of argv. In a top-level chat it runs on the SAME read-only filesystem the chat promises — you can read anything and write only your own scratch, so open a thread for work that changes files. A thread can do everything a chat can and more: its worktree is writable and a command there may act on the live host, next to the branch and the transcript that explain it. The named secrets are in its environment and never in the output. Ten-minute timeout, capped output, one ledger row per run.",
  "inputSchema": {
    "type": "object",
    "required": ["argv"],
    "properties": {
      "stdin": { "type": "string", "maxLength": 4096, "description": "Exact input bytes approved with a JSON command target containing argv and stdin." },
      "argv": {
        "type": "array",
        "minItems": 1,
        "items": {"type": "string", "minLength": 1},
        "description": "The command and its arguments as separate words."
      }
    },
    "additionalProperties": false
  }
};

export const WORKSPACE_TOOL: ToolDefinition = {
  "name": "workspace",
  "description": "Make or refresh your own copy of this place's repository and index it. In a thread it checks out the thread branch where you can commit; in a chat it is a read-only copy of the target branch. Returns the path, or the reason it failed. Run dependency installs yourself in the copy.",
  "inputSchema": {"type": "object", "properties": {}, "additionalProperties": false}
};

export const SILENT_TOOL: ToolDefinition = {
  "name": "no_reply_needed",
  "description": "Acknowledge an answer already posted for this request. An unanswered queue item remains pending: provide your own answer. For a tagged message, messageId selects the tag to acknowledge after answering it.",
  "inputSchema": {"type": "object", "properties": {"messageId": {"type": "string", "pattern": "^[0-9a-f]{64}$", "description": "Explicitly decline this tagged message in the current chat."}}, "additionalProperties": false}
};

/**
 * The Beeline apps app_tool serves in a place.
 * Onboarding joins only while the server marks the Room eligible.
 */
export function placeBeelineApps(_cornerTurn: boolean, onboarding = false): string[] {
  return Object.keys(CAPABILITY_ROUTES)
    .filter(capability => (capability !== 'onboarding' || onboarding))
    .map(capability => `beeline:${capability}`);
}

/** app_tool names only the Beeline apps that work in this place, so discovery never offers one that refuses. */
export function minimalTools(cornerTurn: boolean): ToolDefinition[] {
  const apps = placeBeelineApps(cornerTurn).join(', ');
  return structuredClone(ORDINARY_TOOLS).map(tool =>
    providerCompatibleTool(tool.name === 'app_tool'
      ? { ...tool, description: tool.description.replace('BEELINE_APPS', apps) } : tool));
}

export function repositoryTools(): ToolDefinition[] { return structuredClone(REPOSITORY_TOOLS).map(providerCompatibleTool); }

export function scratchTools(quota: boolean): ToolDefinition[] {
 const tools = structuredClone(SCRATCH_TOOLS);
 if (!quota) {
   const properties = tools[0]!.inputSchema.properties as Record<string, { enum?: string[] }>;
   properties.action!.enum = ['write', 'image'];
 }
 return tools.map(providerCompatibleTool);
}


/** Full input contract, retained independently of provider schema restrictions. */
export function toolValidationSchema(name: string): Record<string, unknown> | undefined {
  const tool = [...ORDINARY_TOOLS, ...REPOSITORY_TOOLS, ...SCRATCH_TOOLS].find(tool => tool.name === name);
  return tool ? structuredClone(invocationTool(tool).inputSchema) : undefined;
}

export function providerCompatibleTool(tool: ToolDefinition): ToolDefinition {
  tool = invocationTool(tool);
  const { anyOf, oneOf, allOf, ...inputSchema } = tool.inputSchema;
  const combinations = { ...(anyOf ? { anyOf } : {}), ...(oneOf ? { oneOf } : {}), ...(allOf ? { allOf } : {}) };
  return Object.keys(combinations).length
    ? { ...tool, inputSchema, description: `${tool.description} Argument combinations (validated by Beeline): ${JSON.stringify(combinations)}` }
    : tool;
}


/** The ordinary surface is stable across warm turns; optional schemas are read through app_tool. */
export function agentToolsFor(
  agentSurface: boolean,
  _directMessage: boolean,
  cornerTurn = false,
  repositoryCorner = false,
  commandRunnerAvailable = true,
  institutionalMemoryEnabled = true,
  nativeIoProven = false,
  freeAgent = false,
): ToolDefinition[] {
  if (!agentSurface) return repositoryTools();
  const tools = minimalTools(cornerTurn).filter(tool =>
    institutionalMemoryEnabled || !['search', 'remember'].includes(tool.name));
  if (commandRunnerAvailable) tools.push(invocationTool(RUNNER_TOOL), invocationTool(WORKSPACE_TOOL));
  // Every harness can acknowledge an answer it already posted through tools.
  tools.push(invocationTool(SILENT_TOOL));
  if (!nativeIoProven) tools.push(...scratchTools(cornerTurn && !repositoryCorner));
  return freeAgent ? tools.map(tool => {
    if (tool.name !== 'connect') return tool;
    const inputSchema = structuredClone(tool.inputSchema);
    const properties = inputSchema.properties as Record<string, unknown>;
    for (const name of ['switchGoogleAccount', 'noApi', 'signedInUrl']) delete properties[name];
    return { ...tool, inputSchema };
  }) : tools;
}
