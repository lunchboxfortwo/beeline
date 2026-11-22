import { expect, it } from 'vitest';
import { localSettingsDefaults, localSettingsParse } from './localSettings';
import { settingsDefaults, settingsParse } from './settings';

it('keeps saved local settings and drops fields it does not know', () => {
  expect(localSettingsParse({ appearance: 'dark', uiSize: 'large', legacy: true })).toEqual({
    ...localSettingsDefaults,
    appearance: 'dark',
    uiSize: 'large',
  });
  expect(
    localSettingsParse({ palette: 'brass', zenMode: true, roomOpenTraceOverlay: true }),
  ).toEqual({
    ...localSettingsDefaults,
    palette: 'brass',
    zenMode: true,
    roomOpenTraceOverlay: true,
  });
});

it.each([
  null,
  'dark',
  [],
  { appearance: 'sepia' },
  { zenMode: 'yes', uiSize: 'large' },
  { appearance: null },
])('falls back to every local default for %j', (saved) => {
  expect(localSettingsParse(saved)).toEqual(localSettingsDefaults);
});

it('keeps saved synced settings, including a cleared language', () => {
  expect(
    settingsParse({ userMessageBubbleColor: 'blue', preferredLanguage: null, other: 1 }),
  ).toEqual({ userMessageBubbleColor: 'blue', preferredLanguage: null });
  expect(settingsParse({ preferredLanguage: 'fr' })).toEqual({
    ...settingsDefaults,
    preferredLanguage: 'fr',
  });
});

it.each([
  undefined,
  7,
  { userMessageBubbleColor: 3 },
  { preferredLanguage: 7, userMessageBubbleColor: 'blue' },
])('falls back to every synced default for %j', (saved) => {
  expect(settingsParse(saved)).toEqual(settingsDefaults);
});
