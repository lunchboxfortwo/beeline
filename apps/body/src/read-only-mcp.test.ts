import {
  callAgentTool,
  CAPABILITY_TOOLS,
  Check,
  cornerCallText,
  describe,
  expect,
  fixtureScope3,
  fixtureScope6,
  it,
  m7_agentToolsFor,
  m7_askChoice,
  m7_describe,
  m7_expect,
  m7_it,
  m7_openPoll,
  m8_agentToolsFor,
  m8_describe,
  m8_emitEvent,
  m8_expect,
  m8_it,
  m8_listEventSubscriptions,
  m8_subscribeEvents,
  mergedDescribe7,
  mergedDescribe8,
  schema,
  type Call,
} from './test-support-read-only-mcp.test-support.js';

describe('thread text', () => {
  it('flattens an untidy call instead of refusing it', () => {
    // A grok-shaped call: the brief arrives with its line breaks intact.
    expect(
      cornerCallText({
        name: 'widget-ledger',
        objective: 'Ship the thread name parameter.\nMake grok able to open a thread.',
      }),
    ).toEqual({
      name: 'widget-ledger',
      objective: 'Ship the thread name parameter. Make grok able to open a thread.',
    });
  });

  it('fixes a spaced name and a long objective, and still requires both', () => {
    expect(
      cornerCallText({
        name: 'far too many words here',
        objective: 'Ship the widget',
      }),
    ).toEqual({
      name: 'far-too-many',
      objective: 'Ship the widget',
      notes: ['the name had spaces and was 5 words; saved as far-too-many (first 3 words)'],
    });
    const long = cornerCallText({
      name: 'widget-ledger',
      objective: Array.from({ length: 61 }, (_, index) => `word${index}`).join(' '),
    });
    expect(long.name).toBe('widget-ledger');
    expect(long.objective.split(' ')).toHaveLength(24);
    expect(long.notes?.[0]).toContain('61 words');
    expect(() => cornerCallText({ objective: 'Ship the widget' })).toThrow(
      'the name is required; give a title of at most 3 words',
    );
  });
});
describe('canonical tool contracts', () => {
  it('requires explicit ownership and a complete brief with optional opening approval', () => {
    const input = {
      room: '11111111-1111-4111-8111-111111111111',
      implementer: 'worker',
      brief: { spec: 'Build the widget', approval: { sourceMessageId: 'human-message' } },
    };
    expect(Check(schema('open_thread'), input)).toBe(true);
    expect(Check(schema('open_thread'), { ...input, implementer: undefined })).toBe(false);
    expect(Check(schema('open_thread'), { ...input, brief: { spec: 'Build the widget' } })).toBe(
      true,
    );
    expect(Check(schema('open_thread'), { ...input, brief: { ...input.brief, spec: '' } })).toBe(
      false,
    );
    const revision = {
      address: 'child',
      action: 'brief',
      brief: input.brief,
      expectedRevision: 2,
      change: 'Approved correction',
    };
    expect(Check(schema('revise_thread'), revision)).toBe(true);
    expect(
      Check(schema('revise_thread'), { ...revision, brief: { spec: 'Build the widget' } }),
    ).toBe(true);
    expect(
      Check(schema('revise_thread'), {
        address: revision.address,
        action: revision.action,
        brief: revision.brief,
        change: revision.change,
      }),
    ).toBe(false);
    expect(
      Check(schema('revise_thread'), {
        address: 'child',
        action: 'metadata',
        name: 'widget',
        brief: input.brief,
      }),
    ).toBe(false);
    expect(
      Check(schema('revise_thread'), {
        address: 'child',
        action: 'install_brief',
        name: 'widget',
        brief: input.brief,
      }),
    ).toBe(true);
  });

  it('keeps sourced memory mutations and procedure upsert distinct', () => {
    const procedure = {
      kind: 'procedure',
      action: 'save',
      slug: 'widget',
      description: 'Build widgets',
      markdown: 'Steps',
    };
    expect(Check(schema('remember'), procedure)).toBe(true);
    expect(Check(schema('remember'), { ...procedure, action: 'update' })).toBe(false);
    expect(
      Check(schema('remember'), { kind: 'fact', action: 'save', body: 'Unattributed fact' }),
    ).toBe(false);
    expect(Check(schema('remember'), { kind: 'fact', action: 'delete', item_id: 'item' })).toBe(
      false,
    );
  });

  it('keeps memory query character limits inside the advertised schema and tool path', async () => {
    const searchSchema = schema('search');
    const memoryQuery = (query: string) => ({ scope: 'memory', query, limit: 1 });
    expect(searchSchema.properties.query.description).toMatch(/1–500 characters/);
    const withinCap = memoryQuery('🙂'.repeat(500));
    const overCap = memoryQuery('🙂'.repeat(501));

    expect(Buffer.byteLength(withinCap.query, 'utf8')).toBe(2_000);
    expect(Check(searchSchema, withinCap)).toBe(true);
    expect(Check(searchSchema, overCap)).toBe(false);
    await expect(callAgentTool('search', overCap, 'memory-search-over-cap')).rejects.toThrow(
      /query: at most 500 characters/,
    );
  });

  it('separates assignment completion, feedback, discovery and execution', () => {
    expect(Check(schema('reply'), { id: 'task', text: 'blocked: input required' })).toBe(true);
    expect(Check(schema('reply'), { id: 'task', text: 'input required', to: 'captain' })).toBe(
      false,
    );
    expect(Check(schema('reply'), { category: 'bug', summary: 'Broken tool' })).toBe(false);
    expect(Check(schema('report_feedback'), { category: 'bug', summary: 'Broken tool' })).toBe(
      true,
    );
    expect(Check(schema('app_tool'), { app: 'beeline:workflow' })).toBe(true);
    expect(Check(schema('app_tool'), { app: 'beeline:workflow', args: {} })).toBe(false);
    expect(
      Check(schema('app_tool'), { app: 'beeline:workflow', tool: 'read', args: { runId: 'run' } }),
    ).toBe(true);
    for (const tools of Object.values(CAPABILITY_TOOLS))
      for (const tool of Object.values(tools)) {
        expect(tool.inputSchema.type).toBe('object');
        expect(tool.inputSchema.properties).toBeDefined();
      }
  });
});
mergedDescribe7('agent-choice-tools.test.ts', () => {
  const scope3 = fixtureScope3();
  m7_describe('the one app front door', () => {
    m7_it(
      'mounts connect wherever an app can be used, and no retired connector tools anywhere',
      () => {
        const room = m7_agentToolsFor(true, false).map((tool) => tool.name);
        const dm = m7_agentToolsFor(true, true).map((tool) => tool.name);
        const corner = m7_agentToolsFor(true, false, true).map((tool) => tool.name);
        m7_expect(room).toContain('connect');
        m7_expect(dm).toContain('connect');
        m7_expect(corner).toContain('connect');
        for (const names of [room, dm, corner])
          for (const retired of [
            'connect_app',
            'offer_connector',
            'connect_mcp_server',
            'search_mcp_registry',
            'composio_tools',
            'composio_execute',
          ])
            m7_expect(names).not.toContain(retired);
      },
    );
  });
  m7_describe('beeline-agent ask_choice and open_poll', () => {
    m7_it('keeps standalone preference cards out of the minimal surface', () => {
      for (const tools of [
        m7_agentToolsFor(true, false),
        m7_agentToolsFor(true, true),
        m7_agentToolsFor(true, false, true),
      ]) {
        const names = tools.map((tool) => tool.name);
        m7_expect(names).not.toContain('ask_choice');
        m7_expect(names).not.toContain('open_poll');
        const schema = tools.find((tool) => tool.name === 'reply')!.inputSchema;
        m7_expect(schema.required ?? []).not.toContain('ask');
        m7_expect(schema.properties?.ask).toMatchObject({ type: 'object' });
        m7_expect(schema.properties?.ask).not.toHaveProperty('maxLength');
      }
    });

    m7_it('posts a choice with no agent-authored ask', async () => {
      const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
      await m7_askChoice(
        { prompt: 'Ship the OTA tonight?', options: scope3.options },
        scope3.deps({ choiceId: 'c-1' }, ops),
      );
      m7_expect(ops[0]?.input.prompt).toBe('Ship the OTA tonight?');
      m7_expect(ops[0]?.input).not.toHaveProperty('ask');
    });

    m7_it('posts ask_choice without pausing the turn', async () => {
      const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
      const reply = await m7_askChoice(
        {
          ask: 'Which approach should we use?',
          prompt: 'How do you want to push the desk past this?',
          constraint: 'CDP AgentKit needs JWT signing',
          options: scope3.options,
          ttl: 900,
        },
        scope3.deps(
          { choiceId: 'c-1', messageId: 'm-1', mode: 'question', electorateCount: 1 },
          ops,
        ),
      );
      m7_expect(ops).toEqual([
        {
          name: 'askRoomChoice',
          input: {
            roomId: 'room-1',
            ask: 'Which approach should we use?',
            prompt: 'How do you want to push the desk past this?',
            constraint: 'CDP AgentKit needs JWT signing',
            options: scope3.options,
            ttlSeconds: 900,
          },
        },
      ]);
      m7_expect(reply).toContain('posted [c-1]');
      m7_expect(reply).toContain('not paused');
      m7_expect(reply).not.toContain('paused on this grant');
    });

    m7_it('posts open_poll as a fact, never a mandate', async () => {
      const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
      const reply = await m7_openPoll(
        { prompt: 'Which paper API?', options: scope3.options, ttl: 3600 },
        scope3.deps(
          {
            choiceId: 'c-2',
            messageId: 'm-2',
            mode: 'poll',
            electorateCount: 4,
            closesAt: 1_800_000_000,
          },
          ops,
        ),
      );
      m7_expect(ops[0]).toEqual({
        name: 'openRoomPoll',
        input: {
          roomId: 'room-1',
          prompt: 'Which paper API?',
          options: scope3.options,
          ttlSeconds: 3600,
        },
      });
      m7_expect(reply).toContain('electorate 4');
      m7_expect(reply).toContain('preference fact');
      m7_expect(reply).toContain('tie or no votes');
    });
  });
});
mergedDescribe8('agent-event-tools.test.ts', () => {
  const scope6 = fixtureScope6();
  m8_describe('beeline-agent event tools', () => {
    m8_it('an agent subscribes itself, and the reply names the whole resulting list', async () => {
      const calls: Call[] = [];
      const result = await m8_subscribeEvents(
        { kinds: ['joined'] },
        scope6.deps(calls, { setEventSubscriptions: { kinds: ['joined'] } }),
      );
      m8_expect(calls).toEqual([
        { name: 'setEventSubscriptions', input: { roomId: 'room-1', kinds: ['joined'] } },
      ]);
      m8_expect(result).toContain('joined');
      m8_expect(result).toContain('You now react to');
    });

    m8_it(
      'refuses a kind that is not a server event kind, without calling the daemon',
      async () => {
        const calls: Call[] = [];
        await m8_expect(
          m8_subscribeEvents({ kinds: ['agent:handoff'] }, scope6.deps(calls)),
        ).rejects.toThrow(/not an event kind you can subscribe to: agent:handoff/);
        await m8_expect(
          m8_subscribeEvents({ kinds: ['everything'] }, scope6.deps(calls)),
        ).rejects.toThrow(/not an event kind/);
        m8_expect(calls).toEqual([]);
      },
    );

    m8_it(
      'refuses a per-item kind: it already wakes its own owner, with no subscription involved',
      async () => {
        const calls: Call[] = [];
        await m8_expect(
          m8_subscribeEvents({ kinds: ['grant-decided'] }, scope6.deps(calls)),
        ).rejects.toThrow(/grant-decided wakes its own item's owner automatically/);
        await m8_expect(
          m8_subscribeEvents({ kinds: ['joined', 'choice-answered'] }, scope6.deps(calls)),
        ).rejects.toThrow(/choice-answered wakes its own item's owner automatically/);
        m8_expect(calls).toEqual([]);
      },
    );

    m8_it(
      'an empty subscription list is a legal answer and says the agent reacts to nothing',
      async () => {
        const calls: Call[] = [];
        const result = await m8_subscribeEvents(
          { kinds: [] },
          scope6.deps(calls, { setEventSubscriptions: { kinds: [] } }),
        );
        m8_expect(calls[0]?.input).toEqual({ roomId: 'room-1', kinds: [] });
        m8_expect(result).toContain('react to no events');
      },
    );

    m8_it('lists what the agent currently reacts to', async () => {
      const calls: Call[] = [];
      const result = await m8_listEventSubscriptions(
        scope6.deps(calls, { listEventSubscriptions: { kinds: ['joined', 'merged'] } }),
      );
      m8_expect(calls).toEqual([{ name: 'listEventSubscriptions', input: { roomId: 'room-1' } }]);
      m8_expect(result).toContain('joined, merged');
    });

    m8_it('emit_event forwards kind, sentence and mentions, and never a cause', async () => {
      const calls: Call[] = [];
      const result = await m8_emitEvent(
        { kind: 'agent:handoff', consequence: 'the branch is ready', mentionAgentIds: ['agent-b'] },
        scope6.deps(calls),
      );
      m8_expect(calls).toEqual([
        {
          name: 'postRoomEvent',
          input: {
            roomId: 'room-1',
            kind: 'agent:handoff',
            consequence: 'the branch is ready',
            mentionAgentIds: ['agent-b'],
          },
        },
      ]);
      m8_expect(Object.keys(calls[0]?.input ?? {})).not.toContain('causeId');
      m8_expect(result).toContain('agent:handoff');
    });

    m8_it(
      'refuses a server kind, a malformed kind, an empty sentence and too many mentions',
      async () => {
        const calls: Call[] = [];
        await m8_expect(
          m8_emitEvent({ kind: 'joined', consequence: 'hello' }, scope6.deps(calls)),
        ).rejects.toThrow(/a fact the server states/);
        await m8_expect(
          m8_emitEvent({ kind: 'agent:Handoff', consequence: 'hello' }, scope6.deps(calls)),
        ).rejects.toThrow(/agent:<slug>/);
        await m8_expect(
          m8_emitEvent({ kind: 'agent:x', consequence: '   ' }, scope6.deps(calls)),
        ).rejects.toThrow(/one sentence/);
        await m8_expect(
          m8_emitEvent(
            { kind: 'agent:x', consequence: 'ok', mentionAgentIds: ['a', 'b', 'c', 'd'] },
            scope6.deps(calls),
          ),
        ).rejects.toThrow(/at most 3 agents/);
        m8_expect(calls).toEqual([]);
      },
    );

    m8_it('accepts the advertised maximum lengths and refuses the next character', async () => {
      const calls: Call[] = [];
      await m8_emitEvent(
        { kind: `agent:${'x'.repeat(40)}`, consequence: 'x'.repeat(200) },
        scope6.deps(calls),
      );
      await m8_expect(
        m8_emitEvent({ kind: `agent:${'x'.repeat(41)}`, consequence: 'ok' }, scope6.deps(calls)),
      ).rejects.toThrow(/slug at most 40 characters/);
      await m8_expect(
        m8_emitEvent({ kind: 'agent:x', consequence: 'x'.repeat(201) }, scope6.deps(calls)),
      ).rejects.toThrow(/at most 200 characters/);
      m8_expect(calls).toHaveLength(1);
    });

    m8_it(
      "surfaces the server's refusal verbatim, so the emitting model reads why nothing was posted",
      async () => {
        const calls: Call[] = [];
        await m8_expect(
          m8_emitEvent(
            { kind: 'agent:ping', consequence: 'again' },
            scope6.deps(calls, {
              postRoomEvent: new Error(
                'daemon operation postRoomEvent failed (400: this event would sit 5 events deep and the limit is 4; nothing was posted.)',
              ),
            }),
          ),
        ).rejects.toThrow(/5 events deep/);
      },
    );

    m8_it('exposes only self-wake management on the minimal surface', () => {
      for (const dm of [false, true]) {
        const names = m8_agentToolsFor(true, dm).map((tool) => tool.name);
        m8_expect(names).toContain('wake');
        for (const retired of [
          'subscribe_events',
          'list_event_subscriptions',
          'emit_event',
          'set_wake_delivery',
          'get_wake_delivery',
        ])
          m8_expect(names).not.toContain(retired);
      }
    });
  });
});
