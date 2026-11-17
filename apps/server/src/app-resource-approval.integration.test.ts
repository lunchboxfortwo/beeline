import { randomUUID } from 'node:crypto';
import { describe, expect, it, PhoneService, WORKSPACE, ROOM, OWNER, HELPER,
  turn, fakeRegistry, fixtureScope2 } from './test-support-app-connections.integration.test-support.js';

describe('connected app resource-owner approval', () => {
  const scope = fixtureScope2();
  const phone = () => new PhoneService(scope.database, 'http://placeholder');

  it.each(['registry-mcp', 'squire-api', 'squire-browser'])(
    'asks and authorizes an active %s app through its resolved resource gate', async transport => {
      const appId = randomUUID();
      await scope.database.query(`INSERT INTO workspace_apps(
        id,workspace_id,owner_identity_id,app_key,display_name,transport,route)
        VALUES($1,$2,$3,'linear','Linear',$4,$4)`, [appId, WORKSPACE, OWNER, transport]);
      await scope.database.query('UPDATE agents SET yolo_mode=false WHERE agent_id=$1', [HELPER]);
      const daemon = scope.daemonWith(fakeRegistry([]).client);
      const call = { ...turn, target: 'registry-mcp:app.linear/linear', operation: 'tools/call' };
      const first = await daemon.execute('authorizeResourceCall', call, HELPER);
      expect(first).toMatchObject({ allowed: false, status: 'pending' });
      expect((await scope.database.query(`SELECT app_id,target,auto FROM agent_grants WHERE id=$1`,
        [first.grantId])).rows).toEqual([{ app_id: appId, target: 'app:linear', auto: false }]);
      expect(await daemon.execute('authorizeResourceCall', call, HELPER))
        .toMatchObject({ allowed: false, grantId: first.grantId });
      await phone().execute('decideAgentGrant', { grantId: first.grantId!, decision: 'always' }, OWNER);
      expect(await daemon.execute('authorizeResourceCall', call, HELPER))
        .toMatchObject({ allowed: true, grantId: first.grantId });
      expect((await scope.database.query(`SELECT app_id,grant_id,transport FROM workspace_app_usage`)).rows)
        .toEqual([{ app_id: appId, grant_id: first.grantId, transport }]);
      await scope.database.query("UPDATE workspace_apps SET state='disconnected' WHERE id=$1", [appId]);
      expect(await daemon.execute('authorizeResourceCall', call, HELPER)).toMatchObject({ allowed: false });
    });

  it.each(['yolo-off', 'public-workspace'])(
    'requires live owner approval for managed tools after %s', async mode => {
      const provider = scope.fakeComposio();
      const daemon = scope.daemonWith(fakeRegistry([]).client, provider);
      const appId = await scope.connectedSlack(daemon, provider);
      const call = { ...turn, appId, tool: 'SLACK_POST_MESSAGE', arguments: { text: 'Launch notes' } };
      expect(await daemon.execute('executeAppTool', call, HELPER)).toMatchObject({ status: 'executed' });
      const auto = await daemon.execute('requestAgentGrant', { ...turn, kind: 'mcp',
        target: 'app:slack', appId, reason: 'Post launch notes' }, HELPER);
      expect(auto).toMatchObject({ auto: true, status: 'approved' });
      if (mode === 'yolo-off')
        await scope.database.query('UPDATE agents SET yolo_mode=false WHERE agent_id=$1', [HELPER]);
      else await scope.database.query("UPDATE workspaces SET visibility='public' WHERE id=$1", [WORKSPACE]);
      const first = await daemon.execute('executeAppTool', call, HELPER);
      expect(first).toMatchObject({ status: 'needs_permission' });
      if (first.status !== 'needs_permission') throw new Error('Owner approval was bypassed');
      expect(provider.execute).toHaveBeenCalledTimes(1);
      expect(first.grantId).not.toBe(auto.grantId);
      expect(await daemon.execute('executeAppTool', call, HELPER))
        .toMatchObject({ status: 'needs_permission', grantId: first.grantId });
      await phone().execute('decideAgentGrant', { grantId: first.grantId!, decision: 'once' }, OWNER);
      expect(await daemon.execute('executeAppTool', call, HELPER)).toMatchObject({ status: 'executed' });
      const second = await daemon.execute('executeAppTool', call, HELPER);
      expect(second).toMatchObject({ status: 'needs_permission' });
      if (second.status !== 'needs_permission') throw new Error('Once approval was reused');
      expect(provider.execute).toHaveBeenCalledTimes(2);
      expect(second.grantId).not.toBe(first.grantId);
      await phone().execute('decideAgentGrant', { grantId: second.grantId!, decision: 'always' }, OWNER);
      expect(await daemon.execute('executeAppTool', call, HELPER)).toMatchObject({ status: 'executed' });
      await phone().execute('revokeAgentGrant', { grantId: second.grantId! }, OWNER);
      const third = await daemon.execute('executeAppTool', call, HELPER);
      expect(third).toMatchObject({ status: 'needs_permission' });
      if (third.status !== 'needs_permission') throw new Error('Revoked approval was reused');
      expect(provider.execute).toHaveBeenCalledTimes(3);
      await phone().execute('decideAgentGrant', { grantId: third.grantId!, decision: 'always' }, OWNER);
      await scope.database.query("UPDATE agent_grants SET expires_at=now()-interval '1 second' WHERE id=$1",
        [third.grantId]);
      expect(await daemon.execute('executeAppTool', call, HELPER)).toMatchObject({ status: 'needs_permission' });
      expect(provider.execute).toHaveBeenCalledTimes(3);
    });

  it.each([[false, false], [false, true], [true, false], [true, true]])(
    'stops automatic installation consent after effective YOLO turns off (browser=%s, public=%s)', async (noApi, publicWorkspace) => {
    await scope.connectSquire();
    const daemon = scope.daemonWith(fakeRegistry([]).client);
    const input = { ...turn, service: 'resend.com', reason: 'Connect email', noApi, squireAvailable: true };
    const first = await daemon.execute('connect', input, HELPER);
    expect(first).toMatchObject({ status: 'needs_squire' });
    const target = `connection-install:${first.appKey}`;
    const auto = (await scope.database.query<{ id: string; auto: boolean }>(
      'SELECT id,auto FROM agent_grants WHERE target=$1', [target])).rows[0]!;
    expect(auto.auto).toBe(true);
    if (publicWorkspace) await scope.database.query("UPDATE workspaces SET visibility='public' WHERE id=$1", [WORKSPACE]);
    else await scope.database.query('UPDATE agents SET yolo_mode=false WHERE agent_id=$1', [HELPER]);
    const asked = await daemon.execute('connect', input, HELPER);
    expect(asked).toMatchObject({ status: 'needs_approval' });
    expect(asked).not.toHaveProperty('squire');
    expect(asked.grantId).not.toBe(auto.id);
    expect(await daemon.execute('connect', input, HELPER))
      .toMatchObject({ status: 'needs_approval', grantId: asked.grantId });
    await phone().execute('decideAgentGrant', { grantId: asked.grantId!, decision: 'always' }, OWNER);
    expect(await daemon.execute('connect', input, HELPER)).toMatchObject({ status: 'needs_squire' });
    expect(await daemon.execute('connect', input, HELPER)).toMatchObject({ status: 'needs_squire' });
    expect((await scope.database.query('SELECT id FROM agent_grants WHERE target=$1', [target])).rows)
      .toHaveLength(2);
  });

  it.each([false, true])('reuses pending and denied installation decisions and consumes Once (browser=%s)', async noApi => {
    await scope.connectSquire();
    await scope.database.query('UPDATE agents SET yolo_mode=false WHERE agent_id=$1', [HELPER]);
    const daemon = scope.daemonWith(fakeRegistry([]).client);
    const input = { ...turn, service: 'resend.com', reason: 'Connect email', noApi, squireAvailable: true };
    const first = await daemon.execute('connect', input, HELPER);
    expect(first).toMatchObject({ status: 'needs_approval' });
    const target = `connection-install:${first.appKey}`;
    expect(await daemon.execute('connect', input, HELPER))
      .toMatchObject({ status: 'needs_approval', grantId: first.grantId });
    expect((await scope.database.query('SELECT id FROM agent_grants WHERE target=$1', [target])).rows)
      .toHaveLength(1);
    await phone().execute('decideAgentGrant', { grantId: first.grantId!, decision: 'once' }, OWNER);
    expect(await daemon.execute('connect', input, HELPER)).toMatchObject({ status: 'needs_squire' });
    expect((await scope.database.query('SELECT expires_at<=now() spent FROM agent_grants WHERE id=$1',
      [first.grantId])).rows).toEqual([{ spent: true }]);
    const second = await daemon.execute('connect', input, HELPER);
    expect(second).toMatchObject({ status: 'needs_approval' });
    expect(second.grantId).not.toBe(first.grantId);
    await phone().execute('decideAgentGrant', { grantId: second.grantId!, decision: 'deny' }, OWNER);
    for (let retry = 0; retry < 2; retry++) {
      const denied = await daemon.execute('connect', input, HELPER);
      expect(denied).toMatchObject({ status: 'unavailable', grantId: second.grantId });
      expect(denied).not.toHaveProperty('squire');
    }
    expect((await scope.database.query('SELECT id FROM agent_grants WHERE target=$1', [target])).rows)
      .toHaveLength(2);
  });

  it.each(['revoked', 'expired'])('does not reuse %s human installation consent', async state => {
    await scope.connectSquire();
    await scope.database.query('UPDATE agents SET yolo_mode=false WHERE agent_id=$1', [HELPER]);
    const daemon = scope.daemonWith(fakeRegistry([]).client);
    const input = { ...turn, service: 'resend.com', reason: 'Connect email', squireAvailable: true };
    const first = await daemon.execute('connect', input, HELPER);
    await phone().execute('decideAgentGrant', { grantId: first.grantId!, decision: 'always' }, OWNER);
    expect(await daemon.execute('connect', input, HELPER)).toMatchObject({ status: 'needs_squire' });
    if (state === 'revoked') await phone().execute('revokeAgentGrant', { grantId: first.grantId! }, OWNER);
    else await scope.database.query("UPDATE agent_grants SET expires_at=now()-interval '1 second' WHERE id=$1", [first.grantId]);
    const next = await daemon.execute('connect', input, HELPER);
    expect(next).toMatchObject({ status: 'needs_approval' });
    expect(next.grantId).not.toBe(first.grantId);
    expect(next).not.toHaveProperty('squire');
  });

  it('does not borrow installation approval from another root requester', async () => {
    await scope.connectSquire();
    await scope.database.query('UPDATE agents SET yolo_mode=false WHERE agent_id=$1', [HELPER]);
    const daemon = scope.daemonWith(fakeRegistry([]).client);
    const input = { ...turn, service: 'resend.com', reason: 'Connect email', squireAvailable: true };
    const first = await daemon.execute('connect', input, HELPER);
    await phone().execute('decideAgentGrant', { grantId: first.grantId!, decision: 'always' }, OWNER);
    expect(await daemon.execute('connect', input, HELPER)).toMatchObject({ status: 'needs_squire' });
    await scope.seedWorkflowWake({ runId: 'installation-wake', startRequester: HELPER });
    const next = await daemon.execute('connect', input, HELPER);
    expect(next).toMatchObject({ status: 'needs_approval' });
    expect(next.grantId).not.toBe(first.grantId);
    expect((await scope.database.query('SELECT requested_by FROM agent_grants WHERE id=$1',
      [next.grantId])).rows).toEqual([{ requested_by: HELPER }]);
  });

  it('retains wake provenance for approval while attributing owner app usage to its owner', async () => {
    const provider = scope.fakeComposio();
    const daemon = scope.daemonWith(fakeRegistry([]).client, provider);
    const appId = await scope.connectedSlack(daemon, provider);
    await scope.seedWorkflowWake({ runId: 'approval-wake', startRequester: HELPER });
    await scope.database.query('UPDATE agents SET yolo_mode=false WHERE agent_id=$1', [HELPER]);
    const call = { ...turn, appId, tool: 'SLACK_POST_MESSAGE', arguments: { text: 'Launch notes' } };
    const first = await daemon.execute('executeAppTool', call, HELPER);
    expect(first).toMatchObject({ status: 'needs_permission' });
    if (first.status !== 'needs_permission') throw new Error('Wake approval was bypassed');
    expect(provider.execute).not.toHaveBeenCalled();
    await phone().execute('decideAgentGrant', { grantId: first.grantId!, decision: 'always' }, OWNER);
    expect(await daemon.execute('executeAppTool', call, HELPER)).toMatchObject({ status: 'executed' });
    expect((await scope.database.query('SELECT requester_id,grant_id FROM workspace_app_usage')).rows)
      .toEqual([{ requester_id: OWNER, grant_id: first.grantId }]);
  });
});
