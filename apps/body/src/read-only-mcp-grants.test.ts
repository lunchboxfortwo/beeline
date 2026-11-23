import {
  fixtureScope12,
  fixtureScope8,
  it,
  m9_agentToolsFor,
  m9_createHash,
  m9_describe,
  m9_expect,
  m9_it,
  m9_listGrants,
  m9_REQUESTABLE_AGENT_GRANT_KINDS,
  m9_requestGrant,
  m9_requestSharedAssetIsolation,
  m9_resolveGrantCommand,
  m9_runGrantedCommand,
  m9_storeSecret,
  m9_tmpdir,
  mergedDescribe9,
  schema,
  toolValidationSchema,
  type m9_GrantRunDeps,
} from './test-support-read-only-mcp.test-support.js';

mergedDescribe9('agent-grant-tools.test.ts', () => {
  const scope8 = fixtureScope8();
  m9_describe('beeline-agent request_grant', () => {
    m9_it('expands literal env split strings without modifying execution argv', () => {
      const argv = ['env', '-S', 'bash approved.sh', 'argument'];
      m9_expect(m9_resolveGrantCommand(argv, '/tmp', {}).argv).toEqual([
        'bash',
        'approved.sh',
        'argument',
      ]);
      m9_expect(argv).toEqual(['env', '-S', 'bash approved.sh', 'argument']);
      m9_expect(
        m9_resolveGrantCommand(['env', '-u', 'PATH', '-S', '/bin/echo approved'], '/tmp', {}).argv,
      ).toEqual(['/bin/echo', 'approved']);
      for (const value of [
        'bash\\_changed.sh',
        'bash ${SCRIPT}',
        'bash "changed.sh"',
        'bash #changed.sh',
      ]) {
        m9_expect(() => m9_resolveGrantCommand(['env', '-S', value], '/tmp', {})).toThrow(
          'unsupported split string',
        );
      }
    });

    m9_it(
      'applies env options before assignments, keeps only the final chdir, and stops options at operands',
      () => {
        m9_expect(
          m9_resolveGrantCommand(
            ['env', '-viuFOO', '-C', '/elsewhere', '-C.', 'FOO=restored', '/bin/echo'],
            '/tmp',
            { FOO: 'old', OTHER: 'removed' },
          ),
        ).toEqual({ argv: ['/bin/echo'], cwd: '/tmp', env: { FOO: 'restored' } });
        m9_expect(
          m9_resolveGrantCommand(['env', '--', '-', 'FOO=x', '-v'], '/tmp', { OTHER: 'removed' }),
        ).toEqual({ argv: ['-v'], cwd: '/tmp', env: { FOO: 'x' } });
        m9_expect(
          m9_resolveGrantCommand(['env', '--deb', '--split-string=', '/bin/echo'], '/tmp', {}).argv,
        ).toEqual(['/bin/echo']);
        m9_expect(
          m9_resolveGrantCommand(
            ['timeout', '5', 'env', '-C', 'nested', 'env', 'PATH=bin', 'chosen'],
            '/tmp',
            {},
          ),
        ).toEqual({ argv: ['chosen'], cwd: '/tmp/nested', env: { PATH: 'bin' } });
        for (const argv of [
          ['env', '--not-an-option', '/bin/echo'],
          ['env', '-u'],
          ['env', '--debug=yes'],
          ['env', '--i'],
        ]) {
          m9_expect(() => m9_resolveGrantCommand(argv, '/tmp', {})).toThrow(/env/);
        }
      },
    );

    m9_it.each([
      '--debug',
      '-i -u FOO -C /tmp',
      '-v',
      '-iv',
      '-0',
      '--null',
      '--help',
      '--version',
      '--',
      '--list-signal-handling',
      '--block-signal=PIPE',
      '--default-signal',
      '--ignore-signal=PIPE',
      '-',
      '-S',
      '--split-string',
      '--split-string=/bin/echo',
      '-S/bin/echo',
      '-i',
      '-u PATH',
      '--unset=PATH',
      '-C /tmp',
      '--chdir=/tmp',
    ])('requests a native env %s command without a script binding', async (option) => {
      const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
      await m9_requestGrant(
        {
          action: 'Use the requested resource',
          kind: 'command',
          target: `env ${option} /bin/echo approved`,
          purpose: 'Print approved',
          reason: 'Native command regression',
        },
        {
          ...scope8.deps({ grantId: 'native', status: 'pending', auto: false }, ops),
          scriptRoots: [m9_tmpdir()],
        },
      );
      m9_expect(ops).toHaveLength(1);
      m9_expect(ops[0]!.name).toBe('requestAgentGrant');
      m9_expect(ops[0]!.input.script).toBeUndefined();
    });

    m9_it.each([undefined, '', '   ', 'x'.repeat(241)])(
      'rejects invalid purpose %s before requesting approval',
      async (purpose) => {
        const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
        await m9_expect(
          m9_requestGrant(
            {
              action: 'Inspect the checkout',
              kind: 'command',
              target: 'git status',
              reason: 'inspect',
              purpose,
            },
            scope8.deps({}, ops),
          ),
        ).rejects.toThrow(/Supply purpose|Shorten purpose/);
        m9_expect(ops).toEqual([]);
      },
    );

    m9_it('requires purpose in the validation contract but permits listing without it', () => {
      const schema = m9_agentToolsFor(true, false).find(
        (tool) => tool.name === 'request_grant',
      )!.inputSchema;
      m9_expect(schema.properties.purpose).toMatchObject({ minLength: 1, maxLength: 240 });
      m9_expect(toolValidationSchema('request_grant')!.anyOf).toEqual(
        m9_expect.arrayContaining([
          m9_expect.objectContaining({
            required: ['mode', 'kind', 'target', 'reason', 'action', 'purpose'],
          }),
        ]),
      );
    });

    m9_it('uses a private cache copy immediately without a grant or mount change', async () => {
      const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
      const answer = await m9_requestSharedAssetIsolation(
        {
          action: 'Use the requested resource',
          category: 'package-cache',
          purpose: 'Shared npm tarball is corrupt',
          reason: 'Shared npm tarball is corrupt',
        },
        scope8.deps({ grantId: 'g-7', status: 'pending', auto: false }, ops),
      );
      m9_expect(ops).toEqual([]);
      m9_expect(answer).toContain('No approval is needed');
      m9_expect(answer).toContain('under your private HOME now');
      await m9_expect(
        m9_requestSharedAssetIsolation(
          {
            action: 'Use the requested resource',
            category: 'cache/file',
            purpose: 'broken',
            reason: 'broken',
          },
          scope8.deps({}, ops),
        ),
      ).rejects.toThrow('category must be one of');
      m9_expect(ops).toHaveLength(0);
    });

    m9_it.each([
      {
        action: 'Use the requested resource',
        kind: 'budget',
        target: '$10',
        purpose: 'more tokens',
        reason: 'more tokens',
      },
      {
        action: 'Use the requested resource',
        kind: 'repository',
        target: 'acme/widgets',
        purpose: 'edit the repository',
        reason: 'edit the repository',
      },
    ])('rejects retired $kind prompts before calling the server', async (ask) => {
      const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
      await m9_expect(m9_requestGrant(ask, scope8.deps({}, ops))).rejects.toThrow(
        'kind must be one of',
      );
      m9_expect(ops).toEqual([]);
    });

    m9_it('is mounted in chats, threads, and direct messages next to run_granted_command', () => {
      for (const directMessage of [false, true]) {
        const names = m9_agentToolsFor(true, directMessage).map((tool) => tool.name);
        m9_expect(names).toContain('request_grant');
        m9_expect(names).toContain('run_granted_command');
      }
      m9_expect(m9_agentToolsFor(false, false).map((tool) => tool.name)).not.toContain(
        'request_grant',
      );
    });

    m9_it('suppresses command execution when the daemon has no usable runner boundary', () => {
      const names = m9_agentToolsFor(true, false, false, false, false).map((tool) => tool.name);
      m9_expect(names).toContain('request_grant');
      m9_expect(names).not.toContain('run_granted_command');
    });

    m9_it(
      'offers every grant kind the contract defines, and names each one where the agent reads it',
      () => {
        const tool = m9_agentToolsFor(true, false).find((entry) => entry.name === 'request_grant');
        const kinds = (tool?.inputSchema as { properties: { kind: { enum: string[] } } }).properties
          .kind.enum;
        m9_expect([...kinds].sort()).toEqual([...m9_REQUESTABLE_AGENT_GRANT_KINDS].sort());
        // The description is the interface the model reads to pick a kind: a kind
        // the schema offers but the prose never names is one nobody asks for.
        m9_expect(tool?.inputSchema.properties).toHaveProperty('kind');
      },
    );

    m9_it(
      'asks for a host MCP route by name and reports it pending, never a yolo approval',
      async () => {
        const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
        const reply = await m9_requestGrant(
          {
            action: 'Use the requested resource',
            kind: 'mcp',
            target: ' squire ',
            purpose: 'vault the provider key',
            reason: 'vault the provider key',
          },
          scope8.deps(
            {
              grantId: 'g-9',
              status: 'pending',
              auto: false,
              messageId: 'm-9',
              approval: { destination: 'trusty-squire-dm', authority: 'resource-owner' },
            },
            ops,
          ),
        );
        m9_expect(ops).toEqual([
          {
            name: 'requestAgentGrant',
            input: {
              action: 'Use the requested resource',
              roomId: 'room-1',
              kind: 'mcp',
              target: 'squire',
              purpose: 'vault the provider key',
              reason: 'vault the provider key',
            },
          },
        ]);
        m9_expect(reply).toMatch(/^pending, card posted: use squire \[grant g-9\]/);
        m9_expect(reply).toContain('paused');
        m9_expect(reply).toContain(
          "The resource owner must answer ALWAYS, ONCE, or NO in the resource owner's private Trusty Squire DM",
        );
        m9_expect(reply).toContain('approval wake continues this session');
        m9_expect(reply).toContain('without restarting or scheduling another turn');
      },
    );

    m9_it('returns "pending, card posted" and tells the agent its turn is paused', async () => {
      const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
      const reply = await m9_requestGrant(
        {
          action: 'Use the requested resource',
          kind: 'command',
          target: 'fly deploy -a beeline-preview --with FLY_TOKEN',
          purpose: 'publish the preview build',
          reason: 'publish the preview build',
          ttl: 3600,
        },
        scope8.deps(
          {
            grantId: 'g-1',
            status: 'pending',
            auto: false,
            messageId: 'm-1',
            approval: { destination: 'system-dm', authority: 'resource-owner' },
          },
          ops,
        ),
      );
      m9_expect(ops).toEqual([
        {
          name: 'requestAgentGrant',
          input: {
            action: 'Use the requested resource',
            roomId: 'room-1',
            kind: 'command',
            target: 'fly deploy -a beeline-preview --with FLY_TOKEN',
            purpose: 'publish the preview build',
            reason: 'publish the preview build',
            ttlSeconds: 3600,
          },
        },
      ]);
      m9_expect(reply).toMatch(
        /^pending, card posted: run fly deploy -a beeline-preview --with FLY_TOKEN \[grant g-1\]/,
      );
      m9_expect(reply).toContain('paused');
      m9_expect(reply).toContain('Always, Once, or Deny');
      m9_expect(reply).toContain(
        "The resource owner must answer Always, Once, or Deny in the resource owner's private @system DM",
      );
      m9_expect(reply).not.toContain('in this chat');
    });

    m9_it('returns approval and, for a command, points at run_granted_command', async () => {
      const command = await m9_requestGrant(
        {
          action: 'Use the requested resource',
          kind: 'command',
          target: 'npm test',
          purpose: 'run the suite',
          reason: 'run the suite',
        },
        scope8.deps({ grantId: 'g-2', status: 'approved', auto: true }),
      );
      m9_expect(command).toBe(
        'approved: run npm test [grant g-2]. Run it now with run_granted_command and the argv.',
      );
      const host = await m9_requestGrant(
        {
          action: 'Use the requested resource',
          kind: 'host',
          target: ' do@100.126.74.60 ',
          purpose: 'check Chad',
          reason: 'check Chad',
        },
        scope8.deps({ grantId: 'g-3', status: 'approved', auto: true }),
      );
      m9_expect(host).toBe(
        'approved: reach do@100.126.74.60 [grant g-3]. Use it now: run_granted_command argv ["ssh", "do@100.126.74.60", "<command>", ...] runs that command on do@100.126.74.60 as that user, with Beeline\'s fixed ssh options; pass no ssh options yourself.',
      );
      m9_expect(host).not.toContain('next session');
    });

    m9_it(
      'never promises a later session for any grant kind, approved at once or on a card',
      async () => {
        const asks = [
          { kind: 'command', target: 'npm test' },
          { kind: 'path', target: '/srv/data' },
          { kind: 'device', target: '/dev/kvm' },
          { kind: 'mcp', target: 'squire' },
          { kind: 'host', target: 'do@100.126.74.60' },
          { kind: 'secret', target: 'FLY_TOKEN' },
        ];
        for (const { kind, target } of asks) {
          for (const answer of [{ status: 'approved', auto: true }, { status: 'pending' }]) {
            const reply = await m9_requestGrant(
              {
                action: 'Use the requested resource',
                kind,
                target,
                purpose: 'do the work',
                reason: 'do the work',
              },
              scope8.deps({ grantId: `g-${kind}`, ...answer }),
            );
            m9_expect(reply).not.toMatch(/next session|new session|later session/i);
          }
        }
        const card = await m9_requestGrant(
          {
            action: 'Use the requested resource',
            kind: 'host',
            target: 'do@100.126.74.60',
            purpose: 'check Chad',
            reason: 'check Chad',
          },
          scope8.deps({ grantId: 'g-card', status: 'pending' }),
        );
        m9_expect(card).toContain(
          'Once approved, in this same session: Use it now: run_granted_command argv ["ssh", "do@100.126.74.60"',
        );
        const secret = await m9_requestGrant(
          {
            action: 'Use the requested resource',
            kind: 'secret',
            target: 'FLY_TOKEN',
            purpose: 'deploy',
            reason: 'deploy',
          },
          scope8.deps({ grantId: 'g-secret', status: 'approved', auto: true }),
        );
        m9_expect(secret).toContain('run_granted_command with secrets ["FLY_TOKEN"]');
        m9_expect(secret).not.toContain('fly-secret-value-123');
      },
    );

    m9_it(
      'refuses at ask time a grant no session could use, before the server is called',
      async () => {
        const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
        const deps = scope8.deps({ grantId: 'never' }, ops);
        await m9_expect(
          m9_requestGrant(
            {
              action: 'Use the requested resource',
              kind: 'secret',
              target: 'GHOST_TOKEN',
              purpose: 'deploy',
              reason: 'deploy',
            },
            deps,
          ),
        ).rejects.toThrow(/Store it first with store_secret/);
        await m9_expect(
          m9_requestGrant(
            {
              action: 'Use the requested resource',
              kind: 'secret',
              target: 'fly token',
              purpose: 'deploy',
              reason: 'deploy',
            },
            deps,
          ),
        ).rejects.toThrow(/UPPER_CASE/);
        await m9_expect(
          m9_requestGrant(
            {
              action: 'Use the requested resource',
              kind: 'host',
              target: 'api.fly.io',
              purpose: 'reach Fly',
              reason: 'reach Fly',
            },
            deps,
          ),
        ).rejects.toThrow(/user@host/);
        m9_expect(ops).toEqual([]);
      },
    );

    m9_it('makes an approved device available to tools without replacing the session', async () => {
      const device = await m9_requestGrant(
        {
          action: 'Use the requested resource',
          kind: 'device',
          target: '/dev/kvm',
          purpose: 'run the Android emulator',
          reason: 'run the Android emulator',
        },
        scope8.deps({ grantId: 'g-4', status: 'approved', auto: true }),
      );
      m9_expect(device).toBe(
        'approved: use /dev/kvm [grant g-4]. Use it now through run_granted_command; its tool sandbox loads the current device grant.',
      );
      m9_expect(device).not.toContain('next session');
      const outside = await m9_requestGrant(
        {
          action: 'Use the requested resource',
          kind: 'device',
          target: 'kvm',
          purpose: 'run the Android emulator',
          reason: 'run the Android emulator',
        },
        scope8.deps({ grantId: 'g-5', status: 'approved', auto: true }),
      );
      m9_expect(outside).toBe(
        'approved: use kvm [grant g-5], but only device nodes under /dev/ are added to your session, so nothing was added.',
      );
    });

    m9_it(
      'refuses shell metacharacters and malformed asks before the server is called',
      async () => {
        const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
        const answer = scope8.deps({ grantId: 'never' }, ops);
        await m9_expect(
          m9_requestGrant(
            {
              action: 'Use the requested resource',
              kind: 'command',
              target: 'fly deploy; rm -rf /',
              purpose: 'x',
              reason: 'x',
            },
            answer,
          ),
        ).rejects.toThrow('shell metacharacters');
        await m9_expect(
          m9_requestGrant(
            {
              action: 'Use the requested resource',
              kind: 'command',
              target: 'echo $FLY_TOKEN',
              purpose: 'x',
              reason: 'x',
            },
            answer,
          ),
        ).rejects.toThrow('shell metacharacters');
        await m9_expect(
          m9_requestGrant(
            {
              action: 'Use the requested resource',
              kind: 'wifi',
              target: 'x',
              purpose: 'x',
              reason: 'x',
            },
            answer,
          ),
        ).rejects.toThrow('kind must be one of');
        await m9_expect(
          m9_requestGrant(
            {
              action: 'Use the requested resource',
              kind: 'host',
              target: '  ',
              purpose: 'x',
              reason: 'x',
            },
            answer,
          ),
        ).rejects.toThrow('target must be a non-empty string');
        await m9_expect(
          m9_requestGrant(
            {
              action: 'Use the requested resource',
              kind: 'host',
              target: 'do@100.126.74.60',
              purpose: 'Inspect the checkout',
              reason: ' ',
            },
            answer,
          ),
        ).rejects.toThrow('reason must be a non-empty string');
        await m9_expect(
          m9_requestGrant(
            {
              action: 'Use the requested resource',
              kind: 'host',
              target: 'do@100.126.74.60',
              purpose: 'x',
              reason: 'x',
              ttl: 5,
            },
            answer,
          ),
        ).rejects.toThrow('ttl must be');
        m9_expect(ops).toEqual([]);
      },
    );

    m9_it(
      'rejects at ask time a command grant whose named secret cannot resolve, before the server is called',
      async () => {
        const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
        const ask = scope8.deps({ grantId: 'never' }, ops, {});
        await m9_expect(
          m9_requestGrant(
            {
              action: 'Use the requested resource',
              kind: 'command',
              target: 'fly deploy -a preview --with DOOMED_SECRET --with ANOTHER_MISSING',
              purpose: 'publish',
              reason: 'publish',
            },
            ask,
          ),
        ).rejects.toThrow('DOOMED_SECRET, ANOTHER_MISSING');
        // Nothing was sent to the server: an unresolvable ask never becomes a card.
        m9_expect(ops).toEqual([]);
      },
    );

    m9_it('lets a command ask through when every named secret resolves now', async () => {
      const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
      const reply = await m9_requestGrant(
        {
          action: 'Use the requested resource',
          kind: 'command',
          target: 'fly deploy -a preview --with FLY_TOKEN',
          purpose: 'publish',
          reason: 'publish',
        },
        scope8.deps({ grantId: 'g-7', status: 'approved', auto: true }, ops),
      );
      m9_expect(ops[0]!.name).toBe('requestAgentGrant');
      m9_expect(ops[0]!.input).toEqual({
        action: 'Use the requested resource',
        roomId: 'room-1',
        kind: 'command',
        target: 'fly deploy -a preview --with FLY_TOKEN',
        purpose: 'publish',
        reason: 'publish',
      });
      m9_expect(reply).toContain('approved: run fly deploy -a preview');
    });

    m9_it(
      'keeps grant listing under request_grant and exposes local secret storage beside request_grant',
      () => {
        for (const directMessage of [false, true]) {
          const names = m9_agentToolsFor(true, directMessage).map((tool) => tool.name);
          m9_expect(names).not.toContain('list_grants');
          m9_expect(names).toContain('store_secret');
          m9_expect(names).toContain('request_grant');
          m9_expect(
            m9_agentToolsFor(true, directMessage, false, false, false).map((tool) => tool.name),
          ).toContain('store_secret');
        }
        m9_expect(m9_agentToolsFor(false, false).map((tool) => tool.name)).not.toContain(
          'store_secret',
        );
        m9_expect(m9_agentToolsFor(false, false).map((tool) => tool.name)).not.toContain(
          'list_grants',
        );
      },
    );
  });
  m9_describe('beeline-agent list_grants and store_secret', () => {
    m9_it(
      'list_grants shows each pending and live grant and flags a command grant whose secret is missing',
      async () => {
        const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
        const reply = await m9_listGrants(
          scope8.deps(
            {
              grants: [
                {
                  action: 'Use the requested resource',
                  grantId: 'g-1',
                  workspaceId: 'w',
                  roomId: 'room-1',
                  kind: 'command',
                  target: 'fly deploy -a preview --with FLY_TOKEN',
                  purpose: 'publish the preview',
                  reason: 'publish the preview',
                  status: 'pending',
                  auto: false,
                  requestedBy: 'c'.repeat(64),
                  createdAt: 1,
                },
                {
                  action: 'Use the requested resource',
                  grantId: 'g-2',
                  workspaceId: 'w',
                  roomId: 'room-1',
                  kind: 'command',
                  target: 'fly deploy -a preview --with GHOST_SECRET',
                  purpose: 'publish the preview',
                  reason: 'publish the preview',
                  status: 'pending',
                  auto: false,
                  requestedBy: 'c'.repeat(64),
                  createdAt: 2,
                },
                {
                  action: 'Use the requested resource',
                  grantId: 'g-3',
                  workspaceId: 'w',
                  roomId: 'room-1',
                  kind: 'host',
                  target: 'api.fly.io',
                  purpose: 'reach the API',
                  reason: 'reach the API',
                  status: 'approved',
                  auto: true,
                  requestedBy: 'c'.repeat(64),
                  createdAt: 3,
                },
              ],
            },
            ops,
            // Only FLY_TOKEN resolves; GHOST_SECRET does not.
            { FLY_TOKEN: 'fly-secret-value-123' },
          ),
        );
        m9_expect(ops[0]!.name).toBe('listAgentGrantRequests');
        m9_expect(reply).toContain('pending command fly deploy -a preview --with FLY_TOKEN');
        m9_expect(reply).toContain('secrets present');
        m9_expect(reply).toContain('GHOST_SECRET NOT resolvable');
        m9_expect(reply).toContain('approved host api.fly.io');
        m9_expect(reply).not.toContain('fly-secret-value-123');
      },
    );

    m9_it('list_grants says none when the server has nothing', async () => {
      const reply = await m9_listGrants(scope8.deps({ grants: [] }));
      m9_expect(reply).toContain('no grants right now');
    });

    m9_it('store_secret writes through its dependency and never echoes the value', async () => {
      const writes: Array<[string, string]> = [];
      const reply = await m9_storeSecret(
        { name: 'DEPLOY_TOKEN', value: 'super-secret-9' },
        {
          roomId: 'room-1',
          execute: async () => ({}),
          storeSecret: async (name, value) => {
            writes.push([name, value]);
          },
        },
      );
      m9_expect(writes).toEqual([['DEPLOY_TOKEN', 'super-secret-9']]);
      m9_expect(reply).toContain('stored secret DEPLOY_TOKEN');
      m9_expect(reply).not.toContain('super-secret-9');
    });

    m9_it('store_secret refuses a name the --with rule would never accept', async () => {
      const writes: Array<[string, string]> = [];
      await m9_expect(
        m9_storeSecret(
          { name: 'lower_case', value: 'x' },
          {
            roomId: 'room-1',
            execute: async () => ({}),
            storeSecret: async (name, value) => {
              writes.push([name, value]);
            },
          },
        ),
      ).rejects.toThrow('UPPER_CASE');
      m9_expect(writes).toEqual([]);
    });
  });
  m9_describe('beeline-agent run_granted_command', () => {
    m9_it(
      'posts the argv to the daemon runner and returns the verdict with the capped output',
      async () => {
        const runs: unknown[] = [];
        const run: m9_GrantRunDeps = {
          roomId: 'room-1',
          run: async (input) => {
            runs.push(input);
            return { grantId: 'g-1', exitCode: 0, timedOut: false, output: 'deployed\n' };
          },
        };
        const reply = await m9_runGrantedCommand(
          { argv: ['fly', 'deploy', '-a', 'beeline-preview'] },
          run,
        );
        m9_expect(runs).toEqual([
          { roomId: 'room-1', argv: ['fly', 'deploy', '-a', 'beeline-preview'] },
        ]);
        m9_expect(reply).toBe('ran under grant g-1: exit 0\ndeployed\n');
      },
    );

    m9_it('surfaces the runner refusal and validates argv locally', async () => {
      const refusing: m9_GrantRunDeps = {
        roomId: 'room-1',
        run: async () => {
          throw new Error('no approved command grant matches: rm -rf /');
        },
      };
      await m9_expect(m9_runGrantedCommand({ argv: ['rm', '-rf', '/'] }, refusing)).rejects.toThrow(
        'no approved command grant matches',
      );
      await m9_expect(m9_runGrantedCommand({ argv: [] }, refusing)).rejects.toThrow('argv must be');
      await m9_expect(m9_runGrantedCommand({ argv: 'npm test' }, refusing)).rejects.toThrow(
        'argv must be',
      );
      const timedOut = await m9_runGrantedCommand(
        { argv: ['sleep'] },
        {
          roomId: 'room-1',
          run: async () => ({ grantId: 'g', exitCode: null, timedOut: true, output: '' }),
        },
      );
      m9_expect(timedOut).toBe(
        'ran under grant g: timed out: the run limit killed its process group\n(no output)',
      );
    });
  });
  m9_describe('request_grant carries the script an interpreter will run', () => {
    const scope12 = fixtureScope12(scope8);

    m9_it.each([
      '-v',
      '-iv --',
      '--chdir=CHECKOUT',
      '-i -u FOO -C CHECKOUT',
      '--block-signal=PIPE',
      '--ignore-signal',
      '--default-signal=',
    ])('binds env %s scripts to the executed bytes', async (option) => {
      const contents = '#!/bin/sh\nprintf approved\n';
      const root = scope12.checkout(contents, 'script.sh');
      const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
      await m9_requestGrant(
        {
          action: 'Use the requested resource',
          kind: 'command',
          target: `env ${option.replaceAll('CHECKOUT', root)} ./script.sh`,
          purpose: 'Run reviewed script',
          reason: 'Wrapper hash regression',
        },
        {
          ...scope8.deps({ grantId: 'script', status: 'pending', auto: false }, ops),
          scriptRoots: [root],
        },
      );
      m9_expect(ops[0]!.input.script).toEqual({
        path: './script.sh',
        contents,
        bytes: Buffer.byteLength(contents),
        sha256: m9_createHash('sha256').update(contents).digest('hex'),
      });
    });
  });
});
