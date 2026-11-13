import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { parseCommandGrantTarget } from '@beeline/api-contract/agent-grants';
import { validateGrantScript } from './values.js';

it('accepts a long script by its full contents and hash', () => {
  const contents = '#!/bin/bash\n' + 'echo proof\n'.repeat(1_980);
  const script = { path: 'proof.sh', sha256: createHash('sha256').update(contents).digest('hex'), bytes: Buffer.byteLength(contents), contents };
  const rule = parseCommandGrantTarget('bash proof.sh');
  expect(validateGrantScript(rule, script)).toEqual(script);
  expect(() => validateGrantScript(rule, { ...script, contents: `${contents}rm -rf ~\n` })).toThrow('hash does not match');
});
