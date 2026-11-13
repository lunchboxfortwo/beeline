import type {SqlDatabase} from './database.js';
import {ownedRoomAccessSql} from './turn-ownership.js';

/** One current command/access cut, retained only through synchronous transport enqueue. */
export async function fenceOwnedTurnReply(
  database:SqlDatabase,agentId:string,
  input:{roomId:string;generationId?:string;commandId?:string;requestId?:string},
  enqueue:()=>void,requireClaimed=false,
):Promise<void>{
    await database.transaction(async db => {
      const command = await db.query(`SELECT command.id FROM agent_commands command
        WHERE command.room_id=$1 AND command.agent_id=$2
          AND (($4::text IS NOT NULL AND command.id=$4) OR ($5::text IS NOT NULL AND command.turn_request_id=$5))
          AND command.generation_id=$3
          AND command.state IN ('claimed','complete','cancelled') AND (NOT $6::boolean OR command.state='claimed')
          AND EXISTS(${ownedRoomAccessSql('$1','$2','$4',true)})
        FOR SHARE OF command NOWAIT`,
        [input.roomId, agentId, input.generationId ?? null,
          input.commandId ?? null, input.requestId ?? null, requireClaimed]);
      if (!command.rowCount) throw new Error('Turn command or access changed before enqueue');
      enqueue();
    });
}
