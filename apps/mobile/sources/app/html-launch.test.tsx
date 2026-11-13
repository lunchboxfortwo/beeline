import { expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { readFileSync } from 'node:fs';

function launch(saved: unknown, migrated: boolean, denied = false) {
  const html = readFileSync('public/index.html', 'utf8');
  const css = html.match(/<style>([\s\S]*?)<\/style>/)![1];
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
  const styles: { textContent: string }[] = [];
  const reads: string[] = [];
  const window = { localStorage: { getItem(key: string) {
    reads.push(key);
    if (denied) throw new Error('Storage denied');
    return key.endsWith('local-settings') ? JSON.stringify(saved) : migrated ? 'done' : null;
  } }, __beelineLaunchSettings: undefined as unknown };
  runInNewContext(script, { window, document: { createElement: () => ({}), head: { appendChild: (style: { textContent: string }) => styles.push(style) } } });
  return { css, styles: styles.map(style => style.textContent).join(''), reads, window };
}

it.each([false, true])('Reproduction STONE-LAUNCH: Stone head before JS with migration=%s', migrated => {
  const result = launch({ palette: migrated ? 'stone' : 'brass', appearance: 'light' }, migrated);
  expect(result.css.toLowerCase()).not.toMatch(/#f3eee4|#14091a/);
  expect(result.css + result.styles).toContain('#fafaf9');
  expect(result.styles.toLowerCase()).not.toMatch(/#f3eee4|#14091a/);
  expect(result.reads.filter(key => key.endsWith('local-settings'))).toHaveLength(1);
  expect(result.window.__beelineLaunchSettings).toEqual({ raw: JSON.stringify({ palette: migrated ? 'stone' : 'brass', appearance: 'light' }) });
});
it('uses Stone if browser storage is unavailable', () => {
  expect(launch(null, false, true).css.toLowerCase()).toContain('#fafaf9');
});
it('hands a deliberate Brass choice to JS without rewriting it', () => {
  expect(launch({ palette: 'brass', appearance: 'light' }, true).window.__beelineLaunchSettings).toEqual({ raw: JSON.stringify({ palette: 'brass', appearance: 'light' }) });
});
