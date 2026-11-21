export type Settings = {
    userMessageBubbleColor: string;
    preferredLanguage: string | null;
};

export const settingsDefaults: Settings = Object.freeze({
    userMessageBubbleColor: 'gray',
    preferredLanguage: null,
});

/** Known fields that are present and valid; one invalid field keeps every default. */
export function settingsParse(settings: unknown): Settings {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return { ...settingsDefaults };
    const { userMessageBubbleColor, preferredLanguage } = settings as Record<string, unknown>;
    if (userMessageBubbleColor !== undefined && typeof userMessageBubbleColor !== 'string') return { ...settingsDefaults };
    if (preferredLanguage !== undefined && preferredLanguage !== null && typeof preferredLanguage !== 'string') return { ...settingsDefaults };
    return {
        ...settingsDefaults,
        ...(userMessageBubbleColor === undefined ? {} : { userMessageBubbleColor }),
        ...(preferredLanguage === undefined ? {} : { preferredLanguage }),
    };
}

export function applySettings(settings: Settings, delta: Partial<Settings>): Settings {
    return { ...settingsDefaults, ...settings, ...delta };
}

export function settingsToSyncPayload(settings: Settings): Partial<Settings> {
    return { ...settings };
}
