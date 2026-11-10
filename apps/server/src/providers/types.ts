export type Json = Record<string, unknown>;
export type Tool = { slug: string; name: string; description: string; inputParameters?: unknown };
export interface ToolContext {
  request(
    path: string,
    method: 'GET' | 'POST' | 'DELETE',
    data?: Json,
    version?: 'v3' | 'v3.1',
  ): Promise<Json>;
  object(value: unknown): Json;
  stripSecrets(value: unknown): unknown;
  providerErrorDetail(value: unknown): string | undefined;
}
export type ToolInput = { accountId: string; tool: string; arguments: Json };
export interface WebhookAdapter {
  event: string;
  catalog: { service: string; event: string; label: string };
  initial(id: string): { signingSecret: string | null; providerId: string | null };
  verify(
    raw: Buffer,
    headers: Record<string, string | string[] | undefined>,
    body: Json,
    hook: { signing_secret: string; provider_id: string; event: string },
    now: number,
  ): string | undefined;
  summary(body: Json): { object: string; payload: Json };
}
export interface ProviderAdapter {
  key: string;
  customAuthOnly?: boolean;
  signInUnavailable?: string;
  preferVault?: boolean;
  officialRegistry?: string;
  aliases?: readonly string[];
  hiddenTools?: readonly string[];
  prependTools?: readonly Tool[];
  appendTools?: readonly Tool[];
  validateTool?(tool: string): void;
  handlesTool?(tool: string): boolean;
  executeTool?(ctx: ToolContext, input: ToolInput, fileCount: number): Promise<unknown>;
  checkFailure?(tool: string, result: unknown, message: string): void;
  checkRequestFailure?(path: string, payload: unknown, message: string): void;
  webhook?: WebhookAdapter;
}
