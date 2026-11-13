// Isolated native-gh proof: built launcher -> daemon HTTP -> managed provider.
// GitHub/Composio responses are fixtures; no account or production daemon is used.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { installRoomGitHubLauncher } from '../apps/body/dist/room-github-auth.js';
import { ComposioApps } from '../apps/server/dist/composio-apps.js';

const root = await mkdtemp(join(tmpdir(), 'room-github-proof-'));
const file = '{"version":"v1","unicode":"🐝"}\n';
const artifactList = '{ "total_count": 1, "artifacts": [{"id":42,"name":"log-walk"}] }';
const requests = [];
const provider = new ComposioApps('fixture-only', async (url, init) => {
  if (String(url).includes('/connected_accounts/')) return Response.json({
    id: 'fixture', user_id: 'fixture', status: 'ACTIVE', toolkit: { slug: 'github' },
  });
  const request = JSON.parse(init.body);
  requests.push(request);
  let data;
  let headers = { 'content-type': 'application/json' };
  if (request.endpoint.endsWith('/graphql')) {
    const query = request.body.query;
    data = query.includes('SearchType_enumValues')
      ? { data: { SearchType: { enumValues: [{ name: 'ISSUE' }] } } }
      : { data: { search: { issueCount: 1, nodes: [{ number: 1, title: 'Fixture PR',
        url: 'https://github.com/a/b/pull/1', state: 'OPEN', isDraft: false,
        headRefName: 'branch' }], pageInfo: { hasNextPage: false, endCursor: '' } } } };
  } else if (request.endpoint.endsWith('/releases/assets/42')) {
    const accept = request.parameters.find(p => p.type === 'header' && p.name === 'Accept');
    data = accept?.value === 'application/octet-stream' ? file : { id: 42 };
    headers['content-type'] = accept ? 'application/octet-stream' : 'application/json';
  } else if (request.endpoint.endsWith('/artifacts')) data = artifactList;
  else {
    const next = request.parameters.some(p => p.name === 'page' && p.value === '2');
    data = [{ id: next ? 2 : 1 }];
    if (!next) headers.link = '<https://api.github.com/repos/a/b/actions/runs?page=2>; rel="next"';
  }
  return Response.json({ status: 200, headers, data });
});
const server = createServer(async (req, res) => {
  try {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw);
    let result;
    if (req.url.endsWith('readAgentWorkbench')) result = { apps: [{ appKey: 'github',
      selectedByOwner: true, transport: 'composio', appId: 'fixture' }] };
    else if (req.url.endsWith('listAppTools')) result = { tools: ['GITHUB_CREATE_AN_ISSUE_COMMENT',
      'BEELINE_GITHUB_REST_READ', 'BEELINE_GITHUB_GRAPHQL_READ'].map(slug => ({ slug })) };
    else result = { status: 'executed', data: await provider.execute({ accountId: 'fixture',
      userId: 'fixture', toolkit: 'github', tool: input.tool, arguments: input.arguments }) };
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(result));
  } catch (error) {
    res.writeHead(error.status ?? 500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: error.message }));
  }
});
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await writeFile(join(root, 'context.json'), JSON.stringify({ roomId: 'fixture' }));
  await writeFile(join(root, 'fixture.json'), JSON.stringify({
    baseUrl: `http://127.0.0.1:${server.address().port}`, daemonToken: 'fixture',
    turnContextPath: join(root, 'context.json'),
  }));
  const path = await installRoomGitHubLauncher({ root, ghBinary: '/usr/bin/gh',
    inheritedPath: process.env.PATH, resourceAuthFile: join(root, 'fixture.json') });
  async function gh(args) {
    const child = spawn(join(path.split(':')[0], 'gh'), args, { cwd: root,
      env: { PATH: path, HOME: root, XDG_CONFIG_HOME: root, XDG_CACHE_HOME: root,
        GH_TOKEN: 'fixture', GH_CACHE_DIR: join(root, 'cache') } });
    let out = ''; let err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    const code = await new Promise((resolve, reject) => {
      child.on('error', reject); child.on('exit', resolve);
    });
    assert.equal(code, 0, err); return out;
  }
  const pages = await gh(['api', '--paginate', 'repos/a/b/actions/runs', '--jq', '.[].id']);
  assert.equal(pages, '1\n2\n');
  const list = await gh(['pr', 'list', '--repo', 'Beeline-Work/beeline', '--state', 'all', '--search', 'token cache']);
  assert.match(list, /Fixture PR/);
  assert.ok(requests.some(r => r.body?.query.startsWith('fragment pr')));
  assert.equal(await gh(['api', 'repos/a/b/releases/assets/42', '-H', 'Accept: application/octet-stream']), file);
  const artifacts = await gh(['api', 'repos/a/b/actions/runs/42/artifacts']);
  assert.equal(artifacts, artifactList);
  assert.equal(JSON.parse(artifacts).artifacts[0].name, 'log-walk');
  console.log('Reproduction ROOM-GITHUB-READS: PASS — native gh pagination, PR search, release file contents and artifact JSON.');
} finally {
  await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
