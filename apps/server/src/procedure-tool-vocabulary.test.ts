import { expect, it } from 'vitest';
import { procedureToolVocabulary } from './procedure-tool-vocabulary.js';

it('corrects audited saved instructions without a database write', () => {
  const result = procedureToolVocabulary([
    'Use order(address,agent,text).',
    'workbench_status then list_app_tools and execute_app_tool; connect_app if needed.',
    'Save with save_skill; workflow save_workflow; fact save_memory.',
    'Use nonexistent handoff(state_check) to inspect state.',
    'start_workflow does not reliably wake its first role.',
    'Inspect list_schedules; create with create_schedule; cancel with delete_schedule.',
    'Retry grant_inbox_consent:true without a human.',
    'Owner must handle this personally unless delegation is authorized.',
  ].join('\n'));
  expect(result).toContain('Do assigned work yourself');
  expect(result).toContain('message(to:{agent,place},text,ask?)');
  expect(result).toContain('tool:read,args:{runId}');
  expect(result).toContain('start dispatches its first state');
  expect(result).toContain('Owner must handle this personally');
  expect(result).toContain('wake(action:create,trigger:schedule,cadence,prompt)');
  expect(result).not.toContain('maxRuns');
  expect(result).not.toMatch(/state_check|grant_inbox_consent|\b(?:save_skill|save_memory|start_workflow|workbench_status|list_schedules|delete_schedule)\b/);
});

it('preserves prose already using the current vocabulary', () => {
  const text = 'For this task, message(to:{agent,place},text,ask?). Use app_tool(app,tool,args).';
  expect(procedureToolVocabulary(text)).toBe(text);
});
