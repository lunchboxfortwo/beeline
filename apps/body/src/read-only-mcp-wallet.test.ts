import {
  m43_describe,
  m43_expect,
  m43_it,
  m43_vi,
  m43_agentToolsFor,
  m43_callAgentTool,
  m43_daemonOperationIsSafeToRepeat,
  mergedDescribe43,
  fixtureScope42,
} from './test-support-read-only-mcp.test-support.js';

mergedDescribe43('wallet-tools.test.ts', () => {
  const scope42 = fixtureScope42();
  m43_describe('wallet MCP identity and signing', () => {
    m43_it('routes every wallet tool as the actual agent in its active thread', async () => {
      m43_vi.stubEnv('BEELINE_DAEMON_AGENT_ID', 'agent-1');
      m43_vi.stubEnv('BEELINE_DAEMON_ROOM_ID', 'parent-room');
      m43_vi.stubEnv('BEELINE_DAEMON_CORNER_ID', 'corner-1');
      m43_vi.stubEnv('BEELINE_DAEMON_BASE_URL', 'http://localhost:1234');
      m43_vi.stubEnv('BEELINE_DAEMON_TOKEN', 'test-token');
      m43_vi.stubEnv('BEELINE_TURN_CONTEXT_FILE', '');
      const calls: Array<{ name: string; body: Record<string, unknown> }> = [];
      m43_vi.stubGlobal('fetch', async (url: URL, options: RequestInit) => {
        const body = JSON.parse(options.body as string);
        calls.push({ name: url.pathname.split('/').at(-1)!, body });
        // Mirror the server ownership invariant: the old literal self fails.
        if (body.agentId !== 'agent-1')
          return Response.json(
            { error: 'daemon token does not own requested agent' },
            { status: 503 },
          );
        return Response.json({ ok: true });
      });
      for (const [tool, args] of [
        ['wallet_address', {}],
        ['wallet_balance', {}],
        ['wallet_chains', {}],
        ['wallet_history', { limit: 5 }],
        ['wallet_quote', { asset: 'usdc', amount: '1' }],
        ['wallet_pay', { asset: 'usdc', amount: '1', to: '0xabc' }],
        ['wallet_swap', { fromAsset: 'usdc', toAsset: 'eth', amount: '1' }],
        [
          'wallet_contract_call',
          {
            chain: 'arbitrum',
            contract: '0x' + '1'.repeat(40),
            data: '0xd0e30db0',
            approve: { asset: 'usdc', amount: '5' },
          },
        ],
        ['wallet_sign_typed_data', scope42.payload],
      ] as const)
        await m43_expect(
          m43_callAgentTool(
            'app_tool',
            { app: 'beeline:wallet', tool: tool.replace('wallet_', ''), args },
            'wallet-call',
          ),
        ).resolves.toBe('{"ok":true}');
      m43_expect(calls).toHaveLength(9);
      m43_expect(calls.find((call) => call.name === 'walletContractCall')?.body).toEqual({
        completionV1: true,
        agentId: 'agent-1',
        roomId: 'corner-1',
        chain: 'arbitrum',
        contract: '0x' + '1'.repeat(40),
        data: '0xd0e30db0',
        approve: { asset: 'usdc', amount: '5' },
      });
      for (const call of calls)
        m43_expect(call.body).toMatchObject({ agentId: 'agent-1', roomId: 'corner-1' });
      for (const call of calls.filter((call) =>
        ['walletPay', 'walletSwap', 'walletContractCall'].includes(call.name),
      ))
        m43_expect(call.body.completionV1).toBe(true);
      m43_expect(calls.at(-1)).toEqual({
        name: 'walletSignTypedData',
        body: { ...scope42.payload, agentId: 'agent-1', roomId: 'corner-1' },
      });
      m43_expect(m43_daemonOperationIsSafeToRepeat('walletSignTypedData', {})).toBe(false);
      m43_expect(m43_daemonOperationIsSafeToRepeat('walletContractCall', {})).toBe(false);
    });

    m43_it(
      'discovers wallet operations without mounting wallet schemas on ordinary turns',
      async () => {
        const names = m43_agentToolsFor(true, false).map((tool) => tool.name);
        m43_expect(names).toContain('app_tool');
        m43_expect(names).not.toContain('wallet_contract_call');
        const catalog = JSON.parse(
          await m43_callAgentTool('app_tool', { app: 'beeline:wallet' }, 'discover'),
        );
        const typed = catalog.tools.find(
          (tool: { name: string }) => tool.name === 'sign_typed_data',
        );
        m43_expect(typed.inputSchema.required).toEqual([
          'domain',
          'types',
          'primaryType',
          'message',
        ]);
        m43_expect(typed.description).toContain('authorize transfers');
        m43_expect(catalog.tools.map((tool: { name: string }) => tool.name)).toEqual(
          m43_expect.arrayContaining(['contract_call', 'link_request', 'link_wait']),
        );
      },
    );

    m43_it(
      'returns an uncertain payment as pending and never redispatches it on elapsed time',
      async () => {
        m43_vi.useFakeTimers();
        m43_vi.stubEnv('BEELINE_DAEMON_AGENT_ID', 'agent-1');
        m43_vi.stubEnv('BEELINE_DAEMON_CORNER_ID', 'corner-1');
        m43_vi.stubEnv('BEELINE_DAEMON_BASE_URL', 'http://localhost:1234');
        m43_vi.stubEnv('BEELINE_DAEMON_TOKEN', 'test-token');
        m43_vi.stubEnv('BEELINE_TURN_CONTEXT_FILE', '');
        const result = {
          outcome: 'pending',
          reason: 'Transaction submission is UNKNOWN. Do not resubmit this intent.',
        };
        const fetched = m43_vi.fn(async (_url: unknown, init: RequestInit) => {
          m43_expect(JSON.parse(String(init.body))).toMatchObject({
            completionV1: true,
            agentId: 'agent-1',
          });
          return Response.json(result);
        });
        m43_vi.stubGlobal('fetch', fetched);
        m43_expect(
          JSON.parse(
            await m43_callAgentTool(
              'app_tool',
              {
                app: 'beeline:wallet',
                tool: 'pay',
                args: { chain: 'base', asset: 'usdc', amount: '1', to: `0x${'1'.repeat(40)}` },
              },
              'uncertain-payment',
            ),
          ),
        ).toEqual(result);
        await m43_vi.advanceTimersByTimeAsync(86_400_000);
        m43_expect(fetched).toHaveBeenCalledTimes(1);
        m43_expect(m43_daemonOperationIsSafeToRepeat('walletPay', {})).toBe(false);
      },
    );
  });
});
