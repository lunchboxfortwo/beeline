import * as React from 'react';

/**
 * Host-element stand-ins for Tamagui, lucide and react-native-svg, so screen
 * tests render the grammar with react-test-renderer and read props and
 * `.props.children` from plain host nodes. Use inside `vi.mock` factories:
 * `vi.mock('tamagui', async () => (await import('…/tamagui-hosts.test-support')).tamaguiHosts())`.
 */
let autoLayout: () => boolean = () => false;

function host(name: string) {
  const Host = (props: any) => {
    // Like the native host stubs: a mounted view reports its layout once.
    React.useEffect(() => { if (autoLayout()) props.onLayout?.(); }, [props.onLayout]);
    return React.createElement(name, props, props.children);
  };
  Host.displayName = name;
  return Host;
}

function compound(name: string, parts: string[]) {
  const Root: any = host(name);
  for (const part of parts) Root[part] = host(`${name}.${part}`);
  return Root;
}

const CollapsibleState = React.createContext<{ open: boolean; toggle: () => void }>({ open: false, toggle: () => undefined });

function Collapsible({ open = false, onOpenChange, children }: { open?: boolean; onOpenChange?: (open: boolean) => void; children?: React.ReactNode }) {
  const value = React.useMemo(() => ({ open, toggle: () => onOpenChange?.(!open) }), [open, onOpenChange]);
  return React.createElement(CollapsibleState.Provider, { value }, React.createElement('Collapsible', { open }, children));
}
Collapsible.Content = function CollapsibleContent({ children }: { children?: React.ReactNode }) {
  return React.useContext(CollapsibleState).open ? React.createElement('Collapsible.Content', null, children) : null;
};
Collapsible.Trigger = function CollapsibleTrigger({ children }: { children: React.ReactElement<any> }) {
  const state = React.useContext(CollapsibleState);
  return React.cloneElement(children, { onPress: state.toggle });
};

/** `layout` decides whether mounted stacks call their `onLayout` (default: never). */
export function tamaguiHosts(layout?: () => boolean) {
  if (layout) autoLayout = layout;
  return {
    YStack: host('YStack'),
    XStack: host('XStack'),
    ScrollView: host('ScrollView'),
    Input: host('Input'),
    ListItem: host('ListItem'),
    Separator: host('Separator'),
    Text: host('Text'),
    Button: host('Button'),
    Card: host('Card'),
    Spinner: host('Spinner'),
    Image: host('Image'),
    Label: host('Label'),
    Theme: ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children),
    Collapsible,
    ToggleGroup: compound('ToggleGroup', ['Item']),
    Sheet: compound('Sheet', ['Overlay', 'Handle', 'Container', 'Background', 'ScrollView', 'Frame']),
    Switch: compound('Switch', ['Thumb']),
    Tabs: compound('Tabs', ['List', 'Tab', 'Content']),
    useTheme: () => ({}),
    useThemeName: () => 'dark_brass',
  };
}

/** Every lucide icon renders as a host named after it. */
export function lucideHosts() {
  const icons = new Map<string, ReturnType<typeof host>>();
  return new Proxy({}, {
    has: (_target, key) => typeof key === 'string',
    get: (_target, key) => {
      if (typeof key !== 'string' || key === 'then' || key === '__esModule') return undefined;
      if (!icons.has(key)) icons.set(key, host(`Icon.${key}`));
      return icons.get(key);
    },
  });
}

export function svgHosts() {
  return { default: host('Svg'), Svg: host('Svg'), Path: host('Path') };
}

