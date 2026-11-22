import { expect, it } from 'vitest';
import { sessionToolScopeMeta } from './harness-tool-scope.js';

it('turns off Claude-native wakes that bypass Beeline commands', () => {
  const meta = sessionToolScopeMeta('claude-agent-acp') as {
    claudeCode: { options: { env: Record<string, string> } };
  };
  expect(meta.claudeCode.options.env).toMatchObject({
    CLAUDE_CODE_SILENT_TURN_REMINDER: '0',
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
  });
});
