import { expect, it, vi } from 'vitest';
import { applySystemBackground } from './system-background';

const closed = "Call to function 'ExpoSystemUI.setBackgroundColorAsync' has been rejected.\n→ Caused by: The current activity is no longer available";

it('Reproduction SENTRY-MOBILE-5: background styling settles without reporting a destroyed activity', async () => {
  const native = vi.fn().mockRejectedValueOnce(new Error(closed)).mockResolvedValue(undefined);
  const report = vi.fn();
  await expect(applySystemBackground(native, report)).resolves.toBeUndefined();
  expect(report).not.toHaveBeenCalled();
  await applySystemBackground(native, report);
  expect(native).toHaveBeenCalledTimes(2);
});

it.each([
  new Error('The current activity is no longer available'),
  new Error("Call to function 'ExpoSystemUI.setBackgroundColorAsync' has been rejected.\n→ Caused by: Invalid color"),
  new Error("Call to function 'ExpoNavigationBar.setButtonStyleAsync' has been rejected.\n→ Caused by: The current activity is no longer available"),
])('reports every other styling failure: %s', async error => {
  const report = vi.fn();
  await expect(applySystemBackground(async () => { throw error; }, report)).resolves.toBeUndefined();
  expect(report).toHaveBeenCalledOnce();
  expect(report).toHaveBeenCalledWith(error);
});
