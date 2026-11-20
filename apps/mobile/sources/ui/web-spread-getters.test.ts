import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { transformSync } from '@babel/core';
import { beforeAll, describe, expect, it } from 'vitest';

const projectRoot = resolve(__dirname, '../..');
const requireFromProject = createRequire(resolve(projectRoot, 'package.json'));

// Tamagui's useTheme() builds `{ ...value, get val() { track(key) } }`. The web
// export (no Hermes engine) used to compile that to Object.assign, which reads
// the getter once and keeps a plain value, so `.val` readers never subscribed
// and kept the old ink after a live Light/Dark switch.
function compiledForWebExport(source: string): Record<string, unknown> {
    const code = transformSync(source, {
        cwd: projectRoot,
        filename: resolve(projectRoot, 'sources/spread-getter.js'),
        caller: { name: 'metro', bundler: 'metro', platform: 'web', isDev: false } as never,
    })?.code;
    const module = { exports: {} as Record<string, unknown> };
    new Function('module', 'exports', 'require', code ?? '')(module, module.exports, requireFromProject);
    return module.exports;
}

describe('web export object spread', () => {
    let compiled: Record<string, unknown>;
    // Cold Expo/Babel plugin initialization is build setup, not getter execution.
    beforeAll(() => {
        compiled = compiledForWebExport(
            'let reads = 0; const value = { a: 1 }; module.exports = { ...value, get val() { reads += 1; return reads; } };',
        );
    }, 30_000);

    it('keeps a getter written after a spread, so it still runs on every read', () => {
        expect(Object.getOwnPropertyDescriptor(compiled, 'val')?.get).toBeTypeOf('function');
        expect([compiled.val, compiled.val]).toEqual([1, 2]);
    });
});
