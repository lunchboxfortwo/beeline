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
  "description": "Run a command under an approved command grant, only when an approved grant matches the exact argv, word for word and the same length; extra or missing words never match. An approved host grant for user@host also runs argv ['ssh', 'user@host', '<command>', ...] with fixed ssh options; pass no ssh options. In a top-level chat it runs on the SAME read-only filesystem the chat promises — you can read anything and write only your own scratch, so open a thread for work that changes files. A thread can do everything a chat can and more: its worktree is writable and a command there may act on the live host, next to the branch and the transcript that explain it. The named secrets are in its environment and never in the output. Ten-minute timeout, capped output, one ledger row per run.",
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
      },
      "secrets": {
        "type": "array",
        "maxItems": 8,
        "items": {"type": "string", "pattern": "^[A-Z][A-Z0-9_]{0,63}$"},
        "description": "Secret names, each under its own approved secret grant, added to this command's environment; the argv must still match a command grant exactly."
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
  const tools = structuredClone(ORDINARY_TOOLS);
  for (const tool of tools) {
    if (tool.name === 'app_tool') tool.description = tool.description.replace('BEELINE_APPS', apps);
  }
  return tools.map(providerCompatibleTool);
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

type SchemaBranch = Record<string, unknown>;
type BranchText = { conditions: string[]; text: string };

/**
 * One branch as `key=value: field,field,no field`. A branch that only fixes a
 * value and needs nothing else returns undefined: the enum already offers it.
 * Unknown shapes fall back to JSON so no rule is lost.
 */
function branchSummary(branch: SchemaBranch): BranchText | undefined {
  const json = { conditions: [], text: JSON.stringify(branch) };
  const known = new Set(['properties', 'required', 'not', 'if', 'then']);
  if (Object.keys(branch).some(key => !known.has(key))) return json;
  if (branch.if !== undefined || branch.then !== undefined) {
    const { if: condition, then, ...rest } = branch;
    if (!condition || !then || Object.keys(rest).length) return json;
    const when = branchParts(condition as SchemaBranch, true);
    const body = branchParts(then as SchemaBranch, false);
    if (!when || !body) return json;
    return { conditions: [], text: `if ${when.conditions.join(',')}: ${body.fields.join(',') || 'no other limits'}` };
  }
  const parts = branchParts(branch, false);
  if (!parts) return json;
  if (!parts.fields.length) return parts.conditions.length ? undefined : json;
  return { conditions: parts.conditions, text: parts.fields.join(',') };
}

function branchParts(branch: SchemaBranch, condition: boolean): { conditions: string[]; fields: string[] } | undefined {
  const conditions: string[] = [];
  const fields: string[] = [];
  const conditionKeys = new Set<string>();
  for (const [key, value] of Object.entries((branch.properties ?? {}) as Record<string, SchemaBranch>)) {
    const { const: exact, enum: options, type, maxLength, ...other } = value;
    if (Object.keys(other).length) return undefined;
    if (exact !== undefined) { conditions.push(`${key}=${String(exact)}`); conditionKeys.add(key); }
    else if (Array.isArray(options)) { conditions.push(`${key}=${options.join('|')}`); conditionKeys.add(key); }
    else if (typeof maxLength === 'number' && (type === undefined || type === 'string')) fields.push(`${key} max ${maxLength} chars`);
    else return undefined;
  }
  const required = Array.isArray(branch.required) ? branch.required as string[] : [];
  if (!condition) fields.unshift(...required.filter(key => !conditionKeys.has(key)));
  const not = branch.not as SchemaBranch | undefined;
  if (not) {
    const excluded = Array.isArray(not.required) && Object.keys(not).length === 1
      ? not.required as string[]
      : Array.isArray(not.anyOf) && Object.keys(not).length === 1 && (not.anyOf as SchemaBranch[]).every(item => Array.isArray(item.required) && Object.keys(item).length === 1)
        ? (not.anyOf as SchemaBranch[]).flatMap(item => item.required as string[])
        : undefined;
    if (!excluded) return undefined;
    fields.push(`no ${excluded.join('/')}`);
  }
  return { conditions, fields };
}

/** Joins branches, naming a shared leading condition once: `kind=fact (action=save: a; action=delete: b)`. */
function joinBranches(branches: BranchText[]): string {
  const out: string[] = [];
  for (let index = 0; index < branches.length;) {
    const [first, ...rest] = branches[index]!.conditions;
    let end = index + 1;
    while (first && rest.length && end < branches.length && branches[end]!.conditions[0] === first && branches[end]!.conditions.length > 1) end++;
    const label = (branch: BranchText, skip: number) => {
      const conditions = branch.conditions.slice(skip).join(',');
      return conditions ? `${conditions}: ${branch.text}` : branch.text;
    };
    out.push(end - index > 1
      ? `${first} (${branches.slice(index, end).map(branch => label(branch, 1)).join('; ')})`
      : label(branches[index]!, 0));
    index = end;
  }
  return out.join('; ');
}

/** Compact, deterministic text for root combinators, generated from the same schema Beeline validates against. */
export function combinationSummary(schema: Record<string, unknown>): string {
  const sentences: string[] = [];
  for (const [key, label] of [['anyOf', 'Needs'], ['oneOf', 'Needs exactly one'], ['allOf', 'Rules']] as const) {
    const branches = schema[key];
    if (!Array.isArray(branches)) continue;
    const texts = (branches as SchemaBranch[]).map(branchSummary).filter((branch): branch is BranchText => !!branch);
    if (texts.length) sentences.push(`${label}: ${joinBranches(texts)}.`);
  }
  return sentences.join(' ');
}

/** Advertised tools omit requestId; validateAdvertisedToolInput still accepts and checks it. */
export function providerCompatibleTool(tool: ToolDefinition): ToolDefinition {
  const { anyOf, oneOf, allOf, ...inputSchema } = tool.inputSchema;
  const summary = combinationSummary({ anyOf, oneOf, allOf });
  return summary ? { ...tool, inputSchema, description: `${tool.description} ${summary}` } : tool;
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
  operatorAgent = false,
): ToolDefinition[] {
  if (!agentSurface) return repositoryTools();
  const tools = minimalTools(cornerTurn).filter(tool =>
    (institutionalMemoryEnabled || !['search', 'remember'].includes(tool.name)) &&
    (operatorAgent || !['send_operator_system_dm','read_operator_system_dm'].includes(tool.name)));
  if (commandRunnerAvailable) tools.push(structuredClone(RUNNER_TOOL), structuredClone(WORKSPACE_TOOL));
  if (!nativeIoProven) tools.push(...scratchTools(cornerTurn && !repositoryCorner));
  return freeAgent ? tools.map(tool => {
    if (tool.name !== 'connect') return tool;
    const inputSchema = structuredClone(tool.inputSchema);
    const properties = inputSchema.properties as Record<string, unknown>;
    for (const name of ['switchGoogleAccount', 'noApi', 'signedInUrl']) delete properties[name];
    return { ...tool, inputSchema };
  }) : tools;
}
