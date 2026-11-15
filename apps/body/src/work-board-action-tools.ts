import { WORK_STATES } from '@beeline/api-contract/phone';
import type { ToolDefinition } from './minimal-tool-surface.js';

const address = {
  roomId: { type: 'string', description: 'Thread, chat or DM containing the work item.' },
  id: { type: 'string', description: 'Work item or asking message id; omit for the thread task.' },
};
const state = { enum: WORK_STATES };
const assigneeId = {
  anyOf: [{ type: 'string' }, { type: 'null' }],
  description: 'Agent or person identity id; null unassigns.',
};

/** Named actions share the existing work-item write and its committed live invalidation. */
export const WORK_BOARD_ACTION_TOOLS: ToolDefinition[] = [
  {
    name: 'create_work_item',
    description:
      'Create a distinct Work board item in a thread, chat or DM. State is optional and defaults to Backlog; pass a state to put it there immediately. The objective says what done looks like; it becomes the thread objective when the work starts. Returns its id for later edits. Any agent with conversation access can create work.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['roomId', 'title'],
      properties: {
        roomId: address.roomId,
        title: { type: 'string' },
        objective: { type: 'string', description: 'What the work must achieve.' },
        state,
        assigneeId,
      },
    },
  },
  {
    name: 'set_work_state',
    description:
      'Set a Work board item state, including moving it to Backlog. This changes the board; agent command authority is unchanged.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['roomId', 'state'],
      properties: { ...address, state },
    },
  },
  {
    name: 'assign_work_item',
    description:
      'Assign the one person or agent who has the ball for a Work board item. Pass assigneeId:null to leave it unassigned. Any agent with conversation access can edit it.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['roomId', 'assigneeId'],
      properties: { ...address, assigneeId },
    },
  },
];
