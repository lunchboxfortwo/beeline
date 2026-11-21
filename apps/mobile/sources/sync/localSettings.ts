export type LocalSettings = {
    appearance: 'system' | 'light' | 'dark';
    // The grammar's colour set: Stone (default) or Brass on the same components.
    palette: 'brass' | 'stone';
    roomOpenTraceOverlay: boolean;
    uiSize: 'small' | 'medium' | 'large';
    zenMode: boolean;
};

// Read at launch, so a few literal checks stand in for a schema library.
const valid: { [Key in keyof LocalSettings]: (value: unknown) => boolean } = {
    appearance: (value) => value === 'system' || value === 'light' || value === 'dark',
    palette: (value) => value === 'brass' || value === 'stone',
    roomOpenTraceOverlay: (value) => typeof value === 'boolean',
    uiSize: (value) => value === 'small' || value === 'medium' || value === 'large',
    zenMode: (value) => typeof value === 'boolean',
};

export const localSettingsDefaults: LocalSettings = Object.freeze({
    appearance: 'system',
    palette: 'stone',
    roomOpenTraceOverlay: false,
    uiSize: 'medium',
    zenMode: false,
});

/** Known fields that are present and valid; one invalid field keeps every default. */
export function localSettingsParse(settings: unknown): LocalSettings {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return { ...localSettingsDefaults };
    const saved = settings as Record<string, unknown>;
    const parsed: Partial<LocalSettings> = {};
    for (const key of Object.keys(valid) as (keyof LocalSettings)[]) {
        if (saved[key] === undefined) continue;
        if (!valid[key](saved[key])) return { ...localSettingsDefaults };
        Object.assign(parsed, { [key]: saved[key] });
    }
    return { ...localSettingsDefaults, ...parsed };
}

export function applyLocalSettings(
    settings: LocalSettings,
    delta: Partial<LocalSettings>,
): LocalSettings {
    return { ...localSettingsDefaults, ...settings, ...delta };
}
