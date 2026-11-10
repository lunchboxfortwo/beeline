import { CommandRefusalError } from '../command-refusal.js';
import type { Json, ProviderAdapter, ToolContext, ToolInput } from './types.js';
export const key = 'youtube' as const;
/** Explicit YouTube rejection before a video exists; timeouts and generic 5xx stay ambiguous. */
export class YouTubeUploadRefusal extends Error {}

function clearYouTubeUploadRefusal(value: unknown): boolean {
  const hasVideoId = (node: unknown): boolean => {
    if (!node || typeof node !== 'object') return false;
    return Object.entries(node).some(
      ([key, item]) =>
        (['id', 'videoId', 'video_id'].includes(key) && item !== null && item !== '') ||
        hasVideoId(item),
    );
  };
  if (hasVideoId(value)) return false;
  const text = JSON.stringify(value);
  return Boolean(
    text &&
    /youtubeSignupRequired|channel is not properly configured|quotaExceeded|uploadLimitExceeded|dailyLimitExceeded|insufficientPermissions|unverified|invalidTitle|invalidDescription|invalidCategoryId/i.test(
      text,
    ),
  );
}

export const YOUTUBE_ANALYTICS_TOOL = 'BEELINE_YOUTUBE_ANALYTICS_REPORT';
/**
 * Composio's YOUTUBE_UPLOAD_VIDEO returns a video id but never delivers the file, so the video
 * stays in processing forever. It is hidden and refused; the multipart tool works.
 */
const YOUTUBE_BROKEN_UPLOAD_TOOL = 'YOUTUBE_UPLOAD_VIDEO';
const YOUTUBE_UPLOAD_TOOL = 'YOUTUBE_MULTIPART_UPLOAD_VIDEO';
const YOUTUBE_ANALYTICS_REPORTS = 'https://youtubeanalytics.googleapis.com/v2/reports';
const REPORT_DATE = /^\d{4}-\d{2}-\d{2}$/;

const youtubeAnalyticsTool = {
  slug: YOUTUBE_ANALYTICS_TOOL,
  name: 'YouTube Analytics report',
  description:
    'Query a YouTube Analytics report for the connected channel (ids=channel==MINE). ' +
    'Returns columnHeaders and rows. Example: metrics "views,estimatedMinutesWatched", ' +
    'dimensions "day", sort "day".',
  inputParameters: {
    type: 'object',
    properties: {
      startDate: { type: 'string', description: 'First day of the report, YYYY-MM-DD.' },
      endDate: { type: 'string', description: 'Last day of the report, YYYY-MM-DD.' },
      metrics: {
        type: 'string',
        description: 'Comma-separated metrics, e.g. "views,likes,subscribersGained".',
      },
      dimensions: {
        type: 'string',
        description: 'Optional comma-separated dimensions, e.g. "day" or "video".',
      },
      filters: {
        type: 'string',
        description: 'Optional filters, e.g. "video==VIDEO_ID" or "country==US".',
      },
      sort: { type: 'string', description: 'Optional sort, e.g. "-views".' },
      maxResults: { type: 'integer', description: 'Optional maximum number of rows.' },
    },
    required: ['startDate', 'endDate', 'metrics'],
  },
};

function youtubeAnalyticsQuery(args: Json): { name: string; value: string; type: 'query' }[] {
  const text = (key: string, required: boolean): string | undefined => {
    const value = args[key];
    if (value === undefined && !required) return undefined;
    if (typeof value !== 'string' || !value.trim() || value.length > 1000)
      throw new Error(`YouTube Analytics ${key} must be a non-empty string`);
    return value.trim();
  };
  const query: { name: string; value: string; type: 'query' }[] = [
    { name: 'ids', value: 'channel==MINE', type: 'query' },
  ];
  for (const key of ['startDate', 'endDate'] as const) {
    const value = text(key, true)!;
    if (!REPORT_DATE.test(value)) throw new Error(`YouTube Analytics ${key} must be YYYY-MM-DD`);
    query.push({ name: key, value, type: 'query' });
  }
  for (const key of ['metrics', 'dimensions', 'filters', 'sort'] as const) {
    const value = text(key, key === 'metrics');
    if (value !== undefined) query.push({ name: key, value, type: 'query' });
  }
  if (args.maxResults !== undefined) {
    if (!Number.isInteger(args.maxResults) || (args.maxResults as number) < 1)
      throw new Error('YouTube Analytics maxResults must be a positive integer');
    query.push({ name: 'maxResults', value: String(args.maxResults), type: 'query' });
  }
  return query;
}

async function youtubeAnalyticsReport(
  ctx: ToolContext,
  accountId: string,
  args: Json,
): Promise<unknown> {
  const result = await ctx.request(
    '/tools/execute/proxy',
    'POST',
    {
      connected_account_id: accountId,
      endpoint: YOUTUBE_ANALYTICS_REPORTS,
      method: 'GET',
      parameters: youtubeAnalyticsQuery(args),
    },
    'v3.1',
  );
  const status = typeof result.status === 'number' ? result.status : 0;
  if (status < 200 || status > 299) {
    const detail = ctx.providerErrorDetail(result.data);
    throw new Error(
      detail
        ? `YouTube Analytics request failed (${status}): ${detail}`
        : `YouTube Analytics request failed (${status})`,
    );
  }
  const data = ctx.object(result.data);
  return ctx.stripSecrets({
    columnHeaders: Array.isArray(data.columnHeaders) ? data.columnHeaders : [],
    rows: Array.isArray(data.rows) ? data.rows : [],
  });
}
export const adapter: ProviderAdapter = {
  key,
  customAuthOnly: true,
  hiddenTools: [YOUTUBE_BROKEN_UPLOAD_TOOL],
  prependTools: [youtubeAnalyticsTool],
  validateTool(tool) {
    if (tool === YOUTUBE_BROKEN_UPLOAD_TOOL)
      throw new CommandRefusalError(
        `${YOUTUBE_BROKEN_UPLOAD_TOOL} does not deliver the video file; use ${YOUTUBE_UPLOAD_TOOL} instead`,
        400,
      );
  },
  handlesTool: (tool) => tool === YOUTUBE_ANALYTICS_TOOL,
  async executeTool(ctx: ToolContext, input: ToolInput, fileCount: number) {
    if (fileCount)
      throw new CommandRefusalError(
        'A Room file was passed for a parameter that does not take a file',
        400,
      );
    return youtubeAnalyticsReport(ctx, input.accountId, input.arguments);
  },
  checkFailure(tool, result, message) {
    if (tool === YOUTUBE_UPLOAD_TOOL && clearYouTubeUploadRefusal(result))
      throw new YouTubeUploadRefusal(message);
  },
  checkRequestFailure(path, payload, message) {
    if (path === `/tools/execute/${YOUTUBE_UPLOAD_TOOL}` && clearYouTubeUploadRefusal(payload))
      throw new YouTubeUploadRefusal(message);
  },
};
