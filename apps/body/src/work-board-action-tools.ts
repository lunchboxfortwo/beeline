import { WORK_STATES } from '@beeline/api-contract/phone';
import type { ToolDefinition } from './minimal-tool-surface.js';

/** Creating a separate task remains distinct from updating the thread's task. */
export const WORK_BOARD_ACTION_TOOLS:ToolDefinition[]=[{
  name:'create_work_item',description:'Create a distinct task in a chat or thread. Returns its id for later update_work calls.',
  inputSchema:{type:'object',required:['roomId','title'],additionalProperties:false,properties:{
    roomId:{type:'string'},title:{type:'string'},objective:{type:'string'},state:{enum:WORK_STATES},
    assigneeId:{anyOf:[{type:'string'},{type:'null'}]},
  }},
}];
