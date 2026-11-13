import React from 'react';

/**
 * Node tests never load Tamagui or lucide: every component renders as a plain
 * host named after itself (`YStack`, `Btn` children, `Glyph` icons), so a test
 * finds controls by their props (`aria-label`, `testID`, `onPress`) and reads
 * text from `.props.children`. Use as
 * `vi.mock('tamagui', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts())`
 * and the same with `lucideHosts()` for `lucide-react-native`.
 */
function host(name: string) {
    const component = (props: Record<string, unknown>) =>
        React.createElement(name, props, props.children as React.ReactNode);
    component.displayName = name;
    return component;
}

function withStatics(name: string, statics: string[]) {
    const component = host(name) as ReturnType<typeof host> & Record<string, unknown>;
    for (const child of statics) component[child] = host(`${name}.${child}`);
    return component;
}

const COMPONENTS = [
    'YStack', 'XStack', 'ZStack', 'Text', 'Paragraph', 'ScrollView', 'Card', 'ListItem', 'Separator', 'Button',
    'Input', 'TextArea', 'Image', 'Spinner', 'Checkbox', 'Switch', 'Label', 'Theme', 'TamaguiProvider', 'View', 'Stack',
];

export function tamaguiHosts() {
    const module: Record<string, unknown> = { __esModule: true };
    for (const name of COMPONENTS) module[name] = host(name);
    module.Sheet = withStatics('Sheet', ['Overlay', 'Handle', 'Frame', 'Container', 'Background', 'ScrollView']);
    module.Collapsible = withStatics('Collapsible', ['Trigger', 'Content']);
    module.RadioGroup = withStatics('RadioGroup', ['Item', 'Indicator']);
    module.ToggleGroup = withStatics('ToggleGroup', ['Item']);
    module.Tabs = withStatics('Tabs', ['List', 'Tab', 'Content']);
    module.Avatar = withStatics('Avatar', ['Image', 'Fallback']);
    module.useTheme = () => new Proxy({}, { get: (_target, key) => ({ val: String(key), get: () => String(key) }) });
    module.useThemeName = () => 'dark_brass';
    module.getTokens = () => ({ space: { '1': { val: 4 } } });
    module.useMedia = () => ({});
    module.styled = (base: unknown) => base;
    return module;
}

/** Every lucide icon renders as a host named after the icon. */
export function lucideHosts() {
    const cache = new Map<string, unknown>();
    return new Proxy({ __esModule: true } as Record<string | symbol, unknown>, {
        has: () => true,
        get: (target, key) => {
            if (key in target) return target[key as string];
            if (typeof key !== 'string' || key === 'then') return undefined;
            if (!cache.has(key)) cache.set(key, host(`Icon.${key}`));
            return cache.get(key);
        },
    });
}
