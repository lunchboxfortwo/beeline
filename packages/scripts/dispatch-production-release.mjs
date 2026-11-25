#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

// Use the active Beeline turn. The server owns identity, provenance and GitHub access.
try {
  const { BEELINE_DAEMON_BASE_URL: baseUrl, BEELINE_DAEMON_TOKEN: token, BEELINE_DAEMON_AGENT_ID: agentId,
    BEELINE_DAEMON_CORNER_ID, BEELINE_DAEMON_ROOM_ID, BEELINE_GRANT_RUNNER_FILE,
    BEELINE_GRANT_RUNNER_URL, BEELINE_GRANT_RUNNER_TOKEN } = process.env;
  const placeId = BEELINE_DAEMON_CORNER_ID || BEELINE_DAEMON_ROOM_ID;
  const endpoint = BEELINE_GRANT_RUNNER_FILE
    ? JSON.parse(await readFile(BEELINE_GRANT_RUNNER_FILE, 'utf8'))
    : { url: BEELINE_GRANT_RUNNER_URL, token: BEELINE_GRANT_RUNNER_TOKEN };
  if (!baseUrl || !token || !agentId || !placeId || !endpoint.url || !endpoint.token)
    throw new Error('Production release requires an authenticated Beeline agent turn');
  const live = await fetch(new URL('/session', endpoint.url), {
    method: 'POST', headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ placeId, action: 'command' }),
  });
  const frame = (await live.text()).trim().split('\n').map(line => JSON.parse(line)).at(-1);
  const context = frame?.status === 200 ? frame.value : undefined;
  if (!context?.requestId)
    throw new Error('Production release requires an authenticated Beeline agent turn');
  const inputs = {};
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 2) {
    const field = args[index + 1];
    if (!['-f', '-F', '--raw-field', '--field'].includes(args[index]) || !field?.includes('='))
      throw new Error('Use -f name=value for release recovery inputs');
    const separator = field.indexOf('=');
    inputs[field.slice(0, separator)] = field.slice(separator + 1);
  }
  const response = await fetch(new URL('/v1/daemon/operations/dispatchRoomWorkflow', baseUrl), {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ agentId, roomId: context.roomId, requestId: context.requestId,
      inputs }), signal: AbortSignal.timeout(120000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message ?? result.error ?? 'Production release dispatch was refused');
  console.log(`Production release dispatched. Dispatch id: ${result.auditMessageId}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
