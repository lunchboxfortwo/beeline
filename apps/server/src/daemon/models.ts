import { renderAgentAvatar } from '../agent-avatar.js';
import { randomUUID } from 'node:crypto';
import type { DaemonContext } from './context.js';
import { Input, id } from './values.js';
import { daemonWriteResult } from './corner-messages.js';


  export async function daemonPostMandate(ctx: DaemonContext, input: Input<'postAgentToolMandate'>, agentId: string) {
    await ctx.database.query(
      `INSERT INTO agent_mandates(agent_id,room_id,generation,mandate) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(agent_id,room_id) DO UPDATE SET generation=EXCLUDED.generation,mandate=EXCLUDED.mandate,updated_at=now()`,
      [agentId, input.roomId, input.generation, JSON.stringify(input.mandate)],
    );
    return daemonWriteResult(ctx);
  }

  export async function daemonAgentAvatar(ctx: DaemonContext, input: Input<'postAgentAvatar'>, agentId: string) {
    const command = ctx.authorizedCommand;
    if (!ctx.commandTransaction || !command) throw new Error('avatar requires an active command');
    // Soul edits lock the agent before its identity; use the same order.
    await ctx.database.query('SELECT agent_id FROM agents WHERE agent_id=$1 FOR UPDATE', [
      agentId,
    ]);
    const ownerRequest = await ctx.database.query(
      `SELECT 1 FROM agents a JOIN messages m ON m.author_id=a.owner_id
      WHERE a.agent_id=$1 AND m.id=$2`,
      [agentId, command.root_source_message_id],
    );
    if (!ownerRequest.rowCount)
      throw new Error('only the agent owner may generate its avatar (access denied)');
    const bytes = await renderAgentAvatar(input.drawing);
    const id = randomUUID();
    const avatar = `/v1/agent-avatars/${id}`;
    await ctx.database.query(
      `INSERT INTO agent_avatars(id,agent_id,bytes,request_id,drawing) VALUES($1,$2,$3,$4,$5::jsonb)
       ON CONFLICT(agent_id) DO UPDATE SET id=EXCLUDED.id,bytes=EXCLUDED.bytes,
         request_id=EXCLUDED.request_id,drawing=EXCLUDED.drawing,generated_at=now()`,
      [id, agentId, bytes, command.turn_request_id, JSON.stringify(input.drawing)],
    );
    await ctx.database.query('UPDATE identities SET avatar=$2,updated_at=now() WHERE id=$1', [
      agentId,
      avatar,
    ]);
    await ctx.database.query(
      `UPDATE agents SET soul=CASE WHEN soul IS NULL THEN NULL ELSE soul - 'avatar' END,updated_at=now() WHERE agent_id=$1`,
      [agentId],
    );
    ctx.live.publish({ type: 'invalidate', roomId: input.roomId, reason: 'message', agentId });
    return { id, createdAt: Math.floor(Date.now() / 1000) };
  }

  export async function daemonCommands(ctx: DaemonContext, input: Input<'postAgentCommands'>, agentId: string) {
    await ctx.database.query(
      `UPDATE agents SET commands=$2::jsonb,updated_at=now() WHERE agent_id=$1`,
      [agentId, JSON.stringify(input.commands)],
    );
    return daemonWriteResult(ctx);
  }

  export async function daemonModelCatalog(ctx: DaemonContext, input: Input<'postAgentModelCatalog'>, agentId: string) {
    return ctx.database.transaction(async (database) => {
    await database.query(
      `UPDATE agents SET model_catalog=$2::jsonb,selected_model=COALESCE($3,selected_model),
         selected_effort=COALESCE($4,selected_effort),model_unavailable=$5,
         harness=COALESCE($7,harness),
         fast_mode=CASE WHEN $6 THEN fast_mode ELSE false END,updated_at=now()
       WHERE agent_id=$1`,
      [
        agentId,
        JSON.stringify(input.options),
        input.selection?.model ?? null,
        input.selection?.effort ?? null,
        input.unavailable ?? null,
        input.options.some(
          (axis) =>
            axis.id === 'fast-mode' &&
            axis.category === 'model_config' &&
            axis.options.some((choice) => choice.id === 'on') &&
            axis.options.some((choice) => choice.id === 'off'),
        ),
        input.harness ?? null,
      ],
    );
    return daemonWriteResult(ctx);
    });
  }

  export async function daemonMachineReport(ctx: DaemonContext, input: Input<'postAgentMachineReport'>, agentId: string) {
    await ctx.database.query(
      `UPDATE agents SET machine_id=$2,machine_name=$3,updated_at=now(),
         squire_work=CASE WHEN COALESCE(machine_id,agent_id)=$2 THEN squire_work ELSE '{}'::jsonb END
       WHERE agent_id=$1`,
      [agentId, input.machineId, input.machineName],
    );
    return ctx.writeResult();
  }
