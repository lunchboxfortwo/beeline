import { APPROVAL_ACTION_SCHEMA, APPROVAL_PURPOSE_SCHEMA } from '@beeline/api-contract/phone';

const APPROVAL_TOOLS = new Set([
  'connect', 'fetch_credential', 'inject_card', 'edit_credential', 'delete_credential',
  'edit_payment_card', 'operate_login', 'operate_fill_credential', 'operate',
  'operate_start', 'operate_navigate', 'operate_drive',
]);
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Squire owns its tools; this transport adds only Beeline's display intent. */
export function squireApprovalSchemas(response: Record<string, unknown>): Record<string, unknown> {
  const result = object(response.result);
  if (!Array.isArray(result.tools)) return response;
  return { ...response, result: { ...result, tools: result.tools.map(raw => {
    const tool = object(raw);
    if (!APPROVAL_TOOLS.has(String(tool.name))) return raw;
    const schema = object(tool.inputSchema);
    return { ...tool, inputSchema: { ...schema,
      properties: { ...object(schema.properties), action: APPROVAL_ACTION_SCHEMA, purpose: APPROVAL_PURPOSE_SCHEMA },
      required: (Array.isArray(schema.required) ? schema.required : []).filter(field => field !== 'action' && field !== 'purpose'),
    } };
  }) } };
}

/** Strip display intent upstream; keep the original call for the approval relay. */
export function squireApprovalCall(message: Record<string, unknown>): Record<string, unknown> {
  if (message.method !== 'tools/call') return message;
  const params = object(message.params);
  if (!APPROVAL_TOOLS.has(String(params.name))) return message;
  const args = object(params.arguments);
  const { action: _action, purpose: _purpose, ...upstream } = args;
  return { ...message, params: { ...params, arguments: upstream } };
}
