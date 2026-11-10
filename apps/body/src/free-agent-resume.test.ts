import { PassThrough } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { watchFreeAgentResume } from './free-agent-resume.js';

it('delivers complete VMGenID records once and ignores other kernel activity', () => {
  const input = new PassThrough(), resumed = vi.fn();
  const stop = watchFreeAgentResume(resumed, input);
  try {
    input.write('<5>[ 0.1] random: crng init done\n');
    input.write('<5>[ 48.3] random: crng reseeded due to virtual');
    expect(resumed).not.toHaveBeenCalled();
    input.write(' machine fork\n<6>[ 48.4] unrelated kernel activity\n');
    expect(resumed).toHaveBeenCalledOnce();
    input.write('<5>[ 93.1] random: crng reseeded due to virtual machine fork\n');
    expect(resumed).toHaveBeenCalledTimes(2);
    stop();
    input.write('<5>[ 94.1] random: crng reseeded due to virtual machine fork\n');
    expect(resumed).toHaveBeenCalledTimes(2);
  } finally { stop(); input.destroy(); }
});
