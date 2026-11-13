import { CommandRefusalError } from '../command-refusal.js';
import type { ProviderAdapter, ToolContext, ToolInput } from './types.js';
export const key = 'github' as const;
const githubRestReadTool = {
  slug: 'BEELINE_GITHUB_REST_READ',
  name: 'GitHub repository REST read',
  description:
    'Read repository data through the connected GitHub account, including contents and pull requests.',
  inputParameters: {
    type: 'object',
    additionalProperties: false,
    required: ['path'],
    properties: {
      path: {
        type: 'string',
        description:
          'Repository API path or HTTPS api.github.com pagination URL, including query parameters.',
      },
      accept: {
        type: 'string',
        enum: ['application/octet-stream'],
        description: 'Download release asset contents.',
      },
    },
  },
};

const githubGraphqlReadTool = {
  slug: 'BEELINE_GITHUB_GRAPHQL_READ',
  name: 'GitHub GraphQL read',
  description: 'Run read-only GitHub GraphQL queries. Mutations and subscriptions are refused.',
  inputParameters: {
    type: 'object',
    required: ['query'],
    additionalProperties: false,
    properties: {
      query: { type: 'string' },
      variables: { type: 'object' },
      operationName: { type: 'string' },
    },
  },
};
const githubContentsPutTool = {
  slug: 'BEELINE_GITHUB_CONTENTS_PUT',
  name: 'GitHub repository contents write',
  description: 'Create or update one repository file through the connected personal account.',
  inputParameters: {
    type: 'object',
    required: ['path', 'body'],
    additionalProperties: false,
    properties: { path: { type: 'string' }, body: { type: 'object' } },
  },
};

async function executeTool(
  ctx: ToolContext,
  input: ToolInput,
  fileCount: number,
): Promise<unknown> {
  const graphql = input.tool === githubGraphqlReadTool.slug;
  const write = input.tool === githubContentsPutTool.slug;
  const path = graphql ? '/graphql' : input.arguments.path;
  const url = typeof path === 'string' ? new URL(path, 'https://api.github.com') : undefined;
  if (
    !graphql &&
    (!url ||
      !path ||
      typeof path !== 'string' ||
      !(path.startsWith('/repos/') || (!write && path.startsWith('https://api.github.com/'))) ||
      url.origin !== 'https://api.github.com' ||
      !/^\/repos\/[^/]+\/[^/]+(?:\/|$)/.test(url.pathname) ||
      url.hash ||
      url.username ||
      url.password ||
      Object.keys(input.arguments).some(
        (key) => !['path', ...(write ? ['body'] : ['accept'])].includes(key),
      ) ||
      (!write &&
        input.arguments.accept !== undefined &&
        input.arguments.accept !== 'application/octet-stream'))
  )
    throw new CommandRefusalError('GitHub read requires a repository API path', 400);
  // Fail closed across every operation in a document, including an unselected
  // mutation. Keyword checks are conservative even inside strings/comments.
  if (
    graphql &&
    (typeof input.arguments.query !== 'string' ||
      !/^(?:\s|,|#[^\r\n]*(?:\r?\n|$))*(?:query\b|fragment\b|\{)/.test(input.arguments.query) ||
      /\b(?:mutation|subscription)\b/.test(input.arguments.query) ||
      Object.keys(input.arguments).some(
        (key) => !['query', 'variables', 'operationName'].includes(key),
      ))
  )
    throw new CommandRefusalError('GitHub GraphQL accepts read queries only', 400);
  if (
    write &&
    (!url ||
      !/^\/repos\/[^/]+\/[^/]+\/contents\/.+/.test(url.pathname) ||
      url.search ||
      url.pathname.split('/').some((part) => {
        const decoded = decodeURIComponent(part);
        return decoded === '..' || decoded === '.' || /[/\\%]/.test(decoded);
      }) ||
      !input.arguments.body ||
      typeof input.arguments.body !== 'object' ||
      Array.isArray(input.arguments.body))
  )
    throw new CommandRefusalError('GitHub write requires a repository contents path and body', 400);
  if (fileCount) throw new CommandRefusalError('GitHub requests do not take files', 400);
  const result = await ctx.request(
    '/tools/execute/proxy',
    'POST',
    {
      connected_account_id: input.accountId,
      endpoint: url!.origin + url!.pathname,
      method: graphql ? 'POST' : write ? 'PUT' : 'GET',
      ...(graphql ? { body: input.arguments } : write ? { body: input.arguments.body } : {}),
      parameters: [
        ...[...url!.searchParams].map(([name, value]) => ({ name, value, type: 'query' })),
        ...(!graphql && !write && input.arguments.accept
          ? [{ name: 'Accept', value: input.arguments.accept, type: 'header' }]
          : []),
      ],
    },
    'v3.1',
  );
  if (
    !Number.isInteger(result.status) ||
    Number(result.status) < 100 ||
    Number(result.status) > 599
  )
    throw new Error('GitHub returned an invalid response status');
  const headers = ctx.object(result.headers);
  return {
    status: result.status,
    headers: {
      'content-type':
        typeof headers['content-type'] === 'string' ? headers['content-type'] : 'application/json',
      ...(typeof headers.link === 'string' ? { link: headers.link } : {}),
    },
    body:
      typeof result.data === 'string' ? result.data : JSON.stringify(ctx.stripSecrets(result.data)),
  };
}
export const adapter: ProviderAdapter = {
  key,
  preferVault: true,
  appendTools: [githubRestReadTool, githubGraphqlReadTool, githubContentsPutTool],
  handlesTool: (tool) =>
    [githubRestReadTool.slug, githubGraphqlReadTool.slug, githubContentsPutTool.slug].includes(
      tool,
    ),
  executeTool,
};
