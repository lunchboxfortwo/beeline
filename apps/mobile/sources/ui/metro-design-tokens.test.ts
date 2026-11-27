import { createRequire } from 'node:module';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const fs = require('fs') as typeof import('node:fs');
const metroConfig = require('../../metro.config.js') as {
  resolver: {
    resolveRequest: (
      context: {
        originModulePath: string;
        resolveRequest: (ctx: unknown, name: string, platform: string | null) => unknown;
      },
      moduleName: string,
      platform: string | null,
    ) => { filePath: string; type: string };
  };
};

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');
const DESIGN_TOKENS_DIST_ENTRY = path.join(REPO_ROOT, 'packages/design-tokens/dist/index.js');
const DESIGN_TOKENS_SRC_DIR = path.join(REPO_ROOT, 'packages/design-tokens/src');
const DESIGN_TOKENS_SRC_ENTRY = path.join(DESIGN_TOKENS_SRC_DIR, 'index.ts');

describe('metro.config.js @beeline/design-tokens resolution', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('falls back to packages/design-tokens/src/index.ts when dist/index.js is absent', () => {
    const realExistsSync = fs.existsSync.bind(fs);
    vi.spyOn(fs, 'existsSync').mockImplementation((target) => {
      if (path.resolve(String(target)) === DESIGN_TOKENS_DIST_ENTRY) return false;
      return realExistsSync(target);
    });
    const fallback = vi.fn();

    const resolved = metroConfig.resolver.resolveRequest(
      { originModulePath: path.join(REPO_ROOT, 'apps/mobile/sources/ui/tamagui.config.ts'), resolveRequest: fallback },
      '@beeline/design-tokens',
      'web',
    );

    expect(resolved).toEqual({ filePath: DESIGN_TOKENS_SRC_ENTRY, type: 'sourceFile' });
    expect(fallback).not.toHaveBeenCalled();
  });

  it('uses packages/design-tokens/dist/index.js when built', () => {
    const realExistsSync = fs.existsSync.bind(fs);
    vi.spyOn(fs, 'existsSync').mockImplementation((target) => {
      if (path.resolve(String(target)) === DESIGN_TOKENS_DIST_ENTRY) return true;
      return realExistsSync(target);
    });
    const fallback = vi.fn();

    const resolved = metroConfig.resolver.resolveRequest(
      { originModulePath: path.join(REPO_ROOT, 'apps/mobile/sources/ui/tamagui.config.ts'), resolveRequest: fallback },
      '@beeline/design-tokens',
      'web',
    );

    expect(resolved).toEqual({ filePath: DESIGN_TOKENS_DIST_ENTRY, type: 'sourceFile' });
    expect(fallback).not.toHaveBeenCalled();
  });

  it('resolves NodeNext relative .js imports inside packages/design-tokens/src/ to sibling .ts files', () => {
    const fallback = vi.fn();
    const cases: Array<[string, string, string]> = [
      ['index.ts', './scale.js', 'scale.ts'],
      ['index.ts', './palettes.js', 'palettes.ts'],
      ['index.ts', './stone-css.js', 'stone-css.ts'],
      ['palettes.ts', './scale.js', 'scale.ts'],
      ['stone-css.ts', './palettes.js', 'palettes.ts'],
      ['stone-css.ts', './scale.js', 'scale.ts'],
    ];

    for (const [originFile, specifier, expectedFile] of cases) {
      const resolved = metroConfig.resolver.resolveRequest(
        { originModulePath: path.join(DESIGN_TOKENS_SRC_DIR, originFile), resolveRequest: fallback },
        specifier,
        'web',
      );
      expect(resolved).toEqual({
        filePath: path.join(DESIGN_TOKENS_SRC_DIR, expectedFile),
        type: 'sourceFile',
      });
    }
    expect(fallback).not.toHaveBeenCalled();
  });

  it('leaves imports outside packages/design-tokens/src/ and missing/escaping targets to Metro default resolution', () => {
    const sentinel = { filePath: '/sentinel/default.js', type: 'sourceFile' };
    const fallback = vi.fn(() => sentinel);

    const distResolved = metroConfig.resolver.resolveRequest(
      { originModulePath: DESIGN_TOKENS_DIST_ENTRY, resolveRequest: fallback },
      './scale.js',
      'web',
    );
    expect(distResolved).toBe(sentinel);

    const mobileResolved = metroConfig.resolver.resolveRequest(
      { originModulePath: path.join(REPO_ROOT, 'apps/mobile/sources/app/_layout.tsx'), resolveRequest: fallback },
      './scale.js',
      'web',
    );
    expect(mobileResolved).toBe(sentinel);

    const missingResolved = metroConfig.resolver.resolveRequest(
      { originModulePath: DESIGN_TOKENS_SRC_ENTRY, resolveRequest: fallback },
      './nonexistent.js',
      'web',
    );
    expect(missingResolved).toBe(sentinel);

    const escapingResolved = metroConfig.resolver.resolveRequest(
      { originModulePath: DESIGN_TOKENS_SRC_ENTRY, resolveRequest: fallback },
      '../dist/index.js',
      'web',
    );
    expect(escapingResolved).toBe(sentinel);

    expect(fallback).toHaveBeenCalledTimes(4);
  });
});
