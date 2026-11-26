import type { AddressInfo } from 'node:net';
import { phoneFetch } from '../../../../packages/test-helpers/helpers/phone-operation.js';
import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { TokenAuth } from '.././auth.js';
import { DaemonService } from '.././daemon-service.js';
import { PhoneService } from '.././phone-service.js';
import { createBeelineServer } from '.././server.js';
import { GitHubHttpError } from '@beeline/auth/github';
import { monolithFixture, HUMAN, AGENT, WORKSPACE, ROOM } from '../test-fixtures/test-support-monolith.js';

describe('monolith integration: github-repositories', () => {
const fixture = monolithFixture();


  it('creates Rooms with or without an installed repository binding', async () => {
    await fixture.database.query(
      `INSERT INTO github_installations(installation_id,owner_id,account_login,account_type) VALUES(42,$1,'owner','User')`,
      [HUMAN],
    );
    await fixture.database.query(
      `INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch) VALUES(77,42,'owner/worker','trunk')`,
    );

    const plain = await fixture.request('/v1/phone/operations/createRoom', 'POST', {
      workspaceId: WORKSPACE,
      name: 'plain-room',
    });
    expect(plain.status).toBe(200);
    const plainId = ((await plain.json()) as { id: string }).id;
    expect(
      (await new PhoneService(fixture.database, fixture.origin).readRoom(plainId, HUMAN))?.repository,
    ).toBeUndefined();
    expect(
      (
        await fixture.database.query<{
          repository_key: string | null;
          repository_remote: string | null;
          github_installation_id: string | null;
        }>(
          `SELECT repository_key,repository_remote,github_installation_id FROM rooms WHERE id=$1`,
          [plainId],
        )
      ).rows[0],
    ).toEqual({
      repository_key: null,
      repository_remote: null,
      github_installation_id: null,
    });

    const bound = await fixture.request('/v1/phone/operations/createRoom', 'POST', {
      workspaceId: WORKSPACE,
      name: 'repository-room',
      repositoryId: 77,
    });
    expect(bound.status).toBe(200);
    const boundId = ((await bound.json()) as { id: string }).id;
    expect((await new PhoneService(fixture.database, fixture.origin).readRoom(boundId, HUMAN))?.repository).toEqual(
      expect.objectContaining({
        key: 'github:77',
        name: 'owner/worker',
        remote: 'git://github.com/owner/worker',
        targetBranch: 'trunk',
        githubInstallationId: 42,
      }),
    );
    const chats = (await (await fixture.request(`/v1/phone/workspaces/${WORKSPACE}/chats`)).json()) as {
      chats: Array<{ room: { id: string }; repositoryName?: string }>;
    };
    expect(chats.chats.find((item) => item.room.id === boundId)?.repositoryName).toBe(
      'owner/worker',
    );
  });


  it('defaults a new Room to its repository visibility unless the client chooses one', async () => {
    await fixture.database.query(
      `INSERT INTO github_installations(installation_id,owner_id,account_login,account_type) VALUES(42,$1,'owner','User')`,
      [HUMAN],
    );
    await fixture.database.query(
      `INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch,private)
       VALUES(77,42,'owner/secret','main',true),(78,42,'owner/open','main',false),
             (79,42,'owner/unknown','main',NULL)`,
    );
    const visibilityOf = async (body: Record<string, unknown>) => {
      const created = await fixture.request('/v1/phone/operations/createRoom', 'POST', {
        workspaceId: WORKSPACE,
        ...body,
      });
      expect(created.status).toBe(200);
      const { id } = (await created.json()) as { id: string };
      return (
        await fixture.database.query<{ visibility: string }>(`SELECT visibility FROM rooms WHERE id=$1`, [
          id,
        ])
      ).rows[0]?.visibility;
    };

    expect(await visibilityOf({ name: 'no-repo' })).toBe('public');
    expect(await visibilityOf({ name: 'private-repo', repositoryId: 77 })).toBe('invite-only');
    expect(await visibilityOf({ name: 'public-repo', repositoryId: 78 })).toBe('public');
    expect(await visibilityOf({ name: 'unknown-repo', repositoryId: 79 })).toBe('invite-only');
    expect(
      await visibilityOf({ name: 'private-made-public', repositoryId: 77, visibility: 'public' }),
    ).toBe('public');
    expect(
      await visibilityOf({
        name: 'public-made-private',
        repositoryId: 78,
        visibility: 'invite-only',
      }),
    ).toBe('invite-only');
  });


  it('preserves existing handles across joins and GitHub login changes', async () => {
    const directMember = 'd'.repeat(64);
    await fixture.database.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Direct member','bee')`,
      [directMember],
    );
    expect(
      (
        await fixture.operation('addWorkspaceMember', {
          workspaceId: WORKSPACE,
          memberId: directMember,
          role: 'member',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fixture.database.query<{ handle: string }>(`SELECT handle FROM identities WHERE id=$1`, [
          AGENT,
        ])
      ).rows[0]?.handle,
    ).toBe('bee');

    const invite = (await (await fixture.operation('createInvite', { workspaceId: WORKSPACE })).json()) as {
      token: string;
    };
    const invitee = await fixture.phoneToken('bee_2');
    expect(
      (await fixture.request('/v1/phone/operations/redeemInvite', 'POST', { token: invite.token }, invitee))
        .status,
    ).toBe(200);
    expect(
      (
        await fixture.database.query<{ handle: string }>(`SELECT handle FROM identities WHERE id=$1`, [
          AGENT,
        ])
      ).rows[0]?.handle,
    ).toBe('bee');

    const renamedLogin = new TokenAuth(fixture.database, async () => ({
      subject: 'owner',
      login: 'bee_3',
      name: 'Owner',
    }));
    await renamedLogin.exchangeGitHubOidc('owner-renamed-login');
    expect(
      (
        await fixture.database.query<{ handle: string }>(`SELECT handle FROM identities WHERE id=$1`, [
          HUMAN,
        ])
      ).rows[0]?.handle,
    ).toBe('owner');
    expect(
      (
        await fixture.database.query<{ handle: string }>(`SELECT handle FROM identities WHERE id=$1`, [
          AGENT,
        ])
      ).rows[0]?.handle,
    ).toBe('bee');
  });


  it('recovers a GitHub identity conflict and exposes the predecessor over HTTP', async () => {
    const predecessor = 'c'.repeat(64);
    await fixture.database.query(`UPDATE identities SET github_subject=NULL WHERE id=$1`, [HUMAN]);
    await fixture.database.query(
      `INSERT INTO identities(id,kind,name,handle,github_subject) VALUES($1,'human','Old Owner','old-owner','owner')`,
      [predecessor],
    );
    await fixture.database.query(
      `UPDATE identity_external_links SET identity_id=$1,audience='old-oauth-client'
       WHERE provider='github' AND subject='owner'`,
      [predecessor],
    );
    const state = 'r'.repeat(43);
    await fixture.request('/v1/phone/operations/beginGitHubIdentityBind', 'POST', {
      redirectUri: 'beeline://buzz/github-callback',
      state,
    });
    expect(
      (
        await fixture.request('/v1/phone/operations/completeGitHubIdentityBind', 'POST', {
          challenge: 'github-code',
          proof: state,
        })
      ).status,
    ).toBe(409);
    const recovered = await fixture.request('/v1/phone/operations/recoverGitHubIdentity', 'POST', {
      challenge: 'github-code',
      proof: state,
    });
    expect(recovered.status).toBe(200);
    await expect(recovered.json()).resolves.toEqual({ personId: HUMAN, recovered: true });
    await expect(
      (await fixture.request('/v1/phone/operations/getIdentityRecovery', 'POST', {})).json(),
    ).resolves.toEqual({ candidates: [{ personId: predecessor, handle: 'old-owner' }] });
  });


  it('archives a repository corner for any member agent, not only its opener', async () => {
    const helper = 'e'.repeat(64);
    await fixture.database.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Helper','helper')`,
      [helper],
    );
    await fixture.database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [helper, HUMAN]);
    await fixture.database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       VALUES($1,NULL,$2,'member'),($1,$3,$2,'member')`,
      [WORKSPACE, helper, ROOM],
    );
    const helperToken = (await fixture.auth.exchangeDaemonToken(
      (await fixture.auth.createDaemonExchange(helper)).exchangeToken,
    ))!.daemonToken;
    const created = await fixture.daemonOperation('createCorner', {
      roomId: ROOM,
      requestId: 'repository-corner-close',
      name: 'Ship-widget',
      objective: 'Ship the widget and close up',
      repository: 'owner/widgets',
      targetBranch: 'main',
    });
    expect(created.status).toBe(200);
    const { cornerId } = (await created.json()) as { cornerId: string };

    // Reach is checked on the target corner, not on the turn's room: an agent
    // outside the corner and its parent is refused even when it names a Room it
    // does belong to.
    const elsewhere = '66666666-6666-4666-8666-666666666666';
    await fixture.database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Elsewhere')`, [
      elsewhere,
      WORKSPACE,
    ]);
    await fixture.database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,
      [WORKSPACE, elsewhere, helper],
    );
    await fixture.database.query(
      `UPDATE memberships SET removed_at=now() WHERE room_id IN ($1,$2) AND identity_id=$3`,
      [cornerId, ROOM, helper],
    );
    expect(
      (await fixture.daemonOperation('archiveCorner', { roomId: elsewhere, cornerId }, helperToken))
        .status,
    ).toBe(403);
    expect(
      (
        await fixture.daemonOperation(
          'closeCornerPullRequest' as never,
          { roomId: elsewhere, cornerId },
          helperToken,
        )
      ).status,
    ).toBe(404);
    await fixture.database.query(
      `UPDATE memberships SET removed_at=NULL WHERE room_id IN ($1,$2) AND identity_id=$3`,
      [cornerId, ROOM, helper],
    );

    // A member that did not open the corner closes it, no merge required.
    expect((await fixture.daemonOperation('archiveCorner', { cornerId }, helperToken)).status).toBe(200);
    expect(
      (
        await fixture.database.query<{ archived: boolean; close_requested: boolean }>(
          `SELECT room.archived_at IS NOT NULL archived,room.archived_at IS NOT NULL close_requested
           FROM rooms room JOIN corner_facts fact ON fact.corner_id=room.id WHERE room.id=$1`,
          [cornerId],
        )
      ).rows[0],
    ).toMatchObject({ archived: true, close_requested: true });
  });


  it('serves bounded GitHub room tokens and deduplicates signed webhooks', async () => {
    const roomToken = await fixture.request(`/v1/phone/github/room-token/${ROOM}`);
    expect(roomToken.status).toBe(200);
    expect(((await roomToken.json()) as { token: string }).token).toBe('github-room-token');
    // A GitHub outage is a bad gateway that names GitHub's status, not this
    // server's own 503; other GitHub refusals keep their mapping.
    fixture.roomTokenFailure = new GitHubHttpError('GitHub installation token', 500);
    const outage = await fixture.request(`/v1/phone/github/room-token/${ROOM}`);
    expect(outage.status).toBe(502);
    expect(await outage.json()).toEqual({ error: 'GitHub installation token failed: HTTP 500' });
    fixture.roomTokenFailure = new GitHubHttpError('GitHub installation token', 422);
    expect((await fixture.request(`/v1/phone/github/room-token/${ROOM}`)).status).toBe(500);
    fixture.roomTokenFailure = undefined;
    const payload = Buffer.from(JSON.stringify({ action: 'opened' }));
    const signature = `sha256=${createHmac('sha256', 'webhook-secret').update(payload).digest('hex')}`;
    const send = () =>
      phoneFetch(`${fixture.origin}/v1/github/webhook`, {
        method: 'POST',
        headers: {
          'x-hub-signature-256': signature,
          'x-github-delivery': 'delivery-1',
          'x-github-event': 'pull_request',
          'content-type': 'application/json',
        },
        body: payload,
      });
    fixture.processWebhook.mockRejectedValueOnce(new Error('transient webhook failure'));
    expect((await send()).status).toBe(500);
    expect(
      (
        await fixture.database.query(`SELECT 1 FROM github_webhook_deliveries WHERE delivery_id=$1`, [
          'delivery-1',
        ])
      ).rowCount,
    ).toBe(0);
    expect((await send()).status).toBe(202);
    const duplicate = await send();
    expect(duplicate.status).toBe(200);
    expect(((await duplicate.json()) as { duplicate: boolean }).duplicate).toBe(true);
    expect(fixture.processWebhook).toHaveBeenCalledTimes(2);
    expect(
      (
        await fixture.database.query<{ received: boolean }>(
          `SELECT received_at IS NOT NULL received FROM github_webhook_deliveries WHERE delivery_id=$1`,
          ['delivery-1'],
        )
      ).rows,
    ).toEqual([{ received: true }]);
  });

  it('accepts a check webhook with 202 when the summary read fails and updates checks on background retry once per delivery', async () => {
    fixture.processWebhook.mockImplementation((event, payload, deliveryId) =>
      fixture.githubOperations.processWebhook(event, payload, deliveryId),
    );
    await fixture.database.query(
      `INSERT INTO github_installations(
         installation_id,owner_id,account_id,account_login,account_type,repository_selection,status
       ) VALUES(77,$1,'42','owner','User','selected','active')`,
      [HUMAN],
    );
    await fixture.database.query(
      `INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch)
       VALUES(101,77,'owner/widgets','main')`,
    );
    await fixture.database.query(
      `UPDATE rooms SET repository_key='owner/widgets',
         repository_remote='https://github.com/owner/widgets.git',
         repository_resolution='repository',github_installation_id=77 WHERE id=$1`,
      [ROOM],
    );
    const created = await fixture.daemonOperation('createCorner', {
      roomId: ROOM,
      requestId: 'webhook-retry-corner',
      name: 'Retry-checks',
      objective: 'Retry failed check rollup reads',
      repository: 'owner/widgets',
      targetBranch: 'main',
    });
    expect(created.status).toBe(200);
    const { cornerId } = (await created.json()) as { cornerId: string };
    const branch = `feature/corner-${cornerId.replaceAll('-', '').slice(0, 12)}`;
    const headSha = 'a'.repeat(40);
    await fixture.database.query(
      `UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`,
      [
        cornerId,
        JSON.stringify({
          lifecycle: 'in-review',
          checks: 'pending',
          pr: {
            number: 55,
            url: 'https://github.com/owner/widgets/pull/55',
            title: 'Retry checks',
            targetBranch: 'main',
            headSha,
            mergeability: 'clean',
          },
        }),
      ],
    );
    Object.assign(fixture.githubApp, {
      readPullRequest: vi.fn(async () => ({
        number: 55,
        url: 'https://github.com/owner/widgets/pull/55',
        headSha,
        headRef: branch,
        baseRef: 'main',
        merged: false,
        mergeability: 'clean',
        state: 'open',
      })),
    });
    fixture.githubApp.readCommitCheckRollup.mockRejectedValueOnce(new GitHubHttpError('Checks', 502));
    fixture.githubRollupState = 'passed';
    const checkPayload = {
      installation: { id: 77 },
      repository: { id: 101, full_name: 'owner/widgets' },
      action: 'completed',
      check_run: {
        id: 88,
        name: 'typecheck',
        status: 'completed',
        conclusion: 'success',
        head_sha: headSha,
        check_suite: { head_branch: branch, head_sha: headSha },
      },
    };
    const refreshSpy = vi.spyOn(fixture.githubOperations, 'refreshCheckRollup');
    try {
      const first = await fixture.webhook('check_run', 'delivery-rollup-retry-1', checkPayload);
      expect(first.status).toBe(202);
      expect(refreshSpy).toHaveBeenCalledTimes(1);
      // Redelivering the same delivery ID must return duplicate (200) and never run a second retry.
      const duplicate = await fixture.webhook('check_run', 'delivery-rollup-retry-1', checkPayload);
      expect(duplicate.status).toBe(200);
      expect(((await duplicate.json()) as { duplicate: boolean }).duplicate).toBe(true);
      await vi.waitFor(
        async () => {
          const row = (
            await fixture.database.query<{ checks: string }>(
              `SELECT lifecycle->>'checks' checks FROM corner_facts WHERE corner_id=$1`,
              [cornerId],
            )
          ).rows[0];
          expect(row?.checks).toBe('passing');
        },
        { timeout: 5_000, interval: 50 },
      );
      expect(refreshSpy).toHaveBeenCalledTimes(2);
    } finally {
      await fixture.githubOperations.stopCheckRefreshes();
    }
  });

  it('deduplicates concurrent webhook deliveries while letting an interrupted delivery claim recover on redelivery', async () => {
    const payload = { action: 'opened' };
    let releaseFirst!: () => void;
    let firstEntered!: () => void;
    const entered = new Promise<void>((resolve) => { firstEntered = resolve; });
    fixture.processWebhook.mockImplementationOnce(async () => {
      firstEntered();
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
    });
    const firstPromise = fixture.webhook('pull_request', 'concurrent-delivery', payload);
    await entered;
    // Concurrent duplicate while first delivery is still running must be deduplicated.
    const concurrent = await fixture.webhook('pull_request', 'concurrent-delivery', payload);
    expect(concurrent.status).toBe(200);
    expect(await concurrent.json()).toEqual({ accepted: false, duplicate: true });
    expect(fixture.processWebhook).toHaveBeenCalledTimes(1);
    releaseFirst();
    const first = await firstPromise;
    expect(first.status).toBe(202);
    expect(
      (
        await fixture.database.query<{ claim_expires_at: string | null }>(
          `SELECT claim_expires_at::text claim_expires_at FROM github_webhook_deliveries WHERE delivery_id=$1`,
          ['concurrent-delivery'],
        )
      ).rows,
    ).toEqual([{ claim_expires_at: null }]);

    // An unfinished claim whose lease expired after a process crash is reclaimed on redelivery.
    await fixture.database.query(
      `INSERT INTO github_webhook_deliveries(delivery_id,claim_expires_at)
       VALUES($1,clock_timestamp()-interval '1 second')`,
      ['interrupted-delivery'],
    );
    const recovered = await fixture.webhook('pull_request', 'interrupted-delivery', payload);
    expect(recovered.status).toBe(202);
    expect(await recovered.json()).toEqual({ accepted: true, duplicate: false });
    expect(fixture.processWebhook).toHaveBeenCalledTimes(2);
    expect(
      (
        await fixture.database.query<{ claim_expires_at: string | null }>(
          `SELECT claim_expires_at::text claim_expires_at FROM github_webhook_deliveries WHERE delivery_id=$1`,
          ['interrupted-delivery'],
        )
      ).rows,
    ).toEqual([{ claim_expires_at: null }]);
    // Once completed, another redelivery is suppressed as a duplicate.
    const afterRecovery = await fixture.webhook('pull_request', 'interrupted-delivery', payload);
    expect(afterRecovery.status).toBe(200);
    expect(await afterRecovery.json()).toEqual({ accepted: false, duplicate: true });
    expect(fixture.processWebhook).toHaveBeenCalledTimes(2);
  });

  it('keeps database-backed ownership exclusive across separate server instances across missed, stalled, and abandoned renewals', async () => {
    const payload = { action: 'opened' };
    const server2Webhook = vi.fn(async () => undefined);
    const server2 = createBeelineServer({
      database: fixture.database,
      auth: fixture.auth,
      phone: fixture.phone,
      daemon: new DaemonService(fixture.database, fixture.live),
      live: fixture.live,
      authHandler: fixture.mountedAuth.handle,
      mediaMaximumBytes: 1024 * 1024,
      objectService: fixture.objectService,
      github: {
        webhookSecret: 'webhook-secret',
        onWebhook: server2Webhook,
      },
    });
    await new Promise<void>((resolve) => server2.listen(0, '127.0.0.1', resolve));
    const server2Origin = `http://127.0.0.1:${(server2.address() as AddressInfo).port}`;
    const sendTo = (targetOrigin: string, delivery: string) => {
      const bytes = Buffer.from(JSON.stringify(payload));
      const signature = `sha256=${createHmac('sha256', 'webhook-secret').update(bytes).digest('hex')}`;
      return phoneFetch(`${targetOrigin}/v1/github/webhook`, {
        method: 'POST',
        headers: {
          'x-hub-signature-256': signature,
          'x-github-delivery': delivery,
          'x-github-event': 'pull_request',
          'content-type': 'application/json',
        },
        body: bytes,
      });
    };

    let releaseSlow!: () => void;
    let slowEntered!: () => void;
    const entered = new Promise<void>((resolve) => { slowEntered = resolve; });
    fixture.processWebhook.mockImplementationOnce(async () => {
      slowEntered();
      await new Promise<void>((resolve) => { releaseSlow = resolve; });
    });

    const originalQuery = fixture.database.query.bind(fixture.database);
    let failFirstRenewal = true;
    let renewalAttempts = 0;
    let holdRenewalDelivery: string | undefined;
    let releaseHeldRenewal: (() => void) | undefined;
    let heldRenewalPromise: Promise<void> | undefined;
    let heldRenewalStarted: (() => void) | undefined;
    const heldRenewalEntered = new Promise<void>((resolve) => { heldRenewalStarted = resolve; });
    const querySpy = vi.spyOn(fixture.database, 'query').mockImplementation((sql, values, preparedName) => {
      if (
        typeof sql === 'string' &&
        sql.includes('UPDATE github_webhook_deliveries') &&
        sql.includes("interval '2 minutes'")
      ) {
        if (holdRenewalDelivery && values?.[0] === holdRenewalDelivery) {
          holdRenewalDelivery = undefined;
          heldRenewalStarted?.();
          const gated = new Promise<void>((resolve) => { releaseHeldRenewal = resolve; }).then(() =>
            originalQuery(sql, values, preparedName),
          );
          heldRenewalPromise = gated.then(() => undefined);
          return gated;
        }
        renewalAttempts++;
        if (failFirstRenewal) {
          failFirstRenewal = false;
          return Promise.reject(new Error('transient renewal failure'));
        }
      }
      return originalQuery(sql, values, preparedName);
    });

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const firstPromise = sendTo(fixture.origin, 'slow-multi-server');
      await entered;
      const initialExpiry = (
        await originalQuery<{ claim_expires_at: string }>(
          `SELECT claim_expires_at::text claim_expires_at FROM github_webhook_deliveries WHERE delivery_id=$1`,
          ['slow-multi-server'],
        )
      ).rows[0]!.claim_expires_at;

      // First renewal at 30s fails (missed renewal); redelivery to server2 must still be suppressed.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(renewalAttempts).toBe(1);
      const afterMiss = await sendTo(server2Origin, 'slow-multi-server');
      expect(afterMiss.status).toBe(200);
      expect(await afterMiss.json()).toEqual({ accepted: false, duplicate: true });
      expect(server2Webhook).not.toHaveBeenCalled();

      // Retry fires 5s later (well before the 2-minute expiry) and advances the database lease.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(renewalAttempts).toBe(2);
      const afterRetry = (
        await originalQuery<{ renewed: boolean; claim_expires_at: string }>(
          `SELECT (claim_expires_at>$2::timestamptz) renewed, claim_expires_at::text claim_expires_at
           FROM github_webhook_deliveries WHERE delivery_id=$1`,
          ['slow-multi-server', initialExpiry],
        )
      ).rows[0]!;
      expect(afterRetry.renewed).toBe(true);

      // Advance past the original two-minute expiry while server1's handler is still running.
      await vi.advanceTimersByTimeAsync(100_000);
      expect(renewalAttempts).toBeGreaterThanOrEqual(5);
      const pastOriginalExpiry = await sendTo(server2Origin, 'slow-multi-server');
      expect(pastOriginalExpiry.status).toBe(200);
      expect(await pastOriginalExpiry.json()).toEqual({ accepted: false, duplicate: true });
      expect(fixture.processWebhook).toHaveBeenCalledTimes(1);
      expect(server2Webhook).not.toHaveBeenCalled();

      releaseSlow();
      const first = await firstPromise;
      expect(first.status).toBe(202);
      expect(
        (
          await originalQuery<{ claim_expires_at: string | null }>(
            `SELECT claim_expires_at::text claim_expires_at FROM github_webhook_deliveries WHERE delivery_id=$1`,
            ['slow-multi-server'],
          )
        ).rows,
      ).toEqual([{ claim_expires_at: null }]);

      // Stalled renewal held past lease expiry: server1 must abort and stop its handler before
      // the 2-minute DB lease can expire, so server2 never runs concurrently with server1.
      holdRenewalDelivery = 'stalled-renewal-delivery';
      let stalledEntered!: () => void;
      const stalledReady = new Promise<void>((resolve) => { stalledEntered = resolve; });
      const stalledClaimStart = Date.now();
      let server1Running = false;
      let server1StoppedAt: number | undefined;
      let server2SawServer1Running = false;
      fixture.processWebhook.mockImplementationOnce(async (_event, _payload, _deliveryId, signal?: AbortSignal) => {
        server1Running = true;
        stalledEntered();
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => {
              server1Running = false;
              server1StoppedAt = Date.now();
              reject(signal.reason ?? new Error('aborted'));
            },
            { once: true },
          );
        });
      });
      server2Webhook.mockImplementationOnce(async () => {
        server2SawServer1Running = server1Running;
      });

      const stalledFirstPromise = sendTo(fixture.origin, 'stalled-renewal-delivery');
      await stalledReady;
      expect(server1Running).toBe(true);

      // Trigger the renewal at 30s and hold it open past the 2-minute lease expiry.
      await vi.advanceTimersByTimeAsync(30_000);
      await heldRenewalEntered;
      expect(server1Running).toBe(true);

      // While the lease is still well before expiry, server2 must still reject redelivery as duplicate.
      await vi.advanceTimersByTimeAsync(30_000);
      const whileStalledBeforeExpiry = await sendTo(server2Origin, 'stalled-renewal-delivery');
      expect(whileStalledBeforeExpiry.status).toBe(200);
      expect(await whileStalledBeforeExpiry.json()).toEqual({ accepted: false, duplicate: true });
      expect(server1Running).toBe(true);

      // Advance past the pre-expiry guard (110s) and past the 2-minute lease expiry (125s) while
      // the renewal query is still hung. Server1 must abort its handler before 120s and fail cleanly.
      await vi.advanceTimersByTimeAsync(65_000);
      const stalledFirst = await stalledFirstPromise;
      expect(stalledFirst.status).toBe(500);
      expect(server1Running).toBe(false);
      expect(server1StoppedAt).toBeDefined();
      expect(server1StoppedAt!).toBeLessThan(stalledClaimStart + 120_000);

      // Server2 can now take over with zero overlap against server1.
      const server2Takeover = await sendTo(server2Origin, 'stalled-renewal-delivery');
      expect(server2Takeover.status).toBe(202);
      expect(await server2Takeover.json()).toEqual({ accepted: true, duplicate: false });
      expect(server2SawServer1Running).toBe(false);
      expect(server2Webhook).toHaveBeenCalledTimes(1);

      // Releasing the hung renewal query after takeover must not overwrite server2's completed delivery.
      releaseHeldRenewal?.();
      await heldRenewalPromise;
      expect(
        (
          await originalQuery<{ claim_expires_at: string | null }>(
            `SELECT claim_expires_at::text claim_expires_at FROM github_webhook_deliveries WHERE delivery_id=$1`,
            ['stalled-renewal-delivery'],
          )
        ).rows,
      ).toEqual([{ claim_expires_at: null }]);
      const afterTakeoverDuplicate = await sendTo(server2Origin, 'stalled-renewal-delivery');
      expect(afterTakeoverDuplicate.status).toBe(200);
      expect(await afterTakeoverDuplicate.json()).toEqual({ accepted: false, duplicate: true });

      // Recovery after the owning server exits: an expired unfinished claim is reclaimed by server2.
      await originalQuery(
        `INSERT INTO github_webhook_deliveries(delivery_id,claim_expires_at)
         VALUES($1,clock_timestamp()-interval '1 second')`,
        ['owner-exited-delivery'],
      );
      const recovered = await sendTo(server2Origin, 'owner-exited-delivery');
      expect(recovered.status).toBe(202);
      expect(await recovered.json()).toEqual({ accepted: true, duplicate: false });
      expect(server2Webhook).toHaveBeenCalledTimes(2);
      expect(
        (
          await originalQuery<{ claim_expires_at: string | null }>(
            `SELECT claim_expires_at::text claim_expires_at FROM github_webhook_deliveries WHERE delivery_id=$1`,
            ['owner-exited-delivery'],
          )
        ).rows,
      ).toEqual([{ claim_expires_at: null }]);
    } finally {
      releaseHeldRenewal?.();
      querySpy.mockRestore();
      vi.useRealTimers();
      await new Promise<void>((resolve) => server2.close(() => resolve()));
    }
  });
});
